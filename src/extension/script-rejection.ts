// Per-script record of a registration `chrome.userScripts` refused.
//
// A rejected spec is a state of its own: the script loaded fine (it has
// valid content, a valid header, and a status of `ok`), but Chrome
// would not accept the registration — a `@match` pattern it considers
// malformed is the usual cause — so the script silently never runs.
// The collections page and the viewer render that as REJECTED. See
// [docs/diagnostics.md](../docs/diagnostics.md#rejected-registrations).
//
// Rarer than it used to be: `matchPatternProblem` (src/url-match.ts)
// catches the malformed shapes we are sure about at parse time, so what
// reaches here is the rest of Chrome's grammar — a malformed port, a
// host its canonicalizer rejects, or whatever it tightens next.
//
// Written only by `src/extension/injector.ts` — `registerWithFallback` and the
// targeted retry are the only places that ever learn a spec was
// refused. Read by the collections page and the viewer for the row's
// status, and by `src/extension/background.ts` for the tab badge; all three
// watch `chrome.storage.session.onChanged` so they repaint without a
// reload.
//
// Why `chrome.storage.session`:
//   - The fact describes Chrome's CURRENT registration set, which is
//     itself dropped on browser shutdown. Persisting it to local
//     storage would let a REJECTED badge outlive the registration
//     attempt that produced it.
//   - It has to outlive the service worker: MV3 evicts the SW freely
//     and `syncRegistrations` runs again on every wake-up, so an
//     in-memory Map would lose the state on every eviction.
//
// Why one map key rather than a key per script (the shape
// `script-log.ts` uses for log levels): the injector rewrites the whole
// set on every sync so that a script which left the active registration
// set — disabled, deleted, or newly INVALID — can't leave a stale
// REJECTED badge behind. Authoritative-set semantics want a single
// read/write; the alternative would need a full session scan to find
// the strays.

import { assertWorkerContext } from '../run-context.js';

// Session-storage key holding the whole `RejectionMap`.
export const REJECTIONS_KEY = 'injector-rejections';

// {registration id → Chrome's reason for refusing it}, covering exactly
// the specs the last sync tried to register.
//
// The reason is Chrome's own wording, e.g. "Script with ID … has
// invalid value for matches[1]: Invalid port". Passed through verbatim:
// it names the offending header value, which is exactly what the user
// has to fix.
export type RejectionMap = Record<string, string>;

// The one sentence every surface uses for a refused registration: the
// Log row, and the viewer's message bar. One message per problem —
// two copies would drift the moment either is reworded.
//
// `reason` is Chrome's own wording, appended rather than rephrased
// because it names the offending header value. See
// [docs/diagnostics.md](../docs/diagnostics.md#rejected-registrations).
export function describeRejection(reason: string): string {
  return `Chrome rejected this script's registration, so it will not run: ${reason}`;
}

// Coerce an unknown storage value into a RejectionMap, dropping any
// entry whose reason isn't a string. Used for both the direct read and
// the `storage.onChanged` newValue, so the two paths can't disagree
// about what a well-formed record looks like.
export function coerceRejectionMap(value: unknown): RejectionMap {
  if (!value || typeof value !== 'object') return {};
  const out: RejectionMap = {};
  for (const [id, message] of Object.entries(value as Record<string, unknown>)) {
    if (typeof message === 'string') out[id] = message;
  }
  return out;
}

// Every registration the last sync could not place. Empty when nothing
// is rejected, which is the overwhelmingly common case.
export async function readRejections(): Promise<RejectionMap> {
  try {
    const got = await chrome.storage.session.get(REJECTIONS_KEY);
    return coerceRejectionMap(got[REJECTIONS_KEY]);
  } catch {
    // Session storage being unavailable shouldn't break a sync; the
    // worst case is a status cell that doesn't say REJECTED.
    return {};
  }
}

// Replace the stored map with `next`, but only when it actually differs
// from `prior`. The no-rejections case — every sync on a healthy
// profile — then costs one read and no write, and no needless
// `storage.onChanged` event fans out to the open UI pages.
//
// Note this is about the STORAGE write, not about logging: a rejection
// that persists across syncs writes nothing here but still gets a fresh
// Log row each time, because "we tried again and Chrome said no again"
// is a fact about this sync. See `registerWithFallback`.
export async function writeRejections(prior: RejectionMap, next: RejectionMap): Promise<void> {
  if (sameRejections(prior, next)) return;
  try {
    assertWorkerContext('write storage');
    await chrome.storage.session.set({ [REJECTIONS_KEY]: next });
  } catch { /* best-effort: the badge isn't load-bearing */ }
}

function sameRejections(a: RejectionMap, b: RejectionMap): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const id of keys) if (a[id] !== b[id]) return false;
  return true;
}
