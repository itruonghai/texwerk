/**
 * The Overleaf link end to end: a real Project (Y.Doc, files on disk), the
 * real link, and a mock Overleaf (test/support/mockOverleaf.ts) that speaks
 * the same Socket.IO 0.9 / OT / REST protocol. "Alice" types in Overleaf
 * through a real OT client on her own connection; "Bob" types in TeXWerk.
 *
 *   node --test test/overleaf-link.test.ts
 */
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import type * as Y from 'yjs';
import { allThreads } from '../src/shared/comments.ts';
import { Project } from '../src/server/project.ts';
import { OverleafLink, readLinkState, setHashInterval, type Choices, type LinkState } from '../src/server/overleaf/link.ts';
import { OtDocument, type OtOp } from '../src/server/overleaf/ot.ts';
import { decodePacked, OverleafSocket } from '../src/server/overleaf/socketio.ts';
import { MockOverleaf, type MockUser } from './support/mockOverleaf.ts';

const cleanup: Array<() => Promise<void>> = [];
after(async () => { for (const c of cleanup.reverse()) await c().catch(() => {}); });

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!await check()) {
    if (Date.now() - start > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A random place in `text` that is not inside a <token> or [token], so tokens are never split. */
function gap(text: string, r: () => number): number {
  const places: number[] = [];
  let depth = 0;
  for (let i = 0; i <= text.length; i++) {
    if (depth === 0) places.push(i);
    const c = text[i];
    if (c === '<' || c === '[') depth++;
    else if (c === '>' || c === ']') depth--;
  }
  return places[Math.floor(r() * places.length)];
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

interface World {
  mock: MockOverleaf;
  hai: MockUser;
  alice: MockUser;
  dir: string;
  project: Project;
  link: OverleafLink;
  text(path: string): string | undefined;
  bob(path: string, fn: (t: Y.Text) => void): void;
  restart(): Promise<void>;
}

async function world(opts: { overleaf?: Record<string, string | Buffer>; local?: Record<string, string | Buffer>; choices?: Choices; noStart?: boolean } = {}): Promise<World> {
  const mock = new MockOverleaf();
  const hai = mock.addUser('hai', 'Hai');
  const alice = mock.addUser('alice', 'Alice');
  for (const [p, c] of Object.entries(opts.overleaf ?? {})) {
    if (typeof c === 'string') mock.addDoc(p, c, false);
    else mock.addFile(p, c, false);
  }
  await mock.start();
  const dir = await mkdtemp(join(tmpdir(), 'texwerk-overleaf-'));
  for (const [p, c] of Object.entries(opts.local ?? {})) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), c);
  }
  const state: LinkState = {
    origin: mock.origin, projectId: mock.projectId, cookie: 'overleaf_session2=hai', linkedBy: 'hai', linkedByName: 'Hai',
    rootFolderId: '', docs: {}, files: {}, threads: {},
  };
  const w: World = {
    mock, hai, alice, dir,
    project: null as unknown as Project,
    link: null as unknown as OverleafLink,
    text: (p) => w.project.texts.get(p)?.toString(),
    bob: (p, fn) => w.project.transactAs('Bob', () => fn(w.project.texts.get(p)!), { author: 'Bob' }),
    async restart() {
      await w.project.close();
      w.project = new Project('Paper', dir);
      await w.project.open();
      w.link = new OverleafLink(w.project, readLinkState(dir)!);
      w.link.start();
      await until('live after restart', () => w.link.isLive);
      await w.link.idle();
    },
  };
  w.project = new Project('Paper', dir);
  await w.project.open();
  w.link = new OverleafLink(w.project, state, opts.choices ?? null);
  cleanup.push(async () => {
    await w.project.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  });
  if (!opts.noStart) {
    w.link.start();
    await until('live', () => w.link.isLive);
    await w.link.idle();
  }
  return w;
}

/** Both sides hold the same text for every doc, and the link has nothing pending. */
async function converged(w: World, ms = 15_000): Promise<void> {
  await until('both sides equal', async () => {
    await w.link.idle();
    const remote = w.mock.snapshot();
    for (const [p, c] of Object.entries(remote)) {
      if (c.startsWith('base64:')) continue;
      if (w.text(p) !== c) return false;
    }
    return true;
  }, ms);
}

