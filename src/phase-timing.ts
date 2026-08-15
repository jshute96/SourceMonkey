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
  note(text: string): void;
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

  note(text: string): void {
    this.notes.push(text);
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

export function startPhaseTimer(label: string): PhaseTimer {
  return isDebugLoggingEnabled() ? new ActiveTimer(label) : NOOP;
}
