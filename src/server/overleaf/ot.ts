/*
 * Operational transformation for Overleaf's text operations.
 *
 * Adapted from Lattice (https://github.com/leo1oel/lattice) at commit
 * 21c71f5e0e1c0095e907a1151c47083118948453: src/overleaf/ot.ts and
 * src/overleaf/changed-runs.ts. Copyright the Lattice authors, licensed under
 * the Apache License, Version 2.0 (see NOTICE and
 * licenses/Apache-2.0.txt). Changes: the two files are joined, Lattice's
 * i18n wrappers are removed, the constructor uses plain fields, and
 * OtDocument has an `inflightOps` getter and `localOps` (a local edit given
 * as operations rather than as the next text).
 */

// ---------------------------------------------------------------- changed-runs.ts

/**
 * Where two versions of a document differ, as separate runs of lines.
 *
 * Most edits are one contiguous change, and trimming the common prefix and
 * suffix finds it exactly. Some are not: a replace-all, a rename, an agent's
 * edit or a file changed on disk can touch distant places within one send.
 * Trimmed alone, that reads as rewriting everything from the first change to
 * the last — harmless as a plain edit, but sent as a suggestion it proposes
 * deleting and retyping every paragraph in between. Matching the lines in the
 * middle (Myers' shortest edit script) keeps each change to itself.
 */

/** A run of `a`'s lines `[aFrom, aTo)` that became `b`'s lines `[bFrom, bTo)`. */
export type ChangedRun = { aFrom: number; aTo: number; bFrom: number; bTo: number };

/** Lines of `text`, each keeping its own line break, so they join back into it. */
export const splitLines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/**
 * The runs where line lists `a` and `b` differ, in order, or null when more
 * than `limit` lines were added or removed — past that, matching costs more
 * than one broad change saves.
 */
export function changedRuns(a: readonly string[], b: readonly string[], limit: number): ChangedRun[] | null {
  const n = a.length;
  const m = b.length;
  // rounds[d][k + d]: how far along `a` the furthest d-edit path on diagonal
  // k (= x - y) reaches, or -1 when no such path stays inside the grid.
  const rounds: Int32Array[] = [];
  for (let d = 0; d <= Math.min(limit, n + m); d += 1) {
    const reach = new Int32Array(2 * d + 1).fill(-1);
    rounds.push(reach);
    for (let k = -d; k <= d; k += 2) {
      const x = d === 0 ? 0 : start(rounds[d - 1]!, d, k, n, m)?.x;
      if (x == null) continue;
      let end = x;
      while (end < n && end - k < m && a[end] === b[end - k]) end += 1;
      reach[k + d] = end;
      if (end === n && end - k === m) return runsOf(matches(rounds, n, m), n, m);
    }
  }
  return null;
}

/**
 * Where a d-edit path on diagonal k begins its final stretch of matching
 * lines: one line further along `a` than the best (d-1)-path on diagonal
 * k - 1 (a line removed), or level with the one on k + 1 (a line added).
 */
function start(previous: Int32Array, d: number, k: number, n: number, m: number): { x: number; from: number } | null {
  const at = (diagonal: number) => (Math.abs(diagonal) <= d - 1 ? previous[diagonal + d - 1]! : -1);
  const removed = at(k - 1) >= 0 && at(k - 1) + 1 <= n && at(k - 1) + 1 - k <= m ? at(k - 1) + 1 : -1;
  const added = at(k + 1) >= 0 && at(k + 1) - k <= m && at(k + 1) - k >= 0 ? at(k + 1) : -1;
  if (removed < 0 && added < 0) return null;
  return removed > added ? { x: removed, from: k - 1 } : { x: added, from: k + 1 };
}

/** The matched line pairs `[x, y]` along the path that reached `(n, m)`, in order. */
function matches(rounds: Int32Array[], n: number, m: number): [number, number][] {
  const pairs: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = rounds.length - 1; d >= 0; d -= 1) {
    const k = x - y;
    const from = d === 0 ? { x: 0, from: 0 } : start(rounds[d - 1]!, d, k, n, m)!;
    while (x > from.x) {
      x -= 1;
      y -= 1;
      pairs.push([x, y]);
    }
    if (d === 0) break;
    x = rounds[d - 1]![from.from + d - 1]!;
    y = x - from.from;
  }
  return pairs.reverse();
}

