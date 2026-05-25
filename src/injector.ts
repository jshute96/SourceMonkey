// Userscript injection via the chrome.userScripts API.
//
// Chrome owns the actual matching + injection at navigation time. Our
// job is to keep its registration set in sync with our "effectively
// enabled ok scripts" view of the world. Whenever the script-store
// cache changes we re-sync (cheap full wipe + re-register at our
// scale).
//
// Each script's body is wrapped in a tiny prelude/postlude:
//   - logs "[SourceMonkey] script "<name>" running on <url>" to the page
//     console on activation,
//   - catches synchronous throws from the body and logs them as
//     "[SourceMonkey] script "<name>" threw: <message>",
//   - posts sm:start / sm:error messages to the SW so the SW can log
//     activity centrally.
//
// In addition to that synchronous catch, the wrapper installs
// window `error` + `unhandledrejection` listeners filtered by a
// per-script `//# sourceURL=sourcemonkey://…` marker appended to the
// body. Errors whose stack (or filename) references our marker are
// attributed to this script and reported as sm:error; everything else
// on the page is ignored. See docs/injection.md.
//
// Requirements: manifest must include the "userScripts" permission AND
// the user must enable the "Allow User Scripts" toggle (Chrome ≥138) or
// developer mode (Chrome 120–137) on chrome://extensions. If the toggle
// is off, chrome.userScripts.register throws; we surface that via
// getLastError() so the options page can prompt the user.
//
// Handling /regex/ @include / @exclude: the User Scripts API has no
// equivalent for these. We work around it by:
//   (a) registering broadly enough that Chrome will hand the page to
//       us — if a script has only regex @includes (no @match, no glob
//       @include), we register `<all_urls>` so Chrome injects
//       everywhere, and let the wrapper filter; otherwise the script
//       already has Chrome-understandable patterns, and we just need
//       the wrapper to apply the regex @excludes.
//   (b) re-running urlMatchesScript inside the wrapper before the
//       body runs, bailing silently if the current URL doesn't
//       actually match. This keeps badge count and actual injection
//       in sync without divergence.
// The runtime filter is only emitted when a script actually contains
// a regex pattern; pure @match / glob-only scripts skip it.

import {
  describeError,
  isScriptEnabled,
  isSourceEnabled,
  type StoredScript,
  type StoredSource,
} from './script-store.js';
import { getValue, getValues, type ParsedHeader } from './userscript-header.js';
import {
  WRAPPER_BRIDGE,
  WRAPPER_GM_RUNTIME,
  WRAPPER_HEAD,
  WRAPPER_MATCHER,
  WRAPPER_TAIL,
} from './generated-wrappers.js';
import { resolveGrants } from './gm-api-catalog.js';
import { emitGmBindings, type GmInfoInput } from './gm-bindings.js';
import { loadAllValues } from './gm-values.js';

const SCRIPT_PREFIX = 'script:';
const SOURCE_PREFIX = 'source:';

// Match the runtime-message types we use between injected scripts and
// the SW. Keep these in sync with the strings the wrapper sends.
export const SM_START_MSG = 'sm:start';
export const SM_ERROR_MSG = 'sm:error';
// Reload fast-path: the wrapper asks the SW whether to run its baked-in
// body, abandon, or swap in a fresher user-code body the SW will hand
// back. See docs/injection.md#reload-fast-path. sm:swapped / sm:abandoned
// are the wrapper's follow-up reports for the swap / skip branches.
export const SM_CHECK_PENDING_MSG = 'sm:check-pending';
export const SM_SWAPPED_MSG = 'sm:swapped';
export const SM_ABANDONED_MSG = 'sm:abandoned';

// Reserved registration id for the MAIN-world bridge (see
// buildBridgeSpec). Chrome's userScripts API rejects ids that start
// with `_`, so we use a `sourcemonkey-` prefix; stored script ids are
// UUIDs and won't collide.
export const BRIDGE_SCRIPT_ID = 'sourcemonkey-bridge';

// Reserved registration id for the USER_SCRIPT-world GM_* shared
// runtime. Registered at document_start so its `window.__SM_GM__`
// global is in place before any userscript wrapper runs.
export const GM_RUNTIME_SCRIPT_ID = 'sourcemonkey-gm-runtime';