/** Alice in Overleaf's editor: her own connection, a real OT client. */
async function overleafEditor(w: World, path: string): Promise<{ type(edit: (text: string) => string): void; text(): string; settled(): boolean; close(): void }> {
  const docId = w.mock.find(path)!.id;
  let ot: OtDocument | null = null;
  const pending: Array<{ name: string; args: unknown[] }> = [];
  let socketRef: OverleafSocket | null = null;
  const send = (s: { version: number; ops: OtOp[] } | null) => {
    if (!s || !socketRef) return;
    ot!.noteSubmitted(socketRef.publicId);
    void socketRef.call('applyOtUpdate', [docId, { doc: docId, op: s.ops, v: s.version }]).catch(() => {});
  };
  const onEvent = (name: string, args: unknown[]) => {
    if (!ot) { pending.push({ name, args }); return; }
    if (name !== 'otUpdateApplied') return;
    const u = args[0] as { doc: string; v: number; op?: OtOp[] };
    if (u.doc !== docId) return;
    if (!u.op) send(ot.acknowledge(u.v).send);
    else ot.remote(u.op.filter((o) => 'i' in o || 'd' in o), u.v);
  };
  const { socket } = await OverleafSocket.connect({ origin: w.mock.origin, cookie: 'overleaf_session2=alice', projectId: w.mock.projectId, onEvent, onClose: () => {} });
  socketRef = socket;
  const answer = await socket.call('joinDoc', [docId, -1, { encodeRanges: true }]);
  ot = new OtDocument((answer[0] as string[]).map(decodePacked).join('\n'), Number(answer[1]));
  for (const e of pending.splice(0)) onEvent(e.name, e.args);
  return {
    type(edit) { send(ot!.local(edit(ot!.text)).send); },
    text: () => ot!.text,
    settled: () => ot!.settled,
    close: () => socket.close(),
  };
}

// ------------------------------------------------------------- first link

test('first link: same files untouched, one-sided files copied both ways, differing files follow the choice', async () => {
  const w = await world({
    overleaf: {
      'main.tex': 'Overleaf main\n', 'intro.tex': 'Overleaf intro\n', 'same.tex': 'identical\n',
      'only-overleaf.tex': 'from Overleaf ✓ ü 中\n', 'figs/plot.png': Buffer.from([137, 80, 78, 71, 0, 1, 2]),
    },
    local: {
      'main.tex': 'TeXWerk main\n', 'intro.tex': 'TeXWerk intro\n', 'same.tex': 'identical\n',
      'only-here.bib': '@misc{k}\n', 'data/scan.pdf': Buffer.from('%PDF-1.4 binary \u0000 bytes'),
    },
    choices: { 'main.tex': 'texwerk', 'intro.tex': 'overleaf' },
  });
  await converged(w);
  assert.equal(w.mock.text('main.tex'), 'TeXWerk main\n', 'TeXWerk side chosen');
  assert.equal(w.text('intro.tex'), 'Overleaf intro\n', 'Overleaf side chosen');
  assert.equal(w.text('only-overleaf.tex'), 'from Overleaf ✓ ü 中\n', 'packed UTF-8 decoded on the way in');
  assert.equal(w.mock.text('only-here.bib'), '@misc{k}\n', 'only-here.bib uploaded, and Overleaf made it a doc');
  assert.deepEqual(w.mock.find('data/scan.pdf')?.data, Buffer.from('%PDF-1.4 binary \u0000 bytes'));
  assert.deepEqual(await readFile(join(w.dir, 'figs/plot.png')), Buffer.from([137, 80, 78, 71, 0, 1, 2]));
  assert.equal(w.link.info().status, 'live');
  w.link.saveNow();
  const saved = JSON.parse(await readFile(join(w.dir, '.texwerk', 'overleaf.json'), 'utf8')) as LinkState;
  assert.equal(saved.cookie, 'overleaf_session2=hai');
  assert.equal(((await import('node:fs')).statSync(join(w.dir, '.texwerk', 'overleaf.json')).mode & 0o777), 0o600, 'the cookie file is private');
});

// ------------------------------------------------------------- live text

test('live text: edits go both ways, Overleaf edits are attributed to "Name · Overleaf"', async () => {
  const w = await world({ overleaf: { 'main.tex': 'one\ntwo\nthree\n' } });
  w.bob('main.tex', (t) => t.insert(0, 'Bob was here. '));
  await until('Bob on Overleaf', () => w.mock.text('main.tex')!.startsWith('Bob was here. '));
  w.mock.edit(w.alice._id, 'main.tex', [{ p: w.mock.text('main.tex')!.length, i: 'four\n' }]);
  await until('Alice in TeXWerk', () => w.text('main.tex')!.endsWith('four\n'));
  await converged(w);
  const authors = [...w.project.authors.values()].map((a) => a.name);
  assert.ok(authors.includes('Alice Test · Overleaf'), `authors: ${authors.join(', ')}`);
  await w.project.persistAll();
  assert.equal(await readFile(join(w.dir, 'main.tex'), 'utf8'), w.mock.text('main.tex'), 'reaches the file on disk');
});

