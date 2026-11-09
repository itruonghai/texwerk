import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { hostname, networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import { extname, join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { cleanPath, cleanProjectId, cleanProjectName } from '../shared/files.ts';
import { BRIDGE_HEADER, CLOSE_SIGN_IN_EXPIRED, type Identity, type ProjectSettings } from '../shared/protocol.ts';
import { setupCompileSandbox, synctex } from './compile.ts';
import * as gitOps from './git.ts';
import { resolveIdentity, type AccessConfig } from './identity.ts';
import {
  canManage, FOLDER_MARKER, folderVisibleTo, isGuest, normalizeLogin, normalizeShares, readAccess, readFolderOwner, roleFor,
  UserDirectory, writeAccess, writeFolderMarker, type ProjectAccess, type ProjectRole,
} from './access.ts';
import {
  admitCloudflareSocket, cloudflareSessionEndsAt, createCloudflareAccessVerifier, isCloudflareRequest,
  type CloudflareAccessConfig,
} from './cloudflareAccess.ts';
import { itemPath, listTrash, moveToTrash, restoreFromTrash, ROOT_TRASH, validTrashId, type TrashMeta } from './trash.ts';
import { Project, type Conn } from './project.ts';
import { OverleafLink, previewLink, readLinkState, type Choices } from './overleaf/link.ts';
import { cookieHeader, OverleafError, parseProjectUrl } from './overleaf/socketio.ts';
import { readZip, writeZip } from './zip.ts';
import { allThreads, commentsMarkdown, sortThreads } from '../shared/comments.ts';
import { messagesSince, parseRef, type ChatRef } from '../shared/chat.ts';
import { annotatePdf, pdfPosition } from './pdfComments.ts';
import { refusal } from './origin.ts';

/**
 * The TeXWerk server: one HTTP port serving the browser client, a JSON API,
 * raw project files, the compiled PDFs, the mirror bridge script, and a
 * WebSocket per open project for live collaboration.
 *
 * Every top-level folder of `rootDir` is a project (and a git repository).
 * Nothing outside `rootDir` is ever read or written.
 */

export interface ServerOptions {
  rootDir: string;
  clientDir: string | null;
  bridgeFile: string | null;
  port: number;
  host: string;
  access: AccessConfig | null;
  /** Host names besides the ones `hostAllowed` accepts on its own (see origin.ts). */
  allowHosts?: string[];
  /**
   * A second, loopback-only listener for a Cloudflare Tunnel behind Cloudflare
   * Access (cloudflareAccess.ts). Needs `access`. `publicUrl` is the address
   * people open; its host name is allowed like an `--allow-host`.
   */
  cloudflare?: CloudflareAccessConfig & { port: number; publicUrl?: string };
}

/** Routes a guest (see isGuest) may not use: anything beyond the projects shared with them. */
const GUEST_FORBIDDEN_ANY = new Set(['/api/users', '/api/projects/trash', '/api/projects/trash/restore']);
const GUEST_FORBIDDEN_WRITES = new Set([
  '/api/projects', '/api/projects/import', '/api/projects/clone', '/api/projects/move', '/api/projects/rename',
  '/api/projects/delete', '/api/folders', '/api/folders/rename',
  // Where the server's git connects, and with which key, stays with the
  // people on the tailnet: a remote URL is a request this machine makes.
  '/api/git/remote', '/api/git/deploy-key',
]);

function guestForbidden(path: string, method: string): boolean {
  if (GUEST_FORBIDDEN_ANY.has(path)) return true;
  return method !== 'GET' && method !== 'HEAD' && GUEST_FORBIDDEN_WRITES.has(path);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json', '.wasm': 'application/wasm',
};

const MAX_BODY = 200 * 1024 * 1024;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'upload too large')); request.destroy(); return; }
      chunks.push(c);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const body = await readBody(request);
  try { return JSON.parse(body.toString('utf8') || '{}') as T; } catch { throw new HttpError(400, 'bad JSON'); }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  return `${kind}; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Types a browser runs scripts in when it navigates to them. */
const ACTIVE_TYPES = /^(text\/html|image\/svg\+xml|application\/xml|text\/xml|application\/xhtml\+xml)\b/;

/**
 * `untrusted`: a file someone put in a project, served from this origin. It
 * must never run as one of our pages: no sniffing, HTML and XML go out as
 * text, and anything else a browser renders (an SVG opened from a link) is
 * sandboxed. PDFs are left alone, since browsers' PDF viewers refuse to run
 * sandboxed and a PDF cannot reach the page's origin anyway.
 */
async function sendFile(request: IncomingMessage, response: ServerResponse, abs: string, opts: { download?: string; noStore?: boolean; immutable?: boolean; untrusted?: boolean } = {}): Promise<void> {
  let info;
  try { info = await stat(abs); } catch { throw new HttpError(404, 'not found'); }
  if (!info.isFile()) throw new HttpError(404, 'not found');
  const etag = `"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
  let type = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream';
  const sandbox: Record<string, string> = {};
  if (opts.untrusted) {
    if (ACTIVE_TYPES.test(type) && type !== 'image/svg+xml') type = 'text/plain; charset=utf-8';
    sandbox['x-content-type-options'] = 'nosniff';
    if (type !== 'application/pdf') sandbox['content-security-policy'] = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
  }
  const headers: Record<string, string> = {
    ...sandbox,
    'content-type': type,
    'cache-control': opts.noStore ? 'no-store' : opts.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    etag,
    'accept-ranges': 'bytes',
  };
  if (opts.download) headers['content-disposition'] = contentDisposition('attachment', opts.download);
  if (!opts.noStore && request.headers['if-none-match'] === etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      response.writeHead(416, { 'content-range': `bytes */${info.size}` });
      response.end();
      return;
    }
    response.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': String(end - start + 1) });
    createReadStream(abs, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, 'content-length': String(info.size) });
  createReadStream(abs).pipe(response);
}

const TEMPLATE = String.raw`\documentclass[11pt]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{hyperref}

\title{Untitled}
\author{}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}
Start writing here.

\end{document}
`;