export type RegistrationSpec = chrome.userScripts.RegisteredUserScript;
export type InjectionWorld = 'MAIN' | 'USER_SCRIPT';

// Normalize the script's declared `@run-at` header to one of the four
// recognized values. The wrapper uses this to gate body execution on
// the right lifecycle event — we no longer ask Chrome's userScripts
// scheduler to honor `@run-at` because it batches document_end into
// the post-load injection burst. See `__smWaitForRunAt` in
// `wrapper-head.js`.
export function normalizeDeclaredRunAt(value: string | undefined): string {
  switch ((value ?? '').toLowerCase()) {
    case 'document-start':
      return 'document-start';
    case 'document-body':
      return 'document-body';
    case 'document-end':
      return 'document-end';
    default:
      return 'document-idle';
  }
}

// Decide which execution world a script should run in. Mirrors
// Violentmonkey's `@inject-into` semantics (and Tampermonkey's default
// for `@grant none`):
//
//   - `@inject-into page`        → MAIN  (page context — sees the page's
//                                          window.X globals)
//   - `@inject-into content`     → USER_SCRIPT (isolated)
//   - default / `auto` / unset   → MAIN when there are no @grant entries
//                                  (or every @grant is `none`); otherwise
//                                  USER_SCRIPT.
//
// Why this default: scripts that opt out of GM_* (the `@grant none`
// convention) expect direct page access — `window.map`, `window.jQuery`,
// page-defined functions. Putting them in USER_SCRIPT silently breaks
// any script that touches a page global. Tampermonkey runs `@grant none`
// scripts in page context for the same reason.
//
// Limitation: MAIN-world scripts cannot call `chrome.runtime.sendMessage`,
// so the wrapper's `sm:start` / `sm:error` reports never reach the SW.
// The wrapper already swallows that throw; the badge's "actual"
// classification simply stays empty for MAIN-world scripts. See
// docs/injection.md.
export function resolveWorld(header: ParsedHeader | null | undefined): InjectionWorld {
  // No metadata block at all → treat like an unannotated script
  // (effectively @grant none). validateHeader rejects scripts without a
  // header anyway, but be defensive here so the function is total.
  if (!header) return 'MAIN';
  const injectInto = (getValue(header, 'inject-into') ?? '').trim().toLowerCase();
  if (injectInto === 'page') return 'MAIN';
  if (injectInto === 'content') return 'USER_SCRIPT';
  // `auto` or unspecified — look at @grant.
  const grants = getValues(header, 'grant').map((g) => g.trim().toLowerCase());
  if (grants.length === 0) return 'MAIN';
  if (grants.every((g) => g === 'none' || g === '')) return 'MAIN';
  return 'USER_SCRIPT';
}

function isRegexLiteral(s: string): boolean {
  return s.length >= 2 && s.startsWith('/') && s.endsWith('/');
}

// Concatenate every prefetched `@require` body, in declaration order,
// before the script's own body. A `;\n` separator between each segment
// ensures that an ASI-sensitive expression at the end of one require
// (e.g. an IIFE that returns a value with no trailing semicolon) can't
// merge into the next segment. The leading `// @require <url>` per
// require makes the registered code easier to scan in devtools.
//
// Why a line comment (`// …`) rather than a block comment: a URL
// can legitimately contain `*/` in its path (`*` is a valid path
// char), which would prematurely close a block comment and break the
// wrapper. Line comments terminate at newline, and URLs can't carry
// newlines.
//
// No per-require `//# sourceURL=` directive — JS only honors the LAST
// such comment in a source file, and the wrapper appends one for the
// userscript itself (used by the async-error attribution path). Stack
// traces inside required code will still point at the userscript's
// sourceURL; that matches TM/VM behavior.
export function composeRequiredBody(script: StoredScript): string {
  const requires = script.requires ?? [];
  if (requires.length === 0) return script.bodyText;
  const parts: string[] = [];
  for (const r of requires) {
    parts.push(`// @require ${r.url}`);
    parts.push(r.source);
    parts.push(';');
  }
  parts.push(script.bodyText);
  return parts.join('\n');
}

