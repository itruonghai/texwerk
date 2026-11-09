import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';
import { allThreads, type CommentMessage } from '../../shared/comments.ts';
import { cleanPath } from '../../shared/files.ts';
import type { OverleafInfo } from '../../shared/protocol.ts';
import { setYText } from '../../shared/textDiff.ts';
import { hashBytes } from '../history.ts';
import type { Project } from '../project.ts';
import { merge3 } from './merge3.ts';
import { applyOps, OtDesyncError, OtDocument, type OtOp } from './ot.ts';
import { type EntityKind, OverleafRest, type OverleafThread } from './rest.ts';
import { decodePacked, OverleafError, OverleafSocket, type JoinedProject } from './socketio.ts';

/**
 * The live link between one TeXWerk project and one Overleaf project.
 *
 * The link is one more client of the project's Y.Doc, running in the server.
 * Towards Overleaf it behaves like Overleaf's own editor: it joins every
 * document, sends local edits as OT operations (one update in flight per
 * document, ShareJS-style; see ot.ts) and applies everyone else's. Y.Text and
 * Overleaf both count positions in UTF-16 units, so an operation applies to
 * the Y.Text as it is.
 *
 * The rule that keeps the two copies equal: before an update from Overleaf
 * is applied, local edits are flushed into the OT client (`flushLocal`), so
 * the OT client's text is exactly the Y.Text's. Node runs one thing at a time,
 * so nothing can be typed between that flush and the apply.
 *
 * Files and folders follow Overleaf's entity ids, so a rename stays a rename
 * on both sides. Comment threads are paired one to one; their anchors move
 * with the text on each side, and messages, resolving and deleting go across.
 *
 * Kept in `.texwerk/overleaf.json` (mode 600, with the session cookie), and
 * `.texwerk/overleaf-base/<doc id>`: the last text both sides agreed on, the
 * base for a three-way merge after a restart. `.texwerk/` is never mirrored,
 * committed or visible to compiles.
 */

export interface DocState {
  path: string;
  /** The Overleaf version of the base text in .texwerk/overleaf-base/<id>. */
  version: number;
}

export interface FileState {
  path: string;
  /** hashBytes of the content both sides last agreed on. */
  hash: string;
}

export interface ThreadState {
  overleafThread: string;
  docId: string;
  resolved: boolean;
  /** Its anchor is on Overleaf (an anchor goes over the live channel, and may wait). */
  anchored: boolean;
  /** TeXWerk message id → Overleaf message id ('' while ours is sent but not yet seen back). */
  messages: Record<string, string>;
  /** The text both sides last agreed on for each paired message, as each side has it, to tell which side edited it. */
  agreed?: Record<string, { tw: string; ol: string }>;
}

export interface LinkState {
  origin: string;
  projectId: string;
  cookie: string;
  /** Login of the owner who linked; their messages go to Overleaf without a name prefix. */
  linkedBy: string;
  linkedByName: string;
  rootFolderId: string;
  docs: Record<string, DocState>;
  files: Record<string, FileState>;
  threads: Record<string, ThreadState>;
}

/** For the first link of a project both sides already have: which side wins each differing file. */
export type Choices = Record<string, 'texwerk' | 'overleaf'>;

interface Entity {
  kind: EntityKind;
  name: string;
  parent: string | null;
  /** Content hash Overleaf gives for binary files, when it does. */
  hash?: string;
}

interface LiveDoc {
  id: string;
  ot: OtDocument | null;
  /** Joining: updates that arrive meanwhile wait here. */
  buffered: Array<{ ops: OtOp[]; v: number; meta: Record<string, unknown> }> | null;
  flushTimer: NodeJS.Timeout | null;
  /**
   * Local edits not yet given to the OT client, exactly as they were made
   * (from the Y.Text's change events), and the text they lead to. A diff of
   * the whole text would also work, but cannot always tell where an edit was
   * made (inserting "ab" into "abab"), and a concurrent edit could then land
   * inside it. Null: unknown, so the next flush diffs.
   */
  queued: OtOp[] | null;
  shadow: string | null;
  lastHashAt: number;
  /**
   * Overleaf's text at `version`, exactly: every update it applied, ours
   * included once acknowledged. The base for a merge when the two copies
   * have to be reconciled, and what .texwerk/overleaf-base keeps.
   */
  confirmed: { text: string; version: number } | null;
}

const FLUSH_DELAY_MS = 150;
const TREE_DELAY_MS = 700;
const COMMENT_DELAY_MS = 500;
const THREAD_POLL_MS = 60_000;
const SAVE_DELAY_MS = 1000;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** How often an update carries the document hash Overleaf checks. */
let hashEveryMs = 5000;
/** For tests: check the hash on every update. */
export function setHashInterval(ms: number): void {
  hashEveryMs = ms;
}

const LINK_AUTHOR = 'Overleaf';

/** OVERLEAF_DEBUG=1 logs each step of connecting and syncing. */
const debug = process.env.OVERLEAF_DEBUG ? (...args: unknown[]) => console.error('[overleaf]', ...args) : () => {};

export function statePath(dir: string): string {
  return join(dir, '.texwerk', 'overleaf.json');
}

export function readLinkState(dir: string): LinkState | null {
  try {
    const raw = JSON.parse(readFileSync(statePath(dir), 'utf8')) as LinkState;
    if (!raw || typeof raw.projectId !== 'string' || typeof raw.cookie !== 'string') return null;
    return {
      ...raw,
      docs: raw.docs ?? {}, files: raw.files ?? {}, threads: raw.threads ?? {},
      rootFolderId: raw.rootFolderId ?? '', linkedBy: raw.linkedBy ?? '', linkedByName: raw.linkedByName ?? '',
    };
  } catch { return null; }
}

/** What Overleaf's document updater hashes a document to: sha1("blob {UTF-16 length}\0{UTF-8 text}"). */
export function docHash(text: string): string {
  return createHash('sha1').update(`blob ${text.length}\0`).update(text, 'utf8').digest('hex');
}

/** A Mongo-ObjectId-shaped id, which is what Overleaf's thread ids are; the client names a new thread. */
export function newThreadId(): string {
  const hex = (value: number, width: number) => Math.floor(value).toString(16).padStart(width, '0').slice(-width);
  return hex(Date.now() / 1000, 8) + hex(Math.random() * 0x1000000, 6) + hex(Math.random() * 0x10000, 4) + hex(Math.random() * 0x1000000, 6);
}

function textOps(ops: unknown): OtOp[] {
  if (!Array.isArray(ops)) return [];
  const out: OtOp[] = [];
  for (const raw of ops) {
    const op = raw as Record<string, unknown>;
    if (typeof op.t === 'string' || typeof op.p !== 'number') continue;
    if (typeof op.i === 'string') out.push({ p: op.p, i: op.i });
    else if (typeof op.d === 'string') out.push({ p: op.p, d: op.d });
  }
  return out;
}

function commentOps(ops: unknown): Array<{ p: number; c: string; t: string }> {
  if (!Array.isArray(ops)) return [];
  const out: Array<{ p: number; c: string; t: string }> = [];
  for (const raw of ops) {
    const op = raw as Record<string, unknown>;
    if (typeof op.t === 'string' && typeof op.c === 'string' && typeof op.p === 'number') out.push({ p: op.p, c: decodePacked(op.c), t: op.t });
  }
  return out;
}

function personName(user: unknown): string {
  if (!user || typeof user !== 'object') return '';
  const u = user as Record<string, unknown>;
  const full = [u.first_name, u.last_name].filter((p) => typeof p === 'string' && p).join(' ');
  if (full) return full;
  return typeof u.email === 'string' ? u.email.split('@')[0] : '';
}

/** Apply ops, in order, to a Y.Text (inside a transaction). */
function applyToYText(ytext: Y.Text, ops: OtOp[]): void {
  for (const op of ops) {
    if (typeof op.d === 'string') ytext.delete(op.p, op.d.length);
    if (typeof op.i === 'string') ytext.insert(op.p, op.i);
  }
}

/** The project as Overleaf has it: entities by id. */
class Tree {
  readonly nodes = new Map<string, Entity>();
  root = '';
  private cache: Map<string, { id: string; kind: EntityKind; hash?: string }> | null = null;

  /** Call after changing any node's name or parent. */
  touch(): void {
    this.cache = null;
  }

  rename(id: string, name: string): void {
    const n = this.nodes.get(id);
    if (n) { n.name = name; this.touch(); }
  }

