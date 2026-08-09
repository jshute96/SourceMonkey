// Catalog of GM_* / GM.* APIs that SourceMonkey supports (or has slots
// for). This is the single source of truth that:
//
//   - The injector consults to decide which GM_* function definitions
//     to compile into a given script's wrapper, based on its @grant
//     lines. This is where @grant is actually enforced: an ungranted
//     API is simply never bound into the script's scope.
//   - The permission-test e2e spec consults to assert that ungranted
//     APIs are not bound in the script's scope.
//
// NOTE: the SW-side async handlers do NOT re-validate @grant against
// this catalog. Enforcement is binding-time only (above). Re-checking
// in the SW would add no security: the per-message `scriptId` is
// wrapper-supplied and spoofable, so a script that wanted to bypass
// the grant would just claim the id of a script that has it. See the
// "trust caveat" notes in docs/GM-APIs.md.
//
// Each API entry says:
//   - The canonical `GM_x` name and the GM4-style `GM.x` alias (if
//     any). Scripts can @grant either form and we honor both. A
//     couple of APIs answer to a second `GM.` spelling as well — see
//     `gmDotSpellings` below for why.
//   - Whether the call resolves in-page (`sync`) — runs in
//     USER_SCRIPT world via the shared __SM_GM__ runtime — or makes a
//     SW round-trip (`async`).
//   - The subsystem the body delegates to. Drives both the wrapper-side
//     stub and the SW-side message routing.
//
// Adding a new API: append an entry, then either (a) implement the
// sync body in src/wrapper-gm-runtime.js if `kind === 'sync'` or (b)
// add an SW-side handler if `kind === 'async'`.

export type ApiKind = 'sync' | 'async';

export type ApiSubsystem =
  | 'info'
  | 'log'
  | 'storage'
  | 'storage-listener'
  | 'dom'
  | 'resource'
  | 'menu'
  | 'xhr'
  | 'clipboard'
  | 'notification'
  | 'tab'
  | 'download'
  | 'unsafe-window';

// Extra header tags an API depends on, beyond the bare `@grant` line.
// The catalog declares these so the wrapper / SW can validate them once
// at sync time (`requires: ['connect']` → `@connect` URL gating for
// xhr) rather than each API body re-deriving the rule.
export type ApiRequirement = 'connect' | 'resource';

export interface GmApiSpec {
  // The legacy `GM_x` name. Always present.
  name: string;
  // The GM4-style alias under the `GM.` namespace, if any. Some APIs
  // (e.g. unsafeWindow, GM_info itself) don't have a GM. alias.
  gmDotName?: string;
  // `sync` resolves in USER_SCRIPT world without an SW round-trip
  // (storage reads, addStyle, etc.). `async` always goes to the SW.
  //
  // Note: `kind` is informational for one entry only — `unsafeWindow`.
  // That entry isn't callable; it's a passthrough binding. The
  // emitter dispatches on `subsystem` for that special case.
  kind: ApiKind;
  // Used by the GM4 `GM.` alias: when truthy, the dot form returns a
  // Promise even if the legacy `GM_x` form returns synchronously. (GM4
  // wrapped every storage primitive in a Promise; the legacy form
  // didn't.)
  gmDotPromised?: boolean;
  subsystem: ApiSubsystem;
  // Header tags the script must declare for this API to be usable.
  // Currently only `connect` (for `GM_xmlhttpRequest`) and `resource`
  // (for `GM_getResource*`). When omitted, no extra header is needed.
  requires?: readonly ApiRequirement[];
}

