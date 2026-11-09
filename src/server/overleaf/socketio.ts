import WebSocket from 'ws';

/**
 * Overleaf's realtime channel: a Socket.IO **0.9** client.
 *
 * Overleaf ships socket.io-client 0.9.17, whose wire protocol is not the
 * Engine.IO / Socket.IO v4 one every current library speaks, so this is
 * written by hand. The protocol facts follow Lattice's
 * docs/overleaf-protocol.md (https://github.com/leo1oel/lattice), which
 * records them against Overleaf's own server; none of this is an official
 * API and Overleaf may change it without notice.
 *
 * - Handshake: GET {origin}/socket.io/1/?projectId={id}&t={ms} with the
 *   session Cookie and a matching Origin. The answer is plain text
 *   `{sid}:{heartbeat}:{close}:{transports}`. A redirect to /login or an HTML
 *   body means the session is dead.
 * - Upgrade: {ws origin}/socket.io/1/websocket/{sid}?projectId={id}&t={ms},
 *   same Cookie and Origin.
 * - Frames: `{type}:{id}:{endpoint}:{data}`, type 0 disconnect, 1 connect,
 *   2 heartbeat, 5 event, 6 ack, 7 error, 8 noop. `:{data}` is left out when
 *   there is none, so a heartbeat is `2::`, which must be echoed promptly.
 * - Events: `5:::{"name":…,"args":[…]}`; with an ack id `5:{id}+::{…}`,
 *   answered by `6:::{id}+[…]`.
 * - Silence for longer than the handshake's heartbeat timeout means the
 *   connection is gone (a socket can stay open long after its network).
 */

export const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ACK_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * Why the channel failed, which decides what the link does next:
 * `session` (the cookie is dead: ask the owner for a new one), `access` (this
 * account lost the project: stop), `network` and `protocol` (retry later).
 */
export type FailureKind = 'session' | 'access' | 'network' | 'protocol';

export class OverleafError extends Error {
  readonly kind: FailureKind;

  constructor(kind: FailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export const SESSION_EXPIRED = 'Overleaf no longer accepts this session cookie. Paste a new one.';
export const ACCESS_LOST = 'This Overleaf account can no longer open the project. It may have been removed from it, or the project deleted.';

/** `https://www.overleaf.com/project/<id>` (or a self-hosted instance) → origin and project id. */
export function parseProjectUrl(raw: string): { origin: string; projectId: string } {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('That is not an Overleaf project address.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The address must start with https://');
  const match = /^\/project\/([0-9a-f]{24})(?:\/|$)/i.exec(url.pathname);
  if (!match) throw new Error('The address must look like https://www.overleaf.com/project/<id>.');
  return { origin: url.origin, projectId: match[1].toLowerCase() };
}

/**
 * Accept either the bare cookie value or `name=value`, and return a Cookie
 * header. Overleaf Cloud calls the cookie overleaf_session2; a self-hosted
 * instance sharelatex.sid.
 */
export function cookieHeader(raw: string, origin: string): string {
  const value = raw.trim().replace(/^cookie:\s*/i, '');
  if (!value) throw new Error('Paste the session cookie.');
  if (/^[\w.-]+=/.test(value)) return value;
  const name = /(^|\.)overleaf\.com$/.test(new URL(origin).hostname) ? 'overleaf_session2' : 'sharelatex.sid';
  return `${name}=${value}`;
}

/** Fold Set-Cookie answers into a Cookie header (a load balancer pins the websocket to a backend this way). */
export function mergeCookies(base: string, setCookies: string[]): string {
  const values = new Map<string, string>();
  const handedBack = setCookies.map((h) => h.split(';')[0]);
  for (const pair of [...base.split(';'), ...handedBack].map((p) => p.trim())) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    values.set(pair.slice(0, eq).trim(), pair);
  }
  return [...values.values()].join('; ');
}

/**
 * Overleaf sends document text as `unescape(encodeURIComponent(text))`: the
 * UTF-8 bytes, one per code point. Text that is not packed that way is left
 * alone (some deployments do not pack).
 */
export function decodePacked(text: string): string {
  if (!/[^\x00-\x7f]/.test(text)) return text;
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) return text;
    bytes[i] = code;
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return text; }
}

export function wsOrigin(origin: string): string {
  return origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

interface Frame {
  type: number;
  id: string;
  data: string;
}

function parseFrame(raw: string): Frame | null {
  const a = raw.indexOf(':');
  const b = a < 0 ? -1 : raw.indexOf(':', a + 1);
  if (a < 0 || b < 0) return null;
  const c = raw.indexOf(':', b + 1);
  const type = Number(raw.slice(0, a));
  if (!Number.isInteger(type) || type < 0 || type > 8) return null;
  return { type, id: raw.slice(a + 1, b), data: c < 0 ? '' : raw.slice(c + 1) };
}

/** The first ack argument, when it says the call failed. */
function ackError(first: unknown): string | null {
  if (typeof first === 'string' && first) return first;
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const o = first as Record<string, unknown>;
    if ('rootFolder' in o || 'lines' in o || 'project' in o) return null;
    const message = o.message ?? o.code;
    if (typeof message === 'string') return message;
  }
  return null;
}

