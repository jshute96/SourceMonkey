// Line diff for the compare page: which lines two texts share, which
// each has alone, and how to fold the shared runs away into hunks.
//
// Pure — no DOM, no store — so the compare page can be tested apart
// from the pages that show its output. A line is the unit: a changed
// character marks its whole line, and nothing here knows what a
// function or a header tag is. Grouping changes into hunks with a few
// lines of context on either side is what makes the output read as
// "just the parts that changed", and it is a separate pass over the
// line ops rather than anything the diff itself does.

// One line of the diff, with where it sits in each text (1-based).
// `same` lines have both numbers; a `del` line is only in A and an
// `add` line only in B.
export interface DiffOp {
  kind: 'same' | 'del' | 'add';
  text: string;
  aLine?: number;
  bLine?: number;
}

// A hunk is the ops for one stretch of change plus its context, with
// the `@@ -a,n +b,m @@` numbers a unified diff would print for it.
export interface Hunk {
  ops: DiffOp[];
  aStart: number;
  aCount: number;
  bStart: number;
  bCount: number;
}

// Split into lines without inventing a trailing empty one: a text that
// ends in a newline has as many lines as newlines, not one more.
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Past this many edits the search is abandoned and the two texts are
// shown as a whole replacement. Myers' algorithm costs O((N+M)·D) time
// and its backtrack trace grows as D², so a pair of large, unrelated
// files (one minified library against a different one) would otherwise
// spend seconds and tens of megabytes to print a diff no one can read
// anyway. A few thousand edits is far past what anyone reads line by
// line.
const MAX_EDITS = 3000;

// Myers' O(ND) shortest-edit-script diff over two line arrays, the same
// algorithm `diff` and git use. The common prefix and suffix are peeled
// off first: they are the bulk of any real comparison, and they cost
// the search nothing that way.
export function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix && suffix < b.length - prefix
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;

  const ops: DiffOp[] = [];
  for (let i = 0; i < prefix; i++) {
    ops.push({ kind: 'same', text: a[i], aLine: i + 1, bLine: i + 1 });
  }
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const middle = myers(midA, midB) ?? replaceAll(midA, midB);
  for (const op of middle) {
    if (op.aLine !== undefined) op.aLine += prefix;
    if (op.bLine !== undefined) op.bLine += prefix;
    ops.push(op);
  }
  for (let i = 0; i < suffix; i++) {
    const ai = a.length - suffix + i;
    const bi = b.length - suffix + i;
    ops.push({ kind: 'same', text: a[ai], aLine: ai + 1, bLine: bi + 1 });
  }
  return ops;
}

// The fallback past `MAX_EDITS`: everything in A removed, everything in
// B added. Honest, if unhelpful — the counts are right, and the reader
// sees both texts in full.
function replaceAll(a: readonly string[], b: readonly string[]): DiffOp[] {
  const ops: DiffOp[] = [];
  a.forEach((text, i) => ops.push({ kind: 'del', text, aLine: i + 1 }));
  b.forEach((text, i) => ops.push({ kind: 'add', text, bLine: i + 1 }));
  return ops;
}

// The forward search from "An O(ND) Difference Algorithm and Its
// Variations" (Myers, 1986). Line numbers in the result are 1-based
// within the arrays given. Returns null when the edit count passes
// `MAX_EDITS`.
//
// `v[k]` is the furthest x reached on diagonal k (where x − y = k)
// with the current number of edits. Diagonals run from −d to d after d
// edits, so each step's array is sized to just that range (plus the
// neighbour on either side it reads) rather than to the worst case,
// and the trace kept for the backtrack costs D² rather than D·(N+M).
// The array for step d is indexed as `v[k + d + 1]`.
function myers(a: readonly string[], b: readonly string[]): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  const max = Math.min(n + m, MAX_EDITS);
  // Before step 0: k ∈ [−1, 1], and the seed on k = 1 is what makes
  // the first move a step down onto k = 0 at x = 0.
  let v = new Int32Array(3).fill(-1);
  v[2] = 0;
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v);
    const offset = d + 1;
    // Step d + 1 reads one diagonal further out on each side.
    const next = new Int32Array(v.length + 2).fill(-1);
    next.set(v, 1);
    for (let k = -d; k <= d; k += 2) {
      // Step down (an added line) or right (a removed line), whichever
      // reached further — preferring right on a tie, the conventional
      // choice that lists a deletion before the insertion beside it.
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      // Then along the diagonal for as long as the lines agree.
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      next[offset + 1 + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d);
    }
    v = next;
  }
  return null;
}

// Walk the trace back from the end to recover the edit script, then
// reverse it into reading order. `trace[d]` is the state before step
// d, which is what decided where that step went.
function backtrack(
  a: readonly string[],
  b: readonly string[],
  trace: readonly Int32Array[],
  edits: number,
): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = edits; d > 0; d--) {
    const v = trace[d];
    const offset = d + 1;
    const k = x - y;
    const prevK = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]))
      ? k + 1
      : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    // The diagonal run that followed the edit, walked backwards.
    while (x > prevX && y > prevY) {
      x--; y--;
      ops.push({ kind: 'same', text: a[x], aLine: x + 1, bLine: y + 1 });
    }
    if (x === prevX) {
      y--;
      ops.push({ kind: 'add', text: b[y], bLine: y + 1 });
    } else {
      x--;
      ops.push({ kind: 'del', text: a[x], aLine: x + 1 });
    }
  }
  // Whatever is left is the diagonal run before the first edit.
  while (x > 0 && y > 0) {
    x--; y--;
    ops.push({ kind: 'same', text: a[x], aLine: x + 1, bLine: y + 1 });
  }
  return ops.reverse();
}

// Group the changed lines into hunks, each padded with `context` lines
// of unchanged text on either side; two changes closer together than
// twice that share a hunk. An op list with no changes yields no hunks.
export function toHunks(ops: readonly DiffOp[], context = 3): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].kind === 'same') { i++; continue; }
    // The hunk starts `context` lines before this change…
    const start = Math.max(0, i - context);
    // …and runs until a stretch of more than 2·context unchanged lines
    // separates it from the next change, or the ops run out.
    let end = i;
    let sameRun = 0;
    let j = i;
    while (j < ops.length) {
      if (ops[j].kind === 'same') {
        sameRun++;
        if (sameRun > 2 * context) break;
      } else {
        sameRun = 0;
        end = j;
      }
      j++;
    }
    const stop = Math.min(ops.length, end + 1 + context);
    hunks.push(makeHunk(ops.slice(start, stop)));
    i = stop;
  }
  return hunks;
}

function makeHunk(ops: DiffOp[]): Hunk {
  let aStart = 0;
  let bStart = 0;
  let aCount = 0;
  let bCount = 0;
  for (const op of ops) {
    if (op.aLine !== undefined) {
      if (!aStart) aStart = op.aLine;
      aCount++;
    }
    if (op.bLine !== undefined) {
      if (!bStart) bStart = op.bLine;
      bCount++;
    }
  }
  // A hunk with nothing on one side (a pure insertion at the top of an
  // empty file) starts where that side's next line would be, which is
  // what `@@ -0,0 +1,3 @@` means.
  return { ops, aStart, aCount, bStart, bCount };
}

// How many lines each side has alone — the `−4 +9` a diff is summed
// up as.
export function countChanges(ops: readonly DiffOp[]): { removed: number; added: number } {
  let removed = 0;
  let added = 0;
  for (const op of ops) {
    if (op.kind === 'del') removed++;
    else if (op.kind === 'add') added++;
  }
  return { removed, added };
}
