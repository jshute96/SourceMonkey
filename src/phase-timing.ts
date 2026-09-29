// Phase timing for the paths a user can perceive as slow.
//
// Exists because "the refresh felt slow" is not something the rest of
// our diagnostics can answer. The Log tab records what a refresh
// DECIDED (loaded / no change / failed); nothing recorded where its
// time went, so every question about cost had to be answered by reading
// the code and guessing which phase dominated.
//
// Gated on the same debug-logging toggle as `dlog` (Options → Debug
// logging), and a disabled timer is a shared no-op object — no clock
// reads, no allocation, nothing on the hot path. `performance.now()`
// rather than `Date.now()` for sub-millisecond resolution on phases
// that are genuinely fast.
//
// **One line per phase group, not one per phase.** A refresh that
// printed a line per step would bury the comparison the reader is
// actually making — which phase is the big one — in a scroll.
//
// **Timers do not nest across contexts.** A collection Refresh runs in
// the collections PAGE, while the registration re-sync it triggers runs
// in the service worker, so their lines land in two different consoles.
// See [docs/diagnostics.md](../docs/diagnostics.md) for how to read the
// pair together.

import { isDebugLoggingEnabled } from './debug-log.js';

export interface PhaseTimer {
  // Close the current phase and name it. Elapsed is measured from the
  // previous mark (or from the timer's start, for the first).
  mark(phase: string): void;
  // Attach a trailing fact — counts, sizes, whatever makes the numbers
  // interpretable. Repeat calls append.
  //
  // Takes a thunk as well as a string because some of these facts cost
  // real work to produce (walking every script to count probe targets,
  // say). A disabled timer must not pay for a line nobody prints —
  // least of all on the path being optimised.
  note(text: string | (() => string)): void;
  // Emit the single summary line.
  done(): void;
}

const NOOP: PhaseTimer = {
  mark() { /* disabled */ },
  note() { /* disabled */ },
  done() { /* disabled */ },
};

class ActiveTimer implements PhaseTimer {
  private readonly start = performance.now();
  private last = this.start;
  private readonly phases: string[] = [];
  private readonly notes: string[] = [];

  constructor(private readonly label: string) {}

  mark(phase: string): void {
    const now = performance.now();
    this.phases.push(`${phase} ${round(now - this.last)}`);
    this.last = now;
  }

  note(text: string | (() => string)): void {
    this.notes.push(typeof text === 'function' ? text() : text);
  }

  done(): void {
    const total = round(performance.now() - this.start);
    // Phases are a breakdown OF the total, so they read as a
    // parenthetical after it rather than as a separate list.
    const breakdown = this.phases.length > 0 ? ` (${this.phases.join(', ')})` : '';
    const notes = this.notes.length > 0 ? ` — ${this.notes.join(', ')}` : '';
    console.log(`[SourceMonkey] timing — ${this.label}: total ${total}ms${breakdown}${notes}`);
  }
}

// Whole milliseconds once a phase is big enough that the fraction is
// noise, one decimal below that — a phase reported as `0ms` reads as
// "didn't run" when it means "too fast to matter", and the difference
// is exactly what a reader chasing a slow refresh needs.
function round(ms: number): number {
  return ms >= 10 ? Math.round(ms) : Math.round(ms * 10) / 10;
}

// Same rounding for a duration a caller measured itself and wants to
// put in a `note`, so the two halves of one line read alike.
export function formatMs(ms: number): string {
  return `${round(ms)}ms`;
}

// The clock, for a caller timing something finer-grained than a phase —
// one operation inside a phase that also contains waiting, say. Reads
// zero when logging is off, which keeps the same promise the no-op
// timer makes: nothing measured costs anything when nobody is looking.
// With the flag steady, a disabled duration comes out as 0 and the
// `note` that would print it is never called.
//
// Toggling the flag mid-operation gives that duration a meaningless
// value (one end measured against a zero origin). Deliberately not
// guarded: it needs a human flipping the setting inside a single
// refresh, and the cost is one wrong debug number.
export function timingNow(): number {
  return isDebugLoggingEnabled() ? performance.now() : 0;
}

export function startPhaseTimer(label: string): PhaseTimer {
  return isDebugLoggingEnabled() ? new ActiveTimer(label) : NOOP;
}

// ---------- Cumulative totals ----------
//
// The timers above measure one sequence. This measures where time went
// inside a fan-out: `rebuildCollection` runs its entries concurrently,
// so no single sequence describes the cost, and "rebuild 384ms" says
// nothing about whether that was dependency fetches, hashing, or the
// parse check.
//
// Totals are CUMULATIVE across concurrent work, so they sum to more
// than the wall clock they happened in — deliberately. The question
// being answered is "which of these dominates", which is a ratio, and
// a ratio survives the overlap. The report labels them so nobody reads
// them as elapsed.
//
// Global to the JS context rather than threaded through: reaching the
// leaf call sites otherwise means a parameter through `applyFiles`,
// `attachFiles` and both per-kind loaders, plus the corpus validator
// that shares them. For a debug-only diagnostic that is a bad trade.
// The cost is that two concurrently refreshing collections land in one
// bucket — which is why the report is emitted per REFRESH PASS, where
// that is the granularity you want anyway.

interface Total { ms: number; n: number }
let totals: Map<string, Total> | null = null;

// Begin (or restart) accumulation. No-op when debug logging is off, so
// the leaf calls stay free.
export function resetPhaseTotals(): void {
  totals = isDebugLoggingEnabled() ? new Map() : null;
}

// Run `fn`, adding its elapsed time to `label`'s bucket. Returns
// whatever `fn` returns; a throw still records the time, since work
// that failed still cost what it cost.
export async function timePhase<T>(label: string, fn: () => Promise<T>): Promise<T> {
  // The map is captured, NOT re-read in the `finally`. Two things go
  // wrong otherwise, and one of them is severe:
  //
  //   - `reportPhaseTotals` nulls the global, and a concurrent pass can
  //     do that while this call is still awaiting. The `finally` would
  //     then dereference null and throw a TypeError OUT OF A FINALLY,
  //     which discards the wrapped call's successful result and rejects
  //     in its place. These wrap `attachFiles`, `buildScriptFromText`
  //     and the dep fetches, so a diagnostic racing itself would fail
  //     the whole collection refresh — with debug logging on, i.e.
  //     exactly when someone is diagnosing a slow refresh.
  //   - Even without the throw, a sample would land in whichever pass
  //     happened to be current when it FINISHED rather than the one it
  //     started in.
  //
  // TypeScript won't catch this: the `if (!totals)` narrowing doesn't
  // survive the `await`, so reading the global in the `finally` type-
  // checks fine.
  const bucket = totals;
  if (!bucket) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const entry = bucket.get(label) ?? { ms: 0, n: 0 };
    entry.ms += performance.now() - start;
    entry.n += 1;
    bucket.set(label, entry);
  }
}

// Emit one line, largest bucket first — the ordering IS the finding.
export function reportPhaseTotals(label: string): void {
  // Cleared even when there is nothing to say, so a pass that recorded
  // nothing doesn't leave its map open for the next one to append to.
  const finished = totals;
  totals = null;
  if (!finished || finished.size === 0) return;
  const parts = [...finished.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(([name, t]) => `${name} ${round(t.ms)}ms/${t.n}`);
  console.log(`[SourceMonkey] timing — ${label} cumulative (concurrent, sums past wall clock): ${parts.join(', ')}`);
}
