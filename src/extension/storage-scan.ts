// Full-namespace `chrome.storage.local.get(null)` reads, in one place.
//
// A `get(null)` returns EVERY row the extension owns — every script
// body, every `@require`/`@resource` payload, every `gmval:` row — even
// when the caller wants one prefix. On a small profile that is
// invisible; on a real one it is megabytes, and the cost lands in two
// places, only one of which is obvious:
//
//   - the read itself, on Chrome's storage thread; and
//   - deserializing the result into JS objects, which runs on the
//     CALLING context's single thread and blocks it. While that runs,
//     every unrelated pending promise callback in that context waits —
//     so a scan can inflate a phase that has nothing to do with it.
//
// The second effect is why these are worth naming individually. A
// reload fast-path phase measured at ~130ms for a point read of a
// small row is not explained by that row; it is explained by whatever
// else was on the thread. Without a per-scan line there is no way to
// tell those apart from the outside.
//
// Gated on the same debug-logging toggle as the phase timers, and the
// wrapper is a plain pass-through when it's off.

import { isDebugLoggingEnabled } from '../debug-log.js';
// Same rounding as the phase timers on purpose: these lines are read
// against phase numbers on the same console, and two formats that
// drift would make that comparison quietly wrong.
import { formatMs } from '../phase-timing.js';

// Runs `chrome.storage.local.get(null)`, reporting what it cost and who
// asked. `reason` should name the CALLER's purpose ("gm snapshot",
// "match index"), not the mechanism — the mechanism is the same every
// time, and the caller is the thing a reader needs to identify.
export async function scanAllStorage(reason: string): Promise<Record<string, unknown>> {
  return timeStorageRead(reason, () => chrome.storage.local.get(null));
}

// Same line for a read that is deliberately NARROW, so a caller that
// used to scan and now doesn't reports in the units it is being
// compared against. `reason` should carry the shape (`gm snapshot
// (narrow)`) — the point of the line is the contrast.
// A `null` result means the read didn't happen (the caller fell back to
// something else) and nothing is logged — a line reporting `0 row(s)`
// for a read that never ran would be worse than silence.
export async function timeStorageRead<T extends Record<string, unknown> | null>(
  reason: string,
  read: () => Promise<T>,
): Promise<T> {
  if (!isDebugLoggingEnabled()) return await read();
  const start = performance.now();
  const rows = await read();
  const ms = performance.now() - start;
  if (rows === null) return rows;
  console.log(
    `[SourceMonkey] timing: storage scan (${reason}): `
    + `${formatMs(ms)}, ${Object.keys(rows).length} row(s)`,
  );
  return rows;
}