function runsOf(pairs: [number, number][], n: number, m: number): ChangedRun[] {
  const runs: ChangedRun[] = [];
  let x = 0;
  let y = 0;
  for (const [mx, my] of [...pairs, [n, m] as [number, number]]) {
    if (mx > x || my > y) runs.push({ aFrom: x, aTo: mx, bFrom: y, bTo: my });
    x = mx + 1;
    y = my + 1;
  }
  return runs;
}

// ---------------------------------------------------------------- ot.ts

/**
 * Operational transformation for Overleaf's text operations, and the client
 * state for one document edited live through it.
 *
 * Overleaf's realtime protocol does not exchange whole documents — it
 * exchanges positioned inserts and deletes, which is what lets two people type
 * in one paragraph without either version being overwritten. When both edit
 * at once, each side's operation was written against a document the other has
 * already changed; transformation rewrites one so it still means the same
 * thing after the other landed. The semantics match ShareJS's `text` type,
 * which Overleaf's server applies, and the property everything rests on is
 * convergence: a-then-transformed-b equals b-then-transformed-a
 * (`ot.test.ts` checks it on thousands of random operations).
 */


/** One OT operation: insert `i` or delete `d`, both at character offset `p`. */
export type OtOp = { p: number; i?: string; d?: string };

/**
 * Describe the change from `before` to `after` as ops.
 *
 * Editing is overwhelmingly one contiguous change at a time — typing, pasting,
 * deleting a selection — so this narrows to the differing middle by matching
 * the common prefix and suffix. That produces exactly the ops the web editor
 * would send for the same keystroke, and never invents overlapping edits.
 * When the middle spans lines, the unchanged lines inside it are matched too
 * (./changed-runs), so changes made far apart in one send stay separate ops.
 */
export function diffToOps(before: string, after: string): OtOp[] {
  return changeOps(before, after, 0, true);
}

/** At most this many lines added or removed are matched up line by line; see `changedRuns`. */
const MAX_CHANGED_LINES = 400;

function changeOps(before: string, after: string, at: number, byLine: boolean): OtOp[] {
  if (before === after) return [];
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix += 1;
  // Never cut a character in half. Two emoji can share the first half of
  // their UTF-16 pair, and an op holding only the second half is a lone
  // surrogate that Overleaf turns into U+FFFD — corrupting a character the
  // edit never meant to touch.
  if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1))) prefix -= 1;
  let suffix = 0;
  const maxSuffix = maxPrefix - prefix;
  while (suffix < maxSuffix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) suffix -= 1;
  const removed = before.slice(prefix, before.length - suffix);
  const inserted = after.slice(prefix, after.length - suffix);
  const [removedLines, insertedLines] = [splitLines(removed), splitLines(inserted)];
  // A pure insertion or deletion is one run however many lines it spans.
  const runs = byLine && removed && inserted && (removedLines.length > 1 || insertedLines.length > 1)
    ? changedRuns(removedLines, insertedLines, MAX_CHANGED_LINES)
    : null;
  if (runs && runs.length > 1) {
    // Each run is trimmed on its own, and lands where the runs before it left
    // the text: ops apply one after another.
    const starts = [0];
    for (const line of removedLines) starts.push(starts.at(-1)! + line.length);
    const ops: OtOp[] = [];
    let shift = 0;
    for (const run of runs) {
      const was = removedLines.slice(run.aFrom, run.aTo).join("");
      const is = insertedLines.slice(run.bFrom, run.bTo).join("");
      ops.push(...changeOps(was, is, at + prefix + starts[run.aFrom]! + shift, false));
      shift += is.length - was.length;
    }
    return ops;
  }
  // Delete first: the insert's position is then expressed against the text
  // that remains, which is what the server expects.
  return [
    ...(removed ? [{ p: at + prefix, d: removed }] : []),
    ...(inserted ? [{ p: at + prefix, i: inserted }] : []),
  ];
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const SURROGATE = /[\uD800-\uDFFF]/;
const SURROGATES = new RegExp(SURROGATE.source, "g");