for (const seed of [1, 2, 3, 4]) {
  test(`concurrent typing on both sides converges, with every keystroke kept (seed ${seed})`, async () => {
    const w = await world({ overleaf: { 'main.tex': 'The quick brown fox.\nJumps over.\n' } });
    w.mock.latencyMs = 3 + seed * 3;
    const alice = await overleafEditor(w, 'main.tex');
    cleanup.push(async () => alice.close());
    const r = rng(seed);
    const tokens: string[] = [];
    for (let step = 0; step < 120; step++) {
      const token = `<${step}>`;
      tokens.push(token);
      const who = r();
      if (who < 0.4) w.bob('main.tex', (t) => t.insert(gap(t.toString(), r), token));
      else if (who < 0.8) alice.type((text) => { const p = gap(text, r); return text.slice(0, p) + token + text.slice(p); });
      else w.mock.edit(w.hai._id, 'main.tex', [{ p: gap(w.mock.text('main.tex')!, r), i: token }]);
      if (r() < 0.3) await sleep(Math.floor(r() * 25));
    }
    await until('Alice settled', () => alice.settled());
    await converged(w);
    await until('Alice equal', () => alice.text() === w.mock.text('main.tex'));
    const final = w.text('main.tex')!;
    for (const t of tokens) assert.equal(final.split(t).length - 1, 1, `${t} appears exactly once`);
  });
}

test('concurrent inserts and deletes on both sides converge (mixed fuzz)', async () => {
  const w = await world({ overleaf: { 'main.tex': 'abcdefghijklmnopqrstuvwxyz\n'.repeat(4) } });
  w.mock.latencyMs = 8;
  const alice = await overleafEditor(w, 'main.tex');
  cleanup.push(async () => alice.close());
  const r = rng(77);
  for (let step = 0; step < 150; step++) {
    const del = r() < 0.4;
    if (r() < 0.5) {
      w.bob('main.tex', (t) => {
        const p = Math.floor(r() * t.length);
        if (del && t.length > 5) t.delete(p, Math.min(3, t.length - p));
        else t.insert(p, 'B');
      });
    } else {
      alice.type((text) => {
        const p = Math.floor(r() * text.length);
        return del && text.length > 5 ? text.slice(0, p) + text.slice(p + 3) : `${text.slice(0, p)}A${text.slice(p)}`;
      });
    }
    if (r() < 0.25) await sleep(Math.floor(r() * 20));
  }
  await until('Alice settled', () => alice.settled());
  await converged(w);
  await until('Alice equal', () => alice.text() === w.text('main.tex'));
});

test('emoji become U+FFFD on both sides (as Overleaf stores them); CRLF becomes LF', async () => {
  const w = await world({ overleaf: { 'main.tex': 'x\n' } });
  w.bob('main.tex', (t) => t.insert(0, 'smile 😀 '));
  await converged(w);
  assert.equal(w.text('main.tex'), 'smile �� x\n');
  w.bob('main.tex', (t) => t.insert(t.length, 'windows\r\nline\r\n'));
  await converged(w);
  assert.equal(w.text('main.tex'), 'smile �� x\nwindows\nline\n');
});

// ---------------------------------------------------------- reconnects

test('a dropped connection catches up: edits from both sides while apart, nothing doubled', async () => {
  const w = await world({ overleaf: { 'main.tex': 'start\n' } });
  w.bob('main.tex', (t) => t.insert(t.length, 'bob-1\n'));
  await converged(w);
  // Overleaf applies Bob's next edit, but the connection drops before the echo.
  w.mock.dropAfterApply = true;
  w.bob('main.tex', (t) => t.insert(t.length, 'bob-2\n'));
  await until('applied on Overleaf', () => w.mock.text('main.tex')!.includes('bob-2'));
  await until('link noticed', () => !w.link.isLive);
  // While apart: both sides keep editing.
  w.bob('main.tex', (t) => t.insert(0, 'bob-3\n'));
  w.mock.edit(w.alice._id, 'main.tex', [{ p: 0, i: 'alice-1\n' }]);
  await until('live again', () => w.link.isLive, 20_000);
  await converged(w);
  const final = w.text('main.tex')!;
  for (const t of ['bob-1', 'bob-2', 'bob-3', 'alice-1']) assert.equal(final.split(t).length - 1, 1, `${t} once in ${JSON.stringify(final)}`);
});

test('repeated drops during typing still converge', async () => {
  const w = await world({ overleaf: { 'main.tex': 'x\n' } });
  w.mock.latencyMs = 10;
  const r = rng(11);
  const tokens: string[] = [];
  for (let step = 0; step < 60; step++) {
    const token = `[${step}]`;
    tokens.push(token);
    if (r() < 0.5) w.bob('main.tex', (t) => t.insert(gap(t.toString(), r), token));
    else w.mock.edit(w.alice._id, 'main.tex', [{ p: gap(w.mock.text('main.tex')!, r), i: token }]);
    if (step % 20 === 10) w.mock.dropAll();
    await sleep(Math.floor(r() * 30));
  }
  await until('live', () => w.link.isLive, 30_000);
  await converged(w, 30_000);
  const final = w.text('main.tex')!;
  for (const t of tokens) assert.equal(final.split(t).length - 1, 1, `${t} once`);
});