// IMPORTANT: when adding entries here keep the order stable — emit
// order in the wrapper isn't load-bearing but stable order makes
// stack traces and diffed wrapper bodies easier to compare across
// runs.
export const GM_APIS: readonly GmApiSpec[] = Object.freeze([
  // ----- Compile-time / in-page constants -----
  { name: 'GM_info', gmDotName: 'info', kind: 'sync', subsystem: 'info' },
  { name: 'unsafeWindow', kind: 'sync', subsystem: 'unsafe-window' },

  // ----- Logging -----
  { name: 'GM_log', gmDotName: 'log', kind: 'sync', subsystem: 'log' },

  // ----- Storage (sync return; GM. form returns Promise per GM4) -----
  { name: 'GM_setValue', gmDotName: 'setValue', gmDotPromised: true, kind: 'sync', subsystem: 'storage' },
  { name: 'GM_getValue', gmDotName: 'getValue', gmDotPromised: true, kind: 'sync', subsystem: 'storage' },
  { name: 'GM_deleteValue', gmDotName: 'deleteValue', gmDotPromised: true, kind: 'sync', subsystem: 'storage' },
  { name: 'GM_listValues', gmDotName: 'listValues', gmDotPromised: true, kind: 'sync', subsystem: 'storage' },

  // ----- Value-change listeners (sync register/unregister) -----
  { name: 'GM_addValueChangeListener', gmDotName: 'addValueChangeListener', kind: 'sync', subsystem: 'storage-listener' },
  { name: 'GM_removeValueChangeListener', gmDotName: 'removeValueChangeListener', kind: 'sync', subsystem: 'storage-listener' },

  // ----- DOM injection -----
  { name: 'GM_addStyle', gmDotName: 'addStyle', kind: 'sync', subsystem: 'dom' },
  { name: 'GM_addElement', gmDotName: 'addElement', kind: 'sync', subsystem: 'dom' },

  // ----- @resource lookups (require @resource header support) -----
  // GM4 spelling is `GM.getResourceUrl` (lowercase 'u') — keep the
  // casing mismatch with GM_getResourceURL, it's deliberate.
  { name: 'GM_getResourceText', gmDotName: 'getResourceText', kind: 'sync', subsystem: 'resource', requires: ['resource'] },
  { name: 'GM_getResourceURL', gmDotName: 'getResourceUrl', kind: 'sync', subsystem: 'resource', requires: ['resource'] },

  // ----- Menu commands (stub: register/unregister) -----
  { name: 'GM_registerMenuCommand', gmDotName: 'registerMenuCommand', kind: 'sync', subsystem: 'menu' },
  { name: 'GM_unregisterMenuCommand', gmDotName: 'unregisterMenuCommand', kind: 'sync', subsystem: 'menu' },

  // ----- Async APIs (cross-world, SW round-trip) -----
  // Note: GM_xmlhttpRequest returns a sync control object, but the
  // request itself is async. We classify by SW round-trip — `async` —
  // because the wrapper has to message the SW to start the request.
  { name: 'GM_xmlhttpRequest', gmDotName: 'xmlHttpRequest', kind: 'async', subsystem: 'xhr', requires: ['connect'] },
  // GM_setClipboard is handled in-page via navigator.clipboard.writeText
  // — no SW round-trip — so it's classified `sync` even though the
  // underlying browser call is async (returns Promise<void>). Page-
  // handled vs SW-handled is what `kind` actually means in this
  // catalog. TM/VM use an offscreen document via execCommand('copy');
  // we may revisit later if real users hit "navigator.clipboard
  // requires focus" failures.
  { name: 'GM_setClipboard', gmDotName: 'setClipboard', kind: 'sync', subsystem: 'clipboard' },
  { name: 'GM_notification', gmDotName: 'notification', kind: 'async', subsystem: 'notification' },
  { name: 'GM_openInTab', gmDotName: 'openInTab', kind: 'async', subsystem: 'tab' },
  // Like GM_xmlhttpRequest, GM_download hands back a sync `{abort}`
  // control object while the transfer itself runs in the SW — `async`
  // classifies the SW round-trip, not the return value. It is NOT
  // `requires: ['connect']`: download URLs are runtime-discovered CDN
  // hosts that scripts can't enumerate in a header, and the bytes go
  // to disk rather than back to the script, so the exfiltration risk
  // `@connect` guards doesn't apply. See docs/GM-APIs.md.
  { name: 'GM_download', gmDotName: 'download', kind: 'async', subsystem: 'download' },
]);

// Every `GM.` property name one API answers to, in priority order
// (the GM4 alias first, then the literal prefix rewrite).
//
// Why there can be two. Violentmonkey resolves a `GM.foo` grant by
// consulting a two-entry alias table (`xmlHttpRequest` →
// `GM_xmlhttpRequest`, `getResourceUrl` → `GM_getResourceURL`) and
// otherwise rewriting the name to `'GM_' + foo` verbatim
// (`src/injected/web/gm-api-wrapper.js`). Inverting that rule, the
// `GM.` spellings VM accepts for an API are its GM4 alias *and* its
// legacy name minus the `GM_` prefix. For most APIs those are the
// same string; they differ only where GM4 re-cased the name:
//
//   GM_xmlhttpRequest  → GM.xmlHttpRequest (GM4)   + GM.xmlhttpRequest (rewrite)
//   GM_getResourceURL  → GM.getResourceUrl (GM4)   + GM.getResourceURL (rewrite)
//
// `GM.xmlhttpRequest` is the one with real usage — published
// GreasyFork scripts both grant it and call it. `GM.getResourceURL`
// has no corpus hits; we accept it because it falls out of the same
// VM rule and leaving it out would be an arbitrary exception.
//
// Tampermonkey does NOT accept the rewrite spellings — its grant
// table is a fixed list of exact names per API. But TM gates that
// whole list on one boolean, so granting any member exposes every
// member. We borrow that "a grant names an API, not a spelling"
// model and apply it to a larger spelling set, which makes us a
// strict superset of both: a script granting `GM_xmlhttpRequest` and
// calling `GM.xmlhttpRequest` works here and nowhere else.
//
// We also do NOT copy VM's quirk that the rewrite spelling gets
// synchronous semantics while the GM4 spelling is promisified — our
// two spellings behave identically. See docs/supported-GM-APIs.md.
//
// Deriving this instead of hand-listing it keeps a new catalog entry
// from silently missing an alias.
export function gmDotSpellings(spec: GmApiSpec): string[] {
  const out: string[] = [];
  if (spec.gmDotName) out.push(spec.gmDotName);
  if (spec.name.startsWith('GM_')) {
    const rewritten = spec.name.slice(3);
    if (!out.includes(rewritten)) out.push(rewritten);
  }
  return out;
}