// Build the per-script sourceURL the wrapper uses to attribute async
// errors back to this script. Two requirements:
//   - The string must be unique per script (we filter error events by
//     `indexOf(sourceUrl) !== -1` against stack/filename), so we include
//     the stored UUID.
//   - The string must be a valid URL-shaped value because the engine
//     parses `//# sourceURL=...` as one — slashes, colons, dots, dashes
//     and underscores are safe; we replace everything else in the name
//     with `_` so a script titled "Foo / Bar (v2)" still produces a
//     well-formed sourceURL.
function buildSourceUrl(id: string, name: string): string {
  const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'script';
  return `sourcemonkey://${id}/${safe}.user.js`;
}

// Wrap a userscript body with our activation/error logging shim plus
// (optionally) the regex-aware match recheck. The wrapper runs in the
// USER_SCRIPT world; `chrome.runtime.sendMessage` works there because
// we call `configureWorld({ messaging: true })` before registering.
//
// The HEAD and TAIL come from src/wrapper-head.js + src/wrapper-tail.js
// pre-minified to a single line each by the build (see
// scripts/build.mjs). Placing the entire HEAD on physical line 1 with
// no trailing newline keeps the body's line N at physical line N, so
// user-facing stack traces report meaningful line numbers.
//
// If `matching` is provided, the wrapper embeds the matcher snippet
// (from src/wrapper-matcher.js) so the wrapper can re-check the URL
// against the full Tampermonkey match semantics — including /regex/
// forms that the User Scripts API can't express — and silently bail
// on a miss.
export function buildWrappedBody(args: {
  id: string;
  name: string;
  body: string;
  loadedAt: number;
  // Declared `@run-at` value from the script header, lowercased. One of
  // 'document-start', 'document-body', 'document-end', 'document-idle'.
  // Defaults to 'document-idle' (the @run-at default) when omitted; the
  // production caller `buildRegistrationSpec` always passes a value
  // pre-normalized by `normalizeDeclaredRunAt`, but unit tests that
  // exercise other parts of the wrapper can leave it off. The wrapper
  // gates body execution on the matching lifecycle event so we don't
  // inherit Chrome's batching of document_end into the post-load
  // injection burst.
  declaredRunAt?: string;
  matching?: { matches: string[]; includes: string[]; excludes: string[] };
  // GM bindings source produced by gm-bindings.ts. Empty string when
  // the script declared no @grant lines (or `@grant none`).
  gmBindings?: string;
  // GM prelude — eager `__SM_GM__.*` calls (today: storage.init) that
  // must run BEFORE the body but AFTER the runtime is installed.
  // Spliced into the wrapper inside `__smWaitForRunAt`'s callback,
  // not at the IIFE top. Empty when no storage grant is declared.
  gmPrelude?: string;
}): string {
  // Pass replacements as functions so `$&` / `$1` etc. inside our
  // generated wrappers aren't interpreted as String.prototype.replace
  // back-references (the matcher contains literal `$&` inside a
  // regex-escape helper, which would otherwise corrupt the output).
  const matcherBlock = args.matching
    ? WRAPPER_MATCHER.replace('"__SM_MATCHING__"', () => JSON.stringify(args.matching!))
    : '';
  const sourceUrl = buildSourceUrl(args.id, args.name);
  const head = WRAPPER_HEAD
    .replace('"__SM_NAME__"', () => JSON.stringify(args.name))
    .replace('"__SM_ID__"', () => JSON.stringify(args.id))
    // The wrapper template has "__SM_LOADED_AT__" (quoted) where the
    // loadedAt should appear. JSON.stringify on a number yields a bare
    // numeric literal, so the surrounding quotes get replaced and the
    // wrapper ends up with `var __smLoadedAt = 1737051234567;`.
    .replace('"__SM_LOADED_AT__"', () => JSON.stringify(args.loadedAt))
    .replace('"__SM_SOURCE_URL__"', () => JSON.stringify(sourceUrl))
    .replace('"__SM_RUN_AT__"', () => JSON.stringify(args.declaredRunAt ?? 'document-idle'))
    .replace('"__SM_MATCHER_BLOCK__";', () => matcherBlock)
    .replace('"__SM_GM_BINDINGS__";', () => args.gmBindings ?? '')
    .replace('"__SM_GM_PRELUDE__";', () => args.gmPrelude ?? '');
  // No newline between head and body so body line N stays at physical
  // line N. Tail goes on its own line after the body for readability
  // when inspecting the registered code. The `//# sourceURL=` directive
  // is appended last — it labels the script in devtools AND is what the
  // wrapper's window error listener greps for to decide whether a given
  // error originated in this script's code.
  return head + args.body + '\n' + WRAPPER_TAIL + '\n//# sourceURL=' + sourceUrl + '\n';
}