/**
 * What Overleaf actually stores for these ops.
 *
 * Its document updater replaces every UTF-16 surrogate in inserted text with
 * U+FFFD — both halves of an emoji or a `unicode-math` letter like 𝔸, one
 * replacement character each — and still acknowledges the operation as sent.
 * Sending such text unchanged leaves this side holding characters the server
 * does not have, with nothing to say so until a later sync quietly replaces
 * them. Mirroring the server keeps the two copies identical, and lengths (so
 * every position) stay the same.
 */
export function asOverleafStores(ops: OtOp[]): { ops: OtOp[]; replaced: boolean } {
  let replaced = false;
  const stored = ops.map((op) => {
    if (typeof op.i !== "string" || !SURROGATE.test(op.i)) return op;
    replaced = true;
    return { ...op, i: op.i.replace(SURROGATES, "\uFFFD") };
  });
  return { ops: stored, replaced };
}

/**
 * Apply ops to a document, in order, so the local copy ends up byte-identical
 * to the server's. Null when an op does not fit the text (a delete whose
 * content differs, a position past the end) — a sign the local copy drifted,
 * which the caller recovers from by re-fetching rather than writing it to disk.
 */
export function applyOps(content: string, ops: OtOp[]): string | null {
  let text = content;
  for (const op of ops) {
    if (op.p < 0 || op.p > text.length) return null;
    if (typeof op.d === "string") {
      if (text.slice(op.p, op.p + op.d.length) !== op.d) return null;
      text = text.slice(0, op.p) + text.slice(op.p + op.d.length);
    }
    if (typeof op.i === "string") {
      if (op.p > text.length) return null;
      text = text.slice(0, op.p) + op.i + text.slice(op.p);
    }
  }
  return text;
}

/**
 * Where a span — a comment quote, a suggestion — ends up after `ops`.
 *
 * Overleaf states where these sit once, when a document is joined, and then
 * expects them to ride along on the operations that move the text. Text typed
 * at either edge lands outside the span: accepting a suggestion rewrites what
 * the span covers, so one that swallowed the words next to it would change
 * text nobody proposed changing. A span whose text is deleted outright
 * collapses to length 0.
 */
export function transformSpan(span: { from: number; length: number }, ops: OtOp[]): { from: number; length: number } {
  let { from, length } = span;
  for (const op of ops) {
    if (typeof op.i === "string") {
      if (op.p <= from) from += op.i.length;
      else if (op.p < from + length) length += op.i.length;
    } else if (typeof op.d === "string") {
      const start = op.p;
      const end = op.p + op.d.length;
      if (end <= from) from -= op.d.length;
      else if (start < from + length) {
        // Overlapping: lose the deleted part of the span, and move its start
        // back by however much of the deletion was in front of it.
        length -= Math.min(end, from + length) - Math.max(start, from);
        if (start < from) from = start;
      }
    }
  }
  return { from, length };
}

/**
 * Add a component, merging it into the previous one when they are adjacent.
 * Merging keeps operations in the canonical shape the server produces, so a
 * round trip does not reshuffle a document's history.
 */
function append(op: OtOp[], component: OtOp): void {
  if (component.i === "" || component.d === "") return;
  const last = op[op.length - 1];
  const inject = (source: string, position: number, text: string) => source.slice(0, position) + text + source.slice(position);
  if (last?.i != null && component.i != null && last.p <= component.p && component.p <= last.p + last.i.length) {
    op[op.length - 1] = { p: last.p, i: inject(last.i, component.p - last.p, component.i) };
  } else if (last?.d != null && component.d != null && component.p <= last.p && last.p <= component.p + component.d.length) {
    op[op.length - 1] = { p: component.p, d: inject(component.d, last.p - component.p, last.d) };
  } else {
    op.push(component);
  }
}

/**
 * Where a position ends up after `component`. `insertAfter` breaks the tie
 * when an insert lands exactly on it: the two sides must disagree
 * consistently, or concurrent inserts at one spot would never converge.
 */
function transformPosition(position: number, component: OtOp, insertAfter: boolean): number {
  if (component.i != null) {
    return component.p < position || (component.p === position && insertAfter) ? position + component.i.length : position;
  }
  const deleted = component.d ?? "";
  if (position <= component.p) return position;
  if (position <= component.p + deleted.length) return component.p;
  return position - deleted.length;
}