export async function startServer(options: ServerOptions) {
  const rootDir = resolve(options.rootDir);
  await mkdir(rootDir, { recursive: true });
  const unsandboxed = setupCompileSandbox(rootDir);
  if (unsandboxed) {
    process.stderr.write(`warning: compiles are not sandboxed (bubblewrap: ${unsandboxed}), so a document can read any file this server can read, other projects included.\n`);
  }
  const projects = new Map<string, Promise<Project>>();
  /** Projects whose folder is being renamed: nobody may (re)open the old id meanwhile. */
  const relocating = new Set<string>();
  const access = options.access ? { admin: normalizeLogin(options.access.admin) } : null;
  if (options.cloudflare && !access) throw new Error('the Cloudflare listener needs --access');
  const cloudflare = options.cloudflare ? createCloudflareAccessVerifier(options.cloudflare) : null;
  const allowHosts = [...options.allowHosts ?? []];
  if (options.cloudflare?.publicUrl) allowHosts.push(new URL(options.cloudflare.publicUrl).hostname);
  const rootTrash = join(rootDir, ROOT_TRASH);
  const users = access ? new UserDirectory(join(rootDir, '.texwerk-users.json')) : null;

  // --------------------------------------------------------- the catalog

  function dirOf(id: string): string {
    const clean = cleanProjectId(id);
    if (!clean) throw new HttpError(400, 'invalid project or folder name');
    return join(rootDir, ...clean.split('/'));
  }

  const isFolderDir = (dir: string) => existsSync(join(dir, FOLDER_MARKER));
  const isProjectDir = (dir: string) => existsSync(dir) && !isFolderDir(dir);

  async function getProject(id: string | null): Promise<Project> {
    if (!id) throw new HttpError(400, 'missing ?project=');
    const clean = cleanProjectId(id);
    if (!clean) throw new HttpError(400, 'invalid project id');
    const dir = dirOf(clean);
    let pending = projects.get(clean);
    if (!pending) {
      if (relocating.has(clean)) throw new HttpError(409, 'this project is being renamed');
      if (!isProjectDir(dir)) throw new HttpError(404, `no project "${clean}"`);
      pending = (async () => {
        const p = new Project(clean, dir);
        await p.open();
        p.onUnload = () => { if (projects.get(clean) === pending) projects.delete(clean); };
        const linked = readLinkState(dir);
        if (linked) new OverleafLink(p, linked).start();
        return p;
      })();
      projects.set(clean, pending);
      pending.catch(() => projects.delete(clean));
    }
    return pending;
  }

  async function closeProject(id: string): Promise<void> {
    const pending = projects.get(id);
    if (!pending) return;
    projects.delete(id);
    await (await pending).close();
  }

  /** The role this identity has on a project; everyone owns everything without --access. */
  async function roleOf(identity: Identity, id: string): Promise<ProjectRole | null> {
    if (!access) return 'owner';
    return roleFor(identity.login, await readAccess(dirOf(id), access), access, isGuest(identity, access));
  }

  async function requireRole(identity: Identity, id: string, need: 'view' | 'edit' | 'manage'): Promise<ProjectRole> {
    const clean = cleanProjectId(id);
    if (!clean || !isProjectDir(dirOf(clean))) throw new HttpError(404, `no project "${id}"`);
    const role = await roleOf(identity, clean);
    if (!role) throw new HttpError(403, 'you do not have access to this project');
    if (need === 'edit' && role === 'view') throw new HttpError(403, 'you have view-only access to this project');
    if (need === 'manage' && access && !canManage(identity.login, await readAccess(dirOf(clean), access), access)) {
      throw new HttpError(403, 'only the owner can do that');
    }
    return role;
  }

  interface ProjectEntry {
    id: string;
    name: string;
    folder: string;
    files: number;
    editedAt: number;
    createdAt: number;
    editors: number;
    people: string[];
    owner?: string;
    visibility?: 'public' | 'private';
    publicRole?: 'edit' | 'view';
    role: ProjectRole;
    canManage: boolean;
    sharedWithMe?: boolean;
  }

  interface FolderEntry {
    path: string;
    name: string;
    parent: string;
    projects: number;
    owner?: string;
    canManage: boolean;
  }

  async function countFiles(dir: string): Promise<number> {
    let n = 0;
    const walk = async (d: string, top: boolean) => {
      let entries;
      try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (top && (e.name === '.git' || e.name === '.texwerk')) continue;
        if (e.isDirectory()) await walk(join(d, e.name), false);
        else if (e.isFile()) n++;
      }
    };
    await walk(dir, true);
    return n;
  }

  /** Every project and folder this identity may see. */
  async function catalog(identity: Identity): Promise<{ projects: ProjectEntry[]; folders: FolderEntry[] }> {
    const outProjects: ProjectEntry[] = [];
    const outFolders: FolderEntry[] = [];
    const walk = async (dir: string, rel: string): Promise<number> => {
      let accessible = 0;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const childDir = join(dir, e.name);
        const id = rel ? `${rel}/${e.name}` : e.name;
        if (!cleanProjectId(id)) continue;
        if (isFolderDir(childDir)) {
          const inside = await walk(childDir, id);
          const owner = access ? await readFolderOwner(childDir, access) : undefined;
          const visible = !access || folderVisibleTo(identity.login, { owner: owner!, accessibleProjects: inside }, access);
          if (visible) {
            outFolders.push({
              path: id, name: e.name, parent: rel, projects: inside, owner,
              canManage: !access || identity.login === access.admin || owner === identity.login,
            });
          }
          accessible += inside;
          continue;
        }
        const projectAccess = access ? await readAccess(childDir, access) : null;
        const role = access ? roleFor(identity.login, projectAccess!, access, isGuest(identity, access)) : 'owner';
        if (!role) continue;
        accessible += 1;
        const dirStat = await stat(childDir);
        let editedAt = dirStat.mtimeMs;
        // Birth time where the filesystem records it (btrfs, ext4, APFS); else the oldest time we have.
        const createdAt = dirStat.birthtimeMs > 0 ? dirStat.birthtimeMs : Math.min(dirStat.mtimeMs, dirStat.ctimeMs);
        try { editedAt = Math.max(editedAt, (await stat(join(childDir, '.texwerk', 'history', 'log.jsonl'))).mtimeMs); } catch { /* never edited here */ }
        const open = projects.get(id);
        const p = open ? await open.catch(() => null) : null;
        const people = p ? [...new Set([...p.conns].map((c) => (c.bridge ? `${c.identity.name} · agent` : c.identity.name)))] : [];
        outProjects.push({
          id, name: e.name, folder: rel,
          files: p ? p.allFiles().length : await countFiles(childDir),
          editedAt, createdAt, editors: people.length, people,
          owner: projectAccess?.owner,
          visibility: projectAccess?.visibility,
          publicRole: projectAccess?.publicRole,
          role,
          canManage: !access || canManage(identity.login, projectAccess!, access),
          sharedWithMe: projectAccess?.sharedWith.some((s) => s.login === identity.login),
        });
      }
      return accessible;
    };
    await walk(rootDir, '');
    outProjects.sort((a, b) => b.editedAt - a.editedAt);
    outFolders.sort((a, b) => a.name.localeCompare(b.name));
    return { projects: outProjects, folders: outFolders };
  }

  /** Who may create things in `folder`: anyone who can see it (it is theirs, or holds their work). */
  async function checkFolder(identity: Identity, folder: string): Promise<string> {
    if (!folder) return '';
    const clean = cleanProjectId(folder);
    if (!clean || !isFolderDir(dirOf(clean))) throw new HttpError(404, `no folder "${folder}"`);
    if (access) {
      const { folders } = await catalog(identity);
      if (!folders.some((f) => f.path === clean)) throw new HttpError(404, `no folder "${folder}"`);
    }
    return clean;
  }

  /** A new project's id in `folder`, refusing names that are taken. */
  async function newProjectId(identity: Identity, name: unknown, folder: unknown): Promise<string> {
    const clean = cleanProjectName(String(name ?? ''));
    if (!clean) throw new HttpError(400, 'invalid project name');
    const parent = await checkFolder(identity, String(folder ?? ''));
    const id = parent ? `${parent}/${clean}` : clean;
    if (existsSync(dirOf(id))) throw new HttpError(409, `"${clean}" already exists here`);
    return id;
  }

  /** New and imported projects start private to their creator. */
  async function claim(identity: Identity, id: string): Promise<void> {
    if (!access) return;
    await writeAccess(dirOf(id), { owner: identity.login, visibility: 'private', sharedWith: [], publicRole: 'view' });
  }

  /**
   * The name a project or folder is to get. `name` is also the typed identity
   * the client adds to every request without --access, so it travels as
   * `newName`; `name` is still read from clients that predate that.
   */
  function newNameParam(url: URL): string | null {
    return url.searchParams.get('newName') ?? url.searchParams.get('name');
  }

  async function identityOf(request: IncomingMessage, url: URL): Promise<Identity> {
    // On the Cloudflare listener, check the sign-in token first: it is all
    // resolveIdentity trusts there.
    const viaCloudflare = isCloudflareRequest(request);
    if (viaCloudflare) await cloudflare?.admit(request);
    const identity = resolveIdentity(request, options.access, url.searchParams.get('name') ?? request.headers['x-texwerk-name'] as string ?? null);
    if (!identity) {
      throw new HttpError(403, viaCloudflare
        ? 'not signed in — open this server through its Cloudflare Access address'
        : 'unidentified connection — this server is reachable only through tailscale serve');
    }
    return identity;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    const method = request.method ?? 'GET';
    const refused = refusal(request, allowHosts);
    if (refused) throw new HttpError(403, refused);
    const identity = await identityOf(request, url);
    if (users) void users.note(identity);
    // A guest from the internet (the Cloudflare door) works only inside
    // projects shared with them. Everything that reaches beyond one project —
    // creating, importing, moving, the trash, the list of everyone on this
    // server, where git connects — is for the people on the tailnet.
    const guest = Boolean(access && isGuest(identity, access));
    if (guest && guestForbidden(path, method)) throw new HttpError(403, 'guests can open what is shared with them, but not this');
    const bridge = request.headers[BRIDGE_HEADER] === '1';
    const who = bridge ? `${identity.name} · agent` : identity.name;
    const projectParam = url.searchParams.get('project');

    // ------------------------------------------------------------ static
    if (path === '/texwerk-connect.mjs' && options.bridgeFile) {
      return sendFile(request, response, options.bridgeFile, { noStore: true });
    }
    if (!path.startsWith('/api/') && !path.startsWith('/raw/') && !path.startsWith('/pdf/')) {
      if (!options.clientDir) throw new HttpError(404, 'client not built — run npm run build');
      const rel = path === '/' ? 'index.html' : path.slice(1);
      const abs = resolve(options.clientDir, rel);
      if (!abs.startsWith(`${options.clientDir}/`) || !existsSync(abs)) return sendFile(request, response, join(options.clientDir, 'index.html'));
      // Vite names everything under app/ by content hash, so it never changes
      // (Harper's 16 MB dictionary would otherwise be revalidated on every load).
      return sendFile(request, response, abs, { immutable: rel.startsWith('app/') });
    }

    // ---------------------------------------------------------- raw files
    // /raw/<project id, URI-encoded as one segment>/<path>: current bytes of a file.
    const raw = /^\/raw\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (raw && method === 'GET') {
      const id = decodeURIComponent(raw[1]);
      await requireRole(identity, id, 'view');
      const project = await getProject(id);
      const rel = cleanPath(decodeURIComponent(raw[2]));
      if (!rel) throw new HttpError(400, 'bad path');
      const ytext = project.texts.get(rel);
      const download = url.searchParams.has('download') ? rel.split('/').pop() : undefined;
      if (ytext) {
        const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
        if (download) headers['content-disposition'] = contentDisposition('attachment', download);
        response.writeHead(200, headers);
        response.end(ytext.toString());
        return;
      }
      // A symlink inside a project (a cloned repo can carry one) must not
      // reach files outside it.
      let real: string;
      try { real = await realpath(join(project.dir, rel)); } catch { throw new HttpError(404, 'not found'); }
      if (!real.startsWith(`${await realpath(project.dir)}/`)) throw new HttpError(403, 'outside the project');
      return sendFile(request, response, real, { download, untrusted: true });
    }
    // /pdf/<project id>/<name>.pdf: the latest compiled PDF.
    const pdf = /^\/pdf\/([^/]+)\/[^/]*$/.exec(url.pathname);
    if (pdf && (method === 'GET' || (method === 'POST' && url.searchParams.get('comments') === '1'))) {
      const id = decodeURIComponent(pdf[1]);
      await requireRole(identity, id, 'view');
      const project = await getProject(id);
      if (!project.lastPdf) throw new HttpError(404, 'not compiled yet');
      const base = project.name.split('/').pop()!;
      if (url.searchParams.get('comments') === '1') {
        const threads = sortThreads(allThreads(project.doc)).filter((t) => !t.resolved && t.line !== null);
        // The browser knows exactly where each quote is printed (it searched
        // the PDF text); fall back to SyncTeX's paragraph for the rest.
        const exact = method === 'POST' ? (await readJson<{ positions?: Record<string, { page: number; x: number; y: number }> }>(request)).positions ?? {} : {};
        const positions = [];
        for (const t of threads) {
          const e = exact[t.id];
          // Same pins as on screen: a thread the browser could not place is left out.
          if (method === 'POST' && !e) { positions.push(null); continue; }
          positions.push(e && Number.isFinite(e.page) && Number.isFinite(e.y)
            ? { page: e.page, x: Number(e.x) || 0, y: e.y, top: e.y, bottom: e.y }
            : await pdfPosition(project, t.path, t.line!));
        }
        const annotated = await annotatePdf(await readFile(project.lastPdf), threads, positions);
        response.writeHead(200, {
          'content-type': 'application/pdf', 'cache-control': 'no-store',
          'content-disposition': contentDisposition('attachment', `${base} (comments).pdf`),
        });
        response.end(annotated);
        return;
      }
      const download = url.searchParams.has('download') ? `${base}.pdf` : undefined;
      // Revalidated on every use (so access is still checked), but a reload with
      // no new compile costs a 304 instead of the whole PDF again.
      return sendFile(request, response, project.lastPdf, { download });
    }

    // ---------------------------------------------------------------- api
    if (path === '/api/me') {
      return json(response, 200, { you: identity, access: Boolean(access), admin: !access || identity.login === access.admin, guest, host: hostname() });
    }

    if (path === '/api/projects' && method === 'GET') return json(response, 200, await catalog(identity));

    if (path === '/api/users' && method === 'GET') return json(response, 200, users ? await users.all() : []);

    if (path === '/api/projects' && method === 'POST') {
      const body = await readJson<{ name: string; folder?: string; blank?: boolean }>(request);
      const id = await newProjectId(identity, body.name, body.folder);
      const dir = dirOf(id);
      await mkdir(dir);
      if (!body.blank) await writeFile(join(dir, 'main.tex'), TEMPLATE);
      await gitOps.ensureRepo(dir);
      await claim(identity, id);
      return json(response, 200, { id });
    }

    if (path === '/api/projects/import' && method === 'POST') {
      const id = await newProjectId(identity, newNameParam(url), url.searchParams.get('folder'));
      const dir = dirOf(id);
      const entries = readZip(await readBody(request));
      // An archive of a single folder is unwrapped: import its contents.
      const names = entries.map((e) => e.name.replace(/\\/g, '/'));
      const tops = new Set(names.map((n) => n.split('/')[0]));
      const strip = tops.size === 1 && names.every((n) => n.includes('/')) ? `${[...tops][0]}/` : '';
      await mkdir(dir);
      for (const [i, e] of entries.entries()) {
        const rel = cleanPath(names[i].slice(strip.length));
        if (!rel || rel.startsWith('__MACOSX/')) continue;
        await mkdir(join(dir, rel, '..'), { recursive: true });
        await writeFile(join(dir, rel), e.data);
      }
      await gitOps.ensureRepo(dir);
      await claim(identity, id);
      return json(response, 200, { id });
    }

    if (path === '/api/projects/clone' && method === 'POST') {
      const body = await readJson<{ url: string; name: string; folder?: string }>(request);
      const id = await newProjectId(identity, body.name, body.folder);
      if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(body.url)) throw new HttpError(400, 'use an https:// or ssh git URL');
      const parent = id.includes('/') ? dirOf(id.slice(0, id.lastIndexOf('/'))) : rootDir;
      const r = await gitOps.clone(parent, body.url, id.split('/').pop()!);
      if (!r.ok) return json(response, 400, { error: r.output });
      await claim(identity, id);
      return json(response, 200, { id, output: r.output });
    }

    /**
     * Renaming or moving changes the id. Moving needs the project closed; a
     * rename (`live`) may happen with people in it, as from the editor's own
     * title: everyone connected is told the new id, the project is persisted
     * and closed, the folder moves, and only then are the sockets closed —
     * so each client's reconnect lands on the new id and resumes the same
     * document (the epoch travels with the folder), unsent edits included.
     */
    const relocate = async (from: string, to: string, live = false) => {
      if (existsSync(dirOf(to))) throw new HttpError(409, `"${to.split('/').pop()}" already exists there`);
      if (relocating.has(from)) throw new HttpError(409, 'this project is being renamed');
      relocating.add(from);
      let conns: Conn[] = [];
      try {
        const open = projects.get(from);
        const project = open ? await open.catch(() => null) : null;
        if (project?.conns.size && !live) {
          throw new HttpError(409, 'someone has this project open; it can be moved once everyone has closed it');
        }
        if (project) {
          project.announceMove(to);
          // A compile writes into the folder by absolute path: let it finish
          // (and any compile queued behind it) before the folder moves.
          for (let c = project.isCompiling(); c; c = project.isCompiling()) await c.catch(() => {});
          conns = [...project.conns];
          projects.delete(from);
          await project.close(false);
        }
        try {
          await rename(dirOf(from), dirOf(to));
        } catch (err) {
          // Still where it was: send everyone back to the old id.
          for (const c of conns) if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify({ t: 'moved', to: from }));
          throw err;
        }
      } finally {
        relocating.delete(from);
        for (const c of conns) c.ws.close(4302, 'project renamed');
      }
    };

    if (path === '/api/projects/rename' && method === 'POST') {
      const id = cleanProjectId(projectParam ?? '') ?? '';
      await requireRole(identity, id, 'manage');
      const name = cleanProjectName(newNameParam(url) ?? '');
      if (!name) throw new HttpError(400, 'invalid name');
      const to = id.includes('/') ? `${id.slice(0, id.lastIndexOf('/'))}/${name}` : name;
      if (to !== id) await relocate(id, to, true);
      return json(response, 200, { id: to });
    }

    if (path === '/api/projects/move' && method === 'POST') {
      const id = cleanProjectId(projectParam ?? '') ?? '';
      await requireRole(identity, id, 'manage');
      const folder = await checkFolder(identity, url.searchParams.get('folder') ?? '');
      const name = id.split('/').pop()!;
      const to = folder ? `${folder}/${name}` : name;
      if (to !== id) await relocate(id, to);
      return json(response, 200, { id: to });
    }

    if (path === '/api/folders' && method === 'POST') {
      const target = cleanProjectId(url.searchParams.get('path') ?? '');
      if (!target) throw new HttpError(400, 'invalid folder name');
      await checkFolder(identity, target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '');
      if (existsSync(dirOf(target))) throw new HttpError(409, 'that name is taken');
      await mkdir(dirOf(target));
      await writeFolderMarker(dirOf(target), identity.login);
      return json(response, 200, { path: target });
    }

    const manageFolder = async (folderPath: string) => {
      const clean = await checkFolder(identity, folderPath);
      if (!clean) throw new HttpError(400, 'missing folder');
      if (access && identity.login !== access.admin && (await readFolderOwner(dirOf(clean), access)) !== identity.login) {
        throw new HttpError(403, 'only the folder\'s creator can do that');
      }
      return clean;
    };

    if (path === '/api/folders/rename' && method === 'POST') {
      const folder = await manageFolder(url.searchParams.get('path') ?? '');
      const name = cleanProjectName(newNameParam(url) ?? '');
      if (!name) throw new HttpError(400, 'invalid name');
      const to = folder.includes('/') ? `${folder.slice(0, folder.lastIndexOf('/'))}/${name}` : name;
      if (existsSync(dirOf(to))) throw new HttpError(409, 'that name is taken');
      for (const id of projects.keys()) {
        if (id.startsWith(`${folder}/`) && (await projects.get(id)!.catch(() => null))?.conns.size) {
          throw new HttpError(409, 'a project in this folder is open; rename it once everyone has closed it');
        }
      }
      for (const id of [...projects.keys()]) if (id.startsWith(`${folder}/`)) await closeProject(id);
      await rename(dirOf(folder), dirOf(to));
      return json(response, 200, { path: to });
    }

    if (path === '/api/folders' && method === 'DELETE') {
      const folder = await manageFolder(url.searchParams.get('path') ?? '');
      const inside = (await readdir(dirOf(folder))).filter((n) => n !== FOLDER_MARKER);
      if (inside.length) throw new HttpError(409, 'only an empty folder can be deleted');
      await moveToTrash(rootTrash, dirOf(folder), { kind: 'folder', path: folder, deletedAt: new Date().toISOString(), deletedBy: identity.login });
      return json(response, 200, { ok: true });
    }

    /**
     * Deleting a project moves it to `<root>/.trash/` (never really deleted).
     * Only its owner (or the admin) may; everyone in it is disconnected first
     * and the document is persisted, so nothing writes the folder back.
     */
    if (path === '/api/projects/delete' && method === 'POST') {
      const id = cleanProjectId(projectParam ?? '') ?? '';
      await requireRole(identity, id, 'manage');
      if (relocating.has(id)) throw new HttpError(409, 'this project is being renamed');
      relocating.add(id);
      let conns: Conn[] = [];
      try {
        const open = projects.get(id);
        const project = open ? await open.catch(() => null) : null;
        if (project) {
          for (let c = project.isCompiling(); c; c = project.isCompiling()) await c.catch(() => {});
          conns = [...project.conns];
          projects.delete(id);
          await project.close(false);
        }
        await moveToTrash(rootTrash, dirOf(id), { kind: 'project', path: id, deletedAt: new Date().toISOString(), deletedBy: identity.login });
      } finally {
        relocating.delete(id);
        for (const c of conns) c.ws.close(4404, 'project deleted');
      }
      return json(response, 200, { ok: true });
    }

    /**
     * Trashed projects and folders, filtered exactly like the catalog: a
     * project by its own access.json (which travelled with it), a folder for
     * its creator and the admin (the only people who see an empty folder).
     */
    const visibleRootTrash = async () => {
      const out: Array<TrashMeta & { canRestore: boolean }> = [];
      for (const meta of await listTrash(rootTrash)) {
        const item = itemPath(rootTrash, meta);
        if (meta.kind === 'project') {
          if (!access) { out.push({ ...meta, canRestore: true }); continue; }
          const pa = await readAccess(item, access);
          if (!roleFor(identity.login, pa, access)) continue;
          out.push({ ...meta, canRestore: canManage(identity.login, pa, access) });
        } else if (meta.kind === 'folder') {
          const mine = !access || identity.login === access.admin || (await readFolderOwner(item, access)) === identity.login;
          if (mine) out.push({ ...meta, canRestore: true });
        }
      }
      return out;
    };

    if (path === '/api/projects/trash' && method === 'GET') {
      return json(response, 200, { items: await visibleRootTrash() });
    }

    if (path === '/api/projects/trash/restore' && method === 'POST') {
      const tid = url.searchParams.get('id');
      if (!validTrashId(tid)) throw new HttpError(400, 'invalid trash id');
      const meta = (await visibleRootTrash()).find((m) => m.id === tid);
      if (!meta) throw new HttpError(404, 'no such item in the trash');
      if (!meta.canRestore) throw new HttpError(403, 'only the owner can restore this');
      const clean = cleanProjectId(meta.path);
      if (!clean) throw new HttpError(400, 'invalid original path');
      const parent = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/')) : '';
      // Back where it was if that folder still exists, else at the top level.
      const to = parent && isFolderDir(dirOf(parent)) ? clean : clean.split('/').pop()!;
      try { await restoreFromTrash(rootTrash, meta, dirOf(to)); } catch (err) { throw new HttpError(409, (err as Error).message); }
      return json(response, 200, { id: to });
    }

    if (path === '/api/access') {
      const id = cleanProjectId(projectParam ?? '') ?? '';
      const role = await requireRole(identity, id, 'view');
      if (!access) return json(response, 200, { enabled: false });
      const current = await readAccess(dirOf(id), access);
      const manage = canManage(identity.login, current, access);
      if (method === 'GET') return json(response, 200, { enabled: true, ...current, canManage: manage, role });
      if (method === 'PUT') {
        if (!manage) throw new HttpError(403, 'only the owner can change who has access');
        const body = await readJson<Partial<ProjectAccess>>(request);
        const next: ProjectAccess = {
          owner: current.owner,
          visibility: body.visibility === 'public' ? 'public' : 'private',
          publicRole: body.publicRole === 'edit' ? 'edit' : 'view',
          sharedWith: normalizeShares(body.sharedWith).filter((s) => s.login !== current.owner),
        };
        await writeAccess(dirOf(id), next);
        // People who just lost access are disconnected; their role is re-read on reconnect.
        const open = projects.get(id);
        const p = open ? await open.catch(() => null) : null;
        if (p) {
          for (const c of p.conns) {
            const nowRole = roleFor(c.identity.login, next, access, isGuest(c.identity, access));
            if (!nowRole || (nowRole === 'view') !== c.readOnly) c.ws.close(4401, 'access changed');
          }
        }
        return json(response, 200, { ok: true });
      }
    }

    // Everything below is scoped to one project. Reading needs any role;
    // anything that changes the project needs edit.
    const role = await requireRole(identity, projectParam ?? '', 'view');
    const project = await getProject(projectParam);
    // Commenting is open to viewers, like "commenter" in Google Docs.
    const reads = method === 'GET' || ['/api/compile', '/api/synctex/edit', '/api/synctex/view', '/api/synctex/lines', '/api/comments', '/api/chat'].includes(path);
    if (!reads && role === 'view') throw new HttpError(403, 'you have view-only access to this project');
    const bodyPath = (p: unknown) => {
      const clean = cleanPath(String(p ?? ''));
      if (!clean) throw new HttpError(400, 'bad path');
      return clean;
    };

    if (path === '/api/file' && method === 'PUT') {
      const rel = bodyPath(url.searchParams.get('path'));
      await project.putFile(rel, await readBody(request), who);
      return json(response, 200, { ok: true });
    }

    if (path === '/api/fs' && method === 'POST') {
      const body = await readJson<{ op: string; path: string; to?: string }>(request);
      const rel = bodyPath(body.path);
      if (body.op === 'mkdir') await project.mkdir(rel, who);
      else if (body.op === 'newfile') {
        if (project.exists(rel)) throw new HttpError(409, `"${rel}" already exists`);
        await project.putFile(rel, Buffer.alloc(0), who);
      } else if (body.op === 'delete') {
        if (!project.exists(rel)) throw new HttpError(404, `no "${rel}"`);
        if (bridge && !project.allowMirrorDelete(rel)) {
          throw new HttpError(409, `refusing to let a mirror delete most of the project ("${rel}"); delete it in the browser if you mean it`);
        }
        await project.remove(rel, who);
      }
      else if (body.op === 'move') {
        try { await project.move(rel, bodyPath(body.to), who); } catch (err) { throw new HttpError(409, (err as Error).message); }
      } else throw new HttpError(400, 'unknown op');
      return json(response, 200, { ok: true });
    }

    // The project's trash: everyone who may open the project may see it
    // (role checked above); restoring changes the project, so needs edit.
    if (path === '/api/trash' && method === 'GET') {
      return json(response, 200, { items: await project.listTrash() });
    }

    if (path === '/api/trash/restore' && method === 'POST') {
      const tid = url.searchParams.get('id');
      if (!validTrashId(tid)) throw new HttpError(400, 'invalid trash id');
      try { return json(response, 200, { path: await project.restoreTrashed(tid, who) }); } catch (err) { throw new HttpError(409, (err as Error).message); }
    }

    if (path === '/api/compile' && method === 'POST') {
      const done = project.requestCompile(who, url.searchParams.get('clean') === '1');
      if (url.searchParams.get('wait') === '1') {
        await done;
        // A compile queued behind a running one: wait for that too.
        while (project.isCompiling()) await project.isCompiling();
        return json(response, 200, { compile: project.compile, output: project.lastOutput });
      }
      return json(response, 202, { compile: project.compile });
    }

    if (path === '/api/compile' && method === 'GET') {
      return json(response, 200, { compile: project.compile, output: project.lastOutput, log: project.lastLog });
    }

    if (path === '/api/settings' && method === 'POST') {
      const body = await readJson<Partial<ProjectSettings>>(request);
      if (body.mainFile !== undefined) {
        const main = bodyPath(body.mainFile);
        if (!project.texts.has(main)) throw new HttpError(400, 'main file must be a text file in the project');
        if (main.startsWith('-')) throw new HttpError(400, 'the main file\'s name must not start with "-"');
        project.settings.mainFile = main;
      }
      if (body.engine && ['pdflatex', 'xelatex', 'lualatex'].includes(body.engine)) project.settings.engine = body.engine;
      if (typeof body.autoCompile === 'boolean') project.settings.autoCompile = body.autoCompile;
      await project.saveSettings();
      return json(response, 200, { settings: project.settings });
    }

    if (path === '/api/synctex/edit') {
      if (!project.lastPdf) return json(response, 200, { file: null });
      const page = Number(url.searchParams.get('page'));
      const x = Number(url.searchParams.get('x'));
      const y = Number(url.searchParams.get('y'));
      const out = await synctex(project.dir, ['edit', '-o', `${page}:${x}:${y}:${project.lastPdf}`]);
      const input = /^Input:(.*)$/m.exec(out)?.[1];
      const line = Number(/^Line:(\d+)/m.exec(out)?.[1] ?? 0);
      if (!input) return json(response, 200, { file: null });
      const rel = project.relative(resolve(project.dir, input));
      return json(response, 200, { file: rel.startsWith('..') ? null : rel.replace(/^\.\//, ''), line });
    }

    if (path === '/api/synctex/view') {
      if (!project.lastPdf) return json(response, 200, { page: null });
      const file = bodyPath(url.searchParams.get('file'));
      const line = Number(url.searchParams.get('line'));
      const out = await synctex(project.dir, ['view', '-i', `${line}:0:${join(project.dir, file)}`, '-o', project.lastPdf]);
      const page = Number(/^Page:(\d+)/m.exec(out)?.[1] ?? 0);
      const y = Number(/^y:([\d.]+)/m.exec(out)?.[1] ?? 0);
      const x = Number(/^x:([\d.]+)/m.exec(out)?.[1] ?? 0);
      return json(response, 200, page ? { page, x, y } : { page: null });
    }

    if (path === '/api/comments' && method === 'GET') {
      return json(response, 200, { threads: sortThreads(allThreads(project.doc)) });
    }

    if (path === '/api/comments' && method === 'POST') {
      const body = await readJson<{ op: string; id?: string; messageId?: string; path?: string; from?: number; to?: number; line?: number; quote?: string; text?: string }>(request);
      const text = String(body.text ?? '').trim().slice(0, 20_000);
      const moderator = role === 'owner';
      try {
        if (body.op === 'create') {
          if (!text) throw new Error('a comment needs text');
          const file = bodyPath(body.path);
          const ytext = project.texts.get(file);
          if (!ytext) throw new Error(`"${file}" is not a text file in this project`);
          let { from, to } = body;
          const content = ytext.toString();
          if (typeof from !== 'number' || typeof to !== 'number') {
            // By quote (optionally near a line), or a whole line: how agents point at text.
            const lineStart = (n: number) => { let at = 0; for (let l = 1; l < n && at >= 0; l++) { at = content.indexOf('\n', at); if (at >= 0) at++; } return at; };
            if (body.quote) {
              const near = body.line ? lineStart(body.line) : 0;
              let best = -1;
              for (let i = content.indexOf(body.quote); i >= 0; i = content.indexOf(body.quote, i + 1)) {
                if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i;
              }
              if (best < 0) throw new Error('that quote does not appear in the file');
              from = best;
              to = best + body.quote.length;
            } else if (body.line) {
              const a = lineStart(body.line);
              if (a < 0 || a > content.length) throw new Error('no such line');
              let b = content.indexOf('\n', a);
              if (b < 0) b = content.length;
              from = a + (content.slice(a, b).length - content.slice(a, b).trimStart().length);
              to = b;
              if (to <= from) throw new Error('that line is empty');
            } else throw new Error('say which text: from/to, quote, or line');
          }
          const id = project.createComment(file, from!, to!, text, who, identity.login);
          return json(response, 200, { id });
        }
        const id = String(body.id ?? '');
        if (body.op === 'reply') { if (!text) throw new Error('empty reply'); project.reply(id, text, who, identity.login); }
        else if (body.op === 'resolve') project.setResolved(id, true, who);
        else if (body.op === 'reopen') project.setResolved(id, false, who);
        else if (body.op === 'edit') { if (!text) throw new Error('empty message'); project.changeMessage(id, String(body.messageId), text, identity.login, moderator); }
        else if (body.op === 'delete') project.changeMessage(id, String(body.messageId), null, identity.login, moderator);
        else throw new Error('unknown op');
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      return json(response, 200, { ok: true });
    }

    if (path === '/api/chat' && method === 'GET') {
      // ?since=<id> for what came after it; &wait=1 holds the request until
      // there is something (or ~25 s pass), for `tw chat --wait`.
      const since = url.searchParams.get('since');
      let messages = messagesSince(project.chat.toArray(), since);
      if (url.searchParams.get('wait') === '1' && since && !messages.length) {
        const gone = new Promise<void>((done) => response.once('close', () => done()));
        await Promise.race([project.waitChat(25_000), gone]);
        messages = messagesSince(project.chat.toArray(), since);
      }
      return json(response, 200, { messages });
    }

    if (path === '/api/chat' && method === 'POST') {
      const body = await readJson<{ text?: string; mentions?: string[]; ref?: unknown }>(request);
      const text = String(body.text ?? '').trim().slice(0, 20_000);
      if (!text) throw new HttpError(400, 'empty message');
      // Anyone here, and anyone the sender picked from the list, can be mentioned.
      const names = [...[...project.conns].map((c) => c.identity.name), ...(Array.isArray(body.mentions) ? body.mentions.map(String) : [])];
      let ref: ChatRef | undefined;
      if (typeof body.ref === 'string') {
        ref = parseRef(body.ref) ?? undefined;
        if (!ref) throw new HttpError(400, 'a ref is file:line or comment:<id>');
      } else if (body.ref && typeof body.ref === 'object') {
        const r = body.ref as { file?: unknown; line?: unknown; commentId?: unknown };
        if (typeof r.commentId === 'string') ref = { commentId: r.commentId };
        else if (typeof r.file === 'string' && Number(r.line) > 0) ref = { file: bodyPath(r.file), line: Number(r.line) };
      }
      const message = project.say(text, { author: who, login: identity.login, agent: bridge }, names, ref);
      return json(response, 200, { message });
    }

    if (path === '/api/synctex/lines' && method === 'POST') {
      const body = await readJson<{ items: Array<{ file: string; line: number }> }>(request);
      const results = [];
      for (const item of (body.items ?? []).slice(0, 300)) {
        results.push(project.lastPdf ? await pdfPosition(project, bodyPath(item.file), Number(item.line)) : null);
      }
      return json(response, 200, { results });
    }

    if (path === '/api/history' && method === 'GET') {
      await project.history.flush();
      return json(response, 200, { entries: project.history.all(), labels: await gitOps.labels(project.dir) });
    }

    if (path === '/api/history/blob' && method === 'GET') {
      const data = await project.history.readBlob(url.searchParams.get('hash') ?? '');
      if (!data) throw new HttpError(404, 'no such version');
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable' });
      response.end(data);
      return;
    }

    if (path === '/api/history/restore-file' && method === 'POST') {
      const body = await readJson<{ path: string; hash: string | null }>(request);
      await project.restoreFile(bodyPath(body.path), body.hash, `${who} (restore)`);
      return json(response, 200, { ok: true });
    }

    if (path === '/api/history/restore-project' && method === 'POST') {
      const body = await readJson<{ id: number }>(request);
      await project.history.flush(true);
      await project.restoreProject(Number(body.id), `${who} (restore)`);
      await project.history.flush(true);
      return json(response, 200, { ok: true });
    }

    // A label (and a pull, which first commits unlabelled work) asks before
    // committing large files: 409 with the list, and `allowLarge` to go ahead.
    const largeFilesRefusal = async (allowLarge: unknown): Promise<boolean> => {
      if (allowLarge === true) return false;
      const largeFiles = await gitOps.largeFilesToCommit(project.dir);
      if (!largeFiles.length) return false;
      json(response, 409, { error: `${largeFiles.length} large file${largeFiles.length === 1 ? '' : 's'} would be committed`, largeFiles });
      return true;
    };

    if (path === '/api/label' && method === 'POST') {
      const body = await readJson<{ message: string; allowLarge?: boolean }>(request);
      const message = String(body.message ?? '').trim().slice(0, 200);
      if (!message) throw new HttpError(400, 'a label needs a name');
      await project.persistAll();
      project.saveComments();
      project.saveChat();
      await project.history.flush(true);
      if (await largeFilesRefusal(body.allowLarge)) return;
      const r = await gitOps.commitAll(project.dir, message, identity.name, identity.login, project.history.lastId());
      project.broadcastEvent({ t: 'git' });
      project.broadcastEvent({ t: 'history' });
      return json(response, r.ok ? 200 : 500, r.ok ? { ok: true } : { error: r.output });
    }

    if (path === '/api/git/revert' && method === 'POST') {
      const body = await readJson<{ commit: string; message: string }>(request);
      await project.persistAll();
      await project.history.flush(true);
      const r = await gitOps.checkoutTree(project.dir, body.commit);
      if (!r.ok) return json(response, 500, { error: r.output });
      await project.reconcileAll(`${who} (revert)`);
      await project.loadComments();
      project.saveChat(); // the chat is a log: a revert does not take it back
      await project.history.flush(true);
      const c = await gitOps.commitAll(project.dir, `Revert to "${body.message}"`, identity.name, identity.login, project.history.lastId());
      project.broadcastEvent({ t: 'git' });
      return json(response, c.ok ? 200 : 500, c.ok ? { ok: true } : { error: c.output });
    }

    if (path === '/api/git' && method === 'GET') {
      return json(response, 200, { status: await gitOps.status(project.dir), deployKey: await gitOps.readDeployKey(project.dir), host: hostname() });
    }

    if (path === '/api/git/deploy-key' && method === 'POST') {
      const key = await gitOps.ensureDeployKey(project.dir, `texwerk:${project.name.replace(/\s+/g, '_')}@${hostname()}`);
      return json(response, 200, { deployKey: key });
    }

    if (path === '/api/git/test' && method === 'POST') {
      const r = await gitOps.testRemote(project.dir);
      return json(response, r.ok ? 200 : 400, r.ok ? { output: r.output } : { error: r.output });
    }

    if (path === '/api/git/remote' && method === 'POST') {
      const body = await readJson<{ url: string }>(request);
      const remote = String(body.url ?? '').trim();
      if (remote && !/^(https?:\/\/|git@|ssh:\/\/)/.test(remote)) throw new HttpError(400, 'use an https:// or ssh git URL');
      const r = await gitOps.setRemote(project.dir, remote);
      project.broadcastEvent({ t: 'git' });
      return json(response, r.ok ? 200 : 400, r.ok ? { ok: true } : { error: r.output });
    }

    if (path === '/api/git/push' && method === 'POST') {
      const r = await gitOps.push(project.dir);
      project.broadcastEvent({ t: 'git' });
      return json(response, r.ok ? 200 : 400, r.ok ? { output: r.output } : { error: r.output });
    }

    if (path === '/api/git/pull' && method === 'POST') {
      const body = await readJson<{ allowLarge?: boolean }>(request);
      await project.persistAll();
      await project.history.flush(true);
      if (await largeFilesRefusal(body.allowLarge)) return;
      const r = await gitOps.pull(project.dir, identity.name, identity.login);
      await project.reconcileAll(`${who} (git pull)`);
      await project.loadComments();
      project.saveChat();
      project.broadcastEvent({ t: 'git' });
      return json(response, r.ok ? 200 : 400, r.ok ? { output: r.output } : { error: r.output });
    }

    // ---------------------------------------------------- Overleaf link
    // Anyone with the project open sees the link's state; only its owner
    // links, unlinks or gives a new cookie. The cookie never comes back out.

    if (path === '/api/overleaf' && method === 'GET') {
      const link = project.overleaf instanceof OverleafLink ? project.overleaf : null;
      const manage = !access || canManage(identity.login, await readAccess(project.dir, access), access);
      return json(response, 200, { info: link ? link.info() : null, canManage: manage });
    }

    if (path.startsWith('/api/overleaf/') && method === 'POST') {
      await requireRole(identity, projectParam ?? '', 'manage');
      const body = await readJson<{ url?: string; cookie?: string; choices?: Choices }>(request);
      const link = project.overleaf instanceof OverleafLink ? project.overleaf : null;
      const failure = (err: unknown) => {
        if (err instanceof OverleafError) return new HttpError(err.kind === 'session' || err.kind === 'access' ? 400 : 502, err.message);
        return new HttpError(400, (err as Error).message);
      };
      if (path === '/api/overleaf/preview' || path === '/api/overleaf/link') {
        if (link) throw new HttpError(409, 'this project is already linked to Overleaf; unlink it first');
        let target: { origin: string; projectId: string };
        let cookie: string;
        try {
          target = parseProjectUrl(String(body.url ?? ''));
          cookie = cookieHeader(String(body.cookie ?? ''), target.origin);
        } catch (err) { throw failure(err); }
        if (path === '/api/overleaf/preview') {
          try { return json(response, 200, await previewLink(project, target.origin, target.projectId, cookie)); } catch (err) { throw failure(err); }
        }
        const choices: Choices = {};
        for (const [p, side] of Object.entries(body.choices ?? {})) {
          const clean = cleanPath(p);
          if (clean && (side === 'texwerk' || side === 'overleaf')) choices[clean] = side;
        }
        const started = new OverleafLink(project, {
          origin: target.origin, projectId: target.projectId, cookie, linkedBy: identity.login, linkedByName: identity.name,
          rootFolderId: '', docs: {}, files: {}, threads: {},
        }, choices);
        started.saveNow();
        started.start();
        return json(response, 200, { info: started.info() });
      }
      if (!link) throw new HttpError(404, 'this project is not linked to Overleaf');
      if (path === '/api/overleaf/cookie') {
        let cookie: string;
        try { cookie = cookieHeader(String(body.cookie ?? ''), link.state.origin); } catch (err) { throw failure(err); }
        await link.setCookie(cookie);
        return json(response, 200, { info: link.info() });
      }
      if (path === '/api/overleaf/reconnect') {
        link.reconnect();
        return json(response, 200, { info: link.info() });
      }
      if (path === '/api/overleaf/unlink') {
        await link.unlink();
        return json(response, 200, { info: null });
      }
      throw new HttpError(404, 'unknown Overleaf action');
    }

    if (path === '/api/zip' && method === 'GET') {
      await project.persistAll();
      response.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': contentDisposition('attachment', `${project.name}.zip`),
        'cache-control': 'no-store',
      });
      const base = project.name.split('/').pop()!;
      const files = project.allFiles().map((rel) => ({
        name: `${base}/${rel}`,
        load: async () => {
          const t = project.texts.get(rel);
          return t ? Buffer.from(t.toString(), 'utf8') : readFile(await project.realFile(rel));
        },
      }));
      // The sources never contain comments; they come along only on request.
      if (url.searchParams.get('comments') === '1') {
        const threads = sortThreads(allThreads(project.doc));
        files.push(
          { name: `${base}/comments.json`, load: async () => Buffer.from(`${JSON.stringify(threads, null, 2)}\n`) },
          { name: `${base}/comments.md`, load: async () => Buffer.from(commentsMarkdown(base, threads)) },
        );
      }
      await writeZip(response, files);
      response.end();
      return;
    }

    throw new HttpError(404, 'not found');
  }

  const onRequest = (request: IncomingMessage, response: ServerResponse) => {
    handle(request, response).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!response.headersSent) json(response, status, { error: (err as Error).message });
      else response.end();
    });
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  const onUpgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    if (refusal(request, allowHosts)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    let identity: Identity;
    try { identity = await identityOf(request, url); } catch {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (socket.destroyed) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      // A socket outlives the sign-in it was opened with: close it when that
      // runs out, so the page goes through the sign-in again.
      const endsAt = cloudflareSessionEndsAt(request);
      if (endsAt !== null) {
        const expiry = setTimeout(() => ws.close(CLOSE_SIGN_IN_EXPIRED, 'sign-in expired'), Math.max(0, endsAt - Date.now()));
        ws.on('close', () => clearTimeout(expiry));
      }
      const name = url.searchParams.get('project');
      // The client speaks first (sync step 1) the moment the socket opens,
      // possibly before the project has finished loading: queue until ready.
      const early: Uint8Array[] = [];
      let deliver: ((data: Uint8Array) => void) | null = null;
      ws.on('message', (data, isBinary) => {
        if (!isBinary) return;
        const bytes = new Uint8Array(data as Buffer);
        if (deliver) deliver(bytes); else early.push(bytes);
      });
      const bridge = url.searchParams.get('bridge') === '1';
      requireRole(identity, name ?? '', bridge ? 'edit' : 'view').then(async (role) => [await getProject(name), role] as const).then(([project, role]) => {
        if (ws.readyState !== ws.OPEN) return;
        const conn: Conn = { ws, identity, bridge, readOnly: role === 'view', awarenessIds: new Set() };
        deliver = (bytes) => {
          try {
            project.handleMessage(conn, bytes);
          } catch (err) {
            console.error(`[${project.name}] bad message from ${identity.name}:`, err);
          }
        };
        ws.on('close', () => project.removeConn(conn));
        project.addConn(conn);
        for (const bytes of early.splice(0)) deliver(bytes);
      }, (err: unknown) => {
        const status = err instanceof HttpError ? err.status : 500;
        ws.close(status === 404 ? 4404 : status === 403 ? 4403 : 1011, (err as Error).message.slice(0, 120));
      });
    });
  };

  const server = createServer(onRequest);
  server.on('upgrade', (request, socket, head) => void onUpgrade(request, socket, head));
  await new Promise<void>((done) => server.listen(options.port, options.host, done));

  // Projects linked to Overleaf stay open (see Project.overleaf): edits made
  // there reach the files even while nobody has the project open here.
  const openLinked = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const childDir = join(dir, e.name);
      const id = rel ? `${rel}/${e.name}` : e.name;
      if (!cleanProjectId(id)) continue;
      if (isFolderDir(childDir)) await openLinked(childDir, id);
      else if (existsSync(join(childDir, '.texwerk', 'overleaf.json'))) {
        await getProject(id).catch((err: Error) => process.stderr.write(`warning: could not open linked project ${id}: ${err.message}\n`));
      }
    }
  };
  await openLinked(rootDir, '');

  // The Cloudflare door: loopback only, for the tunnel daemon on this
  // machine. Every connection on it is marked so that identity there comes
  // from the Cloudflare Access token alone (identity.ts).
  let cloudflareServer: ReturnType<typeof createServer> | null = null;
  if (options.cloudflare) {
    cloudflareServer = createServer(onRequest);
    cloudflareServer.on('connection', (socket) => admitCloudflareSocket(socket));
    cloudflareServer.on('upgrade', (request, socket, head) => void onUpgrade(request, socket, head));
    await new Promise<void>((done) => cloudflareServer!.listen(options.cloudflare!.port, '127.0.0.1', done));
  }

  const urls: string[] = [];
  const hosts = options.host === '0.0.0.0' || options.host === '::'
    ? Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4').map((i) => i!.address)
    : [options.host];
  for (const h of hosts) urls.push(`http://${h}:${options.port}/`);

  return {
    urls,
    cloudflarePort: cloudflareServer ? options.cloudflare!.port : undefined,
    async close() {
      server.close();
      cloudflareServer?.close();
      for (const ws of wss.clients) ws.terminate();
      await Promise.all([...projects.values()].map(async (p) => (await p.catch(() => null))?.close()));
    },
  };
}