// Build the GM-binding source string for one script. Async because
// storage-granting scripts need to read their persisted values from
// chrome.storage.local at register time so the page-side cache is
// populated synchronously before the user body runs.
//
// Returns `{ js: '', granted: [] }` when the script declares no @grant
// or @grant none.
//
// Side effects. When the script declares `@grant` lines that aren't in
// the catalog (TM-only APIs we don't support, typos like
// `GM_setvalue`), we log a one-liner with the unknown names so a
// future user can see why their script throws ReferenceError. The
// binding emission still goes ahead for the recognized grants.
export async function buildGmBindingsForScript(
  script: StoredScript,
  scriptHandlerVersion: string,
): Promise<{ js: string; prelude: string; granted: readonly string[] }> {
  if (!script.header) return { js: '', prelude: '', granted: [] };
  const grants = getValues(script.header, 'grant');
  const resolved = resolveGrants(grants);
  if (resolved.unknown.length > 0) {
    const name = getValue(script.header, 'name') ?? script.relativePath;
    console.info(
      `[SourceMonkey] ${name}: unknown @grant entries dropped: ${resolved.unknown.join(', ')}`,
    );
  }
  if (resolved.hasNone || resolved.granted.size === 0) {
    return { js: '', prelude: '', granted: [] };
  }
  const name = getValue(script.header, 'name') ?? script.relativePath;
  // Only bother reading storage if a storage API is actually granted.
  // Saves an O(everything) chrome.storage.local.get(null) scan for
  // scripts that only @grant non-storage APIs.
  const storageNames = new Set([
    'GM_setValue', 'GM_getValue', 'GM_deleteValue', 'GM_listValues',
  ]);
  let initialValues: Record<string, unknown> = {};
  for (const n of resolved.granted) {
    if (storageNames.has(n)) {
      initialValues = await loadAllValues(script.id);
      break;
    }
  }
  const info: GmInfoInput = {
    scriptId: script.id,
    name,
    version: getValue(script.header, 'version') ?? '',
    namespace: getValue(script.header, 'namespace') ?? '',
    description: getValue(script.header, 'description') ?? '',
    matches: script.matching.matches.slice(),
    includes: script.matching.includes.slice(),
    excludes: script.matching.excludes.slice(),
    grants: [...resolved.granted],
    runAt: getValue(script.header, 'run-at') ?? '',
    scriptMetaStr: script.headerText,
    scriptHandlerVersion,
    initialValues,
  };
  return emitGmBindings([...resolved.granted], info);
}

