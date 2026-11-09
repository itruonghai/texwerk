import diff from 'fast-diff';

/**
 * Line-based three-way merge, for the moments the Overleaf link cannot replay
 * operations: the first link of a document both sides already have edits on
 * since an agreed copy, and a reconnect after a server restart.
 *
 * `base` is the text both sides last agreed on. A change only one side made
 * is taken as it is; the same change made on both sides is taken once. Where
 * both sides changed the same lines differently, both versions are kept,
 * fenced by marker lines that start with `%`, so the document still compiles
 * (TeX reads them as comments) and nothing either side wrote is lost.
 */

export interface MergeResult {
  text: string;
  /** Number of conflicting regions. */
  conflicts: number;
  /** 1-based line of each conflict's first marker in `text`. */
  conflictLines: number[];
}

export interface MergeLabels {
  ours: string;
  theirs: string;
}

const splitLines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** A change of one side, in base line coordinates: base[from, to) became `lines`. */
interface Hunk {
  from: number;
  to: number;
  lines: string[];
}

/**
 * Lines become single characters so fast-diff compares whole lines (the
 * line-mode trick of diff-match-patch). Codes skip the surrogate range, which
 * fast-diff treats specially.
 */
class LineCodes {
  private readonly codes = new Map<string, string>();

  encode(lines: string[]): string | null {
    let out = '';
    for (const line of lines) {
      let code = this.codes.get(line);
      if (code === undefined) {
        const n = this.codes.size + 1;
        const point = n < 0xd800 ? n : n + 0x800;
        if (point > 0xffff) return null;
        code = String.fromCharCode(point);
        this.codes.set(line, code);
      }
      out += code;
    }
    return out;
  }
}

function hunks(base: string[], side: string[], codes: LineCodes): Hunk[] | null {
  const a = codes.encode(base);
  const b = codes.encode(side);
  if (a === null || b === null) return null;
  const out: Hunk[] = [];
  let at = 0;
  let sideAt = 0;
  for (const [kind, chunk] of diff(a, b)) {
    if (kind === diff.EQUAL) {
      at += chunk.length;
      sideAt += chunk.length;
      continue;
    }
    let last = out[out.length - 1];
    if (!last || last.to !== at) {
      last = { from: at, to: at, lines: [] };
      out.push(last);
    }
    if (kind === diff.DELETE) {
      last.to += chunk.length;
      at += chunk.length;
    } else {
      last.lines.push(...side.slice(sideAt, sideAt + chunk.length));
      sideAt += chunk.length;
    }
  }
  return out;
}

/** What one side made of base[from, to), given its hunks inside that range. */
function sideText(base: string[], list: Hunk[], from: number, to: number): string[] {
  const out: string[] = [];
  let at = from;
  for (const h of list) {
    out.push(...base.slice(at, h.from), ...h.lines);
    at = h.to;
  }
  out.push(...base.slice(at, to));
  return out;
}

/**
 * Whether hunk `x` belongs to the region base[from, to): it overlaps it, or
 * starts where the region starts (two insertions at one place, or an
 * insertion where the other side replaced lines, cannot be ordered safely).
 */
const overlaps = (x: Hunk, from: number, to: number) => x.from === from || (x.from < to && from < x.to);

const withNewline = (lines: string[]) => {
  const out = [...lines];
  if (out.length && !out[out.length - 1].endsWith('\n')) out[out.length - 1] += '\n';
  return out;
};

export function merge3(base: string, ours: string, theirs: string, labels: MergeLabels = { ours: 'TeXWerk', theirs: 'Overleaf' }): MergeResult {
  if (ours === theirs) return { text: ours, conflicts: 0, conflictLines: [] };
  if (base === ours) return { text: theirs, conflicts: 0, conflictLines: [] };
  if (base === theirs) return { text: ours, conflicts: 0, conflictLines: [] };
  const b = splitLines(base);
  const o = splitLines(ours);
  const t = splitLines(theirs);
  const codes = new LineCodes();
  const oh = hunks(b, o, codes);
  const th = hunks(b, t, codes);
  if (!oh || !th) return conflictAll(ours, theirs, labels);

  const out: string[] = [];
  const conflictLines: number[] = [];
  let at = 0;
  let i = 0;
  let j = 0;
  while (i < oh.length || j < th.length) {
    // The next hunk in base order starts a region; every hunk of either side
    // that overlaps the region joins it, which can widen it further.
    const first = j >= th.length || (i < oh.length && oh[i].from <= th[j].from) ? oh[i] : th[j];
    let from = first.from;
    let to = first.to;
    const mine: Hunk[] = [];
    const theirsIn: Hunk[] = [];
    let grew = true;
    while (grew) {
      grew = false;
      while (i < oh.length && overlaps(oh[i], from, to)) {
        mine.push(oh[i]);
        from = Math.min(from, oh[i].from);
        to = Math.max(to, oh[i].to);
        i++;
        grew = true;
      }
      while (j < th.length && overlaps(th[j], from, to)) {
        theirsIn.push(th[j]);
        from = Math.min(from, th[j].from);
        to = Math.max(to, th[j].to);
        j++;
        grew = true;
      }
    }
    out.push(...b.slice(at, from));
    if (!theirsIn.length) out.push(...sideText(b, mine, from, to));
    else if (!mine.length) out.push(...sideText(b, theirsIn, from, to));
    else {
      const a = sideText(b, mine, from, to);
      const c = sideText(b, theirsIn, from, to);
      if (a.join('') === c.join('')) out.push(...a);
      else {
        if (out.length && !out[out.length - 1].endsWith('\n')) out[out.length - 1] += '\n';
        conflictLines.push(out.length + 1);
        out.push(`%<<<<<<< ${labels.ours}\n`, ...withNewline(a), '%=======\n', ...withNewline(c), `%>>>>>>> ${labels.theirs}\n`);
      }
    }
    at = to;
  }
  out.push(...b.slice(at));
  return { text: out.join(''), conflicts: conflictLines.length, conflictLines };
}

function conflictAll(ours: string, theirs: string, labels: MergeLabels): MergeResult {
  const text = [`%<<<<<<< ${labels.ours}\n`, ...withNewline(splitLines(ours)), '%=======\n', ...withNewline(splitLines(theirs)), `%>>>>>>> ${labels.theirs}\n`].join('');
  return { text, conflicts: 1, conflictLines: [1] };
}
