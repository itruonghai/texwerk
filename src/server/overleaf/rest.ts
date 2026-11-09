import { OverleafError, SESSION_EXPIRED, USER_AGENT } from './socketio.ts';

/**
 * Overleaf's HTTP endpoints the link uses: comment threads, and changes to
 * the file tree. These are the routes Overleaf's own web page calls, not a
 * public API (see socketio.ts). Mutations carry the CSRF token from the
 * signed-in project list page, which also names the account (ol-user_id).
 */

export type EntityKind = 'doc' | 'file' | 'folder';

export interface OverleafMessage {
  id: string;
  content: string;
  timestamp: number;
  userId: string;
  userName: string;
}

export interface OverleafThread {
  messages: OverleafMessage[];
  resolved: boolean;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** The decoded `content` of `<meta name="…" content="…">`. */
export function metaContent(html: string, name: string): string | null {
  const tag = new RegExp(`<meta[^>]*name="${name}"[^>]*>`).exec(html);
  if (!tag) return null;
  const content = /content="([^"]*)"/.exec(tag[0]);
  if (!content) return null;
  return content[1].replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function personName(user: unknown): string {
  if (!user || typeof user !== 'object') return '';
  const u = user as Record<string, unknown>;
  const full = [u.first_name, u.last_name].filter((p) => typeof p === 'string' && p).join(' ');
  if (full) return full;
  if (typeof u.email === 'string') return u.email.split('@')[0];
  return '';
}

export function parseThreads(body: unknown): Map<string, OverleafThread> {
  const out = new Map<string, OverleafThread>();
  if (!body || typeof body !== 'object') return out;
  for (const [id, raw] of Object.entries(body as Record<string, unknown>)) {
    const t = (raw ?? {}) as Record<string, unknown>;
    const messages: OverleafMessage[] = [];
    for (const m of Array.isArray(t.messages) ? t.messages : []) {
      const msg = m as Record<string, unknown>;
      const mid = typeof msg.id === 'string' ? msg.id : typeof msg._id === 'string' ? msg._id : null;
      if (!mid) continue;
      const user = msg.user as Record<string, unknown> | undefined;
      messages.push({
        id: mid,
        content: typeof msg.content === 'string' ? msg.content : '',
        timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.parse(String(msg.timestamp ?? '')) || 0,
        userId: typeof msg.user_id === 'string' ? msg.user_id : typeof user?.id === 'string' ? user.id : typeof user?._id === 'string' ? user._id : '',
        userName: personName(user) || 'Someone',
      });
    }
    out.set(id, { messages, resolved: Boolean(t.resolved) });
  }
  return out;
}

export class OverleafRest {
  readonly origin: string;
  readonly projectId: string;
  cookie: string;
  /** The signed-in account, from the project list page. */
  userId: string | null = null;
  private csrf: string | null = null;

  constructor(origin: string, projectId: string, cookie: string) {
    this.origin = origin;
    this.projectId = projectId;
    this.cookie = cookie;
  }