  reparent(id: string, parent: string): void {
    const n = this.nodes.get(id);
    if (n) { n.parent = parent; this.touch(); }
  }

  add(id: string, entity: Entity): void {
    this.nodes.set(id, entity);
    this.touch();
  }

  static fromJoin(project: Record<string, unknown>): Tree {
    const tree = new Tree();
    const field = project.rootFolder;
    const root = (Array.isArray(field) ? field[0] : field) as Record<string, unknown> | undefined;
    if (!root || typeof root._id !== 'string') throw new OverleafError('protocol', 'Overleaf sent a project with no root folder.');
    tree.root = root._id;
    tree.absorb(root, null, 0);
    return tree;
  }

  private absorb(folder: Record<string, unknown>, parent: string | null, depth: number): void {
    if (depth > 64 || typeof folder._id !== 'string') return;
    this.nodes.set(folder._id, { kind: 'folder', name: String(folder.name ?? ''), parent });
    for (const [key, kind] of [['docs', 'doc'], ['fileRefs', 'file']] as const) {
      for (const e of Array.isArray(folder[key]) ? folder[key] as Array<Record<string, unknown>> : []) this.insert(folder._id, e, kind);
    }
    for (const f of Array.isArray(folder.folders) ? folder.folders as Array<Record<string, unknown>> : []) this.absorb(f, folder._id, depth + 1);
  }

  insert(parent: string, e: Record<string, unknown>, kind: EntityKind): string | null {
    if (typeof e._id !== 'string' || typeof e.name !== 'string') return null;
    this.nodes.set(e._id, { kind, name: e.name, parent, hash: typeof e.hash === 'string' ? e.hash : undefined });
    this.touch();
    if (kind === 'folder') {
      for (const [key, k] of [['docs', 'doc'], ['fileRefs', 'file']] as const) {
        for (const c of Array.isArray(e[key]) ? e[key] as Array<Record<string, unknown>> : []) this.insert(e._id, c, k);
      }
      for (const f of Array.isArray(e.folders) ? e.folders as Array<Record<string, unknown>> : []) this.insert(e._id, f, 'folder');
    }
    return e._id;
  }

  /** Project-relative path; null for the root, unknown ids and names TeXWerk cannot hold. */
  path(id: string): string | null {
    const parts: string[] = [];
    let at: string | null = id;
    for (let i = 0; i < 65 && at; i++) {
      const n = this.nodes.get(at);
      if (!n) return null;
      if (n.parent === null) break;
      parts.unshift(n.name);
      at = n.parent;
    }
    if (!parts.length) return null;
    const joined = parts.join('/');
    return cleanPath(joined) === joined ? joined : null;
  }

  /** Every entity with a usable path, by path (cached until the tree changes; do not modify). */
  byPath(): Map<string, { id: string; kind: EntityKind; hash?: string }> {
    if (this.cache) return this.cache;
    const out = new Map<string, { id: string; kind: EntityKind; hash?: string }>();
    for (const [id, n] of this.nodes) {
      const p = this.path(id);
      if (p) out.set(p, { id, kind: n.kind, hash: n.hash });
    }
    this.cache = out;
    return out;
  }

  /** The entity and everything under it. */
  subtree(id: string): string[] {
    const out = [id];
    for (let i = 0; i < out.length; i++) {
      for (const [cid, n] of this.nodes) if (n.parent === out[i]) out.push(cid);
    }
    return out;
  }

  remove(id: string): void {
    for (const cid of this.subtree(id)) this.nodes.delete(cid);
    this.touch();
  }

  folderFor(path: string): string | null {
    const parent = path.split('/').slice(0, -1).join('/');
    if (!parent) return this.root;
    const hit = this.byPath().get(parent);
    return hit && hit.kind === 'folder' ? hit.id : null;
  }
}

export class OverleafLink {
  readonly project: Project;
  state: LinkState;
  private status: OverleafInfo['status'] = 'connecting';
  private message = 'Connecting to Overleaf…';
  private conflicts = new Set<string>();
  private seq = 0;
  private socket: OverleafSocket | null = null;
  private rest: OverleafRest;
  private tree = new Tree();
  private readonly docs = new Map<string, LiveDoc>();
  private readonly users = new Map<string, string>();
  /** Overleaf thread → where its anchor is, from joined documents' ranges and live comment ops. */
  private readonly anchors = new Map<string, { docId: string; p: number; quote: string }>();
  private readonly pendingMoves: Array<{ from: string; to: string }> = [];
  /** Text we uploaded, by path, until Overleaf tells us the doc it became. */
  private readonly uploading = new Map<string, string>();
  /** Paths we uploaded lately: Overleaf replaces a file by removing the old entity, which must not delete ours. */
  private readonly recentUploads = new Map<string, number>();
  /** Uploads Overleaf refused, by path and content hash, so they are not tried on every change. */
  private readonly refused = new Map<string, string>();
  private choices: Choices | null;
  private stopped = false;
  private live = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retries = 0;
  /** Bumped by every connection attempt; an older attempt that finishes later closes what it opened. */
  private generation = 0;
  private treeTimer: NodeJS.Timeout | null = null;
  private commentTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** Marks transactions the link makes, so it does not send them back. */
  private readonly token = randomUUID();
  private readonly pathOfText = new Map<Y.Text, string>();
  private readonly onAfterTransaction: (tr: Y.Transaction) => void;
  private readonly onTexts: (events: Array<Y.YEvent<Y.AbstractType<unknown>>>, tr: Y.Transaction) => void;
  private readonly onComments: (events: Array<Y.YEvent<Y.AbstractType<unknown>>>, tr: Y.Transaction) => void;
  /** Counts work in progress, for tests and status. */
  onChange: (() => void) | null = null;

  constructor(project: Project, state: LinkState, choices: Choices | null = null) {
    this.project = project;
    this.state = state;
    this.choices = choices;
    this.rest = new OverleafRest(state.origin, state.projectId, state.cookie);
    this.reindex();
    this.onAfterTransaction = (tr) => this.afterTransaction(tr);
    this.onTexts = (events, tr) => this.textEvents(events, tr);
    this.onComments = (_events, tr) => { if (!this.ours(tr.origin)) this.scheduleComments(); };
  }

  // ------------------------------------------------------------- lifecycle

  start(): void {
    this.project.doc.on('afterTransaction', this.onAfterTransaction);
    this.project.texts.observeDeep(this.onTexts);
    this.project.comments.observeDeep(this.onComments);
    this.project.onMove = (from, to, author) => {
      if (author.endsWith(` · ${LINK_AUTHOR}`) || author === LINK_AUTHOR) return;
      this.pendingMoves.push({ from, to });
      this.scheduleTree();
    };
    this.project.overleaf = this;
    void this.connect();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.live = false;
    this.generation++;
    for (const t of [this.retryTimer, this.treeTimer, this.commentTimer, this.pollTimer]) if (t) clearTimeout(t);
    for (const d of this.docs.values()) if (d.flushTimer) clearTimeout(d.flushTimer);
    this.project.doc.off('afterTransaction', this.onAfterTransaction);
    this.project.texts.unobserveDeep(this.onTexts);
    this.project.comments.unobserveDeep(this.onComments);
    if (this.project.onMove) this.project.onMove = null;
    if (this.project.overleaf === this) this.project.overleaf = null;
    this.socket?.close();
    this.socket = null;
    await this.chain.catch(() => {});
    this.saveNow();
  }

  /** Forget the link entirely (the files stay as they are on both sides). */
  async unlink(): Promise<void> {
    await this.stop();
    rmSync(statePath(this.project.dir), { force: true });
    rmSync(join(this.project.dir, '.texwerk', 'overleaf-base'), { recursive: true, force: true });
    this.project.broadcastEvent({ t: 'overleaf', info: null });
  }

  /** A new session cookie: reconnect with it. */
  async setCookie(cookie: string): Promise<void> {
    this.state.cookie = cookie;
    this.rest.cookie = cookie;
    this.saveNow();
    this.reconnect();
  }

  /** Drop the connection (if any) and connect again now; an attempt under way is superseded. */
  reconnect(): void {
    if (this.stopped) return;
    this.retries = 0;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const socket = this.socket;
    this.socket = null;
    this.live = false;
    socket?.close();
    void this.connect();
  }

  info(): OverleafInfo {
    return {
      status: this.status,
      message: this.message,
      url: `${this.state.origin}/project/${this.state.projectId}`,
      linkedBy: this.state.linkedByName || this.state.linkedBy,
      conflicts: [...this.conflicts],
      seq: this.seq,
    };
  }