function rejection(reason: unknown): OverleafError {
  const text = typeof reason === 'string' ? reason
    : reason && typeof reason === 'object' && typeof (reason as { message?: unknown }).message === 'string' ? (reason as { message: string }).message
      : 'Overleaf refused the realtime connection.';
  const lower = text.toLowerCase();
  if (lower.includes('invalid session') || lower.includes('not logged in')) return new OverleafError('session', SESSION_EXPIRED);
  if (lower.includes('not authorized') || lower.includes('project not found') || lower.includes('restricted')) return new OverleafError('access', ACCESS_LOST);
  return new OverleafError('protocol', `Overleaf refused the realtime connection: ${text}`);
}

export interface JoinedProject {
  /** The `project` object: rootFolder, rootDoc_id, owner, members, … */
  project: Record<string, unknown>;
  permissionsLevel: string;
}

export interface ConnectOptions {
  origin: string;
  cookie: string;
  projectId: string;
  /** Called for every event after the project is joined. */
  onEvent: (name: string, args: unknown[]) => void;
  /** Called once when the channel ends, for whatever reason. */
  onClose: (error: OverleafError) => void;
}

export class OverleafSocket {
  /** Overleaf's name for this connection; it stamps our updates' meta.source with it. */
  publicId = '';
  private readonly ws: WebSocket;
  private readonly options: ConnectOptions;
  private nextAck = 1;
  private readonly pending = new Map<number, { resolve: (args: unknown[]) => void; reject: (err: OverleafError) => void; timer: NodeJS.Timeout }>();
  private lastHeard = Date.now();
  private watchdog: NodeJS.Timeout | null = null;
  private ended = false;
  private joinWaiter: ((value: JoinedProject | OverleafError) => void) | null = null;
  private connectWaiter: ((error: OverleafError | null) => void) | null = null;

  private constructor(ws: WebSocket, options: ConnectOptions, heartbeatSeconds: number) {
    this.ws = ws;
    this.options = options;
    ws.on('message', (data) => {
      this.lastHeard = Date.now();
      this.onFrame(data.toString());
    });
    ws.on('close', () => this.end(new OverleafError('network', 'The Overleaf connection closed.')));
    ws.on('error', (err) => this.end(new OverleafError('network', `The Overleaf connection failed: ${err.message}`)));
    if (heartbeatSeconds > 0) {
      const limit = heartbeatSeconds * 1000 + 5000;
      this.watchdog = setInterval(() => {
        if (Date.now() - this.lastHeard > limit) {
          this.end(new OverleafError('network', `Overleaf sent nothing for ${Math.round(limit / 1000)} s; the connection is presumed lost.`));
        }
      }, 1000);
    }
  }