// Quick lookup. Built lazily so unit tests that only import types or
// constants don't pay the Map cost; callers that hit this in a hot
// loop should cache the result of `findApi` themselves.
let byName: Map<string, GmApiSpec> | null = null;
function ensureIndex(): Map<string, GmApiSpec> {
  if (byName !== null) return byName;
  const m = new Map<string, GmApiSpec>();
  for (const a of GM_APIS) {
    m.set(a.name, a);
    for (const dot of gmDotSpellings(a)) m.set(`GM.${dot}`, a);
  }
  byName = m;
  return m;
}

// Case-folded index over the same keys, used only to explain a
// near-miss to the user. NOT used for matching — TM and VM both
// compare grant names byte-exactly, and we deliberately don't
// diverge (see docs/supported-GM-APIs.md → "Granting").
//
// Values are index keys, not canonical `GM_x` names, so a `GM.` miss
// suggests a `GM.` spelling and a `GM_` miss suggests a `GM_` one.
// (A cross-form suggestion is structurally impossible: `.` and `_`
// don't case-fold together.) Where two keys collide —
// `GM.xmlHttpRequest` and `GM.xmlhttpRequest` fold to the same
// string — first-write-wins picks the GM4 spelling, which is the
// better one to suggest anyway.
let byLowerName: Map<string, string> | null = null;
function ensureCaseFoldedIndex(): Map<string, string> {
  if (byLowerName !== null) return byLowerName;
  const m = new Map<string, string>();
  for (const key of ensureIndex().keys()) {
    const lower = key.toLowerCase();
    if (!m.has(lower)) m.set(lower, key);
  }
  byLowerName = m;
  return m;
}

// Look up an API spec by either its `GM_x` name OR its `GM.x` form.
// Returns undefined for unknown names (e.g. APIs we don't support
// yet — `GM_webRequest`, `GM_audio`, etc.).
export function findApi(name: string): GmApiSpec | undefined {
  return ensureIndex().get(name);
}

// For an unrecognized `@grant` name, the known spelling it differs
// from only in capitalization — or null when there isn't one.
//
// Purely a diagnostic aid: `@grant GM_xmlHttpRequest` (capital H) is
// dropped by TM/VM and by us, and the resulting `ReferenceError` at
// call time gives the author no hint about why. Naming the near miss
// in the unknown-grant warning does.
export function suggestGrant(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (findApi(trimmed)) return null; // not a miss at all
  return ensureCaseFoldedIndex().get(trimmed.toLowerCase()) ?? null;
}

// Normalize a single `@grant` line to its canonical `GM_x` name.
//
// Cases:
//   - `GM_setValue` → `'GM_setValue'`
//   - `GM.setValue` → `'GM_setValue'` (canonicalized to the legacy form)
//   - unknown / blank → `null`
//
// Does NOT handle the `none` sentinel — that's a per-script policy,
// not a per-name canonicalization. `resolveGrants` is where `none`
// gets recognized and propagated.
export function canonicalizeGrant(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed.toLowerCase() === 'none') return null;
  const spec = findApi(trimmed);
  return spec ? spec.name : null;
}

// Resolve the set of granted GM_* names for a script, given its raw
// @grant lines.
//
// Rules:
//   - A `none` line anywhere wins — the script is treated as ungranted.
//     Matches TM/VM behavior: a script with `@grant none` and `@grant
//     GM_setValue` is treated as `@grant none`. The granted set is
//     returned empty in this case; `unknown` is still populated so the
//     caller can warn.
//   - Unknown names are dropped from `granted` and surfaced in
//     `unknown`. The wrapper simply won't emit a binding for them, and
//     the script gets a natural ReferenceError at call time.
//   - Duplicate names collapse to one (Set semantics).
export function resolveGrants(rawGrants: readonly string[]): {
  granted: Set<string>;
  hasNone: boolean;
  unknown: string[];
} {
  const granted = new Set<string>();
  let hasNone = false;
  const unknown: string[] = [];
  for (const raw of rawGrants) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (trimmed.toLowerCase() === 'none') {
      hasNone = true;
      continue;
    }
    const canonical = canonicalizeGrant(trimmed);
    if (canonical === null) {
      unknown.push(trimmed);
      continue;
    }
    granted.add(canonical);
  }
  // @grant none wins — even if other granted lines were also present.
  if (hasNone) granted.clear();
  return { granted, hasNone, unknown };
}

// True iff the named API is part of the supported surface. Used by the
// SW-side message router to reject unknown method calls (a misbehaving
// or stale wrapper that asks for `GM_audio.play` shouldn't be able to
// drive any handler).
export function isSupportedApi(name: string): boolean {
  return findApi(name) !== undefined;
}
