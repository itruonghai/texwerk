/**
 * A small Overleaf for the link's tests: the session/CSRF pages, the
 * Socket.IO 0.9 realtime channel with ShareJS-style OT (versions, transform
 * of late updates, own-update echoes as `{doc, v}`), packed UTF-8 lines,
 * comment ranges and threads, uploads and the file tree, with the events
 * Overleaf broadcasts for each. It also plays Overleaf users ("Alice typing
 * in the browser") through the same paths a real update takes.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { applyOps, transformBoth, transformSpan, type OtOp } from '../../src/server/overleaf/ot.ts';

export interface MockUser {
  _id: string;
  first_name: string;
  last_name: string;
  email: string;
}

type Kind = 'doc' | 'file' | 'folder';

interface Node {
  id: string;
  kind: Kind;
  name: string;
  parent: string | null;
  text?: string;
  version?: number;
  history?: Array<{ v: number; op: AnyOp[]; meta: Record<string, unknown> }>;
  comments?: Array<{ id: string; op: { p: number; c: string; t: string } }>;
  data?: Buffer;
  hash?: string;
}

type AnyOp = OtOp | { p: number; c: string; t: string };

interface Client {
  ws: WebSocket;
  userId: string;
  publicId: string;
}

interface Thread {
  messages: Array<{ id: string; content: string; timestamp: number; user_id: string; user: MockUser }>;
  resolved: boolean;
}

const objectId = () => randomBytes(12).toString('hex');
const pack = (s: string) => unescape(encodeURIComponent(s));
const isText = (name: string) => /\.(tex|bib|txt|sty|cls|md|bst|bbl|tikz)$/i.test(name);
const sha1 = (data: Buffer) => createHash('sha1').update(data).digest('hex');
export const docHash = (text: string) => createHash('sha1').update(`blob ${text.length}\0`).update(text, 'utf8').digest('hex');

function parseMultipart(body: Buffer, contentType: string): Map<string, { data: Buffer; filename?: string }> {
  const out = new Map<string, { data: Buffer; filename?: string }>();
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  if (!boundary) return out;
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let at = body.indexOf(marker);
  while (at >= 0) {
    const start = at + marker.length;
    if (body.slice(start, start + 2).toString() === '--') break;
    const headerEnd = body.indexOf('\r\n\r\n', start);
    const next = body.indexOf(marker, headerEnd);
    if (headerEnd < 0 || next < 0) break;
    const headers = body.slice(start, headerEnd).toString();
    const name = /name="([^"]*)"/.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/.exec(headers)?.[1];
    if (name) out.set(name, { data: body.slice(headerEnd + 4, next - 2), filename });
    at = next;
  }
  return out;
}

export class MockOverleaf {
  readonly projectId = objectId();
  readonly users = new Map<string, MockUser>();
  /** cookie value → user id */
  readonly sessions = new Map<string, string>();
  readonly csrf = randomBytes(8).toString('hex');
  readonly nodes = new Map<string, Node>();
  readonly root: string;
  readonly threads = new Map<string, Thread>();
  readonly clients = new Set<Client>();
  /** Delay before an applyOtUpdate is processed, to open concurrency windows. */
  latencyMs = 0;
  /** Push joinProjectResponse on connect (newer servers) instead of only answering joinProject. */
  pushJoin = true;
  /** The next update from a client is applied, then its connection drops before it hears so. */
  dropAfterApply = false;
  /** The access level joinProject reports. */
  permissionsLevel = 'owner';
  /** Count of requests per route, for assertions. */
  readonly hits = new Map<string, number>();
  origin = '';
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly handshakes = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  constructor() {
    this.root = objectId();
    this.nodes.set(this.root, { id: this.root, kind: 'folder', name: 'rootFolder', parent: null });
  }

  addUser(cookie: string, first: string): MockUser {
    const user = { _id: objectId(), first_name: first, last_name: 'Test', email: `${first.toLowerCase()}@example.com` };
    this.users.set(user._id, user);
    this.sessions.set(cookie, user._id);
    return user;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => { void this.http(req, res); });
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      const m = /^\/socket\.io\/1\/websocket\/([^?]+)/.exec(req.url ?? '');
      const userId = m ? this.handshakes.get(m[1]) : undefined;
      if (!userId) { socket.destroy(); return; }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, userId));
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.origin = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this.origin;
  }

  async close(): Promise<void> {
    for (const c of this.clients) c.ws.terminate();
    this.wss?.close();
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  get url(): string {
    return `${this.origin}/project/${this.projectId}`;
  }

  // ------------------------------------------------------------ the tree

  path(id: string): string {
    const parts: string[] = [];
    for (let n = this.nodes.get(id); n && n.parent !== null; n = this.nodes.get(n.parent)) parts.unshift(n.name);
    return parts.join('/');
  }

  find(path: string): Node | undefined {
    for (const n of this.nodes.values()) if (n.parent !== null && this.path(n.id) === path) return n;
    return undefined;
  }

  folder(path: string, broadcast = true): string {
    if (!path) return this.root;
    const hit = this.find(path);
    if (hit) return hit.id;
    const parent = this.folder(path.split('/').slice(0, -1).join('/'), broadcast);
    const id = objectId();
    const name = path.split('/').pop()!;
    this.nodes.set(id, { id, kind: 'folder', name, parent });
    if (broadcast) this.broadcast('reciveNewFolder', [parent, { _id: id, name, docs: [], fileRefs: [], folders: [] }]);
    return id;
  }

  /** Files as path → content (text for docs, base64 for files). */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const n of this.nodes.values()) {
      if (n.kind === 'doc') out[this.path(n.id)] = n.text!;
      if (n.kind === 'file') out[this.path(n.id)] = `base64:${n.data!.toString('base64')}`;
    }
    return out;
  }

  text(path: string): string | undefined {
    const n = this.find(path);
    return n?.kind === 'doc' ? n.text : undefined;
  }

  private projectJson(): Record<string, unknown> {
    const folder = (id: string): Record<string, unknown> => {
      const kids = [...this.nodes.values()].filter((n) => n.parent === id);
      return {
        _id: id, name: this.nodes.get(id)!.name,
        docs: kids.filter((n) => n.kind === 'doc').map((n) => ({ _id: n.id, name: n.name })),
        fileRefs: kids.filter((n) => n.kind === 'file').map((n) => ({ _id: n.id, name: n.name, hash: n.hash })),
        folders: kids.filter((n) => n.kind === 'folder').map((n) => folder(n.id)),
      };
    };
    const [owner, ...members] = [...this.users.values()];
    return { _id: this.projectId, name: 'Paper', rootFolder: [folder(this.root)], owner, members };
  }

  // ------------------------------------------------- what Overleaf users do

  addDoc(path: string, text: string, broadcast = true): string {
    const parent = this.folder(path.split('/').slice(0, -1).join('/'), broadcast);
    const id = objectId();
    const name = path.split('/').pop()!;
    this.nodes.set(id, { id, kind: 'doc', name, parent, text, version: 0, history: [], comments: [] });
    if (broadcast) this.broadcast('reciveNewDoc', [parent, { _id: id, name }]);
    return id;
  }

  addFile(path: string, data: Buffer, broadcast = true): string {
    const parent = this.folder(path.split('/').slice(0, -1).join('/'), broadcast);
    const id = objectId();
    const name = path.split('/').pop()!;
    this.nodes.set(id, { id, kind: 'file', name, parent, data, hash: sha1(data) });
    if (broadcast) this.broadcast('reciveNewFile', [parent, { _id: id, name, hash: sha1(data) }]);
    return id;
  }

  rename(path: string, name: string): void {
    const n = this.find(path)!;
    n.name = name;
    this.broadcast('reciveEntityRename', [n.id, name]);
  }

  move(path: string, folderPath: string): void {
    const n = this.find(path)!;
    n.parent = this.folder(folderPath);
    this.broadcast('reciveEntityMove', [n.id, n.parent]);
  }

  remove(path: string): void {
    const n = this.find(path)!;
    this.removeNode(n.id);
    this.broadcast('removeEntity', [n.id]);
  }

  private removeNode(id: string): void {
    for (const n of [...this.nodes.values()]) if (n.parent === id) this.removeNode(n.id);
    this.nodes.delete(id);
  }

  /** An Overleaf user's edit, as their browser would send it at the current version. */
  edit(userId: string, path: string, ops: AnyOp[]): void {
    const n = this.find(path)!;
    this.apply(n, ops, n.version!, { source: `browser-${userId}`, user_id: userId }, null);
  }

  /** Replace the whole text the way an Overleaf user would by select-all and paste. */
  setText(userId: string, path: string, text: string): void {
    const n = this.find(path)!;
    const ops: AnyOp[] = [];
    if (n.text) ops.push({ p: 0, d: n.text });
    if (text) ops.push({ p: 0, i: text });
    this.edit(userId, path, ops);
  }

  comment(userId: string, path: string, from: number, to: number, content: string): string {
    const n = this.find(path)!;
    const t = objectId();
    this.message(userId, t, content);
    this.edit(userId, path, [{ p: from, c: n.text!.slice(from, to), t }]);
    return t;
  }

  message(userId: string, threadId: string, content: string): void {
    const thread = this.threads.get(threadId) ?? { messages: [], resolved: false };
    this.threads.set(threadId, thread);
    const m = { id: objectId(), content, timestamp: Date.now(), user_id: userId, user: this.users.get(userId)! };
    thread.messages.push(m);
    this.broadcast('new-comment', [threadId, m]);
  }

  editMessage(threadId: string, messageId: string, content: string): void {
    this.threads.get(threadId)!.messages.find((m) => m.id === messageId)!.content = content;
    this.broadcast('edit-message', [threadId, messageId, content]);
  }

  deleteMessage(threadId: string, messageId: string): void {
    const thread = this.threads.get(threadId)!;
    thread.messages = thread.messages.filter((m) => m.id !== messageId);
    this.broadcast('delete-message', [threadId, messageId]);
  }

  resolve(threadId: string, resolved: boolean): void {
    this.threads.get(threadId)!.resolved = resolved;
    this.broadcast(resolved ? 'resolve-thread' : 'reopen-thread', [threadId]);
  }

  deleteThread(threadId: string): void {
    this.threads.delete(threadId);
    for (const n of this.nodes.values()) if (n.comments) n.comments = n.comments.filter((c) => c.op.t !== threadId);
    this.broadcast('delete-thread', [threadId]);
  }

  /** Every comment range, by thread: where it is and what it quotes. */
  ranges(): Map<string, { path: string; p: number; c: string }> {
    const out = new Map<string, { path: string; p: number; c: string }>();
    for (const n of this.nodes.values()) for (const c of n.comments ?? []) out.set(c.op.t, { path: this.path(n.id), p: c.op.p, c: c.op.c });
    return out;
  }

  /** Cut every realtime connection, as a network blip or a deploy would. */
  dropAll(): void {
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
  }

  expire(cookie: string): void {
    this.sessions.delete(cookie);
    this.dropAll();
  }

  // --------------------------------------------------------------- OT

  private apply(n: Node, incoming: AnyOp[], v: number, meta: Record<string, unknown>, sender: Client | null, hash?: string, echo = true): string | null {
    if (v > n.version!) return 'Delete component does not match / version from the future';
    let op = incoming.map((c) => ('i' in c && typeof c.i === 'string' ? { ...c, i: c.i.replace(/[\uD800-\uDFFF]/g, '�') } : c));
    for (const h of n.history!.filter((x) => x.v >= v)) {
      const theirText = h.op.filter((c): c is OtOp => !('t' in c));
      const ourText = op.filter((c): c is OtOp => !('t' in c));
      const [, transformed] = transformBoth(theirText, ourText);
      const comments = op.filter((c): c is { p: number; c: string; t: string } => 't' in c)
        .map((c) => ({ ...c, p: transformSpan({ from: c.p, length: 0 }, theirText).from }));
      op = [...transformed, ...comments];
    }
    const textOps = op.filter((c): c is OtOp => !('t' in c));
    const next = applyOps(n.text!, textOps);
    if (next === null) return 'Delete component does not match';
    // Overleaf checks the hash only for an update applied at its own version: a
    // transformed one cannot match the text its sender hashed.
    if (hash && v === n.version && docHash(next) !== hash) return 'Invalid hash';
    n.text = next;
    for (const c of n.comments!) {
      const span = transformSpan({ from: c.op.p, length: c.op.c.length }, textOps);
      c.op = { ...c.op, p: span.from, c: next.slice(span.from, span.from + span.length) };
    }
    for (const c of op) if ('t' in c) n.comments!.push({ id: c.t, op: { ...c } });
    const appliedAt = n.version!;
    n.version = appliedAt + 1;
    const fullMeta = { ...meta, ts: Date.now() };
    n.history!.push({ v: appliedAt, op, meta: fullMeta });
    for (const c of this.clients) {
      if (c === sender) { if (echo) this.emit(c, 'otUpdateApplied', [{ doc: n.id, v: appliedAt }]); }
      else this.emit(c, 'otUpdateApplied', [{ doc: n.id, op, v: appliedAt, meta: fullMeta }]);
    }
    return null;
  }

  // ------------------------------------------------------------ sockets

  private send(c: Client, frame: string): void {
    if (c.ws.readyState === 1) c.ws.send(frame);
  }

  private emit(c: Client, name: string, args: unknown[]): void {
    this.send(c, `5:::${JSON.stringify({ name, args })}`);
  }

  broadcast(name: string, args: unknown[]): void {
    for (const c of this.clients) this.emit(c, name, args);
  }

  private onSocket(ws: WebSocket, userId: string): void {
    const client: Client = { ws, userId, publicId: `P.${randomBytes(6).toString('hex')}` };
    this.clients.add(client);
    // The handshake promises a heartbeat every 2 s; the client must hear one.
    const beat = setInterval(() => this.send(client, '2::'), 1000);
    ws.on('close', () => { clearInterval(beat); this.clients.delete(client); });
    ws.on('message', (raw) => this.onFrame(client, raw.toString()));
    this.send(client, '1::');
    this.emit(client, 'connectionAccepted', [null, client.publicId]);
    if (this.pushJoin) {
      this.emit(client, 'joinProjectResponse', [{ publicId: client.publicId, project: this.projectJson(), permissionsLevel: this.permissionsLevel, protocolVersion: 2 }]);
    }
  }

  private onFrame(c: Client, raw: string): void {
    const m = /^5:(\d+)\+::(.*)$/s.exec(raw) ?? /^5:::(.*)$/s.exec(raw);
    if (!m) return;
    const ackId = m.length === 3 ? m[1] : null;
    const { name, args } = JSON.parse(m.length === 3 ? m[2] : m[1]) as { name: string; args: unknown[] };
    const ack = (...answer: unknown[]) => { if (ackId) this.send(c, `6:::${ackId}+${JSON.stringify(answer)}`); };
    this.hits.set(`ws:${name}`, (this.hits.get(`ws:${name}`) ?? 0) + 1);
    if (name === 'joinProject') { ack(null, this.projectJson(), this.permissionsLevel, 2); return; }
    if (name === 'joinDoc') {
      const n = this.nodes.get(String(args[0]));
      if (!n || n.kind !== 'doc') { ack('document not found'); return; }
      const from = Number(args[1]);
      const updates = from >= 0 && from <= n.version! ? n.history!.filter((h) => h.v >= from).map((h) => ({ doc: n.id, op: h.op, v: h.v, meta: h.meta })) : [];
      ack(null, n.text!.split('\n').map(pack), n.version, updates, { comments: n.comments!.map((x) => ({ id: x.id, op: { ...x.op, c: pack(x.op.c) } })), changes: [] });
      return;
    }
    if (name === 'leaveDoc') { ack(null); return; }
    if (name === 'applyOtUpdate') {
      const update = args[1] as { op: AnyOp[]; v: number; hash?: string; dupIfSource?: string[] };
      this.queue = this.queue.then(async () => {
        if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
        const n = this.nodes.get(String(args[0]));
        if (!n || n.kind !== 'doc' || !this.clients.has(c)) return;
        if (!Array.isArray(update.op) || update.op.length === 0) { c.ws.terminate(); return; }
        const dup = update.dupIfSource?.length && n.history!.some((h) => h.v >= update.v && update.dupIfSource!.includes(String(h.meta.source)));
        if (dup) { ack(null); return; }
        const drop = this.dropAfterApply;
        if (drop) this.dropAfterApply = false;
        const error = this.apply(n, update.op, update.v, { source: c.publicId, user_id: c.userId }, c, update.hash, !drop);
        if (drop && !error) { c.ws.terminate(); this.clients.delete(c); return; }
        if (error) {
          this.hits.set('otUpdateError', (this.hits.get('otUpdateError') ?? 0) + 1);
          this.emit(c, 'otUpdateError', [error, { doc: n.id }]);
          c.ws.terminate();
          return;
        }
        ack(null);
      });
      return;
    }
    ack(null);
  }

  // --------------------------------------------------------------- HTTP

  private userOf(req: IncomingMessage): string | null {
    const cookie = req.headers.cookie ?? '';
    for (const part of cookie.split(';')) {
      const [k, v] = part.trim().split('=');
      if ((k === 'overleaf_session2' || k === 'sharelatex.sid') && this.sessions.has(v)) return this.sessions.get(v)!;
    }
    return null;
  }

  private async http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const user = this.userOf(req);
    const route = `${req.method} ${url.pathname.replace(/[0-9a-f]{24}/g, ':id')}`;
    this.hits.set(route, (this.hits.get(route) ?? 0) + 1);
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (!user) { res.writeHead(302, { Location: '/login' }); res.end(); return; }
    if (url.pathname === '/socket.io/1/') {
      const sid = randomBytes(10).toString('hex');
      this.handshakes.set(sid, user);
      res.writeHead(200, { 'Set-Cookie': 'GCLB=backend-1; Path=/' });
      res.end(`${sid}:2:60:websocket,xhr-polling`);
      return;
    }
    if (url.pathname === '/project') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><meta name="ol-csrfToken" content="${this.csrf}"><meta name="ol-user_id" content="${user}"></head></html>`);
      return;
    }
    const prefix = `/project/${this.projectId}`;
    if (!url.pathname.startsWith(prefix)) { json(404, {}); return; }
    const path = url.pathname.slice(prefix.length);
    if (req.method !== 'GET' && req.headers['x-csrf-token'] !== this.csrf) { json(403, { message: 'invalid csrf' }); return; }
    const data = () => (body.length && String(req.headers['content-type']).includes('json') ? JSON.parse(body.toString()) : {});
    let m: RegExpExecArray | null;
    if (path === '/threads' && req.method === 'GET') {
      json(200, Object.fromEntries(this.threads));
      return;
    }
    if (path === '/ranges' && req.method === 'GET') {
      json(200, [...this.nodes.values()].filter((n) => n.kind === 'doc')
        .map((n) => ({ id: n.id, ranges: { comments: n.comments!.map((x) => ({ id: x.id, op: { ...x.op, c: pack(x.op.c) } })) } })));
      return;
    }
    if ((m = /^\/thread\/(\w+)\/messages\/(\w+)\/edit$/.exec(path)) && req.method === 'POST') {
      this.editMessage(m[1], m[2], data().content);
      res.writeHead(204); res.end();
      return;
    }
    if ((m = /^\/thread\/(\w+)\/(?:own-)?messages\/(\w+)$/.exec(path)) && req.method === 'DELETE') {
      this.deleteMessage(m[1], m[2]);
      res.writeHead(204); res.end();
      return;
    }
    if ((m = /^\/thread\/(\w+)\/messages$/.exec(path)) && req.method === 'POST') {
      this.message(user, m[1], data().content);
      res.writeHead(204); res.end();
      return;
    }
    if ((m = /^\/doc\/(\w+)\/thread\/(\w+)\/(resolve|reopen)$/.exec(path))) {
      if (!this.threads.has(m[2])) { json(404, {}); return; }
      this.resolve(m[2], m[3] === 'resolve');
      res.writeHead(204); res.end();
      return;
    }
    if ((m = /^\/doc\/(\w+)\/thread\/(\w+)$/.exec(path)) && req.method === 'DELETE') {
      this.deleteThread(m[2]);
      res.writeHead(204); res.end();
      return;
    }
    if (path === '/upload' && req.method === 'POST') {
      const parts = parseMultipart(body, String(req.headers['content-type']));
      const rel = parts.get('relativePath')?.data.toString() || parts.get('name')!.data.toString();
      const fileData = parts.get('qqfile')!.data;
      const existing = this.find(rel);
      if (existing?.kind === 'doc' && isText(rel)) {
        this.setText(user, rel, fileData.toString('utf8'));
        json(200, { success: true, entity_id: existing.id, entity_type: 'doc' });
        return;
      }
      if (existing) { this.removeNode(existing.id); this.broadcast('removeEntity', [existing.id]); }
      const id = isText(rel) ? this.addDoc(rel, fileData.toString('utf8')) : this.addFile(rel, fileData);
      json(200, { success: true, entity_id: id, entity_type: isText(rel) ? 'doc' : 'file' });
      return;
    }
    if (path === '/folder' && req.method === 'POST') {
      const { name, parent_folder_id: parent } = data();
      const id = objectId();
      this.nodes.set(id, { id, kind: 'folder', name, parent });
      this.broadcast('reciveNewFolder', [parent, { _id: id, name, docs: [], fileRefs: [], folders: [] }]);
      json(200, { _id: id, name });
      return;
    }
    if ((m = /^\/(doc|file|folder)\/(\w+)\/rename$/.exec(path))) {
      const n = this.nodes.get(m[2])!;
      n.name = data().name;
      this.broadcast('reciveEntityRename', [n.id, n.name]);
      res.writeHead(204); res.end();
      return;
    }
    if ((m = /^\/(doc|file|folder)\/(\w+)\/move$/.exec(path))) {
      const n = this.nodes.get(m[2])!;
      n.parent = data().folder_id;
      this.broadcast('reciveEntityMove', [n.id, n.parent]);
      res.writeHead(204); res.end();
      return;
    }
    if ((m = /^\/(doc|file|folder)\/(\w+)$/.exec(path)) && req.method === 'DELETE') {
      this.removeNode(m[2]);
      this.broadcast('removeEntity', [m[2]]);
      res.writeHead(204); res.end();
      return;
    }
    if ((m = /^\/file\/(\w+)$/.exec(path))) {
      const n = this.nodes.get(m[1]);
      if (!n?.data) { json(404, {}); return; }
      res.writeHead(200); res.end(n.data);
      return;
    }
    if ((m = /^\/blob\/(\w+)$/.exec(path))) {
      const n = [...this.nodes.values()].find((x) => x.hash === m![1]);
      if (!n?.data) { json(404, {}); return; }
      res.writeHead(200); res.end(n.data);
      return;
    }
    json(404, { path });
  }
}