// Pure: build the spec we'll hand to chrome.userScripts.register for
// one script. Returns null only if validateHeader would have caught
// the script upstream (no matchable patterns at all).
//
// Strategy for regex patterns:
//   - /regex/ @includes have no Chrome equivalent; they go to the
//     wrapper-side filter. If a script's ONLY includes are regexes
//     (and it has no @match), we register with `<all_urls>` so Chrome
//     hands us every page and the wrapper does the real check.
//   - /regex/ @excludes likewise go to the wrapper. We can't tell
//     Chrome to skip them, so they always get an injection that the
//     wrapper aborts.
// `scriptHandlerVersion` default is for unit tests that don't exercise
// the GM bindings (the value lands in `GM_info.version`). Production
// callers pass `chrome.runtime.getManifest().version`.
//
// Async because storage-granting scripts read their persisted values
// from chrome.storage.local at register time (see
// buildGmBindingsForScript).
export async function buildRegistrationSpec(
  script: StoredScript,
  scriptHandlerVersion: string = '0.0.0',
): Promise<RegistrationSpec | null> {
  const matches = script.matching.matches.slice();
  const includeGlobs: string[] = [];
  const excludeGlobs: string[] = [];
  let hasRegexInclude = false;
  let hasRegexExclude = false;
  for (const inc of script.matching.includes) {
    if (isRegexLiteral(inc)) hasRegexInclude = true;
    else includeGlobs.push(inc);
  }
  for (const ex of script.matching.excludes) {
    if (isRegexLiteral(ex)) hasRegexExclude = true;
    else excludeGlobs.push(ex);
  }

  // If Chrome has nothing to pattern-match on, fall back to <all_urls>
  // (only when there's at least a regex @include to defer to — a
  // script with literally no match/include patterns shouldn't reach
  // here because validateHeader rejects it).
  if (matches.length === 0 && includeGlobs.length === 0) {
    if (hasRegexInclude) matches.push('<all_urls>');
    else return null;
  }

  const declaredRunAt = normalizeDeclaredRunAt(
    script.header ? getValue(script.header, 'run-at') : undefined,
  );
  const name = (script.header && getValue(script.header, 'name')) || script.relativePath;
  const needsWrapperFilter = hasRegexInclude || hasRegexExclude;
  const body = composeRequiredBody(script);

  const world = resolveWorld(script.header);
  // GM_* bindings only make sense in USER_SCRIPT world today —
  // wrapper-gm-runtime.js is registered there. A script that mixes
  // `@grant something` with `@inject-into page` lands in MAIN; we
  // skip the bindings so the script gets a natural ReferenceError if
  // it touches a GM_* name. This is a documented limitation (see
  // docs/GM-API-strategy.md).
  const gmEmit = world === 'USER_SCRIPT'
    ? await buildGmBindingsForScript(script, scriptHandlerVersion)
    : { js: '', prelude: '', granted: [] };
  // Register at document_start regardless of the declared @run-at. The
  // wrapper itself awaits the matching lifecycle event (DOMContentLoaded
  // for document-end, load for document-idle, etc.) before invoking the
  // user body. This is the TM/VM pattern — Chrome's userScripts scheduler
  // batches document_end and document_idle into a single post-load burst,
  // which makes @run-at document-end observe readyState=complete instead
  // of interactive. Gating in-page side-steps the batching entirely.
  const spec: RegistrationSpec = {
    id: script.id,
    js: [{ code: buildWrappedBody({
      id: script.id,
      name,
      body,
      loadedAt: script.loadedAt,
      declaredRunAt,
      matching: needsWrapperFilter ? script.matching : undefined,
      gmBindings: gmEmit.js,
      gmPrelude: gmEmit.prelude,
    }) }],
    runAt: 'document_start',
    world,
  };
  if (matches.length > 0) spec.matches = matches;
  if (includeGlobs.length > 0) spec.includeGlobs = includeGlobs;
  if (excludeGlobs.length > 0) spec.excludeGlobs = excludeGlobs;
  return spec;
}

// Pure: pick the scripts that should be registered right now. Both the
// script's own enabled flag and its parent source's flag must be true.
// `ok` scripts are eligible; `missing` scripts are eligible too when the
// user has explicitly re-enabled them (the cached body + header from
// the last good load is what gets injected). `error` scripts never run.
// Async because each spec build is async (storage pre-load). We
// parallelize the per-script builds with Promise.all rather than
// awaiting sequentially — the per-spec storage reads are independent.
export async function collectActiveSpecs(
  scripts: StoredScript[],
  sources: Map<string, StoredSource>,
  scriptHandlerVersion: string = '0.0.0',
): Promise<RegistrationSpec[]> {
  const promises: Array<Promise<RegistrationSpec | null>> = [];
  for (const s of scripts) {
    if (s.status !== 'ok' && s.status !== 'missing') continue;
    if (!isScriptEnabled(s)) continue;
    const src = sources.get(s.sourceId);
    if (!src || !isSourceEnabled(src)) continue;
    promises.push(buildRegistrationSpec(s, scriptHandlerVersion));
  }
  const results = await Promise.all(promises);
  const out: RegistrationSpec[] = [];
  for (const r of results) if (r) out.push(r);
  return out;
}