/** Transform one component against one other, appending the result. */
function transformComponent(destination: OtOp[], component: OtOp, other: OtOp, side: "left" | "right"): void {
  if (component.i != null) {
    append(destination, { p: transformPosition(component.p, other, side === "right"), i: component.i });
    return;
  }
  const deleted = component.d ?? "";
  if (other.i != null) {
    // Our delete spans text the other side just split with an insert, so it
    // becomes two deletes — one each side of the inserted text, which is left
    // untouched because we never meant to remove it.
    const split = Math.max(0, other.p - component.p);
    if (component.p < other.p) append(destination, { p: component.p, d: deleted.slice(0, split) });
    if (deleted.slice(split) !== "") append(destination, { p: component.p + other.i.length, d: deleted.slice(split) });
    return;
  }
  const otherDeleted = other.d ?? "";
  if (component.p >= other.p + otherDeleted.length) {
    // Entirely after their delete: shift back by what they removed.
    append(destination, { p: component.p - otherDeleted.length, d: deleted });
  } else if (component.p + deleted.length <= other.p) {
    // Entirely before their delete: unaffected.
    append(destination, component);
  } else {
    // The two deletes overlap. Whatever they already removed is gone, so only
    // the parts outside their range remain for us to delete.
    let remaining = component.p < other.p ? deleted.slice(0, other.p - component.p) : "";
    if (component.p + deleted.length > other.p + otherDeleted.length) {
      remaining += deleted.slice(other.p + otherDeleted.length - component.p);
    }
    if (remaining !== "") append(destination, { p: transformPosition(component.p, other, false), d: remaining });
  }
}

/**
 * Transform two concurrent operations against each other, returning each
 * rewritten to apply after the other. The first takes precedence in ties.
 *
 * Doing both together is what makes multi-component operations correct: as
 * each of the left op's components is transformed, the right component has to
 * be carried forward transformed too, or every later position is measured
 * against a document that no longer exists. A component can also split in two
 * (a delete straddling an insert), and then the rest of the work has to be
 * transformed against both halves — hence the recursion.
 */
export function transformBoth(left: OtOp[], right: OtOp[]): [OtOp[], OtOp[]] {
  let leftOp = left;
  const newRightOp: OtOp[] = [];
  for (const original of right) {
    let rightComponent: OtOp | null = original;
    const newLeftOp: OtOp[] = [];
    for (let index = 0; index < leftOp.length && rightComponent; index += 1) {
      const split: OtOp[] = [];
      transformComponent(newLeftOp, leftOp[index]!, rightComponent, "left");
      transformComponent(split, rightComponent, leftOp[index]!, "right");
      if (split.length === 1) {
        rightComponent = split[0]!;
      } else if (split.length === 0) {
        // The right component vanished (fully deleted by the left op), so the
        // rest of the left op is unaffected by it.
        for (const rest of leftOp.slice(index + 1)) append(newLeftOp, rest);
        rightComponent = null;
      } else {
        const [restLeft, restRight] = transformBoth(leftOp.slice(index + 1), split);
        for (const item of restLeft) append(newLeftOp, item);
        for (const item of restRight) append(newRightOp, item);
        rightComponent = null;
      }
    }
    if (rightComponent) append(newRightOp, rightComponent);
    leftOp = newLeftOp;
  }
  return [leftOp, newRightOp];
}

/** Combine two operations that apply one after the other into a single one. */
export function composeOps(first: OtOp[], second: OtOp[]): OtOp[] {
  const result = first.slice();
  for (const component of second) append(result, component);
  return result;
}

type OtSend = { version: number; ops: OtOp[] } | null;

/**
 * Thrown when the server's view and ours have provably diverged. Recovering
 * means re-fetching the document rather than guessing, so this is deliberately
 * loud instead of silently producing wrong text.
 */
export class OtDesyncError extends Error {}

/**
 * Client state for one document edited live through Overleaf, mirroring the
 * ShareJS client Overleaf's own editor uses.
 *
 * The server applies operations in a single order and is the authority. A
 * client can only have one operation in flight at a time, so anything typed
 * while waiting is collected and sent as one operation on acknowledgement.
 * Everything arriving from the server has to be transformed against whatever
 * this client still owes, and vice versa — that bookkeeping is the whole job
 * here, and getting it wrong is how characters go missing.
 *
 * Every `version` a method takes is the version an operation applied at, as
 * Overleaf reports it; the document then moves to `version + 1`. An older one
 * is the same operation arriving twice and is ignored; a newer one means an
 * operation went missing, which cannot be repaired by guessing.
 */