  /** True once connected and every document is joined. */
  get isLive(): boolean {
    return this.live;
  }

  /** Resolves when the link has nothing left queued: for tests. */
  async idle(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const before = this.chain;
      await before.catch(() => {});
      await new Promise((r) => setTimeout(r, 0));
      const busyDocs = [...this.docs.values()].some((d) => d.flushTimer || d.buffered || (d.ot && !d.ot.settled));
      if (before === this.chain && !this.treeTimer && !this.commentTimer && !busyDocs) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  private setStatus(status: OverleafInfo['status'], message: string): void {
    this.status = status;
    this.message = message;
    this.seq = Math.max(this.seq + 1, Date.now());
    this.project.broadcastEvent({ t: 'overleaf', info: this.info() });
    this.onChange?.();
  }

  /** Run `fn` after everything queued before it: tree and comment work never interleave. */
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch((err) => this.fail(err));
    return next;
  }

  private fail(err: unknown): void {
    if (this.stopped) return;
    const e = err instanceof OverleafError ? err : new OverleafError('protocol', (err as Error)?.message ?? String(err));
    console.error(`[${this.project.name}] Overleaf link:`, e.message);
    if ((e.kind === 'session' || e.kind === 'access') && this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.close();
      this.onSocketClosed(e);
    }
  }

  private ours(origin: unknown): boolean {
    return !!origin && typeof origin === 'object' && (origin as { overleafLink?: string }).overleafLink === this.token;
  }

  private origin(author: string): { author: string; overleafLink: string } {
    return { author, overleafLink: this.token };
  }