// Pure: build the registration spec for the MAIN-world bridge, or
// return null when no MAIN-world script is active.
//
// Why we need this: MAIN-world wrappers can't call
// chrome.runtime.sendMessage (chrome.runtime is undefined there), so
// __smSend in wrapper-head.js falls back to window.postMessage with a
// "sourcemonkey-bridge" marker. The bridge runs in USER_SCRIPT world on
// the same page, listens for those postMessages, and forwards them to
// the SW. Without it, MAIN-world scripts execute fine but never report
// sm:start / sm:error, so the badge shows them as MISSING.
//
// Scoping. The bridge registers at `<all_urls>` and runAt
// document_start. Narrowing to the exact union of MAIN-world scripts'
// patterns would save the addEventListener call on unrelated pages but
// complicates the spec (especially with regex includes) for a
// negligible runtime cost.
//
// Ordering vs. wrappers. Every userscript wrapper now registers at
// document_start too (the wrapper itself awaits the declared @run-at
// in-page), so the bridge and the wrapper both run during the same
// document_start tick. postMessage queues the event in a later task —
// even if a MAIN wrapper happens to run before the bridge in the same
// task, the dispatch fires after both finish their synchronous init,
// so the bridge catches it. Wrapper bodies that run later (DCL / load
// via __smWaitForRunAt) always have the bridge in place by then.
export function buildBridgeSpec(activeSpecs: RegistrationSpec[]): RegistrationSpec | null {
  const hasMainWorld = activeSpecs.some((s) => s.world === 'MAIN');
  if (!hasMainWorld) return null;
  return {
    id: BRIDGE_SCRIPT_ID,
    matches: ['<all_urls>'],
    js: [{ code: WRAPPER_BRIDGE }],
    runAt: 'document_start',
    world: 'USER_SCRIPT',
  };
}

// Pure: build the registration spec for the USER_SCRIPT-world GM_*
// shared runtime, or return null when no USER_SCRIPT-world script is
// active.
//
// Why we need this: every per-script wrapper compiles in `const GM_X
// = function () { ... }` bindings that delegate to
// `window.__SM_GM__` (sync) or use `__SM_GM__.sendAsync` (async).
// `__SM_GM__` is defined by src/wrapper-gm-runtime.js, registered
// here. Without it, the FIRST GM_* call would throw "__SM_GM__ is
// undefined" instead of the per-API "not implemented" or the real
// handler.
//
// Scoping. Registered at `<all_urls>`, runAt document_start. The
// runtime is small and idempotent — a `if (window.__SM_GM__) return;`
// guard handles the case where Chrome happens to re-run it on a
// document that already initialized.
//
// Ordering vs. wrappers. Every userscript wrapper now registers at
// document_start too, so the runtime and the wrappers run in the same
// document_start tick. In practice Chromium runs registered scripts in
// registration order — and we list the runtime spec before user specs
// in syncRegistrations — but that ordering is implementation-defined
// and not part of the documented userScripts contract. The real safety
// net is that the wrapper dereferences `window.__SM_GM__` lazily,
// inside the `__smAwaitDecision` microtask (and again inside the
// `__smWaitForRunAt` callback for DCL/load gating), AFTER the runtime
// has had a chance to install. See docs/GM-APIs.md.
export function buildGmRuntimeSpec(activeSpecs: RegistrationSpec[]): RegistrationSpec | null {
  const hasUserScriptWorld = activeSpecs.some((s) => s.world === 'USER_SCRIPT');
  if (!hasUserScriptWorld) return null;
  return {
    id: GM_RUNTIME_SCRIPT_ID,
    matches: ['<all_urls>'],
    js: [{ code: WRAPPER_GM_RUNTIME }],
    runAt: 'document_start',
    world: 'USER_SCRIPT',
  };
}

// ---------- Runtime sync (uses chrome.userScripts) ----------

let lastError: string | null = null;
export function getLastError(): string | null { return lastError; }

// Per-script registration errors from the last sync. Populated when the
// batch register() rejects and we fall back to per-script registration
// (see syncRegistrations). Cleared at the start of each sync.
const perScriptErrors = new Map<string, string>();
export function getPerScriptErrors(): Map<string, string> {
  return new Map(perScriptErrors);
}

// True if the API surface is present at all. The permission is required
// for chrome.userScripts to exist; if it's missing the sync no-ops.
export function isUserScriptsAvailable(): boolean {
  return typeof chrome !== 'undefined' && (chrome as { userScripts?: unknown }).userScripts != null;
}

async function readAll(): Promise<{ scripts: StoredScript[]; sources: Map<string, StoredSource> }> {
  const all = await chrome.storage.local.get(null);
  const scripts: StoredScript[] = [];
  const sources = new Map<string, StoredSource>();
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(SCRIPT_PREFIX)) scripts.push(v as StoredScript);
    else if (k.startsWith(SOURCE_PREFIX)) {
      const s = v as StoredSource;
      sources.set(s.id, s);
    }
  }
  return { scripts, sources };
}