export class OtDocument {
  /** Sent, not yet acknowledged. */
  private inflight: OtOp[] | null = null;
  /** Typed while `inflight` was outstanding. */
  private pending: OtOp[] | null = null;
  /**
   * Every connection `inflight` has gone out on. Overleaf names a new
   * connection id each time the socket reconnects and stamps it on the update
   * as its source, so after a reconnect the replay of an operation we sent
   * earlier carries an id that is no longer ours — and only this list can
   * still recognise it as our own acknowledgement.
   */
  private submitted: string[] = [];

  /** Includes unsent work. */
  text: string;
  /** The last server version seen. */
  version: number;

  constructor(text: string, version: number) {
    this.text = text;
    this.version = version;
  }

  /** The operation in flight, as it stands after transforms: what the server applies when it acknowledges. */
  get inflightOps(): readonly OtOp[] | null {
    return this.inflight;
  }

  /** True while the server still owes us an acknowledgement. */
  get waiting(): boolean {
    return this.inflight !== null;
  }

  /** The connections the operation in flight has been sent on, oldest first. */
  get submittedVia(): readonly string[] {
    return this.submitted;
  }

  /** Record that the operation in flight went out on connection `publicId`. */
  noteSubmitted(publicId: string) {
    if (this.inflight && !this.submitted.includes(publicId)) this.submitted.push(publicId);
  }

  /**
   * The operation in flight again, to resend after a reconnect, naming the
   * connections it went out on so Overleaf can recognise a duplicate. Only
   * valid once a replay has brought `version` up to date, which also
   * transformed the operation to match.
   *
   * The replay can cancel it out entirely — a collaborator deleted the same
   * words. It never landed (the replay would have answered it), so there is
   * nothing left to wait for: it is settled here without moving the version,
   * and anything typed meanwhile goes out in its place as a fresh operation.
   */
  resend(): (NonNullable<OtSend> & { dupIfSource: readonly string[] }) | null {
    if (!this.inflight) return null;
    if (this.inflight.length) return { version: this.version, ops: this.inflight, dupIfSource: [...this.submitted] };
    this.inflight = null;
    this.submitted = [];
    if (!this.pending) return null;
    this.inflight = this.pending;
    this.pending = null;
    return { version: this.version, ops: this.inflight, dupIfSource: [] };
  }

  /**
   * The text the server will hold once the operation in flight lands exactly
   * as sent, which is what Overleaf's update `hash` describes. Null when
   * nothing is in flight, or when later work is queued on top of it and this
   * copy is already ahead of that.
   */
  get sentText(): string | null {
    return this.inflight && !this.pending ? this.text : null;
  }

  /** True when everything typed here has reached the server. */
  get settled(): boolean {
    return this.inflight === null && this.pending === null;
  }

  /**
   * Record a local edit. Returns what to send, if anything: while an operation
   * is in flight the new work waits, because the server numbers versions and
   * would reject a second operation built on a version it has not confirmed.
   * `ops` is the edit itself, sent or not, for moving anchors with the text.
   */
  local(nextText: string): { send: OtSend; replaced: boolean; ops: OtOp[] } {
    return this.localOps(diffToOps(this.text, nextText));
  }

  /** Like `local`, with the edit given as the operations that were typed. */
  localOps(typed: OtOp[]): { send: OtSend; replaced: boolean; ops: OtOp[] } {
    const nextText = applyOps(this.text, typed);
    if (nextText === null) throw new OtDesyncError(`A local edit did not fit the document.`);
    // See `asOverleafStores`: when it changes what was typed, `text` takes
    // the stored form and the caller has to show it in place of the original.
    const { ops, replaced } = asOverleafStores(typed);
    this.text = replaced ? applyOps(this.text, ops) ?? nextText : nextText;
    if (ops.length === 0) return { send: null, replaced, ops };
    if (this.inflight) {
      this.pending = this.pending ? composeOps(this.pending, ops) : ops;
      return { send: null, replaced, ops };
    }
    this.inflight = ops;
    return { send: { version: this.version, ops }, replaced, ops };
  }