test('a server restart merges what both sides did meanwhile (different lines)', async () => {
  const w = await world({ overleaf: { 'main.tex': 'line 1\nline 2\nline 3\nline 4\nline 5\n' } });
  await w.project.close(); // the TeXWerk server stops
  w.mock.setText(w.alice._id, 'main.tex', 'line 1 (Alice)\nline 2\nline 3\nline 4\nline 5\n');
  await writeFile(join(w.dir, 'main.tex'), 'line 1\nline 2\nline 3\nline 4\nline 5 (edited on disk)\n');
  w.project = new Project('Paper', w.dir);
  await w.project.open();
  w.link = new OverleafLink(w.project, readLinkState(w.dir)!);
  w.link.start();
  await until('live', () => w.link.isLive);
  await converged(w);
  assert.equal(w.text('main.tex'), 'line 1 (Alice)\nline 2\nline 3\nline 4\nline 5 (edited on disk)\n');
  assert.deepEqual(w.link.info().conflicts, []);
});

test('a server restart with both sides changing one line keeps both versions and says so in the chat', async () => {
  const w = await world({ overleaf: { 'main.tex': 'a\nb\nc\n' } });
  await w.project.close();
  w.mock.setText(w.alice._id, 'main.tex', 'a\nB from Overleaf\nc\n');
  await writeFile(join(w.dir, 'main.tex'), 'a\nB from TeXWerk\nc\n');
  w.project = new Project('Paper', w.dir);
  await w.project.open();
  w.link = new OverleafLink(w.project, readLinkState(w.dir)!);
  w.link.start();
  await until('live', () => w.link.isLive);
  await converged(w);
  assert.equal(w.text('main.tex'), 'a\n%<<<<<<< TeXWerk\nB from TeXWerk\n%=======\nB from Overleaf\n%>>>>>>> Overleaf\nc\n');
  assert.deepEqual(w.link.info().conflicts, ['main.tex']);
  assert.ok(w.project.chat.toArray().some((m) => m.text.includes('main.tex:2')), 'the chat names the place');
});

test('a drifted copy (hash mismatch) is noticed, rejoined and merged', async () => {
  setHashInterval(0);
  try {
    const w = await world({ overleaf: { 'main.tex': 'hello\nworld\n' } });
    // Overleaf's copy changes without telling anyone: the next update's hash will not match.
    w.mock.find('main.tex')!.text = 'hello\nworld\nsilent change\n';
    w.bob('main.tex', (t) => t.insert(0, 'Bob: '));
    await until('rejected', () => (w.mock.hits.get('otUpdateError') ?? 0) > 0);
    await until('live again', () => w.link.isLive, 20_000);
    await converged(w);
    assert.equal(w.text('main.tex'), 'Bob: hello\nworld\nsilent change\n');
  } finally {
    setHashInterval(5000);
  }
});

test('an expired cookie stops the link until a new one is given; local edits wait and then go', async () => {
  const w = await world({ overleaf: { 'main.tex': 'x\n' } });
  w.mock.expire('hai');
  await until('expired', () => w.link.info().status === 'expired', 20_000);
  w.bob('main.tex', (t) => t.insert(0, 'typed while expired\n'));
  await sleep(300);
  assert.equal(w.mock.text('main.tex'), 'x\n');
  w.mock.sessions.set('hai-new', w.hai._id);
  await w.link.setCookie('overleaf_session2=hai-new');
  await until('live', () => w.link.isLive);
  await converged(w);
  assert.equal(w.mock.text('main.tex'), 'typed while expired\nx\n');
  assert.equal(readLinkState(w.dir)!.cookie, 'overleaf_session2=hai-new');
});

test('read-only access to the Overleaf project is refused, nothing is changed', async () => {
  const mockLevel = 'readOnly';
  const w = await world({ overleaf: { 'main.tex': 'theirs\n' }, local: { 'main.tex': 'ours\n' }, noStart: true });
  w.mock.permissionsLevel = mockLevel;
  w.link.start();
  await until('lost', () => w.link.info().status === 'lost');
  assert.equal(w.text('main.tex'), 'ours\n');
  assert.equal(w.mock.text('main.tex'), 'theirs\n');
});

// ------------------------------------------------------------- the tree

test('tree, TeXWerk → Overleaf: new text and binary files, rename keeps the entity, delete', async () => {
  const w = await world({ overleaf: { 'main.tex': 'main\n', 'old.tex': 'old\n' } });
  await w.project.putFile('chapters/new.tex', Buffer.from('new chapter\n'), 'Bob');
  await w.project.putFile('img/a.png', Buffer.from([1, 2, 3]), 'Bob');
  await until('uploaded', () => w.mock.text('chapters/new.tex') === 'new chapter\n' && !!w.mock.find('img/a.png'));
  const oldId = w.mock.find('old.tex')!.id;
  await w.project.move('old.tex', 'chapters/renamed.tex', 'Bob');
  await until('renamed on Overleaf', () => w.mock.find('chapters/renamed.tex')?.id === oldId);
  assert.equal(w.mock.find('old.tex'), undefined);
  // The renamed doc is still live.
  w.bob('chapters/renamed.tex', (t) => t.insert(0, 'still live: '));
  await until('edit after rename', () => w.mock.text('chapters/renamed.tex') === 'still live: old\n');
  await w.project.remove('img/a.png', 'Bob');
  await until('deleted on Overleaf', () => !w.mock.find('img/a.png'));
  // Replacing a binary replaces it on Overleaf and does not delete it here.
  await w.project.putFile('logo.png', Buffer.from([9, 9]), 'Bob');
  await until('logo up', () => !!w.mock.find('logo.png'));
  await w.project.putFile('logo.png', Buffer.from([7, 7, 7]), 'Bob');
  await until('logo replaced', () => w.mock.find('logo.png')?.data?.equals(Buffer.from([7, 7, 7])) === true);
  await sleep(1500);
  assert.ok(w.project.bins.has('logo.png'), 'still here');
  await converged(w);
});

