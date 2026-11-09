/** The Overleaf link's pure parts: OT, the three-way merge, and the protocol helpers. */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { merge3 } from '../src/server/overleaf/merge3.ts';
import { applyOps, composeOps, diffToOps, OtDocument, transformBoth, type OtOp } from '../src/server/overleaf/ot.ts';
import { cookieHeader, decodePacked, mergeCookies, parseProjectUrl } from '../src/server/overleaf/socketio.ts';
import { docHash, newThreadId } from '../src/server/overleaf/link.ts';
import { metaContent, parseThreads } from '../src/server/overleaf/rest.ts';

/** A small seeded generator, so a failure names its seed and repeats. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

const ALPHABET = 'ab \né中';
function randomText(r: () => number, n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[Math.floor(r() * ALPHABET.length)];
  return out;
}

function randomOp(r: () => number, text: string): OtOp[] {
  const ops: OtOp[] = [];
  let doc = text;
  const count = 1 + Math.floor(r() * 3);
  for (let i = 0; i < count; i++) {
    const p = Math.floor(r() * (doc.length + 1));
    const op: OtOp = r() < 0.5 && p < doc.length
      ? { p, d: doc.slice(p, p + 1 + Math.floor(r() * Math.min(4, doc.length - p))) }
      : { p, i: randomText(r, 1 + Math.floor(r() * 3)) };
    ops.push(op);
    doc = applyOps(doc, [op])!;
  }
  return ops;
}

test('OT: concurrent operations converge in either order (5000 random pairs)', () => {
  const r = rng(42);
  for (let n = 0; n < 5000; n++) {
    const base = randomText(r, Math.floor(r() * 12));
    const a = randomOp(r, base);
    const b = randomOp(r, base);
    const [a2, b2] = transformBoth(a, b);
    const left = applyOps(applyOps(base, a)!, b2);
    const right = applyOps(applyOps(base, b)!, a2);
    assert.ok(left !== null && right !== null, `ops apply (case ${n})`);
    assert.equal(left, right, `converges (case ${n}: ${JSON.stringify({ base, a, b })})`);
  }
});

test('OT: diffToOps turns one text into the other, by changed line runs', () => {
  const r = rng(7);
  for (let n = 0; n < 2000; n++) {
    const a = randomText(r, Math.floor(r() * 30));
    const b = randomText(r, Math.floor(r() * 30));
    assert.equal(applyOps(a, diffToOps(a, b)), b);
  }
  const ops = diffToOps('one\ntwo\nthree\nfour\n', 'ONE\ntwo\nthree\nFOUR\n');
  assert.equal(ops.length, 4, 'two separate changes stay two delete+insert pairs');
});

test('OT: a client with one update in flight converges with a server (200 seeds)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed);
    let server = 'hello world\n';
    const history: OtOp[][] = [];
    const client = new OtDocument(server, 0);
    let inflight: { version: number; ops: OtOp[] } | null = null;
    const deliver = () => {
      // The server applies the client's op, transformed against what it missed.
      let ops = inflight!.ops;
      for (const h of history.slice(inflight!.version)) ops = transformBoth(h, ops)[1];
      server = applyOps(server, ops)!;
      history.push(ops);
      inflight = null;
      const { send } = client.acknowledge(history.length - 1);
      if (send) inflight = send;
    };
    for (let step = 0; step < 40; step++) {
      const x = r();
      if (x < 0.4) {
        const ops = randomOp(r, client.text);
        const { send } = client.local(applyOps(client.text, ops)!);
        if (send) inflight = send;
      } else if (x < 0.75) {
        const ops = randomOp(r, server);
        server = applyOps(server, ops)!;
        history.push(ops);
        client.remote(ops, history.length - 1);
      } else if (inflight) deliver();
    }
    while (inflight) deliver();
    assert.equal(client.text, server, `seed ${seed}`);
  }
});

test('OT: composing keeps the effect of both operations', () => {
  assert.equal(applyOps('', composeOps([{ p: 0, i: 'ab' }], [{ p: 2, i: 'cd' }])), 'abcd');
});

test('merge3: one-sided, identical and disjoint changes merge without conflict', () => {
  const base = 'a\nb\nc\nd\ne\nf\n';
  assert.deepEqual(merge3(base, 'a\nB\nc\nd\ne\nf\n', base), { text: 'a\nB\nc\nd\ne\nf\n', conflicts: 0, conflictLines: [] });
  assert.equal(merge3(base, base, 'a\nb\nc\nd\nE\nf\n').text, 'a\nb\nc\nd\nE\nf\n');
  assert.equal(merge3(base, 'a\nB\nc\nd\ne\nf\n', 'a\nB\nc\nd\ne\nf\n').conflicts, 0);
  const both = merge3(base, 'x\na\nB\nc\nd\ne\nf\n', 'a\nb\nc\nd\nE\nf\ny\n');
  assert.equal(both.conflicts, 0);
  assert.equal(both.text, 'x\na\nB\nc\nd\nE\nf\ny\n');
});

test('merge3: a real conflict keeps both versions between % markers', () => {
  const m = merge3('a\nb\nc\n', 'a\nOURS\nc\n', 'a\nTHEIRS\nc\n');
  assert.equal(m.conflicts, 1);
  assert.equal(m.text, 'a\n%<<<<<<< TeXWerk\nOURS\n%=======\nTHEIRS\n%>>>>>>> Overleaf\nc\n');
  assert.deepEqual(m.conflictLines, [2]);
  assert.ok(merge3('a', 'b', 'c').text.includes('b\n%=======\nc\n'), 'a last line without newline still gets its own marker line');
});

test('merge3: random disjoint line edits always merge to both edits (1000 cases)', () => {
  const r = rng(99);
  for (let n = 0; n < 1000; n++) {
    const lines = Array.from({ length: 6 + Math.floor(r() * 10) }, (_, i) => `line ${i}\n`);
    const cut = 2 + Math.floor(r() * (lines.length - 4));
    const oi = Math.floor(r() * (cut - 1));
    const ti = cut + 1 + Math.floor(r() * (lines.length - cut - 1));
    if (ti >= lines.length) continue;
    const ours = [...lines];
    const theirs = [...lines];
    ours[oi] = `ours ${n}\n`;
    theirs[ti] = `theirs ${n}\n`;
    const expected = [...lines];
    expected[oi] = ours[oi];
    expected[ti] = theirs[ti];
    const m = merge3(lines.join(''), ours.join(''), theirs.join(''));
    assert.equal(m.conflicts, 0, `case ${n}`);
    assert.equal(m.text, expected.join(''), `case ${n}`);
  }
});

test('merge3: nothing either side wrote is lost, conflict or not (1000 random cases)', () => {
  const r = rng(5);
  for (let n = 0; n < 1000; n++) {
    const base = Array.from({ length: 5 }, (_, i) => `b${i}\n`);
    const edit = (tag: string) => {
      const out = [...base];
      for (let k = 0; k < 2; k++) {
        const at = Math.floor(r() * (out.length + 1));
        if (r() < 0.5 && out.length) out[Math.min(at, out.length - 1)] = `${tag}${n}.${k}\n`;
        else out.splice(at, 0, `${tag}${n}.${k}\n`);
      }
      return out;
    };
    const ours = edit('o');
    const theirs = edit('t');
    const m = merge3(base.join(''), ours.join(''), theirs.join(''));
    for (const line of [...ours, ...theirs]) {
      if (line.startsWith('o') || line.startsWith('t')) assert.ok(m.text.includes(line), `case ${n}: ${line.trim()} survives`);
    }
  }
});

test('protocol helpers: packed UTF-8, project URLs, cookies, hashes, meta tags, threads', () => {
  assert.equal(decodePacked(unescape(encodeURIComponent('Intro ✓ ünïcode 中文'))), 'Intro ✓ ünïcode 中文');
  assert.equal(decodePacked('plain ascii'), 'plain ascii');
  assert.equal(decodePacked('already ✓ decoded'), 'already ✓ decoded', 'text that is not packed is left alone');

  assert.deepEqual(parseProjectUrl('https://www.overleaf.com/project/6721c0ffee0123456789abcd'), { origin: 'https://www.overleaf.com', projectId: '6721c0ffee0123456789abcd' });
  assert.deepEqual(parseProjectUrl(' https://latex.lab.example/project/6721C0FFEE0123456789ABCD/ '), { origin: 'https://latex.lab.example', projectId: '6721c0ffee0123456789abcd' });
  assert.throws(() => parseProjectUrl('https://www.overleaf.com/read/abc'));
  assert.throws(() => parseProjectUrl('ftp://x/project/6721c0ffee0123456789abcd'));

  assert.equal(cookieHeader('s%3Aabc', 'https://www.overleaf.com'), 'overleaf_session2=s%3Aabc');
  assert.equal(cookieHeader('s%3Aabc', 'https://latex.lab.example'), 'sharelatex.sid=s%3Aabc');
  assert.equal(cookieHeader('Cookie: overleaf_session2=x; GCLB=y', 'https://www.overleaf.com'), 'overleaf_session2=x; GCLB=y');
  assert.throws(() => cookieHeader('  ', 'https://www.overleaf.com'));
  assert.equal(mergeCookies('a=1; b=2', ['b=3; Path=/', 'c=4; HttpOnly']), 'a=1; b=3; c=4');

  // Overleaf hashes "blob {UTF-16 length}\0" then the UTF-8 bytes: 'hé' is 2 units, 3 bytes.
  assert.equal(docHash('hé'), createHash('sha1').update(Buffer.concat([Buffer.from('blob 2\0'), Buffer.from('hé', 'utf8')])).digest('hex'));
  assert.match(newThreadId(), /^[0-9a-f]{24}$/);
  assert.equal(metaContent('<meta name="ol-csrfToken" content="a&amp;b">', 'ol-csrfToken'), 'a&b');
  const threads = parseThreads({ t1: { messages: [{ id: 'm1', content: 'hi', timestamp: 5, user_id: 'u1', user: { first_name: 'Alice', last_name: 'Test' } }], resolved: true } });
  assert.deepEqual(threads.get('t1'), { messages: [{ id: 'm1', content: 'hi', timestamp: 5, userId: 'u1', userName: 'Alice Test' }], resolved: true });
});