  // ------------------------------------------------------------ connecting

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.generation;
    const superseded = () => this.stopped || generation !== this.generation;
    this.live = false;
    this.setStatus(this.retries ? 'reconnecting' : 'connecting', this.retries ? 'Reconnecting to Overleaf… Edits here are kept and sent when it is back.' : 'Connecting to Overleaf…');
    let socket: OverleafSocket | null = null;
    try {
      this.rest = new OverleafRest(this.state.origin, this.state.projectId, this.state.cookie);
      debug('connect: signing in');
      await this.rest.signIn();
      if (superseded()) return;
      debug('connect: opening the realtime channel');
      const opened = await OverleafSocket.connect({
        origin: this.state.origin,
        cookie: this.state.cookie,
        projectId: this.state.projectId,
        onEvent: (name, args) => { if (socket && this.socket === socket) this.onEvent(name, args); },
        onClose: (err) => { if (socket && this.socket === socket) this.onSocketClosed(err); },
      });
      socket = opened.socket;
      if (superseded()) { socket.close(); return; }
      this.socket = socket;
      debug('connect: joined, queueing the sync');
      await this.queue(() => this.onJoined(opened.joined));
      debug('connect: synced');
      if (this.socket !== socket || !socket.open) return;
      this.retries = 0;
      this.live = true;
      this.choices = null;
      this.setStatus('live', 'Edits go both ways.');
      this.scheduleComments(0);
      this.schedulePoll();
    } catch (err) {
      if (superseded()) { if (this.socket === socket) this.socket = null; socket?.close(); return; }
      const e = err instanceof OverleafError ? err : new OverleafError('protocol', (err as Error).message);
      // A socket that closed on its own already scheduled what comes next,
      // unless the reason is one that needs the owner (expired, no access).
      if (socket && this.socket !== socket && e.kind !== 'session' && e.kind !== 'access') return;
      if (this.socket === socket) this.socket = null;
      socket?.close();
      if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
      this.onSocketClosed(e);
    }
  }

  private onSocketClosed(err: OverleafError): void {
    this.socket = null;
    this.live = false;
    if (this.stopped) return;
    if (err.kind === 'session') {
      this.setStatus('expired', err.message);
      return;
    }
    if (err.kind === 'access') {
      this.setStatus('lost', err.message);
      return;
    }
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.retries, 6));
    this.retries++;
    this.setStatus('reconnecting', `${err.message} Trying again in ${Math.round(delay / 1000)} s; edits here are kept.`);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.connect(); }, delay);
  }

  private async onJoined(joined: JoinedProject): Promise<void> {
    const project = joined.project;
    const level = joined.permissionsLevel || String(project.permissionsLevel ?? '');
    if (level && !['owner', 'readAndWrite'].includes(level)) {
      throw new OverleafError('access', 'This Overleaf account cannot edit the project (it has read-only or review access).');
    }
    for (const u of [project.owner, ...(Array.isArray(project.members) ? project.members : [])]) {
      const user = u as Record<string, unknown> | undefined;
      if (user && typeof user._id === 'string') this.users.set(user._id, personName(user) || 'Someone');
    }
    const previous = this.tree;
    this.tree = Tree.fromJoin(project);
    this.state.rootFolderId = this.tree.root;
    await this.reconcileRemoteTree(previous.nodes.size ? previous : null);
    // Every doc is joined (catching up where it can), then the local side goes up.
    for (const [path, e] of this.tree.byPath()) {
      if (e.kind === 'doc') await this.joinDoc(e.id, path);
    }
    for (const id of [...this.docs.keys()]) if (!this.tree.nodes.has(id)) this.docs.delete(id);
    await this.syncFilesDown();
    await this.syncTreeUp();
    this.scheduleSave();
  }

  // ------------------------------------------------------------- documents

  private ytext(path: string): Y.Text | undefined {
    return this.project.texts.get(path);
  }

  private reindex(): void {
    this.pathOfText.clear();
    for (const [p, t] of this.project.texts) this.pathOfText.set(t, p);
  }

  private docPath(id: string): string | null {
    return this.tree.path(id);
  }

  private basePath(id: string): string {
    return join(this.project.dir, '.texwerk', 'overleaf-base', id);
  }

  private readBase(id: string): string | null {
    try { return readFileSync(this.basePath(id), 'utf8'); } catch { return null; }
  }

  /**
   * Join one document and make both sides equal: catch up from where this
   * process left it when possible, else merge three ways against the last
   * agreed text (or let the first link's choice decide).
   */
  private async joinDoc(id: string, path: string): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    let doc = this.docs.get(id);
    if (!doc) {
      doc = { id, ot: null, buffered: null, flushTimer: null, queued: null, shadow: null, lastHashAt: 0, confirmed: null };
      this.docs.set(id, doc);
    }
    doc.buffered = [];
    const resumeFrom = doc.ot ? doc.ot.version : -1;
    if (doc.ot) this.flushLocal(doc, false);
    const answer = await socket.call('joinDoc', [id, resumeFrom, { encodeRanges: true }]);
    const lines = (Array.isArray(answer[0]) ? answer[0] : []).map((l) => decodePacked(String(l)));
    const remoteText = lines.join('\n');
    const version = Number(answer[1]);
    if (!Number.isFinite(version)) throw new OverleafError('protocol', `Overleaf sent no version for ${path}.`);
    const updates = Array.isArray(answer[2]) ? answer[2] as Array<Record<string, unknown>> : [];
    this.readRanges(id, answer[3]);

    let resumed = false;
    if (doc.ot && resumeFrom >= 0 && (updates.length > 0 || version === resumeFrom)) {
      try {
        const ytext = this.ytext(path);
        if (ytext) this.flushLocal(doc, false);
        // Each replayed update is someone else's (applied here) or our own
        // finally landing (an acknowledgement), as in OtDocument.catchUp.
        const mine = new Set(doc.ot.submittedVia);
        for (const u of updates) {
          const v = Number(u.v);
          if (v < doc.ot.version) continue;
          const source = String((u.meta as Record<string, unknown> | undefined)?.source ?? '');
          if (mine.has(source) && doc.ot.waiting) this.confirmAck(doc, v);
          else {
            this.confirmRemote(doc, textOps(u.op), v);
            const { applied } = doc.ot.remote(textOps(u.op), v);
            if (ytext && applied.length) this.applyRemote(path, applied, LINK_AUTHOR);
          }
        }
        resumed = (!ytext || ytext.toString() === doc.ot.text) && doc.confirmed?.version === doc.ot.version;
      } catch (err) {
        if (!(err instanceof OtDesyncError)) throw err;
      }
    }
    if (!resumed) {
      // Start from Overleaf's copy; what the local side has goes up as operations.
      const ytext = this.ytext(path);
      let wanted = remoteText;
      if (ytext) {
        const local = ytext.toString();
        const base = doc.confirmed?.text ?? (this.state.docs[id] ? this.readBase(id) : null) ?? this.uploading.get(path) ?? null;
        const choice = this.choices?.[path];
        if (local === remoteText) wanted = remoteText;
        else if (base !== null) {
          const m = merge3(base, local, remoteText);
          wanted = m.text;
          if (m.conflicts) this.noteConflict(path, m.conflictLines);
        } else if (choice === 'texwerk') wanted = local;
        else if (choice === 'overleaf' || this.choices) wanted = remoteText;
        else {
          const m = merge3('', local, remoteText);
          wanted = m.text;
          if (m.conflicts) this.noteConflict(path, m.conflictLines);
        }
        if (wanted !== local) {
          this.project.transactAs(`${LINK_AUTHOR} (merge)`, () => setYText(ytext, wanted), this.origin(`${LINK_AUTHOR} (merge)`));
        }
      } else if (this.state.docs[id] && !this.uploading.has(path) && this.readBase(id) === remoteText) {
        // Deleted here while the link was down, unchanged on Overleaf since:
        // the deletion goes to Overleaf (syncTreeUp), the file does not come back.
        doc.buffered = null;
        doc.ot = null;
        return;
      } else if (this.uploading.has(path)) {
        // Our own upload, and the file is gone from here since: never bring it back.
        doc.buffered = null;
        doc.ot = null;
        return;
      } else {
        await this.project.putFile(path, Buffer.from(remoteText, 'utf8'), LINK_AUTHOR);
      }
      this.uploading.delete(path);
      doc.ot = new OtDocument(remoteText, version);
      // Edits queued against the old client no longer apply; the next flush diffs.
      doc.queued = null;
      doc.shadow = null;
      doc.confirmed = { text: remoteText, version };
      this.state.docs[id] = { path, version };
      this.writeBase(id, remoteText);
    }
    this.state.docs[id] = { path, version: this.state.docs[id]?.version ?? version };
    // Updates that arrived while joining, in order; older ones are already in.
    const waiting = doc.buffered ?? [];
    doc.buffered = null;
    for (const u of waiting) this.onRemoteUpdate(doc, u.ops, u.v, u.meta);
    // What was in flight before the reconnect goes again, naming the
    // connections it went out on so Overleaf drops it if it already landed.
    const again = resumed ? doc.ot?.resend() : null;
    if (again) this.send(doc, { version: again.version, ops: again.ops }, again.dupIfSource);
    this.flushLocal(doc, true);
  }

  private readRanges(docId: string, ranges: unknown): void {
    const comments = (ranges as { comments?: unknown } | undefined)?.comments;
    if (!Array.isArray(comments)) return;
    for (const c of comments) {
      const op = (c as { op?: Record<string, unknown> }).op;
      if (op && typeof op.t === 'string' && typeof op.p === 'number') {
        this.anchors.set(op.t, { docId, p: op.p, quote: decodePacked(String(op.c ?? '')) });
      }
    }
  }

  private noteConflict(path: string, lines: number[]): void {
    this.conflicts.add(path);
    this.seq = Math.max(this.seq + 1, Date.now());
    const where = lines.map((l) => `${path}:${l}`).join(', ');
    this.project.say(`Overleaf link: both sides changed the same lines of ${where} while apart. Both versions are kept between %<<<<<<< and %>>>>>>> lines; keep the right one and delete the rest.`,
      { author: LINK_AUTHOR, login: '', agent: true }, []);
  }

  /**
   * Bring the OT client up to the Y.Text, and send what that produced if the
   * document is live. `send: false` only records (while (re)joining).
   */
  private flushLocal(doc: LiveDoc, send: boolean): void {
    if (doc.flushTimer) { clearTimeout(doc.flushTimer); doc.flushTimer = null; }
    const path = this.docPath(doc.id);
    const ytext = path ? this.ytext(path) : undefined;
    if (!doc.ot || !ytext || !path) return;
    let text = ytext.toString();
    if (doc.queued !== null && doc.shadow === text) {
      const ops = doc.queued;
      doc.queued = [];
      if (ops.length) {
        const { send: out, replaced } = doc.ot.localOps(ops);
        if (replaced) {
          const stored = doc.ot.text;
          this.project.transactAs(LINK_AUTHOR, () => setYText(ytext, stored), this.origin(LINK_AUTHOR));
        }
        if (out && send && !doc.buffered) this.send(doc, out);
      }
      if (doc.ot.text === doc.shadow) return;
      text = ytext.toString();
    }
    // Unknown edits (or a carriage return to take out): diff the whole text.
    doc.queued = null;
    if (text.includes('\r')) {
      // Overleaf keeps lines without carriage returns; match it so both sides stay equal.
      const clean = text.replace(/\r/g, '');
      this.project.transactAs(LINK_AUTHOR, () => setYText(ytext, clean), this.origin(LINK_AUTHOR));
      text = clean;
    }
    const { send: out, replaced } = doc.ot.local(text);
    if (replaced) {
      // Overleaf stores characters outside the BMP as U+FFFD; show what it stores.
      const stored = doc.ot.text;
      this.project.transactAs(LINK_AUTHOR, () => setYText(ytext, stored), this.origin(LINK_AUTHOR));
    }
    doc.queued = [];
    doc.shadow = ytext.toString();
    if (out && send && !doc.buffered) this.send(doc, out);
  }

  /**
   * Every change to a text, as it happens: local edits are queued as the
   * operations they are, and the link's own changes keep `shadow` equal to
   * the Y.Text.
   */
  private textEvents(events: Array<Y.YEvent<Y.AbstractType<unknown>>>, tr: Y.Transaction): void {
    if (this.stopped) return;
    const ours = this.ours(tr.origin);
    for (const event of events) {
      if (!(event.target instanceof Y.Text)) continue;
      const path = this.pathOfText.get(event.target) ?? [...this.project.texts].find(([, t]) => t === event.target)?.[0];
      const entity = path ? this.tree.byPath().get(path) : undefined;
      const doc = entity?.kind === 'doc' ? this.docs.get(entity.id) : undefined;
      if (!doc || doc.shadow === null) continue;
      let text = doc.shadow;
      let pos = 0;
      const ops: OtOp[] = [];
      let unknown = false;
      for (const d of (event as Y.YTextEvent).delta) {
        if (typeof d.retain === 'number') pos += d.retain;
        else if (typeof d.insert === 'string') {
          if (d.insert.includes('\r')) unknown = true;
          ops.push({ p: pos, i: d.insert });
          text = text.slice(0, pos) + d.insert + text.slice(pos);
          pos += d.insert.length;
        } else if (typeof d.delete === 'number') {
          ops.push({ p: pos, d: text.slice(pos, pos + d.delete) });
          text = text.slice(0, pos) + text.slice(pos + d.delete);
        } else unknown = true;
      }
      doc.shadow = text;
      if (ours) continue;
      if (unknown || doc.queued === null) doc.queued = null;
      else doc.queued.push(...ops);
    }
  }

  private send(doc: LiveDoc, out: { version: number; ops: OtOp[] }, dupIfSource: readonly string[] = []): void {
    const socket = this.socket;
    if (!socket || !doc.ot || doc.buffered) return;
    const update: Record<string, unknown> = { doc: doc.id, op: out.ops, v: out.version };
    if (dupIfSource.length) update.dupIfSource = [...dupIfSource];
    const sentText = doc.ot.sentText;
    if (sentText !== null && Date.now() - doc.lastHashAt >= hashEveryMs) {
      update.hash = docHash(sentText);
      doc.lastHashAt = Date.now();
    }
    doc.ot.noteSubmitted(socket.publicId);
    socket.call('applyOtUpdate', [doc.id, update]).catch((err: OverleafError) => {
      // Not proof of rejection: the reconnect's catch-up settles what landed.
      if (err.kind !== 'network' && this.socket === socket) {
        console.error(`[${this.project.name}] Overleaf refused an edit:`, err.message);
        socket.close();
      }
    });
  }

  /** Our update in flight landed at `version`: the confirmed text takes it, as transformed. */
  private confirmAck(doc: LiveDoc, version: number): { version: number; ops: OtOp[] } | null {
    const sent = doc.ot!.inflightOps;
    const { send } = doc.ot!.acknowledge(version);
    if (doc.confirmed && sent && doc.confirmed.version === version) {
      const next = applyOps(doc.confirmed.text, [...sent]);
      doc.confirmed = next === null ? null : { text: next, version: version + 1 };
    } else if (doc.confirmed && doc.confirmed.version <= version) doc.confirmed = null;
    this.scheduleSave();
    return send;
  }

  /** Someone else's update landed at `version`. */
  private confirmRemote(doc: LiveDoc, ops: OtOp[], version: number): void {
    if (!doc.confirmed || doc.confirmed.version > version) return;
    if (doc.confirmed.version < version) { doc.confirmed = null; return; }
    const next = applyOps(doc.confirmed.text, ops);
    doc.confirmed = next === null ? null : { text: next, version: version + 1 };
    this.scheduleSave();
  }

  private onAck(doc: LiveDoc, version: number): void {
    if (!doc.ot) return;
    try {
      const send = this.confirmAck(doc, version);
      if (send) this.send(doc, send);
    } catch (err) {
      if (err instanceof OtDesyncError) this.resync(doc, err.message);
      else throw err;
    }
  }

  private onRemoteUpdate(doc: LiveDoc, ops: OtOp[], version: number, meta: Record<string, unknown>): void {
    if (!doc.ot) return;
    const path = this.docPath(doc.id);
    if (!path) return;
    try {
      this.flushLocal(doc, true);
      const { applied } = doc.ot.remote(ops, version);
      this.confirmRemote(doc, ops, version);
      const name = this.users.get(String(meta.user_id ?? ''));
      if (applied.length) this.applyRemote(path, applied, name ? `${name} · ${LINK_AUTHOR}` : LINK_AUTHOR);
      const ytext = this.ytext(path);
      if (ytext && ytext.toString() !== doc.ot.text) throw new OtDesyncError(`${path} drifted from Overleaf's copy.`);
    } catch (err) {
      if (err instanceof OtDesyncError) this.resync(doc, err.message);
      else throw err;
    }
  }

  private applyRemote(path: string, ops: OtOp[], author: string): void {
    const ytext = this.ytext(path);
    if (!ytext) return;
    this.project.transactAs(author, () => applyToYText(ytext, ops), this.origin(author));
  }

  /** The two copies disagree: rejoin and merge against the last agreed text. */
  private resync(doc: LiveDoc, why: string): void {
    console.error(`[${this.project.name}] Overleaf link: ${why} Rejoining the document.`);
    doc.ot = null;
    const path = this.docPath(doc.id);
    if (path) void this.queue(() => this.joinDoc(doc.id, path));
  }

  private afterTransaction(tr: Y.Transaction): void {
    if (this.stopped) return;
    const changed = tr.changed as Map<unknown, unknown>;
    const structural = changed.has(this.project.texts) || changed.has(this.project.bins) || changed.has(this.project.dirs);
    if (structural) {
      this.reindex();
      if (!this.ours(tr.origin)) this.scheduleTree();
    }
    if (this.ours(tr.origin)) return;
    for (const type of tr.changed.keys()) {
      if (!(type instanceof Y.Text)) continue;
      const path = this.pathOfText.get(type);
      if (!path) continue;
      const entity = this.tree.byPath().get(path);
      if (!entity) continue;
      if (entity.kind === 'file') { this.scheduleTree(); continue; }
      const doc = this.docs.get(entity.id);
      if (!doc || !doc.ot) continue;
      if (!doc.flushTimer) doc.flushTimer = setTimeout(() => { doc.flushTimer = null; this.flushLocal(doc, true); }, FLUSH_DELAY_MS);
    }
  }

  // ------------------------------------------------------------ events in

  private onEvent(name: string, args: unknown[]): void {
    switch (name) {
      case 'otUpdateApplied': {
        const u = (args[0] ?? {}) as Record<string, unknown>;
        const doc = typeof u.doc === 'string' ? this.docs.get(u.doc) : undefined;
        if (!doc) return;
        const v = Number(u.v);
        if (!('op' in u)) { this.onAck(doc, v); return; }
        for (const c of commentOps(u.op)) {
          this.anchors.set(c.t, { docId: doc.id, p: c.p, quote: c.c });
          this.scheduleComments();
        }
        const meta = (u.meta ?? {}) as Record<string, unknown>;
        const ops = textOps(u.op);
        if (doc.buffered) { doc.buffered.push({ ops, v, meta }); return; }
        if (doc.ot && typeof meta.source === 'string' && doc.ot.submittedVia.includes(meta.source) && v === doc.ot.version) {
          // Our own update replayed (sent before a reconnect): an acknowledgement.
          this.onAck(doc, v);
          return;
        }
        this.onRemoteUpdate(doc, ops, v, meta);
        return;
      }
      case 'otUpdateError': {
        const u = (args[1] ?? args[0] ?? {}) as Record<string, unknown>;
        console.error(`[${this.project.name}] Overleaf rejected an edit:`, typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0]));
        const doc = typeof u.doc === 'string' ? this.docs.get(u.doc) : undefined;
        if (doc) doc.ot = null;
        this.socket?.close();
        return;
      }
      case 'reciveNewDoc':
      case 'reciveNewFile':
      case 'reciveNewFolder': {
        const kind: EntityKind = name === 'reciveNewDoc' ? 'doc' : name === 'reciveNewFile' ? 'file' : 'folder';
        const parent = String(args[0] ?? '');
        const e = args[1] as Record<string, unknown> | undefined;
        if (!e) return;
        void this.queue(() => this.onRemoteNew(parent, e, kind));
        return;
      }
      case 'reciveEntityRename':
      case 'reciveEntityMove': {
        const id = String(args[0] ?? '');
        const value = String(args[1] ?? '');
        void this.queue(() => this.onRemoteMove(id, name === 'reciveEntityRename' ? { name: value } : { parent: value }));
        return;
      }
      case 'removeEntity': {
        const id = String(args[0] ?? '');
        void this.queue(() => this.onRemoteRemove(id));
        return;
      }
      case 'new-comment':
      case 'new-comment-threads':
      case 'resolve-thread':
      case 'reopen-thread':
      case 'delete-thread':
      case 'edit-message':
      case 'delete-message':
        this.scheduleComments();
        return;
      default:
    }
  }

  // ------------------------------------------------------------- the tree

  private localHash(path: string): string | null {
    const t = this.project.texts.get(path);
    if (t) return hashBytes(Buffer.from(t.toString(), 'utf8'));
    return this.project.bins.get(path)?.hash ?? null;
  }

  private async localBytes(path: string): Promise<Buffer | null> {
    const t = this.project.texts.get(path);
    if (t) return Buffer.from(t.toString(), 'utf8');
    if (!this.project.bins.has(path)) return null;
    try { return readFileSync(await this.project.realFile(path)); } catch { return null; }
  }

  private localPaths(): Set<string> {
    return new Set([...this.project.texts.keys(), ...this.project.bins.keys()]);
  }

  /**
   * After a (re)connect: apply what happened on Overleaf while apart —
   * entities renamed, moved or deleted there (known by id from the state).
   */
  private async reconcileRemoteTree(previous: Tree | null): Promise<void> {
    const known = [...Object.entries(this.state.docs).map(([id, d]) => ({ id, path: d.path, kind: 'doc' as const })),
      ...Object.entries(this.state.files).map(([id, f]) => ({ id, path: f.path, kind: 'file' as const }))];
    const local = this.localPaths();
    let removed = 0;
    for (const { id, path, kind } of known) {
      const now = this.tree.path(id);
      if (now === path) continue;
      if (now === null) {
        // Deleted on Overleaf while apart: delete here too, unless it changed here since.
        const unchanged = kind === 'doc'
          ? this.ytext(path)?.toString() === (this.docs.get(id)?.confirmed?.text ?? this.readBase(id))
          : this.localHash(path) === this.state.files[id]?.hash;
        if (local.has(path) && unchanged) { await this.project.remove(path, LINK_AUTHOR); removed++; }
        if (kind === 'doc') { delete this.state.docs[id]; this.docs.delete(id); rmSync(this.basePath(id), { force: true }); }
        else delete this.state.files[id];
      } else if (local.has(path)) {
        // Renamed on Overleaf while apart. A different file here at the new
        // name is moved aside first, so neither is merged into the other.
        if (local.has(now)) await this.moveAside(now);
        await this.project.move(path, now, LINK_AUTHOR);
      }
      if (kind === 'doc' && this.state.docs[id] && now) this.state.docs[id].path = now;
      if (kind === 'file' && this.state.files[id] && now) this.state.files[id].path = now;
    }
    if (removed && previous === null) console.error(`[${this.project.name}] Overleaf link: ${removed} file(s) deleted on Overleaf while apart were deleted here (restorable from the trash).`);
    for (const [path, e] of this.tree.byPath()) {
      if (e.kind === 'folder' && !this.project.dirs.has(path) && !local.has(path)) await this.project.mkdir(path, LINK_AUTHOR);
    }
  }

  /** Binary files: what Overleaf has that the local side does not, or has newer. */
  private async syncFilesDown(): Promise<void> {
    for (const [path, e] of this.tree.byPath()) {
      if (e.kind !== 'file') continue;
      const st = this.state.files[e.id];
      const localHash = this.localHash(path);
      // Agreed earlier (Overleaf gives a changed file a new id): a local change
      // goes up, and a local deletion goes up as a deletion.
      if (st && st.path === path) continue;
      if (localHash !== null && !st) {
        const choice = this.choices?.[path];
        if (choice === 'texwerk') { this.state.files[e.id] = { path, hash: '' }; continue; } // goes up in syncTreeUp
        if (this.uploading.has(path)) continue;
      }
      const data = await this.rest.download(e.id, e.hash);
      if (localHash !== hashBytes(data)) await this.project.putFile(path, data, LINK_AUTHOR);
      this.state.files[e.id] = { path, hash: hashBytes(data) };
    }
  }

  private scheduleTree(): void {
    if (this.stopped || this.treeTimer) return;
    this.treeTimer = setTimeout(() => {
      this.treeTimer = null;
      if (this.live) void this.queue(() => this.syncTreeUp());
    }, TREE_DELAY_MS);
  }

  /** Local structure → Overleaf: moves, new files, changed binaries, deletions. */
  private async syncTreeUp(): Promise<void> {
    if (!this.socket) return;
    // Moves first, so a renamed file is not uploaded again and deleted.
    for (const move of this.pendingMoves.splice(0)) {
      const remote = this.tree.byPath();
      const entity = remote.get(move.from);
      if (!entity || remote.has(move.to)) continue;
      const fromName = move.from.split('/').pop()!;
      const toName = move.to.split('/').pop()!;
      const fromParent = move.from.split('/').slice(0, -1).join('/');
      const toParent = move.to.split('/').slice(0, -1).join('/');
      if (fromParent !== toParent) {
        const folder = await this.ensureFolder(toParent);
        await this.rest.move(entity.kind, entity.id, folder);
        this.tree.reparent(entity.id, folder);
      }
      if (fromName !== toName) {
        await this.rest.rename(entity.kind, entity.id, toName);
        this.tree.rename(entity.id, toName);
      }
      for (const id of this.tree.subtree(entity.id)) {
        const p = this.tree.path(id);
        if (p && this.state.docs[id]) this.state.docs[id].path = p;
        if (p && this.state.files[id]) this.state.files[id].path = p;
      }
      for (const id of this.tree.subtree(entity.id)) {
        if (this.tree.nodes.get(id)?.kind !== 'doc') continue;
        const p = this.tree.path(id);
        const from = p && (p === move.to ? move.from : `${move.from}/${p.slice(move.to.length + 1)}`);
        if (p && from && this.uploading.has(from)) { this.uploading.set(p, this.uploading.get(from)!); this.uploading.delete(from); }
        if (p && !this.docs.get(id)?.ot && this.project.texts.has(p)) await this.joinDoc(id, p);
      }
    }
    const remote = this.tree.byPath();
    const local = this.localPaths();
    // New and changed files.
    for (const path of local) {
      const entity = remote.get(path);
      if (entity?.kind === 'doc') continue; // text goes over the live channel
      if (entity?.kind === 'folder') continue;
      const hash = this.localHash(path);
      if (entity && this.state.files[entity.id]?.hash === hash) continue;
      if (this.uploading.has(path) || (hash && this.refused.get(path) === hash)) continue;
      const data = await this.localBytes(path);
      if (!data || data.length > MAX_UPLOAD_BYTES) continue;
      const parent = path.split('/').slice(0, -1).join('/');
      const folder = await this.ensureFolder(parent);
      const text = this.project.texts.has(path) ? data.toString('utf8') : null;
      if (text !== null) this.uploading.set(path, text);
      this.recentUploads.set(path, Date.now());
      let made: { id: string; kind: EntityKind };
      try {
        made = await this.rest.upload(path, data, this.tree.root);
      } catch (err) {
        this.uploading.delete(path);
        if (err instanceof OverleafError && (err.kind === 'session' || err.kind === 'network')) throw err;
        console.error(`[${this.project.name}] Overleaf link: ${path} not uploaded:`, (err as Error).message);
        this.refused.set(path, hash ?? '');
        continue;
      }
      if (entity && entity.id !== made.id) this.tree.remove(entity.id);
      if (made.kind === 'file') {
        this.uploading.delete(path);
        this.tree.add(made.id, { kind: 'file', name: path.split('/').pop()!, parent: folder });
        this.state.files[made.id] = { path, hash: hashBytes(data) };
      } else {
        if (!this.tree.nodes.has(made.id)) this.tree.add(made.id, { kind: 'doc', name: path.split('/').pop()!, parent: folder });
        // Join it now rather than wait for Overleaf's event about it, unless
        // it was moved or deleted here while the upload was on its way: then
        // the next pass renames or deletes it on Overleaf, and it is joined
        // where it is then (a join must never bring back a file from here).
        if (this.project.texts.has(path)) await this.joinDoc(made.id, path);
        this.scheduleTree();
      }
    }
    // Deletions: entities known to both sides that are gone here.
    const gone: Array<{ id: string; kind: EntityKind; path: string }> = [];
    for (const [path, e] of remote) {
      if (e.kind === 'folder') {
        if (!this.project.dirs.has(path) && ![...local].some((p) => p.startsWith(`${path}/`))) {
          const parent = this.tree.nodes.get(e.id)?.parent;
          if (parent && this.tree.nodes.get(parent) && !gone.some((g) => path.startsWith(`${g.path}/`))) gone.push({ id: e.id, kind: 'folder', path });
        }
        continue;
      }
      if (!local.has(path) && !gone.some((g) => path.startsWith(`${g.path}/`))) gone.push({ id: e.id, kind: e.kind, path });
    }
    const files = [...remote.values()].filter((e) => e.kind !== 'folder').length;
    const goneFiles = [...remote].filter(([p, e]) => e.kind !== 'folder' && gone.some((g) => p === g.path || p.startsWith(`${g.path}/`))).length;
    if (goneFiles > 3 && goneFiles > files / 2) {
      this.setStatus('live', `Not deleting ${goneFiles} of ${files} files on Overleaf at once. Delete them on Overleaf if you mean it.`);
      return;
    }
    for (const g of gone) {
      await this.rest.remove(g.kind, g.id);
      for (const id of this.tree.subtree(g.id)) {
        delete this.state.docs[id];
        delete this.state.files[id];
        this.docs.delete(id);
      }
      this.tree.remove(g.id);
    }
    this.scheduleSave();
  }

  private async ensureFolder(path: string): Promise<string> {
    if (!path) return this.tree.root;
    const hit = this.tree.byPath().get(path);
    if (hit?.kind === 'folder') return hit.id;
    const parentPath = path.split('/').slice(0, -1).join('/');
    const parent = await this.ensureFolder(parentPath);
    const name = path.split('/').pop()!;
    const id = await this.rest.addFolder(name, parent);
    this.tree.add(id, { kind: 'folder', name, parent });
    return id;
  }

  private async onRemoteNew(parent: string, e: Record<string, unknown>, kind: EntityKind): Promise<void> {
    // Already known (one we made ourselves, maybe renamed since): its name
    // in the event may be out of date. Join it if it is a doc here not joined yet.
    if (typeof e._id === 'string' && this.tree.nodes.has(e._id)) {
      const known = this.tree.path(e._id);
      if (kind === 'doc' && known && !this.docs.get(e._id)?.ot && this.project.texts.has(known)) await this.joinDoc(e._id, known);
      return;
    }
    const id = this.tree.insert(parent, e, kind);
    if (!id) return;
    const path = this.tree.path(id);
    if (!path) return;
    if (kind === 'folder') {
      if (!this.project.dirs.has(path)) await this.project.mkdir(path, LINK_AUTHOR);
      return;
    }
    if (kind === 'doc') {
      await this.joinDoc(id, path);
      return;
    }
    // A binary file: ours coming back from an upload, or someone else's.
    const st = this.state.files[id];
    if (st && st.path === path) return;
    const localHash = this.localHash(path);
    const data = await this.rest.download(id, typeof e.hash === 'string' ? e.hash : undefined);
    const hash = hashBytes(data);
    if (localHash !== hash) await this.project.putFile(path, data, LINK_AUTHOR);
    this.state.files[id] = { path, hash };
    this.scheduleSave();
  }

  private async onRemoteMove(id: string, change: { name?: string; parent?: string }): Promise<void> {
    const node = this.tree.nodes.get(id);
    if (!node) return;
    const before = this.tree.path(id);
    if (change.name !== undefined) this.tree.rename(id, change.name);
    if (change.parent !== undefined) this.tree.reparent(id, change.parent);
    const after = this.tree.path(id);
    if (!before || !after || before === after) return;
    if (this.project.exists(before)) {
      if (this.project.exists(after)) await this.moveAside(after);
      await this.project.move(before, after, LINK_AUTHOR);
    }
    for (const cid of this.tree.subtree(id)) {
      const p = this.tree.path(cid);
      if (p && this.state.docs[cid]) this.state.docs[cid].path = p;
      if (p && this.state.files[cid]) this.state.files[cid].path = p;
    }
    this.scheduleSave();
  }

  /**
   * Move a local file or folder out of the way of one Overleaf renamed onto
   * its name: "b.tex" becomes "b (TeXWerk).tex" (then goes to Overleaf as a new
   * file), and the chat says so.
   */
  private async moveAside(path: string): Promise<void> {
    const slash = path.lastIndexOf('/');
    const dot = path.lastIndexOf('.');
    const cut = dot > slash + 1 && !this.project.dirs.has(path) ? dot : path.length;
    let target = '';
    for (let n = 1; !target || this.project.exists(target); n++) {
      target = `${path.slice(0, cut)} (TeXWerk${n > 1 ? ` ${n}` : ''})${path.slice(cut)}`;
    }
    await this.project.move(path, target, LINK_AUTHOR);
    this.project.say(`Overleaf link: a file on Overleaf was renamed to ${path}, which was taken here. The file that was here is now ${target}.`,
      { author: LINK_AUTHOR, login: '', agent: true }, []);
  }

  private async onRemoteRemove(id: string): Promise<void> {
    if (!this.tree.nodes.has(id)) return;
    const path = this.tree.path(id);
    // Our own upload replaced this entity: the new one is already in place.
    const uploadedAt = path ? this.recentUploads.get(path) : undefined;
    if (path && uploadedAt && Date.now() - uploadedAt < 30_000 && this.tree.byPath().get(path)?.id !== id) {
      this.tree.remove(id);
      delete this.state.files[id];
      return;
    }
    const ids = this.tree.subtree(id);
    this.tree.remove(id);
    for (const cid of ids) {
      delete this.state.docs[cid];
      delete this.state.files[cid];
      this.docs.delete(cid);
      rmSync(this.basePath(cid), { force: true });
    }
    if (path && this.project.exists(path)) await this.project.remove(path, LINK_AUTHOR);
    this.scheduleSave();
  }

  // ------------------------------------------------------------- comments

  private scheduleComments(delay = COMMENT_DELAY_MS): void {
    if (this.stopped || this.commentTimer) return;
    this.commentTimer = setTimeout(() => {
      this.commentTimer = null;
      if (this.live) void this.queue(() => this.syncComments());
    }, delay);
  }

  private schedulePoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (this.stopped) return;
      this.scheduleComments(0);
      this.schedulePoll();
    }, THREAD_POLL_MS);
  }

  private outgoing(m: CommentMessage): string {
    return m.login && m.login === this.state.linkedBy ? m.text : `[${m.author}] ${m.text}`;
  }

  /** Both directions, in one pass: Overleaf first (what it has wins on a tie), then what changed here. */
  private async syncComments(): Promise<void> {
    if (!this.socket) return;
    const threads = await this.rest.threads();
    await this.pullComments(threads);
    await this.pushComments(threads);
    this.scheduleSave();
  }

  /** "[Bob] text" (how a message from here reads on Overleaf) → "text". */
  private incoming(content: string, author: string): string {
    const prefix = `[${author}] `;
    return content.startsWith(prefix) ? content.slice(prefix.length) : content;
  }

  private overleafAuthor(m: { userId: string; userName: string }): string {
    return `${m.userId === this.rest.userId && this.state.linkedByName ? this.state.linkedByName : m.userName} · ${LINK_AUTHOR}`;
  }

  private async pullComments(threads: Map<string, OverleafThread>): Promise<void> {
    const byOverleaf = new Map(Object.entries(this.state.threads).map(([tw, st]) => [st.overleafThread, tw]));
    // Anchors seen on the live channel can be stale by the time a thread is
    // imported (its words edited meanwhile): ask Overleaf where they are now.
    if ([...threads.keys()].some((tid) => !byOverleaf.has(tid))) {
      try {
        for (const [tid, anchor] of await this.rest.ranges()) this.anchors.set(tid, anchor);
      } catch (err) {
        if (err instanceof OverleafError && err.kind === 'session') throw err;
      }
    }
    const here = new Map(allThreads(this.project.doc).map((t) => [t.id, t]));
    for (const [tid, th] of threads) {
      const twId = byOverleaf.get(tid);
      if (!twId) {
        // New on Overleaf: needs its anchor (in a joined document) and a first message.
        const anchor = this.anchors.get(tid);
        if (!anchor || !th.messages.length) continue;
        const path = this.docPath(anchor.docId);
        if (!path) continue;
        const first = th.messages[0];
        const id = this.project.importThread({
          path, from: anchor.p, to: anchor.p + anchor.quote.length, quote: anchor.quote,
          author: this.overleafAuthor(first), login: '', createdAt: first.timestamp || Date.now(),
          resolved: th.resolved,
          messages: th.messages.map((m) => ({ id: randomUUID().slice(0, 8), author: this.overleafAuthor(m), login: '', ts: m.timestamp || Date.now(), text: m.content })),
        }, this.origin(LINK_AUTHOR));
        if (!id) continue;
        const imported = allThreads(this.project.doc).find((t) => t.id === id);
        const st: ThreadState = { overleafThread: tid, docId: anchor.docId, resolved: th.resolved, anchored: true, messages: {}, agreed: {} };
        imported?.messages.forEach((m, i) => {
          const o = th.messages[i];
          st.messages[m.id] = o?.id ?? '';
          if (o) st.agreed![m.id] = { tw: m.text, ol: o.content };
        });
        this.state.threads[id] = st;
        continue;
      }
      const st = this.state.threads[twId];
      st.agreed ??= {};
      const t = here.get(twId);
      if (!t) continue; // deleted here: pushComments deletes it on Overleaf
      const olById = new Map(th.messages.map((m) => [m.id, m]));
      // Messages both sides have: edited or deleted on Overleaf since they last agreed.
      for (const [twMsgId, olId] of Object.entries(st.messages)) {
        if (!olId) continue;
        const twMsg = t.messages.find((m) => m.id === twMsgId);
        const olMsg = olById.get(olId);
        if (!twMsg) continue; // deleted here: pushComments
        if (!olMsg) {
          // Deleted on Overleaf. The first message stays: here it carries the thread.
          if (t.messages[0]?.id !== twMsgId) this.project.setMessage(twId, twMsgId, null, this.origin(LINK_AUTHOR));
          delete st.messages[twMsgId];
          delete st.agreed[twMsgId];
          continue;
        }
        const agreed = st.agreed[twMsgId];
        if (agreed && olMsg.content !== agreed.ol) {
          const text = this.incoming(olMsg.content, twMsg.author);
          this.project.setMessage(twId, twMsgId, text, this.origin(LINK_AUTHOR));
          st.agreed[twMsgId] = { tw: text, ol: olMsg.content };
        } else if (!agreed) st.agreed[twMsgId] = { tw: twMsg.text, ol: olMsg.content };
      }
      const mapped = new Set(Object.values(st.messages).filter(Boolean));
      const toImport: OverleafThread['messages'] = [];
      for (const m of th.messages) {
        if (mapped.has(m.id)) continue;
        // One of ours coming back: same account, same text, not yet paired.
        const twMsg = m.userId === this.rest.userId
          ? t.messages.find((x) => st.messages[x.id] === '' && this.outgoing(x) === m.content)
          : undefined;
        if (twMsg) {
          st.messages[twMsg.id] = m.id;
          st.agreed[twMsg.id] = { tw: twMsg.text, ol: m.content };
        } else toImport.push(m);
      }
      if (toImport.length) {
        const ids = this.project.appendMessages(twId, toImport.map((m) => ({
          author: this.overleafAuthor(m), login: '', ts: m.timestamp || Date.now(), text: m.content,
        })), this.origin(LINK_AUTHOR));
        ids.forEach((mid, i) => {
          st.messages[mid] = toImport[i].id;
          st.agreed![mid] = { tw: toImport[i].content, ol: toImport[i].content };
        });
      }
      if (th.resolved !== st.resolved) {
        st.resolved = th.resolved;
        if (t.resolved !== th.resolved) this.project.setResolved(twId, th.resolved, LINK_AUTHOR, this.origin(LINK_AUTHOR));
      }
    }
    // Deleted on Overleaf.
    for (const [twId, st] of Object.entries(this.state.threads)) {
      if (st.anchored && !threads.has(st.overleafThread)) {
        this.project.deleteThread(twId, this.origin(LINK_AUTHOR));
        delete this.state.threads[twId];
      }
    }
  }

  private async pushComments(threads: Map<string, OverleafThread>): Promise<void> {
    const remote = this.tree.byPath();
    const here = allThreads(this.project.doc);
    const present = new Set(here.map((t) => t.id));
    for (const t of here) {
      let st = this.state.threads[t.id];
      if (!st) {
        const entity = remote.get(t.path);
        if (!entity || entity.kind !== 'doc' || t.from === null || t.to === null || !t.messages.length) continue;
        st = { overleafThread: newThreadId(), docId: entity.id, resolved: false, anchored: false, messages: {}, agreed: {} };
        this.state.threads[t.id] = st;
      }
      st.agreed ??= {};
      const ids = new Set(t.messages.map((m) => m.id));
      // Messages first (Overleaf's own editor posts the first message, then the anchor).
      for (const m of t.messages) {
        if (m.id in st.messages) {
          // Edited here since both sides agreed.
          const olId = st.messages[m.id];
          const agreed = st.agreed[m.id];
          if (olId && agreed && m.text !== agreed.tw) {
            await this.rest.editMessage(st.overleafThread, olId, this.outgoing(m));
            st.agreed[m.id] = { tw: m.text, ol: this.outgoing(m) };
          }
          continue;
        }
        await this.rest.postMessage(st.overleafThread, this.outgoing(m));
        st.messages[m.id] = '';
      }
      // Deleted here.
      for (const [twMsgId, olId] of Object.entries(st.messages)) {
        if (ids.has(twMsgId)) continue;
        if (olId) await this.rest.deleteMessage(st.overleafThread, olId);
        delete st.messages[twMsgId];
        delete st.agreed[twMsgId];
      }
      if (!st.anchored) await this.sendAnchor(t.id, st);
      if (!st.anchored) continue;
      if (t.resolved !== st.resolved) {
        await this.rest.setResolved(st.docId, st.overleafThread, t.resolved);
        st.resolved = t.resolved;
      }
    }
    for (const [twId, st] of Object.entries(this.state.threads)) {
      if (present.has(twId)) continue;
      if (threads.has(st.overleafThread)) await this.rest.deleteThread(st.docId, st.overleafThread);
      delete this.state.threads[twId];
    }
  }

  /** Put a thread's anchor on Overleaf; waits for the document to have nothing in flight. */
  private async sendAnchor(twId: string, st: ThreadState): Promise<void> {
    const doc = this.docs.get(st.docId);
    const socket = this.socket;
    if (!doc || !doc.ot || !socket || doc.buffered) return;
    this.flushLocal(doc, true);
    const t = allThreads(this.project.doc).find((x) => x.id === twId);
    if (!t || t.from === null || t.to === null) return;
    const slot = doc.ot.anchor();
    if (!slot) { this.scheduleComments(); return; } // an edit is in flight: next round
    const quote = doc.ot.text.slice(t.from, t.to);
    doc.ot.noteSubmitted(socket.publicId);
    await socket.call('applyOtUpdate', [doc.id, { doc: doc.id, op: [{ p: t.from, c: quote, t: st.overleafThread }], v: slot.version }]);
    st.anchored = true;
    this.anchors.set(st.overleafThread, { docId: doc.id, p: t.from, quote });
  }

  // ------------------------------------------------------------ persisting

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, SAVE_DELAY_MS);
  }

  private writeBase(id: string, text: string): void {
    const dir = join(this.project.dir, '.texwerk', 'overleaf-base');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.basePath(id)}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, this.basePath(id));
  }

  saveNow(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!existsSync(join(this.project.dir, '.texwerk'))) return;
    for (const doc of this.docs.values()) {
      const st = this.state.docs[doc.id];
      if (doc.confirmed && st && doc.confirmed.version !== st.version) {
        this.writeBase(doc.id, doc.confirmed.text);
        st.version = doc.confirmed.version;
      }
    }
    const file = statePath(this.project.dir);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }
}