test('tree, Overleaf → TeXWerk: new doc, file and folder, rename, move, delete', async () => {
  const w = await world({ overleaf: { 'main.tex': 'main\n', 'b.tex': 'b\n' } });
  w.mock.addDoc('ch/one.tex', 'chapter one\n');
  w.mock.addFile('fig.png', Buffer.from([5, 6]));
  await until('new doc here', () => w.text('ch/one.tex') === 'chapter one\n');
  await until('new file here', () => w.project.bins.has('fig.png'));
  w.mock.edit(w.alice._id, 'ch/one.tex', [{ p: 0, i: 'Alice: ' }]);
  await until('new doc is live', () => w.text('ch/one.tex') === 'Alice: chapter one\n');
  w.mock.rename('b.tex', 'bee.tex');
  await until('renamed here', () => w.text('bee.tex') === 'b\n' && !w.project.texts.has('b.tex'));
  w.mock.move('bee.tex', 'ch');
  await until('moved here', () => w.text('ch/bee.tex') === 'b\n');
  w.bob('ch/bee.tex', (t) => t.insert(0, 'B'));
  await until('moved doc still live', () => w.mock.text('ch/bee.tex') === 'Bb\n');
  w.mock.remove('fig.png');
  await until('deleted here', () => !w.project.bins.has('fig.png'));
  assert.ok((await w.project.listTrash()).some((t) => t.path === 'fig.png'), 'restorable from the trash');
  await converged(w);
});

test('deleting most files at once here is not passed on to Overleaf', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 8; i++) files[`f${i}.tex`] = `${i}\n`;
  const w = await world({ overleaf: files });
  for (let i = 0; i < 7; i++) await w.project.remove(`f${i}.tex`, 'Bob');
  await sleep(1500);
  await w.link.idle();
  assert.equal(Object.keys(w.mock.snapshot()).length, 8, 'nothing deleted on Overleaf');
  assert.match(w.link.info().message, /Not deleting 7 of 8/);
});

test('files deleted on Overleaf while the server was down are deleted here (unless changed here)', async () => {
  const w = await world({ overleaf: { 'main.tex': 'm\n', 'gone.tex': 'g\n', 'kept.tex': 'k\n' } });
  await w.project.close();
  w.mock.remove('gone.tex');
  w.mock.remove('kept.tex');
  await writeFile(join(w.dir, 'kept.tex'), 'k changed here\n');
  w.project = new Project('Paper', w.dir);
  await w.project.open();
  w.link = new OverleafLink(w.project, readLinkState(w.dir)!);
  w.link.start();
  await until('live', () => w.link.isLive);
  await converged(w);
  assert.equal(w.project.texts.has('gone.tex'), false);
  assert.equal(w.text('kept.tex'), 'k changed here\n', 'a file changed here is kept');
  await until('kept.tex goes back up', () => w.mock.text('kept.tex') === 'k changed here\n');
});

// ------------------------------------------------------------- comments

test('comments: an Overleaf thread arrives anchored, with authors; replies and resolve go both ways', async () => {
  const w = await world({ overleaf: { 'main.tex': 'We use implicit neural fields here.\n' } });
  const quote = 'implicit neural fields';
  const at = w.mock.text('main.tex')!.indexOf(quote);
  const tid = w.mock.comment(w.alice._id, 'main.tex', at, at + quote.length, 'Cite the survey?');
  await until('thread here', () => allThreads(w.project.doc).length === 1);
  let t = allThreads(w.project.doc)[0];
  assert.equal(t.quote, quote);
  assert.equal(t.from, at);
  assert.equal(t.messages[0].author, 'Alice Test · Overleaf');
  assert.equal(t.messages[0].text, 'Cite the survey?');

  // Bob replies in TeXWerk.
  w.project.reply(t.id, 'Added \\cite{tewari2022}.', 'Bob', 'bob');
  await until('reply on Overleaf', () => w.mock.threads.get(tid)!.messages.length === 2);
  assert.equal(w.mock.threads.get(tid)!.messages[1].content, '[Bob] Added \\cite{tewari2022}.');
  // Alice replies on Overleaf.
  w.mock.message(w.alice._id, tid, 'Thanks!');
  await until('reply here', () => allThreads(w.project.doc)[0].messages.length === 3);
  // Bob resolves here; Alice reopens there.
  w.project.setResolved(t.id, true, 'Bob');
  await until('resolved there', () => w.mock.threads.get(tid)!.resolved);
  w.mock.resolve(tid, false);
  await until('reopened here', () => !allThreads(w.project.doc)[0].resolved);
  await sleep(1200);
  await w.link.idle();
  t = allThreads(w.project.doc)[0];
  assert.equal(t.messages.length, 3, 'no echoes');
  assert.equal(w.mock.threads.get(tid)!.messages.length, 3, 'no echoes there either');
  // The owner's own messages go without a name prefix.
  w.project.reply(t.id, 'Owner here.', 'Hai', 'hai');
  await until('owner reply', () => w.mock.threads.get(tid)!.messages.length === 4);
  assert.equal(w.mock.threads.get(tid)!.messages[3].content, 'Owner here.');
});