  /**
   * Reserve the wire for an operation that carries no text — a comment anchor.
   * Null when something is already in flight. Recording it as in flight is
   * what makes the acknowledgement move the version on, and what makes
   * anything typed meanwhile wait its turn.
   */
  anchor(): { version: number } | null {
    if (this.inflight) return null;
    this.inflight = [];
    return { version: this.version };
  }

  /** The server accepted our in-flight operation. Anything typed since goes out now, as a single operation. */
  acknowledge(version?: number): { send: OtSend } {
    if (version != null && version < this.version) return { send: null };
    if (version != null && version !== this.version) {
      const current = this.version;
      throw new OtDesyncError(`Overleaf acknowledged version ${version} while this document is at ${current}.`);
    }
    if (!this.inflight) return { send: null };
    this.inflight = null;
    this.submitted = [];
    this.version += 1;
    if (!this.pending) return { send: null };
    // Work typed while waiting can cancel out entirely against someone else's
    // edit — both deleted the same words. There is then nothing to send, and
    // sending an empty operation anyway is worse than useless: the server
    // either rejects it and disconnects or never answers, stalling every
    // later edit (docs/overleaf-protocol.md). Overleaf's own client drops it
    // the same way.
    if (this.pending.length === 0) {
      this.pending = null;
      return { send: null };
    }
    this.inflight = this.pending;
    this.pending = null;
    return { send: { version: this.version, ops: this.inflight } };
  }

  /**
   * Apply work from someone else. Our outstanding operations are rewritten to
   * account for it, and it for them, so both sides end up at the same text no
   * matter which order things arrived in. Returns the ops actually applied
   * locally, for moving the caret and anchors.
   *
   * Storing `version` flat instead of `version + 1` leaves us a version behind
   * and nothing complains — the server quietly transforms our next operation
   * forward a second time and lands it at the wrong offset for everyone else.
   */
  remote(ops: OtOp[], version: number): { text: string; applied: OtOp[] } {
    if (version < this.version) return { text: this.text, applied: [] };
    if (version !== this.version) {
      const current = this.version;
      throw new OtDesyncError(`Overleaf sent version ${version} while this document is at ${current}.`);
    }
    // The incoming operation is already in the server's history, so it takes
    // precedence and ours is transformed as the later one — exactly as the
    // server will when ours arrives, or two inserts at one spot would order
    // differently here and never converge.
    let incoming = ops;
    if (this.inflight) [incoming, this.inflight] = transformBoth(incoming, this.inflight);
    if (this.pending) {
      [incoming, this.pending] = transformBoth(incoming, this.pending);
      // Cancelled out entirely (see `acknowledge`): nothing is left to send.
      if (this.pending.length === 0) this.pending = null;
    }
    const next = applyOps(this.text, incoming);
    if (next === null) throw new OtDesyncError(`An update from Overleaf did not fit this document; it needs to be reloaded.`);
    this.text = next;
    this.version = version + 1;
    return { text: next, applied: incoming };
  }

  /**
   * Replay the work the server did while this document was not being watched.
   *
   * Coming back to a file, the alternative is taking the server's text as it
   * stands, which silently throws away anything typed here that never got
   * that far. Each update is either someone else's, which our outstanding work
   * is transformed against, or our own finally landing, which is an
   * acknowledgement in every respect. `send` is whatever became sendable.
   */
  catchUp(updates: { version: number; ops: OtOp[]; mine: boolean }[]): { text: string; applied: OtOp[]; send: OtSend } {
    // Each applied list is in the coordinate space left by the ones before it,
    // so they concatenate for the purpose of moving a caret.
    const applied: OtOp[] = [];
    let send: OtSend = null;
    for (const update of updates) {
      if (update.mine) send = this.acknowledge(update.version).send ?? send;
      else applied.push(...this.remote(update.ops, update.version).applied);
    }
    return { text: this.text, applied, send };
  }

  /** Start again from the server's copy, dropping unsent work: guessing at reconciliation risks writing text neither side wrote. */
  reset(text: string, version: number) {
    this.text = text;
    this.version = version;
    this.inflight = null;
    this.pending = null;
    this.submitted = [];
  }
}