let worldConfigured = false;
async function ensureWorldConfigured(): Promise<void> {
  if (worldConfigured) return;
  // configureWorld must be called before register. Settings:
  //   - messaging: true — lets our wrapper call
  //     chrome.runtime.sendMessage from the USER_SCRIPT world.
  //   - csp — relaxes the default USER_SCRIPT-world CSP (which omits
  //     'unsafe-eval') so the reload-fast-path swap can eval the
  //     SW-supplied body. Tampermonkey / Violentmonkey allow eval in
  //     their script worlds too — scripts can already do anything in
  //     this world (DOM access, GM_* eventually), so blocking eval
  //     would be inconsistent. The CSP only applies to scripts running
  //     in this world; it does NOT change the page's own CSP.
  // Idempotent — Chrome accepts repeated calls but we still guard so
  // we don't issue them on every sync.
  await chrome.userScripts.configureWorld({
    messaging: true,
    csp: "script-src 'self' 'unsafe-eval'",
  });
  worldConfigured = true;
}

// Wipe Chrome's current registration set and replace it with `specs`.
// Cheap full resync — simpler than a diff and fine at the script counts
// we expect.
//
// Failure modes:
//   - User hasn't enabled "Allow User Scripts" → configureWorld /
//     getScripts / register throws. `lastError` carries the message.
//   - One spec has a malformed pattern → batch register() is all-or-
//     nothing, so we first wipe (`unregister`), then retry one-at-a-
//     time so a single bad pattern doesn't drop every other script.
//     Per-script failures land in `perScriptErrors` keyed by ID.
export async function syncRegistrations(): Promise<void> {
  if (!isUserScriptsAvailable()) {
    lastError = 'chrome.userScripts not available (permission missing?)';
    return;
  }
  perScriptErrors.clear();
  try {
    await ensureWorldConfigured();
    const { scripts, sources } = await readAll();
    const handlerVersion = chrome.runtime.getManifest().version;
    const userSpecs = await collectActiveSpecs(scripts, sources, handlerVersion);
    const bridge = buildBridgeSpec(userSpecs);
    const gmRuntime = buildGmRuntimeSpec(userSpecs);
    // GM runtime first so it installs window.__SM_GM__ ahead of any
    // USER_SCRIPT-world wrapper that compiles in GM_* bindings.
    // Bridge next so MAIN wrappers' postMessages have a listener.
    // Then the user scripts.
    const specs: RegistrationSpec[] = [];
    if (gmRuntime) specs.push(gmRuntime);
    if (bridge) specs.push(bridge);
    specs.push(...userSpecs);
    const existing = await chrome.userScripts.getScripts();
    if (existing.length > 0) {
      await chrome.userScripts.unregister({ ids: existing.map((e) => e.id) });
    }
    const registered = await registerWithFallback(specs);
    lastError = null;
    const failed = specs.length - registered;
    if (failed > 0) {
      console.info(
        `[SourceMonkey] registered ${registered}/${specs.length} userscript(s); ${failed} rejected by chrome.userScripts (see per-script errors)`,
      );
    } else {
      console.log(`[SourceMonkey] registered ${registered} userscript(s) with chrome.userScripts`);
    }
  } catch (err) {
    lastError = describeError(err);
    // Common case: "Allow User Scripts" toggle is off. Log once per
    // sync so we don't bury the SW console.
    console.info('[SourceMonkey] userScripts sync failed:', lastError);
  }
}

// Register a list of specs, falling back from batch to per-script on a
// batch failure so one malformed pattern doesn't take everything down.
// Returns the count of specs that actually registered. Per-spec failure
// reasons are recorded in `perScriptErrors`.
async function registerWithFallback(specs: RegistrationSpec[]): Promise<number> {
  if (specs.length === 0) return 0;
  try {
    await chrome.userScripts.register(specs);
    return specs.length;
  } catch {
    // Batch rejected — at least one spec is bad. Find the good ones.
  }
  let ok = 0;
  for (const spec of specs) {
    try {
      await chrome.userScripts.register([spec]);
      ok++;
    } catch (err) {
      const msg = describeError(err);
      perScriptErrors.set(spec.id, msg);
      console.info(`[SourceMonkey] script ${spec.id} rejected: ${msg}`);
    }
  }
  return ok;
}