test('comments: a TeXWerk thread gets an Overleaf thread with its anchor on the right text', async () => {
  const w = await world({ overleaf: { 'main.tex': 'Alpha beta gamma delta.\n' } });
  const from = 'Alpha '.length;
  const id = w.project.createComment('main.tex', from, from + 'beta gamma'.length, 'Rephrase?', 'Bob', 'bob');
  await until('thread on Overleaf', () => w.mock.ranges().size === 1 && w.mock.threads.size === 1);
  const [tid, range] = [...w.mock.ranges()][0];
  assert.equal(range.c, 'beta gamma');
  assert.equal(range.p, from);
  assert.equal(w.mock.threads.get(tid)!.messages[0].content, '[Bob] Rephrase?');
  // Typing before it moves the anchor on both sides.
  w.mock.edit(w.alice._id, 'main.tex', [{ p: 0, i: 'Intro. ' }]);
  w.bob('main.tex', (t) => t.insert(0, 'Bob. '));
  await converged(w);
  const t = allThreads(w.project.doc).find((x) => x.id === id)!;
  assert.equal(w.text('main.tex')!.slice(t.from!, t.to!), 'beta gamma');
  assert.equal(w.mock.ranges().get(tid)!.c, 'beta gamma');
  // Deleting it here deletes it there.
  w.project.deleteThread(id, { author: 'Bob' });
  await until('deleted on Overleaf', () => !w.mock.threads.has(tid) && w.mock.ranges().size === 0);
});

test('comments: deleting a thread on Overleaf deletes it here; threads survive a restart without duplicates', async () => {
  const w = await world({ overleaf: { 'main.tex': 'one two three four\n' } });
  const keep = w.mock.comment(w.alice._id, 'main.tex', 0, 3, 'keep me');
  const drop = w.mock.comment(w.alice._id, 'main.tex', 4, 7, 'drop me');
  await until('two here', () => allThreads(w.project.doc).length === 2);
  w.mock.deleteThread(drop);
  await until('one here', () => allThreads(w.project.doc).length === 1);
  await w.restart();
  await sleep(800);
  await w.link.idle();
  const threads = allThreads(w.project.doc);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].messages[0].text, 'keep me');
  assert.equal(w.mock.threads.get(keep)!.messages.length, 1);
});

test('unlink stops syncing and forgets the cookie; files stay on both sides', async () => {
  const w = await world({ overleaf: { 'main.tex': 'x\n' } });
  await w.link.unlink();
  w.bob('main.tex', (t) => t.insert(0, 'after unlink '));
  await sleep(500);
  assert.equal(w.mock.text('main.tex'), 'x\n');
  assert.equal(readLinkState(w.dir), null);
  assert.equal(w.project.overleaf, null);
});

// ------------------------------------------------------------ the server