  /** Read the CSRF token and the account id; fails with `session` when signed out. */
  async signIn(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.origin}/project`, {
        headers: { Cookie: this.cookie, Accept: 'text/html', 'User-Agent': USER_AGENT },
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new OverleafError('network', `Could not reach Overleaf (${(err as Error).message}).`);
    }
    if (response.status >= 300 && response.status < 400) throw new OverleafError('session', SESSION_EXPIRED);
    if (response.status === 401 || response.status === 403) throw new OverleafError('session', SESSION_EXPIRED);
    if (!response.ok) throw new OverleafError('network', `Overleaf answered HTTP ${response.status} for the project list.`);
    const html = await response.text();
    const csrf = metaContent(html, 'ol-csrfToken');
    if (!csrf) throw new OverleafError('session', SESSION_EXPIRED);
    this.csrf = csrf;
    this.userId = metaContent(html, 'ol-user_id');
  }

  /** `{origin}/project/{id}{path}`. Mutations carry the CSRF token; a refused token is fetched again once. */
  private async request(method: string, path: string, body?: unknown, raw = false): Promise<Response> {
    const mutation = method !== 'GET';
    for (let attempt = 0; attempt < 2; attempt++) {
      if (mutation && !this.csrf) await this.signIn();
      const headers: Record<string, string> = { Cookie: this.cookie, Accept: 'application/json', 'User-Agent': USER_AGENT };
      if (mutation) headers['X-Csrf-Token'] = this.csrf!;
      let payload: BodyInit | undefined;
      if (body instanceof FormData) payload = body;
      else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
      else if (mutation) headers['Content-Length'] = '0';
      let response: Response;
      try {
        response = await fetch(`${this.origin}/project/${this.projectId}${path}`, {
          method, headers, body: payload, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        throw new OverleafError('network', `Could not reach Overleaf (${(err as Error).message}).`);
      }
      const location = response.headers.get('location') ?? '';
      if (response.status >= 300 && response.status < 400 && location.includes('/login')) throw new OverleafError('session', SESSION_EXPIRED);
      if (response.status === 403 && mutation && attempt === 0) { this.csrf = null; continue; }
      if (response.status === 401) throw new OverleafError('session', SESSION_EXPIRED);
      if (response.status === 403) throw new OverleafError('access', 'Overleaf refused the request (403).');
      if (!response.ok) {
        const text = raw ? '' : (await response.text()).slice(0, 200);
        throw new OverleafError('protocol', `Overleaf answered HTTP ${response.status} to ${method} ${path}${text ? `: ${text}` : ''}`);
      }
      return response;
    }
    throw new OverleafError('session', SESSION_EXPIRED);
  }

  private async json(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.request(method, path, body);
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  // ------------------------------------------------------------- comments

  async threads(): Promise<Map<string, OverleafThread>> {
    return parseThreads(await this.json('GET', '/threads'));
  }

  async postMessage(threadId: string, content: string): Promise<void> {
    await this.request('POST', `/thread/${threadId}/messages`, { content });
  }

  async setResolved(docId: string, threadId: string, resolved: boolean): Promise<void> {
    await this.request('POST', `/doc/${docId}/thread/${threadId}/${resolved ? 'resolve' : 'reopen'}`);
  }

  async deleteThread(docId: string, threadId: string): Promise<void> {
    await this.request('DELETE', `/doc/${docId}/thread/${threadId}`);
  }

  // ------------------------------------------------------------ file tree

  /**
   * Upload a file at `relPath` (folders on the way are made). Overleaf decides
   * from the name whether it becomes a doc (text, edited live) or a file. An
   * upload onto an existing name replaces it.
   */
  async upload(relPath: string, data: Uint8Array, rootFolderId: string): Promise<{ id: string; kind: EntityKind }> {
    const name = relPath.split('/').pop()!;
    const form = new FormData();
    form.set('name', name);
    form.set('relativePath', relPath);
    form.set('qqfile', new Blob([new Uint8Array(data)]), name);
    const response = await this.request('POST', `/upload?folder_id=${encodeURIComponent(rootFolderId)}`, form);
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || body.success !== true || typeof body.entity_id !== 'string') {
      throw new OverleafError('protocol', `Overleaf did not take the upload of ${relPath}${body && typeof body.error === 'string' ? `: ${body.error}` : ''}.`);
    }
    return { id: body.entity_id, kind: body.entity_type === 'doc' ? 'doc' : 'file' };
  }

  async addFolder(name: string, parentId: string): Promise<string> {
    const body = await this.json('POST', '/folder', { name, parent_folder_id: parentId }) as Record<string, unknown> | null;
    if (!body || typeof body._id !== 'string') throw new OverleafError('protocol', `Overleaf did not make the folder ${name}.`);
    return body._id;
  }

  async rename(kind: EntityKind, id: string, name: string): Promise<void> {
    await this.request('POST', `/${kind}/${id}/rename`, { name });
  }

  async move(kind: EntityKind, id: string, folderId: string): Promise<void> {
    await this.request('POST', `/${kind}/${id}/move`, { folder_id: folderId });
  }

  async remove(kind: EntityKind, id: string): Promise<void> {
    await this.request('DELETE', `/${kind}/${id}`);
  }

  /** A binary file's bytes: by content hash where Overleaf gave one, else by id. */
  async download(fileId: string, hash?: string): Promise<Buffer> {
    if (hash) {
      try {
        return Buffer.from(await (await this.request('GET', `/blob/${hash}`, undefined, true)).arrayBuffer());
      } catch (err) {
        if (err instanceof OverleafError && err.kind === 'session') throw err;
      }
    }
    return Buffer.from(await (await this.request('GET', `/file/${fileId}`, undefined, true)).arrayBuffer());
  }
}