// ------------------------------------------------------------- first link

export interface LinkPreview {
  /** Overleaf's name for the project. */
  name: string;
  /** Overleaf's account name for the cookie. */
  account: string;
  same: string[];
  /** Only on Overleaf: copied here. */
  toTexwerk: string[];
  /** Only here: copied to Overleaf. */
  toOverleaf: string[];
  /**
   * On both sides with different content: the owner picks a side for each.
   * Text files carry both versions (up to PREVIEW_TEXT_LIMIT each) so the
   * dialog can show how they differ.
   */
  differ: Array<{ path: string; kind: 'text' | 'binary'; texwerk?: string; overleaf?: string }>;
}

const PREVIEW_TEXT_LIMIT = 300_000;

/**
 * Look at both sides without changing either: what a first link would copy
 * which way, and which files differ. Opens and closes its own connection.
 */
export async function previewLink(project: Project, origin: string, projectId: string, cookie: string): Promise<LinkPreview> {
  const rest = new OverleafRest(origin, projectId, cookie);
  await rest.signIn();
  const { socket, joined } = await OverleafSocket.connect({ origin, cookie, projectId, onEvent: () => {}, onClose: () => {} });
  try {
    const level = joined.permissionsLevel || String(joined.project.permissionsLevel ?? '');
    if (level && !['owner', 'readAndWrite'].includes(level)) throw new OverleafError('access', 'This Overleaf account cannot edit the project (it has read-only or review access).');
    const tree = Tree.fromJoin(joined.project);
    const out: LinkPreview = { name: String(joined.project.name ?? ''), account: '', same: [], toTexwerk: [], toOverleaf: [], differ: [] };
    for (const u of [joined.project.owner, ...(Array.isArray(joined.project.members) ? joined.project.members : [])]) {
      const user = u as Record<string, unknown> | undefined;
      if (user && user._id === rest.userId) out.account = personName(user);
    }
    const remote = tree.byPath();
    const local = new Set([...project.texts.keys(), ...project.bins.keys()]);
    for (const [path, e] of remote) {
      if (e.kind === 'folder') continue;
      if (!local.has(path)) { out.toTexwerk.push(path); continue; }
      const here = project.texts.get(path);
      if (e.kind === 'doc') {
        const answer = await socket.call('joinDoc', [e.id, -1, { encodeRanges: true }]);
        const text = (Array.isArray(answer[0]) ? answer[0] : []).map((l) => decodePacked(String(l))).join('\n');
        await socket.call('leaveDoc', [e.id]).catch(() => {});
        const mine = here ? here.toString().replace(/\r/g, '') : null;
        if (mine === text) out.same.push(path);
        else if (mine !== null && mine.length <= PREVIEW_TEXT_LIMIT && text.length <= PREVIEW_TEXT_LIMIT) out.differ.push({ path, kind: 'text', texwerk: mine, overleaf: text });
        else out.differ.push({ path, kind: 'text' });
      } else {
        const data = await rest.download(e.id, e.hash);
        const mineHash = here ? hashBytes(Buffer.from(here.toString(), 'utf8')) : project.bins.get(path)?.hash;
        if (mineHash === hashBytes(data)) out.same.push(path);
        else out.differ.push({ path, kind: 'binary' });
      }
    }
    for (const path of local) if (!remote.has(path)) out.toOverleaf.push(path);
    for (const list of [out.same, out.toTexwerk, out.toOverleaf]) list.sort();
    out.differ.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  } finally {
    socket.close();
  }
}