  /** Handshake, open the websocket and join the project. */
  static async connect(options: ConnectOptions): Promise<{ socket: OverleafSocket; joined: JoinedProject }> {
    const { origin, projectId } = options;
    let cookie = options.cookie;
    const q = `projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`;
    let response: Response;
    try {
      response = await fetch(`${origin}/socket.io/1/?${q}`, {
        headers: { Cookie: cookie, Origin: origin, 'User-Agent': USER_AGENT },
        redirect: 'manual',
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      });
    } catch (err) {
      throw new OverleafError('network', `Could not reach Overleaf (${(err as Error).message}).`);
    }
    const location = response.headers.get('location') ?? '';
    if (response.status === 401 || response.status === 403 || location.includes('/login')) throw new OverleafError('session', SESSION_EXPIRED);
    const body = await response.text();
    if (!response.ok) throw new OverleafError('network', `Overleaf refused the realtime handshake (HTTP ${response.status}).`);
    if (body.trimStart().startsWith('<')) throw new OverleafError('session', SESSION_EXPIRED);
    const fields = body.trim().split(':');
    if (fields.length < 3 || !/^[\w-]{1,128}$/.test(fields[0])) throw new OverleafError('protocol', `Unexpected handshake from Overleaf: ${body.slice(0, 80)}`);
    if (fields[3] && !fields[3].split(',').includes('websocket')) throw new OverleafError('protocol', 'Overleaf does not offer websockets.');
    const heartbeat = Number(fields[1]) || 0;
    cookie = mergeCookies(cookie, response.headers.getSetCookie());

    const ws = new WebSocket(`${wsOrigin(origin)}/socket.io/1/websocket/${encodeURIComponent(fields[0])}?${q}`, {
      headers: { Cookie: cookie, Origin: origin, 'User-Agent': USER_AGENT },
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    });
    const socket = new OverleafSocket(ws, options, heartbeat);
    const connected = new Promise<OverleafError | null>((resolve) => { socket.connectWaiter = resolve; });
    const joined = new Promise<JoinedProject | OverleafError>((resolve) => { socket.joinWaiter = resolve; });
    const timeout = setTimeout(() => socket.end(new OverleafError('network', 'Overleaf did not answer the connection in time.')), CONNECT_TIMEOUT_MS);
    try {
      const failed = await connected;
      if (failed) throw failed;
      // Newer servers join on connect and push joinProjectResponse; older
      // ones answer the joinProject call. Whichever comes first wins.
      socket.call('joinProject', [{ project_id: projectId }]).then((args) => {
        const project = args[0] as Record<string, unknown> | undefined;
        if (project) socket.settleJoin({ project, permissionsLevel: String(args[1] ?? project.permissionsLevel ?? '') });
      }, (err: OverleafError) => socket.settleJoin(err));
      const result = await joined;
      if (result instanceof OverleafError) throw result;
      return { socket, joined: result };
    } catch (err) {
      socket.end(err instanceof OverleafError ? err : new OverleafError('protocol', String(err)));
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private settleJoin(value: JoinedProject | OverleafError): void {
    const waiter = this.joinWaiter;
    this.joinWaiter = null;
    waiter?.(value);
  }

  get open(): boolean {
    return !this.ended;
  }

  /** Emit an event and wait for its ack; resolves with the ack's arguments after a leading null. */
  call(name: string, args: unknown[], timeoutMs = ACK_TIMEOUT_MS): Promise<unknown[]> {
    if (this.ended) return Promise.reject(new OverleafError('network', 'The Overleaf connection is closed.'));
    const id = this.nextAck++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OverleafError('network', `Overleaf did not answer ${name} in time.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (ackArgs) => {
          const failed = ackError(ackArgs[0]);
          if (failed) reject(new OverleafError('protocol', `Overleaf refused ${name}: ${failed}`));
          else resolve(ackArgs[0] === null || ackArgs[0] === undefined ? ackArgs.slice(1) : ackArgs);
        },
        reject,
        timer,
      });
      this.send(`5:${id}+::${JSON.stringify({ name, args })}`);
    });
  }

  /** Emit an event that wants no answer. */
  emit(name: string, args: unknown[]): void {
    this.send(`5:::${JSON.stringify({ name, args })}`);
  }

  close(): void {
    this.end(new OverleafError('network', 'Closed by TeXWerk.'));
  }

  private send(frame: string): void {
    if (!this.ended && this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  private end(error: OverleafError): void {
    if (this.ended) return;
    this.ended = true;
    if (this.watchdog) clearInterval(this.watchdog);
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new OverleafError('network', 'The Overleaf connection closed before it answered.')); }
    this.pending.clear();
    const connect = this.connectWaiter;
    this.connectWaiter = null;
    connect?.(error);
    this.settleJoin(error);
    try { this.ws.terminate(); } catch { /* already gone */ }
    this.options.onClose(error);
  }

  private onFrame(raw: string): void {
    const frame = parseFrame(raw);
    if (!frame) return;
    switch (frame.type) {
      case 0: this.end(new OverleafError('network', 'Overleaf closed the connection.')); break;
      case 1: { const w = this.connectWaiter; this.connectWaiter = null; w?.(null); break; }
      case 2: this.send('2::'); break;
      case 5: this.onEvent(frame.data); break;
      case 6: {
        const plus = frame.data.indexOf('+');
        const id = Number(plus < 0 ? frame.data : frame.data.slice(0, plus));
        const p = this.pending.get(id);
        if (!p) break;
        this.pending.delete(id);
        clearTimeout(p.timer);
        let args: unknown[] = [];
        try {
          const parsed = plus < 0 || !frame.data.slice(plus + 1).trim() ? [] : JSON.parse(frame.data.slice(plus + 1));
          args = Array.isArray(parsed) ? parsed : [parsed];
        } catch { /* an unreadable ack is an empty one */ }
        p.resolve(args);
        break;
      }
      case 7: this.end(new OverleafError('protocol', `Overleaf's realtime server reported an error: ${frame.data}`)); break;
      default: break;
    }
  }

  private onEvent(data: string): void {
    let name: string;
    let args: unknown[];
    try {
      const parsed = JSON.parse(data) as { name?: unknown; args?: unknown };
      if (typeof parsed.name !== 'string') return;
      name = parsed.name;
      args = Array.isArray(parsed.args) ? parsed.args : [];
    } catch { return; }
    switch (name) {
      case 'connectionAccepted': {
        const id = args.find((a) => typeof a === 'string');
        if (typeof id === 'string') this.publicId = id;
        return;
      }
      case 'connectionRejected': this.end(rejection(args[0])); return;
      case 'joinProjectResponse': {
        const body = (args[0] ?? {}) as Record<string, unknown>;
        if (typeof body.publicId === 'string' && !this.publicId) this.publicId = body.publicId;
        const project = body.project as Record<string, unknown> | undefined;
        if (project) this.settleJoin({ project, permissionsLevel: String(body.permissionsLevel ?? '') });
        return;
      }
      case 'disconnect':
      case 'forceDisconnect': this.end(new OverleafError('network', `Overleaf ended the session${typeof args[0] === 'string' ? `: ${args[0]}` : ''}.`)); return;
      default: this.options.onEvent(name, args);
    }
  }
}