test('HTTP: preview, link, status without the cookie, new cookie, unlink; a restarted server resumes the link by itself', async () => {
  const { startServer } = await import('../src/server/server.ts');
  const mock = new MockOverleaf();
  const hai = mock.addUser('hai', 'Hai');
  const alice = mock.addUser('alice', 'Alice');
  mock.addDoc('main.tex', 'from Overleaf\n', false);
  mock.addDoc('only-there.tex', 'there\n', false);
  await mock.start();
  const root = await mkdtemp(join(tmpdir(), 'texwerk-overleaf-http-'));
  await mkdir(join(root, 'Paper'), { recursive: true });
  await writeFile(join(root, 'Paper', 'main.tex'), 'from TeXWerk\n');
  await writeFile(join(root, 'Paper', 'only-here.tex'), 'here\n');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const origin = `http://127.0.0.1:${port}`;
  const options = { rootDir: root, clientDir: null, bridgeFile: null, port, host: '127.0.0.1', access: null };
  let server = await startServer(options);
  cleanup.push(async () => { await server.close(); await mock.close(); await rm(root, { recursive: true, force: true }); });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${origin}${path}${path.includes('?') ? '&' : '?'}project=Paper&name=Bob`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };

  assert.deepEqual((await call('GET', '/api/overleaf')).body, { info: null, canManage: true });
  const bad = await call('POST', '/api/overleaf/preview', { url: mock.url, cookie: 'wrong' });
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /session cookie/);
  assert.equal((await call('POST', '/api/overleaf/preview', { url: 'https://example.com/nope', cookie: 'hai' })).status, 400);

  const preview = await call('POST', '/api/overleaf/preview', { url: mock.url, cookie: 'hai' });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body, {
    name: 'Paper', account: 'Hai Test', same: [], toTexwerk: ['only-there.tex'], toOverleaf: ['only-here.tex'],
    differ: [{ path: 'main.tex', kind: 'text', texwerk: 'from TeXWerk\n', overleaf: 'from Overleaf\n' }],
  });
  assert.equal(mock.text('main.tex'), 'from Overleaf\n', 'a preview changes nothing');

  const linked = await call('POST', '/api/overleaf/link', { url: mock.url, cookie: 'hai', choices: { 'main.tex': 'texwerk' } });
  assert.equal(linked.status, 200);
  await until('linked', async () => ((await call('GET', '/api/overleaf')).body.info as { status: string } | null)?.status === 'live');
  await until('synced', () => mock.text('main.tex') === 'from TeXWerk\n' && mock.text('only-here.tex') === 'here\n');
  await until('only-there here', async () => (await readFile(join(root, 'Paper', 'only-there.tex'), 'utf8').catch(() => '')) === 'there\n');
  const status = await call('GET', '/api/overleaf');
  assert.ok(!JSON.stringify(status.body).includes('overleaf_session2'), 'the cookie never comes back out');
  assert.equal((await call('POST', '/api/overleaf/link', { url: mock.url, cookie: 'hai' })).status, 409, 'linked once');

  // The server restarts while Alice keeps writing; nobody opens the project afterwards.
  await server.close();
  mock.edit(alice._id, 'main.tex', [{ p: 0, i: 'Alice while down. ' }]);
  server = await startServer(options);
  await until('resumed by itself, file updated', async () => (await readFile(join(root, 'Paper', 'main.tex'), 'utf8')) === 'Alice while down. from TeXWerk\n');
  mock.edit(alice._id, 'main.tex', [{ p: 0, i: 'And after. ' }]);
  await until('still live with nobody here', async () => (await readFile(join(root, 'Paper', 'main.tex'), 'utf8')) === 'And after. Alice while down. from TeXWerk\n');

  // A new cookie (the old one expired), then unlink.
  mock.expire('hai');
  await until('expired', async () => ((await call('GET', '/api/overleaf')).body.info as { status: string }).status === 'expired', 20_000);
  mock.sessions.set('hai2', hai._id);
  assert.equal((await call('POST', '/api/overleaf/cookie', { cookie: 'overleaf_session2=hai2' })).status, 200);
  await until('live again', async () => ((await call('GET', '/api/overleaf')).body.info as { status: string }).status === 'live');
  assert.equal((await call('POST', '/api/overleaf/unlink')).status, 200);
  assert.deepEqual((await call('GET', '/api/overleaf')).body, { info: null, canManage: true });
  assert.equal(readLinkState(join(root, 'Paper')), null);
});

// ------------------------------------------- regressions from the review

test('review: deleting a whole folder of most files is not passed on to Overleaf', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 5; i++) files[`folder/${i}.tex`] = `${i}\n`;
  const w = await world({ overleaf: files });
  await w.project.remove('folder', 'Bob');
  await sleep(1500);
  await w.link.idle();
  assert.equal(Object.keys(w.mock.snapshot()).length, 5, 'nothing deleted on Overleaf');
  assert.match(w.link.info().message, /Not deleting 5 of 5/);
});

test('review: a file deleted here while the link was down stays deleted, and goes on Overleaf too', async () => {
  const w = await world({ overleaf: { 'main.tex': 'm\n', 'a.tex': 'hello\n', 'pic.png': Buffer.from([1, 2]) } });
  await w.link.stop();
  await w.project.remove('a.tex', 'Bob');
  await w.project.remove('pic.png', 'Bob');
  w.link = new OverleafLink(w.project, readLinkState(w.dir)!);
  w.link.start();
  await until('live', () => w.link.isLive);
  await until('deleted on Overleaf', () => !w.mock.find('a.tex') && !w.mock.find('pic.png'));
  assert.equal(w.project.texts.has('a.tex'), false);
  assert.equal(w.project.bins.has('pic.png'), false);
});

test('review: a file deleted here while down but changed on Overleaf comes back (their edits are kept)', async () => {
  const w = await world({ overleaf: { 'main.tex': 'm\n', 'a.tex': 'hello\n' } });
  await w.link.stop();
  await w.project.remove('a.tex', 'Bob');
  w.mock.edit(w.alice._id, 'a.tex', [{ p: 0, i: 'Alice: ' }]);
  w.link = new OverleafLink(w.project, readLinkState(w.dir)!);
  w.link.start();
  await until('live', () => w.link.isLive);
  await converged(w);
  assert.equal(w.text('a.tex'), 'Alice: hello\n');
});

test('review: a rename on Overleaf onto a name taken here keeps both files apart', async () => {
  const w = await world({ overleaf: { 'a.tex': 'old source\n' } });
  await w.link.stop();
  await w.project.putFile('b.tex', Buffer.from('unrelated local\n'), 'Bob');
  w.mock.rename('a.tex', 'b.tex');
  w.link = new OverleafLink(w.project, readLinkState(w.dir)!);
  w.link.start();
  await until('live', () => w.link.isLive);
  await converged(w);
  assert.equal(w.text('b.tex'), 'old source\n');
  assert.equal(w.text('b (TeXWerk).tex'), 'unrelated local\n');
  assert.equal(w.mock.text('b (TeXWerk).tex'), 'unrelated local\n');
  assert.equal(w.project.texts.has('a.tex'), false);
  // Live, too.
  await w.project.putFile('c.tex', Buffer.from('mine\n'), 'Bob');
  w.mock.addDoc('d.tex', 'theirs\n');
  await until('d here', () => w.text('d.tex') === 'theirs\n');
  await until('c there', () => w.mock.text('c.tex') === 'mine\n');
  w.mock.remove('c.tex');
  await until('c gone here', () => !w.project.texts.has('c.tex'));
  await w.project.putFile('c.tex', Buffer.from('mine again\n'), 'Bob');
  await sleep(1200);
  w.mock.rename('d.tex', 'c.tex');
  await until('renamed here', () => w.text('c.tex') === 'theirs\n');
  assert.equal(w.text('c (TeXWerk).tex'), 'mine again\n');
});

test('review: a comment whose words change before it is imported still arrives, on its current words', async () => {
  const w = await world({ overleaf: { 'a.tex': 'hello world\n' } });
  w.mock.comment(w.alice._id, 'a.tex', 0, 5, 'comment');
  w.mock.edit(w.alice._id, 'a.tex', [{ p: 2, i: 'X' }]);
  await until('thread here', () => allThreads(w.project.doc).length === 1);
  const t = allThreads(w.project.doc)[0];
  assert.equal(t.quote, 'heXllo');
  assert.equal(w.text('a.tex')!.slice(t.from!, t.to!), 'heXllo');
});

test('review: message edits and deletions go both ways; the first message stays', async () => {
  const w = await world({ overleaf: { 'a.tex': 'one two three\n' } });
  const tid = w.mock.comment(w.alice._id, 'a.tex', 0, 3, 'original');
  await until('thread here', () => allThreads(w.project.doc).length === 1);
  const id = allThreads(w.project.doc)[0].id;
  w.mock.message(w.alice._id, tid, 'second');
  await until('second here', () => allThreads(w.project.doc)[0].messages.length === 2);
  w.project.reply(id, 'from Bob', 'Bob', 'bob');
  await until('Bob there', () => w.mock.threads.get(tid)!.messages.length === 3);

  // Overleaf → here: edit the first, delete the second.
  const [first, second, bobs] = w.mock.threads.get(tid)!.messages;
  w.mock.editMessage(tid, first.id, 'edited on Overleaf');
  w.mock.deleteMessage(tid, second.id);
  await until('edit and delete here', () => {
    const m = allThreads(w.project.doc)[0].messages;
    return m.length === 2 && m[0].text === 'edited on Overleaf';
  });

  // Here → Overleaf: edit Bob's reply, then delete it.
  const bob = allThreads(w.project.doc)[0].messages[1];
  w.project.setMessage(id, bob.id, 'from Bob, edited', { author: 'Bob' });
  await until('edit there', () => w.mock.threads.get(tid)!.messages.find((m) => m.id === bobs.id)?.content === '[Bob] from Bob, edited');
  w.project.setMessage(id, bob.id, null, { author: 'Bob' });
  await until('delete there', () => !w.mock.threads.get(tid)!.messages.some((m) => m.id === bobs.id));

  // Deleting the first message on Overleaf does not delete the thread here.
  w.mock.deleteMessage(tid, first.id);
  await sleep(1200);
  await w.link.idle();
  assert.equal(allThreads(w.project.doc).length, 1);
  assert.equal(allThreads(w.project.doc)[0].messages[0].text, 'edited on Overleaf');
});

test('review: reconnecting repeatedly keeps one connection, and stop closes it', async () => {
  const w = await world({ overleaf: { 'a.tex': 'hello\n' } });
  w.link.reconnect();
  w.link.reconnect();
  w.link.reconnect();
  await until('live', () => w.link.isLive);
  await sleep(500);
  assert.equal(w.mock.clients.size, 1);
  w.bob('a.tex', (t) => t.insert(0, 'still works: '));
  await until('edit there', () => w.mock.text('a.tex') === 'still works: hello\n');
  await w.link.stop();
  await sleep(200);
  assert.equal(w.mock.clients.size, 0);
});
