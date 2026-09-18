// Userscript injection via the chrome.userScripts API.
//
// Chrome owns the actual matching + injection at navigation time. Our
// job is to keep its registration set in sync with our "effectively
// enabled ok scripts" view of the world. Whenever the script-store
// cache changes we re-sync just the rows that moved, updating their
// registrations in place; a full rebuild happens only when this context
// has no record of what it last registered (service-worker startup).
// See docs/injection.md#lifecycle.
//
// ---------- Injection shape (concatenated user program) ----------
//
// Each registered userscript ships with a js[] array whose entries
// share an execution world (USER_SCRIPT or MAIN). All entries run in
// the same realm; they communicate via globals on
// `self.__smPrelude.*`. The layout per script:
//
//   js[0]  — per-script config {code}. Tiny JSON-literal call into
//            the prelude (queues it if the prelude hasn't run yet on
//            this navigation).
//   js[1]  — `{code: WRAPPER_PRELUDE}` — the static prelude source,
//            inlined as a {code} blob in every script's registration.
//            Originally tried as `{file: "userscript-prelude.js"}`
//            but `{file}` entries load asynchronously in MAIN world
//            (likely <script src=> under the hood), so subsequent
//            entries would see `self.__smRun` undefined. The IIFE
//            inside is idempotent — runs once per execution world,
//            drains any queued configs on each entry so subsequent
//            scripts in the same world also get initialized.
//   js[2]  — the whole user program: every `@require` concatenated
//            ahead of the script's own body, wrapped in
//            `self.__smRun(id,function(__smE){<gm bindings>…<source>})`
//            so it runs only after the prelude's matcher +
//            check-pending + @run-at gates resolve. Trailing
//            `//# sourceURL=sourcemonkey://<id>/<name>.user.js`, plus
//            an inline source map when the script has requires.
//   js[3]  — parse-failure sentinel (`wrapSealEntry`). Its own script,
//            so it still runs when js[2] failed to parse.
//
// Why ONE entry for the user program: separate js[] entries are
// separate V8 scripts with separate top-level scopes, so a library's
// `const`/`let`/`class` never reached the body. Concatenating gives
// them one scope, which is what TM/VM do. The cost is line numbers,
// which the source map pays back. See docs/injection-modes.md for the
// arrangement this replaced and the one never built.
//
// Caveats:
//   - Wrapper-side regex matcher rechecks /regex/ @includes / @excludes
//     that the userScripts API can't express. (Lives in the prelude.)
//   - We register every script at document_start; the prelude in-page
//     gates body execution on the declared @run-at lifecycle event so
//     we don't inherit Chrome's batching of document_end into the
//     post-load burst.
//   - MAIN-world wrappers can't call chrome.runtime directly; the
//     prelude's send() falls back to window.postMessage which
//     wrapper-bridge.js relays.
//
// Requirements: manifest must include the "userScripts" permission AND
// the user must enable the "Allow User Scripts" toggle on
// chrome://extensions. If the toggle is off, chrome.userScripts.register
// throws. The collections page
// prompts for the toggle off its own probe (`probeUserScriptsApi` in
// collections.ts) rather than anything this module records — it needs
// an answer at render time, and an SW that has been evicted since the
// last sync would have nothing to report.

import {
  describeError,
  ensureCollectionKeysMigrated,
  isScriptEnabled,
  isCollectionEnabled,
  verifyParseChecks,
  type StartupLog,
  type StoredScript,
  type StoredCollection,
} from './script-store.js';
import { getValue, getValues, type ParsedHeader } from './userscript-header.js';
import {
  WRAPPER_BRIDGE,
  WRAPPER_GM_RUNTIME,
  WRAPPER_PRELUDE,
} from './generated-wrappers.js';
import { findApi, resolveGrants, type ApiSubsystem } from './gm-api-catalog.js';
import { scanAllStorage } from './storage-scan.js';
import { canonicalMatchPatterns, matchPatternProblem } from './url-match.js';
import { dlog } from './debug-log.js';
import { startPhaseTimer } from './phase-timing.js';
import { emitGmBindings, type GmBindingEmit, type GmInfoInput } from './gm-bindings.js';
import {
  buildSourceMap,
  inlineSourceMapComment,
  type MappedSegment,
} from './source-map.js';
import {
  USER_SOURCE_START_LINE,
  composeRequiredBody,
  composeSource,
  countLines,
} from './composed-source.js';
import {
  BRIDGE_SOURCE_URL,
  GM_RUNTIME_SOURCE_URL,
  PRELUDE_SOURCE_URL,
  buildConfigSourceUrl,
  buildRequireSourceUrl,
  buildSealSourceUrl,
  buildSourceUrl,
} from './script-source-url.js';
import { computeLogIds, type LogIdInput } from './script-log-id.js';
import { scriptBasename, scriptDisplayName } from './script-display.js';
import { logScriptEvent } from './script-log.js';
import {
  describeRejection,
  readRejections,
  writeRejections,
  type RejectionMap,
} from './script-rejection.js';

const SCRIPT_PREFIX = 'script:';
const COLLECTION_PREFIX = 'collection:';

// Match the runtime-message types we use between injected scripts and
// the SW. Keep these in sync with the strings the prelude sends.
export const SM_START_MSG = 'sm:start';
export const SM_ERROR_MSG = 'sm:error';
// Reload fast-path: the prelude asks the SW whether to run its baked-in
// body, abandon, or swap in a fresher user-code body the SW will hand
// back. sm:swapped / sm:abandoned are the follow-up reports for the
// swap / skip branches. See docs/injection.md#reload-fast-path.
export const SM_CHECK_PENDING_MSG = 'sm:check-pending';
export const SM_SWAPPED_MSG = 'sm:swapped';
export const SM_ABANDONED_MSG = 'sm:abandoned';
// GM_log capture: the page-side runtime sends one of these for every
// GM_log() call so the SW can append it to the script's Log tab.
export const SM_GM_LOG_MSG = 'sm:gm-log';
// The page reporting that it just came to the front, so the SW can
// check this tab's local scripts for edits. Chrome's own focus events
// miss the case that matters most — see
// docs/updates.md#focus-triggered-refresh.
export const SM_FOCUS_MSG = 'sm:focus';

// Reserved registration ids. Chrome's userScripts API rejects ids
// that start with `_`, so we use a `sourcemonkey-` prefix; stored
// script ids are UUIDs and won't collide.
export const BRIDGE_SCRIPT_ID = 'sourcemonkey-bridge';

// Reserved registration id for the USER_SCRIPT-world GM_* shared
// runtime. Registered at document_start so its `window.__SM_GM__`
// global is in place before any userscript wrapper runs.
export const GM_RUNTIME_SCRIPT_ID = 'sourcemonkey-gm-runtime';

// MAIN-world flavor of the same runtime source. Needed whenever an
// active MAIN-world script grants a runtime-backed API — which now
// includes every `@grant unsafeWindow` script, since that grant forces
// MAIN world. Its SW traffic rides `wrapper-bridge.js`.
export const GM_RUNTIME_MAIN_SCRIPT_ID = 'sourcemonkey-gm-runtime-main';

export type RegistrationSpec = chrome.userScripts.RegisteredUserScript;
export type InjectionWorld = 'MAIN' | 'USER_SCRIPT';

// The patterns one script is registered on, for the scripts whose world
// needs the shared `__SM_GM__` runtime. The runtime's own registration
// takes the union — see `buildGmRuntimeSpecs`.
export interface GmRuntimePatterns {
  matches: string[];
  includeGlobs: string[];
}

// The union of those patterns for one world.
export interface GmRuntimeScope {
  matches: Set<string>;
  includeGlobs: Set<string>;
}

// What one pass of `collectActiveSpecs` produced.
export interface ActiveSpecs {
  specs: RegistrationSpec[];
  // The scripts that need the shared `__SM_GM__` runtime in their
  // world, and the patterns each is registered on. See
  // `collectActiveSpecs`.
  gmRuntime: Map<string, GmRuntimePatterns>;
  // The same answer pre-unioned per world — what `buildGmRuntimeSpecs`
  // takes. Derived from `gmRuntime`, so the two can't disagree.
  gmRuntimeScope: Map<InjectionWorld, GmRuntimeScope>;
}

// Normalize the script's declared `@run-at` header to one of the four
// recognized values. The prelude gates body execution on the matching
// lifecycle event because Chrome's userScripts scheduler batches
// document_end into the post-load injection burst. See `waitForRunAt`
// in `userscript-prelude.js`.
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

// True iff the script's `@grant` lines ask for `unsafeWindow`.
// `unsafeWindow` is defined as "the page's real window object", which in
// Chrome is only reachable from MAIN world — an isolated world's
// `window` is a different realm and no synchronous bridge to the page's
// can exist. So this grant is a world request, not just a binding
// request. See docs/injection.md#unsafewindow-forces-main-world.
export function grantsUnsafeWindow(header: ParsedHeader | null | undefined): boolean {
  if (!header) return false;
  const { granted } = resolveGrants(getValues(header, 'grant'));
  return granted.has('unsafeWindow');
}

// Decide which execution world a script should run in. Mirrors
// Violentmonkey's `@inject-into` semantics (and Tampermonkey's default
// for `@grant none`):
//
//   - `@inject-into page`        → MAIN  (page context — sees the page's
//                                          window.X globals)
//   - `@inject-into content`     → USER_SCRIPT (isolated)
//   - default / `auto` / unset   → MAIN when there are no @grant entries
//                                  (or every @grant is `none`), and MAIN
//                                  when `unsafeWindow` is granted;
//                                  otherwise USER_SCRIPT.
//
// Why `@grant none` defaults to MAIN: scripts that opt out of GM_* (the
// `@grant none` convention) expect direct page access — `window.map`,
// `window.jQuery`, page-defined functions. Putting them in USER_SCRIPT
// silently breaks any script that touches a page global. Tampermonkey
// runs `@grant none` scripts in page context for the same reason.
//
// Why `@grant unsafeWindow` also defaults to MAIN: same reason, one
// level down. The whole point of the grant is reaching the page's
// globals, and USER_SCRIPT world cannot do that at all. Running such a
// script isolated hands it a `window` that merely *looks* right, so the
// failure is silent. GM_* still works in MAIN — the runtime is
// registered there too and routes SW traffic over `wrapper-bridge.js`.
//
// `@inject-into content` still wins, because it is an explicit request
// for isolation. Such a script gets `unsafeWindow === window` (the
// isolated realm's), matching Violentmonkey's content mode, plus a
// startup-log warning so the mismatch is visible rather than silent —
// see `extractStartupLogs` in script-store.ts.
export function resolveWorld(header: ParsedHeader | null | undefined): InjectionWorld {
  if (!header) return 'MAIN';
  const injectInto = (getValue(header, 'inject-into') ?? '').trim().toLowerCase();
  if (injectInto === 'page') return 'MAIN';
  if (injectInto === 'content') return 'USER_SCRIPT';
  const grants = getValues(header, 'grant').map((g) => g.trim().toLowerCase());
  if (grants.length === 0) return 'MAIN';
  if (grants.every((g) => g === 'none' || g === '')) return 'MAIN';
  if (grantsUnsafeWindow(header)) return 'MAIN';
  return 'USER_SCRIPT';
}

// True iff the script needs the shared `__SM_GM__` runtime registered in
// its world. `GM_info` is a baked-in literal and `unsafeWindow` is a
// plain `window` alias, so a script granting only those (or nothing at
// all) needs no runtime — which is what keeps `window.__SM_GM__` off the
// page in the overwhelmingly common `@grant none` MAIN-world case.
export function needsGmRuntime(header: ParsedHeader | null | undefined): boolean {
  for (const subsystem of grantedSubsystems(header)) {
    if (subsystem !== 'info' && subsystem !== 'unsafe-window') return true;
  }
  return false;
}

// The catalog subsystems the script's `@grant` lines reach — the set the
// SW's bridge gate (`bridgeMayActAs` in background.ts) checks a relayed
// request against, so a page can only act for a script through APIs
// that script actually has. `@grant none` and unknown names contribute
// nothing.
export function grantedSubsystems(header: ParsedHeader | null | undefined): Set<ApiSubsystem> {
  const out = new Set<ApiSubsystem>();
  if (!header) return out;
  const { granted } = resolveGrants(getValues(header, 'grant'));
  for (const name of granted) {
    const spec = findApi(name);
    if (spec) out.add(spec.subsystem);
  }
  return out;
}

function isRegexLiteral(s: string): boolean {
  return s.length >= 2 && s.startsWith('/') && s.endsWith('/');
}

// JSON-encode for embedding in a JS source context. Same `</script>`
// escape as in gm-bindings.ts — chrome.userScripts takes raw code so
// the escape is paranoid, but the cost is zero.
function jsLit(value: unknown): string {
  return JSON.stringify(value).replace(/<\/script>/gi, '<\\/script>');
}

// ---------- Wrap helpers ----------
//
// Each helper returns the wrapped source for one js[] entry. They are
// pure string functions that don't know how they'll be assembled, so
// an alternative assembler (e.g. the eval-per-require arrangement in
// docs/injection-modes.md) could consume the same pieces.

interface ScriptCfgLiteral {
  id: string;
  // Dedup-aware label used by the URL builders — derives the
  // script's folder name in devtools. Not consumed by the prelude
  // itself (only the URL builders here read it).
  logLabel: string;
  name: string;
  sourceUrl: string;
  loadedAt: number;
  runAt: string;
  needsGmValues: boolean;
  matching: { matches: string[]; includes: string[]; excludes: string[] } | null;
  startupLogs: ReadonlyArray<StartupLog>;
}

// Build the per-script config blob. Calls
// `self.__smPrelude.init(cfg)` directly when the prelude is already
// loaded in this world, or queues onto `self.__smCfgQueue` so the
// FIRST script's prelude-file load drains it.
//
// Stays on one physical line so it doesn't perturb anything visual.
// Trailing `//# sourceURL=` puts the blob under the script's folder
// in devtools — see "devtools URL layout" below.
export function buildConfigBlob(cfg: ScriptCfgLiteral): string {
  // Drop matching when null so the literal stays compact.
  const wire: Record<string, unknown> = {
    id: cfg.id,
    name: cfg.name,
    sourceUrl: cfg.sourceUrl,
    loadedAt: cfg.loadedAt,
    runAt: cfg.runAt,
    needsGmValues: cfg.needsGmValues,
  };
  if (cfg.matching) wire.matching = cfg.matching;
  if (cfg.startupLogs && cfg.startupLogs.length > 0) {
    // Level and message only. A `StartupLog` also carries the header
    // `location` the diagnostic is about, and that is for the Log tab
    // — the prelude just echoes these to the page console. Passing it
    // would put the script's path (an absolute local path, for a
    // single-file install) into code the page can read.
    wire.startupLogs = cfg.startupLogs.map((l) => ({ level: l.level, message: l.message }));
  }
  const call =
    `(function(c){` +
    `if(self.__smPrelude){self.__smPrelude.init(c);}else{(self.__smCfgQueue=self.__smCfgQueue||[]).push(c);}})(${jsLit(wire)});`;
  return call + `\n//# sourceURL=${buildConfigSourceUrl(cfg.logLabel)}\n`;
}


// Wrap the static prelude source as a per-script {code} entry.
// Bytes (WRAPPER_PRELUDE) are byte-identical across every script;
// the trailing `//# sourceURL=` uses the page-wide
// `sourcemonkey://SourceMonkey/__prelude.js` URL so devtools'
// Sources tree groups all N inclusions into a single visible entry
// (V8 dedups script entries by URL in the tree view). Stack traces
// from inside the prelude all attribute to that same URL.
//
// Why inline (instead of one shared chrome.userScripts registration):
// per-script entries within one js[] array execute in order;
// separate registrations DON'T. A separate-prelude design races —
// the per-script main body's `self.__smRun(...)` call beats the
// prelude's helper installation. Inlining eliminates the race at
// the cost of shipping ~12KB × N times in the registration
// payload (negligible at our script counts).
export function wrapPreludeEntry(): string {
  return WRAPPER_PRELUDE + `\n//# sourceURL=${PRELUDE_SOURCE_URL}\n`;
}

// Wrap the whole user program — every `@require` plus the script's own
// body — as ONE js[] entry. Output shape:
//
//   self.__smRun("<id>",function(__smE){<DECL PREAMBLE><GM BINDINGS><GM PRELUDE>
//   // @require <url 1>
//   <require 1 line 1>
//   ...
//   ;
//   <main body line 1>
//   ...
//   });
//   //# sourceURL=<main url>
//   //# sourceMappingURL=data:application/json;…   (only when requires exist)
//
// `__smE` is the per-script entry the prelude passes in. The DECL
// PREAMBLE pulls `__smDecision` / `__smName` / `__smId` /
// `__smLoadedAt` / `__smSend` out of it so the GM bindings + GM
// prelude (generated by gm-bindings.ts, which references those
// identifiers) work unchanged.
//
// Why ONE entry: separate js[] entries are separate V8 scripts with
// separate top-level scopes, so a require's `const`/`let`/`class` was
// invisible to the main body and had to be bridged across. One entry
// means one scope, and the question stops existing — the same
// arrangement TM/VM get by concatenating into a single IIFE. See
// docs/injection-modes.md for what that bridge cost.
//
// Fidelity wins that fall out of the same change:
//
//   - `@require` code now runs inside the `@run-at` gate along with
//     the body, instead of firing early in Chrome's document_start
//     injection burst.
//   - It therefore sees the GM prelude (`storage.init`), so a
//     require's top-level `GM_setValue` reads a live cache.
//   - The GM binding block ships once per script instead of once per
//     require.
//
// Line numbers:
//
//   - **No requires** (the overwhelmingly common case) — head,
//     bindings and prelude are minified onto the opening line, so body
//     line N is still physical line N and no map is emitted. Byte for
//     byte the same entry as before Mode A.
//   - **With requires** — the body necessarily moves down by however
//     many lines the requires occupy. An inline source map restores
//     the original file and line in devtools. `Error.stack` strings
//     stay in generated coordinates because V8 doesn't map those; see
//     src/source-map.ts and TODO.md.
export function wrapCombinedEntry(args: {
  scriptId: string;
  sourceUrl: string;
  script: StoredScript;
  requireUrls: readonly string[];
  gmBindings: string;
  gmPrelude: string;
}): string {
  const idLit = jsLit(args.scriptId);
  // Declaration preamble — pulls per-script values out of the entry
  // the prelude passes in. The names match what gm-bindings.ts's
  // prelude expects (`__smDecision`, `__smName`, `__smId`,
  // `__smLoadedAt`, `__smSend`) so we don't have to rewrite that
  // module for the wrapper shape.
  const declPreamble =
    `var __smDecision=__smE.decision;` +
    `var __smName=__smE.cfg.name;` +
    `var __smId=__smE.cfg.id;` +
    `var __smLoadedAt=__smE.cfg.loadedAt;` +
    `var __smSend=self.__smPrelude.send;`;
  // gmBindings and gmPrelude are already single-line strings (or
  // empty), so the head stays on one physical line.
  const head = `self.__smRun(${idLit},function(__smE){${declPreamble}${args.gmBindings}${args.gmPrelude}`;

  if ((args.script.requires ?? []).length === 0) {
    // Nothing to concatenate, so nothing shifts and no map is needed.
    // No newline after `head`: the body's first line SHARES generated
    // line 0 with the wrap, which is what makes generated line N equal
    // original line N and lets the viewer pass refs through unmapped.
    // `buildSwapEvalBody` mirrors this exactly — see NO_REQUIRE_LAYOUT
    // in composed-source.ts.
    return head + composeRequiredBody(args.script) + `\n});\n//# sourceURL=${args.sourceUrl}\n`;
  }

  // Head occupies generated line 0; user source starts below it.
  const composed = composeSource(args.script, {
    requireUrls: args.requireUrls,
    mainUrl: args.sourceUrl,
    startLine: USER_SOURCE_START_LINE,
  });
  const code = head + '\n' + composed.text + `\n});\n`;
  const map = buildSourceMap({
    file: args.sourceUrl,
    segments: composed.segments,
    // head + user source + the closing `});`
    totalLines: 1 + composed.lineCount + 1,
  });
  return code + `//# sourceURL=${args.sourceUrl}\n` + inlineSourceMapComment(map) + '\n';
}

// Assembler: Mode A (concatenated user program). See
// docs/injection-modes.md for the arrangements tried or considered
// instead (separate entries per require, eval-per-require) and why
// this one won.
//
// The prelude is inlined as the second js[] entry — NOT
// registered separately. We tried the separate-singleton approach
// and hit a real race: chrome.userScripts injection order isn't
// guaranteed BETWEEN registrations, so a per-script main-body
// entry could call `self.__smRun(...)` before its world's singleton
// prelude had defined the helper. The synchronous TypeError killed
// the body before it ran. Within a SINGLE registration's js[],
// entries run in order, so inlining the prelude eliminates the
// race.
//
// Cost: the WRAPPER_PRELUDE bytes ship N times in the registration
// payload (~12KB × N). Devtools tree-dedups by sourceURL though, so
// the user only sees one `__prelude.js` entry in the Sources tree
// — see wrapPreludeEntry's URL choice.
//
// ---------- devtools URL layout ----------
//
// Every `{code}` entry that wants a friendly name in the devtools
// Sources tree carries its own `//# sourceURL=` directive built by
// `src/script-source-url.ts`. The shape is
// `sourcemonkey://SourceMonkey/<folder>/...`:
//
//   sourcemonkey://SourceMonkey/
//     __bridge.js                         (one page-wide registration, USER_SCRIPT world)
//     __gm-runtime.js                     (one page-wide registration, USER_SCRIPT world)
//     __prelude.js                        (one tree entry — bytes ship per script, devtools dedups by URL)
//     <folder-1>/                         (per-script — dedup-aware log label)
//       __config.js                       (per-script config blob)
//       <name>.user.js                    (per-script main body)
//       <host>/<path>                     (one subtree per @require)
//     <folder-2>/
//       ...
//
// Why `SourceMonkey` as the authority: devtools strips the URL
// scheme and uses the host as the first visible folder; without it
// our scripts would scatter at the top level of the Sources tree.
// Why the per-script folder is the dedup-aware log label rather than
// the script's UUID: the UUID is a debug-grade hash that's useless
// when scanning the tree. See script-source-url.ts for the URL
// builders and the `#` → `%23` encoding for dedup suffixes.
//
// `@require` entries also get synthetic `sourcemonkey://` URLs so
// they (a) cluster with their owning script and (b) tell the truth
// — we're injecting our stored copy, not re-fetching from the CDN.
// The original host + path become subfolders so provenance is still
// visible in the tree.
function assembleEntries(parts: {
  configBlob: string;
  preludeCode: string;
  combinedCode: string;
  sealCode: string;
}): RegistrationSpec['js'] {
  return [
    { code: parts.configBlob },
    { code: parts.preludeCode },
    { code: parts.combinedCode },
    { code: parts.sealCode },
  ];
}

// Trailing sentinel entry. Everything the user wrote lives in ONE
// script now, so a syntax error anywhere in any `@require` — a
// truncated CDN response, an HTML fragment that squeaked past the
// content-type gate — makes the whole entry fail to parse. `__smRun`
// is then never reached, and without this the script would simply
// never run: no error, no log entry, no badge.
//
// This is a separate js[] entry, so it parses and runs even when the
// one before it didn't; the prelude reports the failure when it sees
// that `__smRun` never fired.
export function wrapSealEntry(scriptId: string, logLabel: string): string {
  return `self.__smSealed(${jsLit(scriptId)});\n//# sourceURL=${buildSealSourceUrl(logLabel)}\n`;
}

// Pure: assemble the GmInfoInput literal we'll bake into GM_info.
// `grantedNames` is the script's resolved grant set (empty for
// `@grant none` / no-grants / unknown-only / MAIN world). It's
// only used to populate `info.script.grant` — the choice of which
// real bindings to emit lives in emitGmBindings.
//
// Precondition: callers must check `script.header != null` before
// calling this. The one production caller (`buildGmBindingsForScript`)
// early-returns for headerless scripts.
function buildGmInfoInput(
  script: StoredScript,
  scriptHandlerVersion: string,
  grantedNames: readonly string[],
): GmInfoInput {
  const header = script.header!;
  // Deliberately NOT `scriptDisplayName`: this is script-visible API
  // surface (`GM_info.script.name`), so it stays byte-identical to
  // what's stored — no decode-for-display pass — and keeps `??`, so a
  // script that declares an empty `@name` sees an empty name rather
  // than silently getting its URL.
  const name = getValue(header, 'name') ?? script.relativePath;
  const resources: Record<string, { b64: string; ct: string }> = {};
  for (const r of script.resources ?? []) {
    resources[r.name] = { b64: r.bytesBase64, ct: r.contentType };
  }
  return {
    scriptId: script.id,
    name,
    version: getValue(header, 'version') ?? '',
    namespace: getValue(header, 'namespace') ?? '',
    description: getValue(header, 'description') ?? '',
    matches: script.matching.matches.slice(),
    includes: script.matching.includes.slice(),
    excludes: script.matching.excludes.slice(),
    grants: grantedNames,
    runAt: getValue(header, 'run-at') ?? '',
    scriptMetaStr: script.headerText,
    scriptHandlerVersion,
    resources,
  };
}

// Build the full GM-binding source string for one script: a const
// declaration per granted API plus the implicit `GM_info`. Async
// because we may eventually need to read persisted values at register
// time (not today; the storage snapshot path runs through the
// check-pending reply).
//
// World-independent. The emitted bodies delegate to
// `window.__SM_GM__`, and the shared runtime that installs it is
// registered in BOTH worlds now (see `buildGmRuntimeSpecs`), with the
// MAIN-world copy routing its SW traffic over `wrapper-bridge.js`. So
// a `@grant unsafeWindow` + `@grant GM_setValue` script gets a real
// page `window` AND working storage.
export async function buildGmBindingsForScript(
  script: StoredScript,
  scriptHandlerVersion: string,
): Promise<GmBindingEmit> {
  // No header at all → no GM_info either (we'd have nothing to put
  // in it). Production callers never hit this because validateHeader
  // rejects headerless scripts upstream; the guard is for unit tests.
  if (!script.header) return { js: '', prelude: '', granted: [], needsValues: false };
  const grants = getValues(script.header, 'grant');
  const resolved = resolveGrants(grants);
  // `@grant none` and no-grants both fall through to emitGmBindings
  // with an empty set — emitGmBindings still emits GM_info (TM/VM
  // compat). `resolved.granted` is the set of real bindings (empty
  // for @grant none / no-grants); GM_info is implicit and not
  // reflected here.
  const grantedNames = resolved.hasNone ? [] : [...resolved.granted];
  return emitGmBindings(grantedNames, buildGmInfoInput(script, scriptHandlerVersion, grantedNames));
}

// The exact text the registered entry compiles as a function body,
// minus our own wrap head — i.e. everything a syntax error in
// user-supplied code could come from, in the scope it actually lands
// in. This is what `src/parse-check.ts` hands to `new Function`.
//
// Includes the GM bindings deliberately. They are `const` declarations
// in the same scope as the user program, so a library doing
// `const unsafeWindow = window.wrappedJSObject || window;` — a real
// idiom — is a duplicate declaration and a genuine parse failure.
// Checking the user source alone would call that script healthy and
// let it fail at injection time, which is the whole thing we are
// trying to stop doing.
//
// NOT included: the wrap head itself (`self.__smRun(id,function(__smE){`),
// its `var` preamble, and the GM prelude. The head is ours and always
// valid, and on its own it leaves an unbalanced brace that
// `new Function` would reject.
//
// Included by way of `js`, and worth knowing: the `@resource` literal
// that `resource.init` carries. Every base64 blob is re-parsed on each
// check. It lives in `js` so the reload swap gets it (see
// gm-bindings.ts); if that cost ever shows up, hand the checker a
// stripped `js` rather than moving the call back.
//
// That leaves a small gap, in the safe direction. `var x` beside
// another `var x` is legal, but `var x` beside `let`/`const`/`class x`
// is a SyntaxError — and so is redeclaring the `__smE` parameter. So a
// script writing `const __smE`, `let __smDecision` or `const __smGmSnap`
// passes this check and fails at injection. Every such name is `__sm`-
// prefixed, so the practical risk is negligible; the run-time seal
// entry still reports it. Closing it properly means compiling with the
// parameter name and the preamble included — see TODO.md.
//
// Returns provenance alongside the text. A syntax error is reported as
// a line in the COMPOSED program, which is not a line of any file the
// user has open — `segments` is what maps it back, using the same
// machinery the source map and the Log tab's stack refs already share.
// See src/parse-location.ts.
export interface ParseCheckSource {
  text: string;
  // Which original file each generated line came from. `url` here is
  // the require's real URL (or the script's path) rather than a
  // synthetic `sourcemonkey://` one: this list is read by us, to name
  // a file in a sentence, not by devtools.
  segments: MappedSegment[];
  // Lines in `text`. A reported position outside it isn't the user's
  // code — see the sentinel note in parse-sandbox.ts.
  lineCount: number;
}

export async function buildParseCheckSource(
  script: StoredScript,
  scriptHandlerVersion: string,
): Promise<ParseCheckSource> {
  // World-agnostic since MAIN-world scripts get the same bindings as
  // USER_SCRIPT ones (the runtime picks its transport at init), so the
  // parse check compiles what will actually be injected in either world.
  const gmEmit = await buildGmBindingsForScript(script, scriptHandlerVersion);
  // The preamble always occupies at least one WHOLE line, even when
  // `gmEmit.js` is empty, and two things rest on that:
  //
  //   - The user's first line is never at offset 0. A `#!` hashbang is
  //     legal only there, so it stays the syntax error it also is in
  //     the real injected entry (which likewise wraps the source), and
  //     the location probes can't be handed a source that parses as a
  //     shebang script.
  //   - The offset below is derived from what was actually emitted
  //     rather than assumed to be 1 — the same discipline
  //     `composeSource` applies internally, and for the same reason:
  //     assumed line counts drift from emitted ones.
  const preamble = gmEmit.js + '\n';
  const startLine = countLines(preamble) - 1;
  const requires = script.requires ?? [];
  const composed = composeSource(script, {
    requireUrls: requires.map((r) => r.url),
    mainUrl: script.relativePath,
    startLine,
  });
  return {
    text: preamble + composed.text,
    // `composeSource` emits no segments for a script with no
    // `@require`s — the viewer keys "pass stack refs through unmapped"
    // off exactly that, so it stays as it is. Here the opposite is
    // wanted: one segment for the body means every reported line
    // resolves through the same lookup, with no second code path for
    // the majority of scripts.
    segments: composed.segments.length > 0
      ? composed.segments
      : [{
          url: script.relativePath,
          content: composed.text,
          generatedLine: startLine,
          lineCount: composed.lineCount,
        }],
    lineCount: startLine + composed.lineCount,
  };
}

// Build the body string for the reload-fast-path swap eval. Prepends
// the script's GM bindings to the composed (requires + body) source so
// the indirect eval — which runs at runMain's function scope, NOT inside
// the main-body wrap function's closure — still sees `GM_info` /
// `GM_addStyle` / etc. The whole prepended string is evaluated in a
// single `(0,eval)(...)` call so `const`-declared bindings at the
// top are in scope for the body that follows.
//
// What's NOT prepended: the gm `prelude` (`storage.init`). It
// references `__smDecision`, which the swap-eval scope doesn't have.
// `needsValues` in the return says whether THIS body needs that init,
// so the SW can tell the wrapper to run the equivalent call from
// `userscript-prelude.js` — where the decision object is in scope —
// right before the eval. It is computed from the NEW script row on
// purpose: a refresh that ADDS a storage grant needs the init even
// though the registered wrapper never asked for a snapshot.
//
// Line layout matches `wrapCombinedEntry` exactly: preamble on
// generated line 0, user source from `USER_SOURCE_START_LINE`. That
// costs a leading blank line when there are no bindings to prepend,
// and buys a single answer to "which file is generated line N?" for
// both run paths — the viewer's Log tab maps stack refs without
// knowing whether the script was registered or hot-swapped. See
// src/composed-source.ts.
export interface SwapEval {
  body: string;
  needsValues: boolean;
}

export async function buildSwapEvalBody(
  script: StoredScript,
  scriptHandlerVersion: string,
  logLabel: string = scriptBasename(script.relativePath),
): Promise<SwapEval> {
  // World-independent now: the shared runtime is registered in whichever
  // worlds need it, so a MAIN-world script gets the same bindings.
  const gmEmit = await buildGmBindingsForScript(script, scriptHandlerVersion);
  const sourceUrl = buildSourceUrl(logLabel);
  const requires = script.requires ?? [];
  // gmEmit.js is single-line and ends with a space (or is empty), so
  // it occupies generated line 0 exactly as `wrapCombinedEntry`'s wrap
  // head does.
  const head = gmEmit.js;
  if (requires.length === 0) {
    // No newline, matching the registered path's no-require branch:
    // the body's first line shares line 0 with the preamble, so
    // generated line N is original line N and the viewer's
    // pass-through is correct. Adding one here would silently shift
    // every logged stack line for the majority of scripts, which have
    // no `@require` — and with no segments to map by, the viewer
    // could not detect it, let alone correct it.
    return { body: head + composeRequiredBody(script), needsValues: gmEmit.needsValues };
  }
  const composed = composeSource(script, {
    requireUrls: requires.map((r) => buildRequireSourceUrl(logLabel, r.url)),
    mainUrl: sourceUrl,
    startLine: USER_SOURCE_START_LINE,
  });
  // The map goes on the body the prelude evals; the prelude appends
  // its own `//# sourceURL=` line after this one. Both are trailing
  // single-line comments, so the order between them doesn't matter to
  // V8 — and devtools needs the map to show the swapped-in requires as
  // their own files, exactly as a fresh registration does.
  const map = buildSourceMap({
    file: sourceUrl,
    segments: composed.segments,
    totalLines: 1 + composed.lineCount,
  });
  return {
    body: head + '\n' + composed.text + '\n' + inlineSourceMapComment(map),
    needsValues: gmEmit.needsValues,
  };
}

// Pure: build the spec we'll hand to chrome.userScripts.register for
// one script. Returns null only if validateHeader would have caught
// the script upstream (no matchable patterns at all).
//
// Strategy for regex patterns: see the matcher block in the prelude.
// `scriptHandlerVersion` default is for unit tests; production
// callers pass `chrome.runtime.getManifest().version`.
// `logLabel` defaults to the script's bare basename (no `#N` dedup);
// production callers pass the dedup-aware label from
// `computeLogIds` (via `collectActiveSpecs`) so two scripts sharing
// a basename get distinct devtools folders.
//
// Async because storage-granting scripts read their persisted values
// from chrome.storage.local at register time (see
// buildGmBindingsForScript).
export async function buildRegistrationSpec(
  script: StoredScript,
  scriptHandlerVersion: string = '0.0.0',
  logLabel: string = scriptBasename(script.relativePath),
): Promise<RegistrationSpec | null> {
  // What Chrome gets is the canonical spelling of each `@match`, not
  // the author's: a scheme-less `*.example.com/*` or a globbed
  // `http*://example.com/*` is a pattern Chrome's parser refuses but
  // our matcher runs, so we hand it the form that means the same thing
  // in Chrome's own grammar. One `@match` can expand to
  // more than one pattern when its scheme glob names more than one
  // scheme; duplicates across patterns collapse.
  //
  // Patterns Chrome's grammar refuses even then never go in the spec:
  // it rejects the registration as a whole, so one bad `@match` would
  // take the script's good patterns down with it. Dropping them costs
  // nothing — `matchPattern` can't match them either — and the reason
  // is already in the script's Log, on the header line that declared
  // it (see `extractStartupLogs`). A script left with no pattern at all
  // was already stored `invalid` by `validateHeader`.
  const matches = [
    ...new Set(
      script.matching.matches
        .flatMap((m) => canonicalMatchPatterns(m))
        .filter((m) => matchPatternProblem(m) === null),
    ),
  ];
  // Deduplicated like `matches` above, and for a reason beyond tidiness:
  // `needsReplace` compares the glob lists we sent against the ones
  // `getScripts` reports back, and a header repeating an `@exclude`
  // would leave those two disagreeing forever if Chrome collapsed the
  // duplicate — re-registering the script, and costing it an injection
  // gap, on every sync.
  const includeGlobSet = new Set<string>();
  const excludeGlobSet = new Set<string>();
  let hasRegexInclude = false;
  let hasRegexExclude = false;
  for (const inc of script.matching.includes) {
    if (isRegexLiteral(inc)) hasRegexInclude = true;
    else includeGlobSet.add(inc);
  }
  for (const ex of script.matching.excludes) {
    if (isRegexLiteral(ex)) hasRegexExclude = true;
    else excludeGlobSet.add(ex);
  }
  const includeGlobs = [...includeGlobSet];
  const excludeGlobs = [...excludeGlobSet];

  // Chrome refuses a registration without `matches` ("must specify
  // 'matches'"), so a script whose header carries only `@include` needs
  // a stand-in — `<all_urls>`, with the wrapper's in-page matcher doing
  // the real narrowing (the arrangement regex `@include`s already use).
  //
  // Handing Chrome the globs *as well* is deliberate, and the reason is
  // that Chrome's own reading of `includeGlobs` is not what the docs for
  // content scripts say. Measured rather than assumed — the probe in
  // tests/e2e/include-only.spec.ts re-checks it on whatever Chrome the
  // suite runs: `chrome.userScripts` ORs
  // `includeGlobs` with `matches` — userscript `@include` semantics —
  // rather than filtering within them. So:
  //   - Under the OR we measured, `<all_urls>` alone already runs
  //     everywhere and the wrapper filter is what makes the script
  //     obey its header.
  //   - Were it ever the documented AND instead, Chrome would narrow
  //     `<all_urls>` to the glob set and the wrapper would agree.
  // Emitting both keeps us correct either way. `excludeGlobs` is a true
  // AND under both readings, so it needs no such care.
  //
  // A script with no match/include patterns whatsoever shouldn't reach
  // here — validateHeader stores it `invalid`.
  //
  // One asymmetry to know about: a script can land here with `@match`
  // patterns that Chrome's grammar refused (dropped above) alongside
  // its includes. The wrapper matcher then evaluates the script's whole
  // `matching`, refused patterns included, so it can run where a
  // registered `@match` never would have. That is the lenient reading
  // the badge already gives those patterns, so the two agree — the
  // script just doesn't get the stricter answer a valid `@match` would.
  let usedAllUrlsFallback = false;
  if (matches.length === 0) {
    if (includeGlobs.length === 0 && !hasRegexInclude) return null;
    matches.push('<all_urls>');
    usedAllUrlsFallback = true;
  }

  const declaredRunAt = normalizeDeclaredRunAt(
    script.header ? getValue(script.header, 'run-at') : undefined,
  );
  const name = scriptDisplayName(script);
  const needsWrapperFilter = hasRegexInclude || hasRegexExclude || usedAllUrlsFallback;
  const sourceUrl = buildSourceUrl(logLabel);

  const world = resolveWorld(script.header);
  // GM_info is implicit in TM/VM — available in every world, with or
  // without an `@grant` line — and the rest of the granted surface is
  // emitted the same way in both worlds. The shared `__SM_GM__` runtime
  // is registered in whichever worlds need it (`buildGmRuntimeSpecs`),
  // and its MAIN-world copy routes SW traffic over `wrapper-bridge.js`.
  const gmEmit = await buildGmBindingsForScript(script, scriptHandlerVersion);

  const requires = script.requires ?? [];
  // Synthetic sourceURLs per require — these are what stack frames
  // will reference, so the async-error filter in the prelude needs
  // to match against these (not the original fetched URLs).
  const requireSourceUrls = requires.map((r) => buildRequireSourceUrl(logLabel, r.url));

  // Per-script config (entry 0).
  const cfgBlob = buildConfigBlob({
    id: script.id,
    logLabel,
    name,
    sourceUrl,
    loadedAt: script.loadedAt,
    runAt: declaredRunAt,
    needsGmValues: gmEmit.needsValues,
    matching: needsWrapperFilter ? script.matching : null,
    startupLogs: script.startupLogs ?? [],
  });

  // The whole user program — requires then body — as ONE entry
  // (js[2]). Sharing a scope is what makes a library's top-level
  // `const`/`class` visible to the body; see wrapCombinedEntry.
  const combinedCode = wrapCombinedEntry({
    scriptId: script.id,
    sourceUrl,
    script,
    requireUrls: requireSourceUrls,
    gmBindings: gmEmit.js,
    gmPrelude: gmEmit.prelude,
  });

  // Register at document_start regardless of the declared @run-at. The
  // prelude itself awaits the matching lifecycle event (DOMContentLoaded
  // for document-end, load for document-idle, etc.) before invoking
  // the user body. See docs/injection.md.
  const spec: RegistrationSpec = {
    id: script.id,
    js: assembleEntries({
      configBlob: cfgBlob,
      preludeCode: wrapPreludeEntry(),
      combinedCode,
      sealCode: wrapSealEntry(script.id, logLabel),
    }),
    runAt: 'document_start',
    world,
  };
  if (matches.length > 0) spec.matches = matches;
  if (includeGlobs.length > 0) spec.includeGlobs = includeGlobs;
  if (excludeGlobs.length > 0) spec.excludeGlobs = excludeGlobs;
  return spec;
}

// Pure: would this script be registered right now? Both the script's
// own enabled flag and its parent collection's flag must be true. `ok`
// scripts are eligible; `missing` scripts are eligible too when the
// user has explicitly re-enabled them (the cached body + header from
// the last good load is what gets injected). `error` scripts never run.
//
// Shared with `runSync`'s parse re-verification, which spends a compile
// round trip per row and so must ask about exactly the rows that are
// about to be registered — one predicate, so "eligible" can't come to
// mean two different things.
export function isRegistrationCandidate(
  script: StoredScript,
  collections: Map<string, StoredCollection>,
): boolean {
  if (script.status !== 'ok' && script.status !== 'missing') return false;
  if (!isScriptEnabled(script)) return false;
  const collection = collections.get(script.collectionId);
  return !!collection && isCollectionEnabled(collection);
}

// Pick the scripts that should be registered right now and build a
// spec for each. Async because each spec build is async (storage
// pre-load). We parallelize the per-script builds with Promise.all
// rather than awaiting sequentially.
//
// `logIds` is the dedup-aware {script id → label} map. It defaults to
// one computed from `scripts`, which is right only when `scripts` is
// every stored row. An incremental sync passes a subset, so it supplies
// the map itself — computed from the whole library, because a `#N`
// suffix that depends on which rows this sync happened to read would
// disagree with every other surface that shows the label.
//
// `gmRuntime` names the scripts that need the shared `__SM_GM__`
// runtime registered in their world, each carrying the patterns Chrome
// will inject IT on. Derived from grants, not from the specs, because a
// `RegistrationSpec` is a plain Chrome type and an extra field on it
// would be handed to `chrome.userScripts.register`. Kept per script
// rather than pre-unioned per world so an incremental sync can keep the
// answer for the rows it isn't rebuilding.
//
// Two things fall out of scoping the runtime this way, both mattering
// only in MAIN world where `window.__SM_GM__` is visible to the page:
//
//   - A `@grant none` script never drags the runtime onto its page.
//   - A script that does need it exposes the global on the pages IT
//     runs on, not on every page the user visits.
//
// See `buildGmRuntimeSpecs`.
export async function collectActiveSpecs(
  scripts: StoredScript[],
  collections: Map<string, StoredCollection>,
  scriptHandlerVersion: string = '0.0.0',
  logIds: Map<string, string> = computeLogIds(scripts.map((s): LogIdInput => ({
    id: s.id, relativePath: s.relativePath,
  }))),
): Promise<ActiveSpecs> {
  const eligible: StoredScript[] = [];
  const promises: Array<Promise<RegistrationSpec | null>> = [];
  for (const s of scripts) {
    if (!isRegistrationCandidate(s, collections)) continue;
    const label = logIds.get(s.id) ?? scriptBasename(s.relativePath);
    eligible.push(s);
    promises.push(buildRegistrationSpec(s, scriptHandlerVersion, label));
  }
  const results = await Promise.all(promises);
  const specs: RegistrationSpec[] = [];
  const gmRuntime = new Map<string, GmRuntimePatterns>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    // A null spec means the script has nothing Chrome can match on, so
    // it isn't registered — and a script that never runs must not drag
    // the GM runtime onto the page either.
    if (!r) continue;
    specs.push(r);
    if (!needsGmRuntime(eligible[i].header)) continue;
    // Take the patterns off the SPEC, not the header: that's what
    // Chrome will actually inject the script on, including the
    // `<all_urls>` fallback a regex-only `@include` gets. So the
    // runtime is present wherever its scripts can run, by
    // construction.
    gmRuntime.set(eligible[i].id, {
      matches: [...(r.matches ?? [])],
      includeGlobs: [...(r.includeGlobs ?? [])],
    });
  }
  return { specs, gmRuntime, gmRuntimeScope: gmRuntimeScopeOfSpecs(specs, gmRuntime) };
}

// Pure: build the registration spec for the MAIN-world bridge, or
// return null when no MAIN-world script is active.
//
// Why we need this: MAIN-world wrappers can't call
// chrome.runtime.sendMessage (chrome.runtime is undefined there), so
// the prelude's send() falls back to window.postMessage with a
// "sourcemonkey-bridge" marker. The bridge runs in USER_SCRIPT world
// on the same page, listens for those postMessages, and forwards them
// to the SW.
//
// Scoping. The bridge registers at `<all_urls>` and runAt
// document_start. Narrowing to the exact union of MAIN-world scripts'
// patterns would save the addEventListener call on unrelated pages
// but complicates the spec (especially with regex includes) for a
// negligible runtime cost.
export function buildBridgeSpec(activeSpecs: RegistrationSpec[]): RegistrationSpec | null {
  return hasWorld(activeSpecs.map((s) => s.world), 'MAIN') ? bridgeSpec() : null;
}

// The one question both our own registrations turn on: is any script
// running in this world? Shared by the exported helpers above and by
// both sync paths, which ask it of different collections — a spec list
// for a full sync, the projected registration set for an incremental
// one — so the answer can't drift between them.
function hasWorld(
  worlds: Iterable<InjectionWorld | chrome.userScripts.ExecutionWorld | undefined>,
  want: InjectionWorld,
): boolean {
  for (const w of worlds) if (w === want) return true;
  return false;
}

// The spec itself, with no "is it wanted?" question attached — the
// incremental sync answers that from the worlds of the whole
// registration set rather than from one sync's spec list.
function bridgeSpec(): RegistrationSpec {
  return {
    id: BRIDGE_SCRIPT_ID,
    matches: ['<all_urls>'],
    js: [{ code: WRAPPER_BRIDGE + `\n//# sourceURL=${BRIDGE_SOURCE_URL}\n` }],
    runAt: 'document_start',
    world: 'USER_SCRIPT',
  };
}


// Pure: build the registration specs for the shared `__SM_GM__` GM_*
// runtime — one per world in `scope`. See the module-level comment in
// src/wrapper-gm-runtime.js for the runtime's design.
//
// The SAME source is registered in both worlds; the runtime detects at
// init time whether `chrome.runtime` is reachable and picks its
// transport accordingly (direct `sendMessage` in USER_SCRIPT, the
// postMessage bridge in MAIN). One implementation, two transports —
// rather than a second MAIN-only copy that would drift.
//
// Registration ids differ per world because `chrome.userScripts`
// namespaces ids globally, not per world.
//
// Patterns: the union of the owning scripts' own, NOT `<all_urls>`.
// The bridge can afford `<all_urls>` (see `buildBridgeSpec`) because
// its only cost on an unrelated page is an `addEventListener`; the
// runtime's cost is a page-visible `window.__SM_GM__` global — a
// fingerprint and an attack surface — so it goes only where its
// scripts go. Excludes are deliberately NOT unioned: `@exclude` is
// per-script, and a runtime present on a page where no script runs is
// harmless, whereas one missing from a page where a script DOES run
// breaks every GM_* call it makes.
export function buildGmRuntimeSpecs(
  scope: ReadonlyMap<InjectionWorld, GmRuntimeScope>,
): RegistrationSpec[] {
  const out: RegistrationSpec[] = [];
  for (const world of GM_RUNTIME_WORLDS) {
    const s = scope.get(world);
    if (!s) continue;
    const spec: RegistrationSpec = {
      id: gmRuntimeIdFor(world),
      js: [{ code: WRAPPER_GM_RUNTIME + `\n//# sourceURL=${GM_RUNTIME_SOURCE_URL}\n` }],
      runAt: 'document_start',
      world,
    };
    if (s.matches.size > 0) spec.matches = [...s.matches];
    if (s.includeGlobs.size > 0) spec.includeGlobs = [...s.includeGlobs];
    // Defensive: Chrome rejects a registration with neither. A script
    // that reached here always had at least one pattern (that's what
    // `buildRegistrationSpec` returning non-null means), so this is
    // unreachable — but a silent rejection would take the whole batch
    // down, and every GM_* call with it.
    if (!spec.matches && !spec.includeGlobs) spec.matches = ['<all_urls>'];
    out.push(spec);
  }
  return out;
}

// The worlds the runtime can be registered in, in registration order.
const GM_RUNTIME_WORLDS: readonly InjectionWorld[] = ['USER_SCRIPT', 'MAIN'];

// The id the runtime carries in a given world. `chrome.userScripts`
// namespaces ids globally rather than per world, so the two
// registrations can't share one.
function gmRuntimeIdFor(world: InjectionWorld): string {
  return world === 'MAIN' ? GM_RUNTIME_MAIN_SCRIPT_ID : GM_RUNTIME_SCRIPT_ID;
}

// ---------- Runtime sync (uses chrome.userScripts) ----------

// Guards the "userScripts is unavailable" console line so it appears
// once per service-worker lifetime rather than once per sync.
let loggedUserScriptsUnavailable = false;

// True if the API surface is present at all. The permission is required
// for chrome.userScripts to exist; if it's missing the sync no-ops.
export function isUserScriptsAvailable(): boolean {
  return typeof chrome !== 'undefined' && (chrome as { userScripts?: unknown }).userScripts != null;
}

async function readAll(): Promise<{ scripts: StoredScript[]; collections: Map<string, StoredCollection> }> {
  // See match-index's loadAll: the pre-rename key spelling has to be
  // moved before anything reads the structural rows directly.
  await ensureCollectionKeysMigrated();
  const all = await scanAllStorage('registration sync');
  const scripts: StoredScript[] = [];
  const collections = new Map<string, StoredCollection>();
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(SCRIPT_PREFIX)) scripts.push(v as StoredScript);
    else if (k.startsWith(COLLECTION_PREFIX)) {
      const s = v as StoredCollection;
      collections.set(s.id, s);
    }
  }
  return { scripts, collections };
}

// ---------- What the last sync left behind ----------
//
// An incremental sync rebuilds only the scripts that moved, and to do
// that it has to answer some questions about the rest without
// re-reading every row:
//
//   - **What does Chrome hold right now?** Needed to tell an update from
//     a first registration, to spot what has to be dropped, and to know
//     whether the bridge / GM-runtime registrations are still wanted.
//   - **What is every script's basename, and what label did it get?**
//     Log labels are dedup-aware across the whole library, so a subset
//     can't compute them — and a script arriving can renumber a dupe
//     group it isn't in, which re-registers scripts whose rows never
//     moved.
//   - **Which collection is each script in, and is it enabled?** A
//     collection toggle moves every script under it, and eligibility
//     needs the parent row.
//
// None of it includes a script body — the expensive part of a full read
// — so this stays small next to the `get(null)` it replaces.
//
// Null until a full sync has run in THIS JS context, which is what
// makes the state safe to trust: the service worker is evicted freely
// and rows change while it's dead, so a fresh worker's first sync is
// always a full reconcile against `chrome.userScripts.getScripts()`. A
// sync that fails part-way drops the state for the same reason.
// What we last placed under one registration id.
interface Placement {
  world: InjectionWorld;
  // Which pattern fields it carries — see `PlacedPatterns` for why an
  // update has to know.
  patterns: PlacedPatterns;
  // The patterns this script is registered on when its world needs the
  // shared `__SM_GM__` runtime; null when it doesn't. Tracked so an
  // incremental sync can compute the runtime's scope from the WHOLE
  // registration set, not just the slice it is rebuilding. Always null
  // for our own registrations.
  gmRuntime: GmRuntimePatterns | null;
}

interface RegistrationState {
  // Every id we believe Chrome holds, including our own reserved ids.
  registered: Map<string, Placement>;
  // The pattern union each GM-runtime registration was last placed
  // with, keyed by registration id. Unlike the bridge, the runtime's
  // patterns follow its scripts, so an incremental sync has to notice
  // when they move — see `gmRuntimeFingerprint`.
  gmRuntimeScopes: Map<string, string>;
  // Every stored script — regardless of status, because log labels are
  // assigned across all of them.
  scriptIndex: Map<string, { relativePath: string; collectionId: string }>;
  // The dedup-aware log label each script was last registered with. A
  // script ARRIVING can change another script's label (a lone
  // `main.user.js` becomes `main.user.js#1` once a second one shows
  // up), and the label is baked into the registered `//# sourceURL=`
  // directives — so the other script has to be re-registered even
  // though its own row never moved.
  labels: Map<string, string>;
  collections: Map<string, StoredCollection>;
}
let syncState: RegistrationState | null = null;

// Forget what we last registered, so the next sync is a full reconcile.
//
// Callers are anything that falsifies what the record encodes — not
// just "these ids are registered" but "everything in here was built
// from current rows and passed the parse gate". Turning the parse
// checker back on is one: rows registered while it was off were never
// gated, and only a full reconcile revisits them.
//
// Unit tests use it between cases too — the state is module-level and
// outlives a storage wipe, which is exactly the cross-test bleed the
// retry gate beside it also has to be reset for.
export function forgetRegistrationState(): void {
  syncState = null;
  lastSyncKind = null;
}

// Which path the last sync took. Test-only, and the only way to tell
// from outside: an incremental sync and a full one leave the same
// registration set behind, which is the point — so a test that means to
// pin the incremental path has to be able to say it took it.
let lastSyncKind: 'full' | 'incremental' | null = null;
export function lastSyncKindForTests(): 'full' | 'incremental' | null {
  return lastSyncKind;
}

// Forget ONE id from the record while leaving Chrome's set alone. Unit
// tests use it to reproduce the divergence a page-side
// `retryRejectedRegistrations` creates: it places a registration in its
// own JS context, and the worker's record never hears about it.
export function _forgetRegistrationForTests(id: string): void {
  syncState?.registered.delete(id);
}

// Which rows a sync has to reconsider. Absent means "everything" — the
// full reconcile.
export interface SyncScope {
  scriptIds: readonly string[];
  collectionIds: readonly string[];
}

// ---------- What `update` can and cannot change ----------
//
// `chrome.userScripts.update` MERGES rather than replaces: "a property
// is only updated for the existing script if it is specified". Two
// things the contract doesn't say, both measured against real Chrome
// (the glob probe lives in tests/e2e/exclude-globs.spec.ts):
//
//   - **An explicit empty array counts as unspecified**, so `update`
//     cannot clear `matches` either. (`matches: []` is refused
//     outright: "must specify at least one match".)
//   - **`includeGlobs` / `excludeGlobs` are ignored entirely** by
//     `update` — it cannot add them, change them, or clear them. The
//     call succeeds and `getScripts` keeps reporting the old globs (or
//     none), so nothing surfaces the loss. Only `matches` really
//     updates.
//
// The glob half is what made a newly added `@exclude` do nothing: the
// header said the script was excluded, our own matcher agreed, and
// Chrome kept injecting on the excluded page — the badge showed
// UNEXPECTED with no way to act on it. The `matches` half is the
// mirror case: `buildRegistrationSpec` emits keys only when non-empty,
// so a user deleting their last `@exclude` would keep an exclusion
// their header no longer declares.
//
// So we track the pattern fields each registration currently carries —
// the glob VALUES, since those can't be updated at all, and only
// presence for `matches`, which can — and any spec that `update` would
// not faithfully apply is placed by `replaceRegistration` instead.
interface PlacedPatterns {
  matches: boolean;
  includeGlobs: readonly string[];
  excludeGlobs: readonly string[];
}

function patternsOf(spec: {
  matches?: string[]; includeGlobs?: string[]; excludeGlobs?: string[];
}): PlacedPatterns {
  return {
    matches: (spec.matches?.length ?? 0) > 0,
    // Sorted, deduplicated copies — the comparison below is about the
    // pattern SET. Re-registering a script only because its globs came
    // back in a different order, or with a duplicate collapsed, would
    // cost it an injection gap for nothing.
    includeGlobs: [...new Set(spec.includeGlobs ?? [])].sort(),
    excludeGlobs: [...new Set(spec.excludeGlobs ?? [])].sort(),
  };
}

function sameGlobs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Would `update` fail to bring a registration shaped like `prior` to
// what `spec` declares? True when the spec drops the `matches` field,
// or when its glob sets differ from the placed ones at all.
function needsReplace(prior: PlacedPatterns, spec: RegistrationSpec): boolean {
  const next = patternsOf(spec);
  return (prior.matches && !next.matches)
    || !sameGlobs(prior.includeGlobs, next.includeGlobs)
    || !sameGlobs(prior.excludeGlobs, next.excludeGlobs);
}

function needsReplaceFrom(
  present: ReadonlyMap<string, PlacedPatterns>,
  spec: RegistrationSpec,
): boolean {
  const prior = present.get(spec.id);
  return prior !== undefined && needsReplace(prior, spec);
}

// What Chrome actually holds for one id, or undefined if it holds
// nothing. The authority both `placeSpec` branches fall back to when
// our belief turns out to be wrong.
async function placedPatterns(id: string): Promise<PlacedPatterns | undefined> {
  try {
    const got = await chrome.userScripts.getScripts({ ids: [id] });
    return got.length > 0 ? patternsOf(got[0]) : undefined;
  } catch {
    // Can't tell. Treated as "nothing there", which routes to the
    // register/replace branch — the safe direction, since those place
    // the spec whatever the truth turns out to be.
    return undefined;
  }
}

// Read just the rows named, rather than the whole store.
async function readRows(
  scriptIds: Iterable<string>,
  collectionIds: Iterable<string>,
): Promise<Record<string, unknown>> {
  await ensureCollectionKeysMigrated();
  const keys = [
    ...[...scriptIds].map((id) => SCRIPT_PREFIX + id),
    ...[...collectionIds].map((id) => COLLECTION_PREFIX + id),
  ];
  if (keys.length === 0) return {};
  return await chrome.storage.local.get(keys) as Record<string, unknown>;
}

// The worlds of the *user* scripts in a registration set. The two
// reserved ids are excluded on purpose: the bridge itself runs in
// USER_SCRIPT world, so counting it would keep the GM runtime
// registered forever once a MAIN-world script had ever been active.
function userWorlds(registered: Map<string, Placement>): InjectionWorld[] {
  return userPlacements(registered).map((p) => p.world);
}

// The placements for user scripts only — our own registrations are the
// thing being decided, so they can't be part of the input.
function userPlacements(registered: Map<string, Placement>): Placement[] {
  return [...registered].filter(([id]) => isUserScriptId(id)).map(([, p]) => p);
}

// Where the shared `__SM_GM__` runtime has to be registered, given what
// is (or is about to be) placed. A world earns an entry only from a
// script that actually grants a runtime-backed API — which is what keeps
// `window.__SM_GM__` off the page on the very common "MAIN world,
// `@grant none` only" page — and the entry carries the union of those
// scripts' own patterns, so the global goes only where they go.
function gmRuntimeScopeOf(placements: Iterable<Placement>): Map<InjectionWorld, GmRuntimeScope> {
  const out = new Map<InjectionWorld, GmRuntimeScope>();
  for (const p of placements) {
    if (!p.gmRuntime) continue;
    let scope = out.get(p.world);
    if (!scope) {
      scope = { matches: new Set(), includeGlobs: new Set() };
      out.set(p.world, scope);
    }
    for (const m of p.gmRuntime.matches) scope.matches.add(m);
    for (const g of p.gmRuntime.includeGlobs) scope.includeGlobs.add(g);
  }
  return out;
}

// Same question against a freshly built spec list, where the answer
// lives beside the specs rather than on them.
function gmRuntimeScopeOfSpecs(
  specs: readonly RegistrationSpec[],
  gmRuntime: ReadonlyMap<string, GmRuntimePatterns>,
): Map<InjectionWorld, GmRuntimeScope> {
  return gmRuntimeScopeOf(specs.map((spec) => ({
    world: (spec.world ?? 'MAIN') as InjectionWorld,
    patterns: patternsOf(spec),
    gmRuntime: gmRuntime.get(spec.id) ?? null,
  })));
}

// A stable identity for one runtime registration's pattern union, so an
// incremental sync can tell whether the scope moved. Sorted because the
// union is built from a Set, whose order follows insertion.
function gmRuntimeFingerprint(spec: RegistrationSpec): string {
  return JSON.stringify([
    [...(spec.matches ?? [])].sort(),
    [...(spec.includeGlobs ?? [])].sort(),
  ]);
}

// ---------- Serializing registration work ----------
//
// `chrome.userScripts` is a single mutable set, and every path that
// changes it does so with a read-modify-write — decide what is there,
// then place or drop — that Chrome does not make atomic. Two of those
// interleaving is what produces
//
//   Chrome rejected this script's registration, so it will not run:
//   Duplicate script ID '<uuid>'
//
// on a script that is in fact registered and running: one attempt
// listed the registrations, a second attempt placed the script, and
// then the first one offered the same id again. It shows up after a
// restart or an extension update (the SW-startup sync overlapping the
// one `onCacheChanged` schedules for whatever boot work writes to
// storage) and after a refresh (the collection refresh's targeted retry
// overlapping the sync its own storage writes triggered).
//
// So: one registration operation at a time per JS context. The queue is
// a promise chain rather than a flag because callers must be able to
// await their own work; a rejected operation is isolated so it can't
// break the ones behind it.
let registrationLock: Promise<unknown> = Promise.resolve();

function withRegistrationLock<T>(run: () => Promise<T>): Promise<T> {
  // Same callback for fulfil and reject: the previous operation's
  // outcome is not ours to care about, only its completion. Called
  // through an arrow rather than passed directly so `run` can never be
  // handed the previous operation's value — or, on the rejection
  // branch, its Error — as an argument.
  const result = registrationLock.then(() => run(), () => run());
  registrationLock = result.catch(() => {});
  return result;
}

// A sync that hasn't started yet, if any. Everything `syncRegistrations`
// does — including reading storage — happens under the lock, so a sync
// still waiting there will see any state a later caller wrote and there
// is nothing to gain by queueing a second one behind it. Callers that
// arrive while one is *running* do get their own, because that one's
// storage read already happened.
let pendingSync: Promise<void> | null = null;

// The scope the queued sync will run with — the UNION of what everyone
// who joined it asked for, since collapsing two syncs must not drop
// either one's rows. A caller that asked for a full reconcile makes the
// whole queued sync full.
let queuedScriptIds = new Set<string>();
let queuedCollectionIds = new Set<string>();
let queuedFull = false;

function queueScope(scope: SyncScope | undefined): void {
  if (!scope) { queuedFull = true; return; }
  for (const id of scope.scriptIds) queuedScriptIds.add(id);
  for (const id of scope.collectionIds) queuedCollectionIds.add(id);
}

function takeQueuedScope(): SyncScope | undefined {
  const full = queuedFull;
  const scope: SyncScope = {
    scriptIds: [...queuedScriptIds],
    collectionIds: [...queuedCollectionIds],
  };
  queuedFull = false;
  queuedScriptIds = new Set();
  queuedCollectionIds = new Set();
  return full ? undefined : scope;
}

let worldConfigured = false;
async function ensureWorldConfigured(): Promise<void> {
  if (worldConfigured) return;
  // configureWorld must be called before register. Settings:
  //   - messaging: true — lets our wrapper call
  //     chrome.runtime.sendMessage from the USER_SCRIPT world.
  //   - csp — relaxes the default USER_SCRIPT-world CSP (which omits
  //     'unsafe-eval') so the reload-fast-path swap can eval the
  //     SW-supplied body. The CSP only applies to scripts running in
  //     this world; it does NOT change the page's own CSP.
  // Idempotent — Chrome accepts repeated calls but we still guard so
  // we don't issue them on every sync.
  await chrome.userScripts.configureWorld({
    messaging: true,
    csp: "script-src 'self' 'unsafe-eval'",
  });
  worldConfigured = true;
}

// Drop the named registrations. Caller must already hold the
// registration lock.
//
// Only ever called for a script that really is going away — disabled,
// deleted, flipped to INVALID, or one whose fresh spec Chrome refused.
// Nothing that is staying registered is dropped, so there is no window
// in which a live script has no registration; see `placeSpecs`.
//
// Chrome fails the WHOLE `unregister` call when any single id in the
// list is unknown, and an id can go missing before this call — an
// extension page runs the retry path in its own context, where our lock
// doesn't reach. So the batch failing is not evidence that the other
// ids are gone; it usually means one of them already was.
//
// Neither of the obvious answers is safe on its own:
//
//   - Aborting leaves ids registered that no longer should be.
//   - Swallowing the failure does the same: a script that was disabled,
//     deleted, or flipped to INVALID would keep injecting until some
//     later sync's batch happened to succeed.
//
// So fall back to unregistering one id at a time, where an id that has
// already gone takes only itself down.
async function unregisterIds(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await chrome.userScripts.unregister({ ids: [...ids] });
    return;
  } catch (err) {
    // A one-id call has no batch/per-id distinction to report, and it
    // fails routinely and harmlessly: a sync asks to drop every
    // affected script that no longer wants a registration, which
    // includes editing an already-disabled one. Saying so every time
    // would be a console line per edit that means nothing.
    if (ids.length > 1) {
      // console.info, like the other contained failures in this module:
      // rare, worth seeing in the SW console, and not something the user
      // can act on or that any one script is to blame for.
      console.info(
        '[SourceMonkey] unregister failed as a batch; dropping ids one at a time:',
        describeError(err),
      );
    }
  }
  for (const id of ids) {
    try {
      await chrome.userScripts.unregister({ ids: [id] });
    } catch { /* already gone, which is what made the batch fail */ }
  }
}

// Drop every registration Chrome currently holds.
async function unregisterAll(): Promise<void> {
  const existing = await chrome.userScripts.getScripts();
  await unregisterIds(existing.map((e) => e.id));
}

// Same, for callers outside this module — today only the test surface's
// `resetAllState`, which wants a deterministic teardown instead of
// waiting for the storage-change sync. Exported so that teardown is
// ordered against any sync already in flight rather than racing it.
export async function unregisterAllRegistrations(): Promise<void> {
  if (!isUserScriptsAvailable()) return;
  await withRegistrationLock(async () => {
    await unregisterAll();
    // Our record of Chrome's set is now a lie, and an incremental sync
    // built on it would leave every script unregistered. Forget it, so
    // the next sync is a full reconcile.
    syncState = null;
  });
}

// Compile-check every candidate whose stored verdict is missing or
// stale, and return the script set with any re-derived rows swapped in.
//
// What this is for: a row stored before the parse check existed — or
// while it was failing open — carries `status: 'ok'` and no verdict,
// and nothing in the load pipeline revisits it. Registering unparsable
// source raises an uncaught `SyntaxError` that Chrome files under
// `chrome://extensions/?errors`, where it is both uncatchable and
// indistinguishable from SourceMonkey itself being broken. See
// `verifyParseChecks` in script-store.ts.
//
// Cost: one compile per unchecked row per extension version. The
// verdict is persisted, so the next sync finds nothing stale — but
// `parseCheckKey` carries the version, so the first sync after an
// update re-checks the whole library (capped fan-out; see
// `PARSE_RECHECK_CONCURRENCY`). The write it makes fires
// `storage.onChanged` and therefore one more sync, which then has
// nothing to do.
//
// Never throws: the checker fails open on its own, and a failure of
// this step must not take the whole registration set down with it.
async function revalidateCandidates(
  scripts: StoredScript[],
  collections: Map<string, StoredCollection>,
): Promise<StoredScript[]> {
  let changed: Map<string, StoredScript>;
  try {
    changed = await verifyParseChecks(
      scripts.filter((s) => isRegistrationCandidate(s, collections)),
    );
  } catch (err) {
    console.info('[SourceMonkey] parse re-verification skipped:', describeError(err));
    return scripts;
  }
  if (changed.size === 0) return scripts;
  for (const row of changed.values()) {
    // Says what we're about to DO, so it asks the same question
    // `collectActiveSpecs` will. `status !== 'ok'` isn't that question:
    // `verifyParseChecks` also hands back rows it refused to write, and
    // a `missing` row the user re-enabled is registered from its cached
    // body — which would print this line and then register it anyway.
    if (isRegistrationCandidate(row, collections)) continue;
    console.info(
      `[SourceMonkey] not registering ${row.relativePath}: ${row.errorMessage ?? 'it does not parse'}`,
    );
  }
  return scripts.map((s) => changed.get(s.id) ?? s);
}

// Bring Chrome's registration set in line with storage.
//
// `scope` names the rows that moved; omit it for a full reconcile
// (SW startup, and any sync this context can't safely make incremental).
// A scoped sync rebuilds only those scripts' registrations and leaves
// every other one exactly as it is — see `runIncrementalSync`.
//
// Serialized against every other registration operation in this
// context, and collapsed with any sync that is queued but hasn't begun
// — see the lock above for what the overlap used to cost.
export function syncRegistrations(scope?: SyncScope): Promise<void> {
  queueScope(scope);
  if (pendingSync) return pendingSync;
  const sync = withRegistrationLock(async () => {
    // We're starting: a caller arriving from here on needs its own sync,
    // because our storage read is about to happen without whatever they
    // just wrote. Their scope goes into a fresh queue for that sync,
    // which is why the scope is taken at the same moment.
    const scopeNow = takeQueuedScope();
    pendingSync = null;
    await runSync(scopeNow);
  });
  pendingSync = sync;
  return sync;
}

async function runSync(scope: SyncScope | undefined): Promise<void> {
  if (!isUserScriptsAvailable()) {
    // Nothing to register into. Not stored anywhere — the collections
    // page runs its own probe for the banner — but a sync that can't do
    // anything shouldn't be silent in the SW console either.
    //
    // Once per SW lifetime: `syncRegistrations` re-runs on every
    // script-storage change, and with the toggle off that would be a
    // console line per write, forever, all saying the same thing.
    if (!loggedUserScriptsUnavailable) {
      loggedUserScriptsUnavailable = true;
      console.info('[SourceMonkey] chrome.userScripts is unavailable — nothing was registered');
    }
    // Drop any rejections recorded while the API still worked. The map
    // describes the current registration set, and "nothing is
    // registered" is a complete answer — leaving entries would strand
    // REJECTED badges blaming a `@match` pattern for a turned-off
    // toggle, which the collections page's own banner already explains.
    await writeRejections(await readRejections(), {});
    // And forget any record of a registration set, for the same reason:
    // if the API comes back, what Chrome holds is not something this
    // context can still claim to know.
    syncState = null;
    return;
  }
  const state = syncState;
  try {
    await ensureWorldConfigured();
    // A scope is only actionable against a record of what we last left
    // registered. Without one — a fresh service worker, or a sync that
    // failed part-way and dropped it — the only safe answer is to
    // reconcile against Chrome's own list.
    if (scope && state) {
      await runIncrementalSync(scope, state);
      lastSyncKind = 'incremental';
    } else {
      syncState = await runFullSync();
      lastSyncKind = 'full';
    }
  } catch (err) {
    console.info('[SourceMonkey] userScripts sync failed:', describeError(err));
    // We no longer know what Chrome holds, so the next sync starts over
    // rather than diffing against a record that may be half-applied.
    // This is also what keeps a scoped sync's ids from being lost: they
    // were consumed by the attempt, and a full reconcile covers them.
    syncState = null;
  }
}

// Rebuild EVERY registration and reconcile the result against what
// Chrome currently holds.
//
// Runs at service-worker startup and whenever this context has no
// trustworthy record of the registration set. Chrome retains
// registrations across SW restarts and rows change while the worker is
// dead, so the post-startup set has to be proven equal to storage
// rather than diffed against nothing.
//
// It is still not a wipe: everything that should stay registered is
// updated in place, and the only unregisters are for ids Chrome holds
// that storage no longer wants.
async function runFullSync(): Promise<RegistrationState> {
  const timer = startPhaseTimer('registration sync');
  const { scripts, collections } = await readAll();
  timer.mark('read');
  const handlerVersion = chrome.runtime.getManifest().version;
  const effective = await revalidateCandidates(scripts, collections);
  const logIds = computeLogIds(scripts.map((s): LogIdInput => ({
    id: s.id, relativePath: s.relativePath,
  })));
  const active = await collectActiveSpecs(effective, collections, handlerVersion, logIds);
  const userSpecs = active.specs;
  // Covers the revalidation too — it is per-script work on the same
  // critical path, and splitting it out would imply the two can be
  // acted on separately when the sync always does both.
  timer.mark('build-specs');
  // Chrome's own list, patterns included — the authority on both what
  // is there and what shape it is in.
  const present = new Map(
    (await chrome.userScripts.getScripts()).map((s) => [s.id, patternsOf(s)] as const),
  );
  timer.mark('list');
  const specs = orderWithOwnSpecs(
    userSpecs,
    hasWorld(userSpecs.map((s) => s.world), 'MAIN'),
    active.gmRuntimeScope,
    // Empty rather than `present`: a full sync re-places the bridge and
    // the GM runtime even when Chrome already holds them, because their
    // code ships with the extension and an update changes it. Skipping
    // them would also drop them — the removal list is everything Chrome
    // holds that this spec list doesn't name.
    new Set(),
  );
  const wanted = new Set(specs.map((s) => s.id));
  const applied = await applyPlan({
    specs,
    removeIds: [...present.keys()].filter((id) => !wanted.has(id)),
    present,
    // The whole set was rebuilt, so the rejection map is rewritten
    // wholesale — a script that has since been disabled, deleted or
    // flipped to INVALID stops being REJECTED instead of stranding a
    // badge nobody can clear.
    owned: 'all',
  });
  timer.mark('register');
  timer.note(`full; ${specs.length} specs, ${scripts.length} stored scripts`);
  timer.done();
  reportSyncResult(applied.placed.length, specs.length);
  return {
    registered: placementsOf(specs, applied, active.gmRuntime),
    gmRuntimeScopes: new Map(
      specs.filter((spec) => !isUserScriptId(spec.id) && spec.id !== BRIDGE_SCRIPT_ID)
        .map((spec) => [spec.id, gmRuntimeFingerprint(spec)] as const),
    ),
    scriptIndex: new Map(scripts.map((s) => [
      s.id, { relativePath: s.relativePath, collectionId: s.collectionId },
    ])),
    labels: logIds,
    collections,
  };
}

// Rebuild only the registrations for the rows that moved.
//
// The rest of the set is not read, not rebuilt, and not touched — which
// is the point: the old full wipe left EVERY script unregistered for the
// length of a register-all, so a document created in that window ran
// nothing at all.
//
// Mutates `state` in place as it goes; the caller drops the whole record
// if this throws.
async function runIncrementalSync(scope: SyncScope, state: RegistrationState): Promise<void> {
  const timer = startPhaseTimer('registration sync');
  // A collection row that appeared, went away, or flipped its enabled
  // flag moves every script under it.
  const affected = new Set(scope.scriptIds);
  if (scope.collectionIds.length > 0) {
    const moved = new Set(scope.collectionIds);
    for (const [id, info] of state.scriptIndex) {
      if (moved.has(info.collectionId)) affected.add(id);
    }
  }
  const rows = await readRows(affected, scope.collectionIds);
  timer.mark('read');
  for (const id of scope.collectionIds) {
    const row = rows[COLLECTION_PREFIX + id] as StoredCollection | undefined;
    if (row) state.collections.set(id, row);
    else state.collections.delete(id);
  }
  const scripts: StoredScript[] = [];
  for (const id of affected) {
    const row = rows[SCRIPT_PREFIX + id] as StoredScript | undefined;
    if (!row) { state.scriptIndex.delete(id); continue; }
    scripts.push(row);
    state.scriptIndex.set(id, {
      relativePath: row.relativePath, collectionId: row.collectionId,
    });
  }
  // A script can name a collection this record has never seen: a
  // collection row is reported only when its enabled flag moves or it
  // goes away, so its arrival — which is what an added collection is —
  // reaches us as the scripts under it. Fetch what's missing rather
  // than calling those scripts ineligible.
  const unseen = [...new Set(scripts.map((s) => s.collectionId))]
    .filter((id) => !state.collections.has(id));
  if (unseen.length > 0) {
    const extra = await readRows([], unseen);
    for (const id of unseen) {
      const row = extra[COLLECTION_PREFIX + id] as StoredCollection | undefined;
      if (row) state.collections.set(id, row);
    }
  }
  // Labels are dedup-aware across the whole library, so they come from
  // the index rather than from the handful of rows this sync read —
  // otherwise a script's devtools folder would gain or lose its `#N`
  // depending on which sync last rebuilt it.
  const logIds = computeLogIds([...state.scriptIndex].map(([id, info]): LogIdInput => ({
    id, relativePath: info.relativePath,
  })));
  // A script arriving or leaving can renumber a dupe group it isn't
  // in — and the label is baked into the registered `//# sourceURL=`
  // directives, so every script whose label just moved has to be
  // rebuilt too, however untouched its own row is.
  const renamed = [...state.registered.keys()].filter(
    (id) => !affected.has(id) && state.labels.get(id) !== logIds.get(id),
  );
  // Only the labels we actually place are recorded as placed. A
  // renamed script whose row we cannot re-read keeps its OLD label in
  // the record, so the next sync sees the mismatch again and retries —
  // rather than recording a label the registration never got and never
  // looking at it again.
  const nextLabels = new Map(logIds);
  if (renamed.length > 0) {
    const extra = await readRows(renamed, []);
    for (const id of renamed) {
      const row = extra[SCRIPT_PREFIX + id] as StoredScript | undefined;
      if (!row) {
        const stale = state.labels.get(id);
        if (stale !== undefined) nextLabels.set(id, stale);
        continue;
      }
      scripts.push(row);
      affected.add(id);
    }
  }
  const handlerVersion = chrome.runtime.getManifest().version;
  const effective = await revalidateCandidates(scripts, state.collections);
  const active = await collectActiveSpecs(
    effective, state.collections, handlerVersion, logIds,
  );
  const userSpecs = active.specs;
  timer.mark('build-specs');

  const wanted = new Set(userSpecs.map((s) => s.id));
  // Every affected script that no longer wants a registration, whether
  // or not WE believe it has one. The belief is this context's, and the
  // collections page and the viewer place registrations in theirs — so
  // a script the page-side retry placed is one this record has never
  // heard of, and guarding on the record would leave it injecting after
  // the user disabled or deleted it.
  //
  // A wrong belief about *presence* self-corrects everywhere else,
  // because `placeSpec` has a second call that disagrees with it (a
  // wrong belief about glob values doesn't — see `placeSpec`).
  // Removal has no such fallback, so it does not get to guess: an
  // unregister for an id nothing holds costs one refused call and is
  // swallowed (see `unregisterIds`).
  const removeIds = [...affected].filter((id) => !wanted.has(id));
  // Project the post-sync world set, so the bridge / GM-runtime
  // registrations follow the WHOLE registration set rather than the
  // slice this sync happens to be holding.
  const projected = new Map(state.registered);
  for (const id of removeIds) projected.delete(id);
  for (const spec of userSpecs) {
    projected.set(spec.id, {
      world: (spec.world ?? 'MAIN') as InjectionWorld,
      patterns: patternsOf(spec),
      gmRuntime: active.gmRuntime.get(spec.id) ?? null,
    });
  }
  const needBridge = hasWorld(userWorlds(projected), 'MAIN');
  const gmRuntimeScope = gmRuntimeScopeOf(userPlacements(projected));
  if (!needBridge && state.registered.has(BRIDGE_SCRIPT_ID)) removeIds.push(BRIDGE_SCRIPT_ID);
  // One runtime registration per world, dropped independently: a page
  // can end up wanting the MAIN copy and not the USER_SCRIPT one.
  for (const world of GM_RUNTIME_WORLDS) {
    const id = gmRuntimeIdFor(world);
    if (!gmRuntimeScope.has(world) && state.registered.has(id)) removeIds.push(id);
  }

  const present = new Map([...state.registered].map(([id, p]) => [id, p.patterns] as const));
  // Our own two registrations are normally not re-offered (see
  // `orderWithOwnSpecs`), but the runtime's patterns follow its
  // scripts: adding the first script on a new host moves the union, and
  // a skipped update would leave `window.__SM_GM__` absent on exactly
  // the page that just started needing it. So a runtime whose
  // fingerprint moved counts as not-yet-placed.
  const nextScopes = new Map(
    buildGmRuntimeSpecs(gmRuntimeScope).map((spec) => [spec.id, gmRuntimeFingerprint(spec)] as const),
  );
  // The bridge has no fingerprint, so for it both `get`s are undefined
  // and the comparison holds — presence alone decides, as intended.
  const alreadyPlaced = {
    has: (id: string) => present.has(id) && state.gmRuntimeScopes.get(id) === nextScopes.get(id),
  };
  const specs = orderWithOwnSpecs(userSpecs, needBridge, gmRuntimeScope, alreadyPlaced);
  state.gmRuntimeScopes = nextScopes;
  const applied = await applyPlan({
    specs,
    removeIds,
    present,
    // Only the rows this sync considered. An id it never looked at
    // keeps whatever the map already says: dropping those would clear a
    // REJECTED badge for a script Chrome is still refusing, and
    // rewriting them wholesale would resurrect ones already cleared.
    owned: affected,
  });
  timer.mark('register');
  timer.note(`incremental; ${specs.length} specs, ${removeIds.length} dropped`);
  timer.done();
  for (const id of removeIds) state.registered.delete(id);
  for (const [id, placement] of placementsOf(specs, applied, active.gmRuntime)) {
    state.registered.set(id, placement);
  }
  for (const id of applied.refused) state.registered.delete(id);
  state.labels = nextLabels;
  reportSyncResult(applied.placed.length, specs.length);
}

// Prepend our own bridge / GM-runtime specs to the user specs, when
// they're wanted and not already in place.
//
// GM runtime first so it installs window.__SM_GM__ ahead of any
// USER_SCRIPT-world wrapper that compiles in GM_* bindings. Bridge next
// so MAIN wrappers' postMessages have a listener. Then the user
// scripts. (Cross-registration ordering isn't guaranteed by the
// userScripts API, but in practice Chrome runs registrations in order.
// We rely on this for the bridge: a MAIN-world wrapper's postMessage
// queues to the message task queue, so the bridge's listener —
// installed during its IIFE at document_start — is in place by the time
// delivery happens. For GM_*: everything gm-bindings.ts emits — both
// the `const GM_x` declarations and the eager calls (`storage.init`,
// `urlchange.enable`) — is spliced INSIDE the main-body wrap function,
// which the prelude only invokes after its awaitDecision + run-at gates
// resolve. By then the runtime spec has had a microtask or more to
// install. The declarations are additionally lazy — they touch
// `window.__SM_GM__` only from inside their own bodies — but that's
// belt-and-braces, not what the ordering argument rests on.)
//
// The order is honoured. Chrome moves an UPDATED registration to the
// end of its set (verified), so grouping the placement calls by kind
// would silently invert this — `placeSpecs` therefore places these two
// first and individually, before any user spec.
//
// An incremental sync can't put a NEW user script ahead of a bridge
// that was already registered, but it doesn't need to: the only way the
// bridge is already there is that a MAIN-world script was already
// active, so the ordering it exists to guarantee is already established.
//
// `alreadyPlaced` names ids not worth re-offering — an incremental sync
// passes what it believes is registered, so an ordinary script edit
// doesn't churn our own two registrations. A full sync passes nothing.
function orderWithOwnSpecs(
  userSpecs: RegistrationSpec[],
  needBridge: boolean,
  gmRuntimeScope: ReadonlyMap<InjectionWorld, GmRuntimeScope>,
  alreadyPlaced: { has(id: string): boolean },
): RegistrationSpec[] {
  const specs: RegistrationSpec[] = [];
  for (const spec of buildGmRuntimeSpecs(gmRuntimeScope)) {
    if (!alreadyPlaced.has(spec.id)) specs.push(spec);
  }
  if (needBridge && !alreadyPlaced.has(BRIDGE_SCRIPT_ID)) specs.push(bridgeSpec());
  specs.push(...userSpecs);
  return specs;
}

// What Chrome now holds, for the specs that actually went in.
function placementsOf(
  specs: readonly RegistrationSpec[],
  applied: AppliedPlan,
  gmRuntime: ReadonlyMap<string, GmRuntimePatterns>,
): Map<string, Placement> {
  const out = new Map<string, Placement>();
  for (const spec of specs) {
    if (applied.refused.has(spec.id)) continue;
    out.set(spec.id, {
      world: (spec.world ?? 'MAIN') as InjectionWorld,
      patterns: patternsOf(spec),
      gmRuntime: gmRuntime.get(spec.id) ?? null,
    });
  }
  return out;
}

function reportSyncResult(registered: number, offered: number): void {
  // A sync whose scope turned out to hold nothing offered nothing, and
  // "registered 0 userscript(s)" would read as though it had emptied
  // the set. Say nothing instead.
  if (offered === 0) return;
  const failed = offered - registered;
  if (failed > 0) {
    console.info(
      `[SourceMonkey] registered ${registered}/${offered} userscript(s); ${failed} rejected by chrome.userScripts (see per-script errors)`,
    );
  } else {
    console.log(`[SourceMonkey] registered ${registered} userscript(s) with chrome.userScripts`);
  }
}

// ---------- Retrying a refused registration ----------

// Shortest gap between two automatic retries. A navigation fans out
// into several checks of the same script — the reload fast-path plus an
// opportunistic check per commit event, per frame — and without a floor
// each one would re-offer the spec and write its own Log row, so a
// single page load produced a burst of identical entries.
//
// A genuine Refresh click ignores the floor on the way in (see
// `userInitiated`): the user asked, so they get an answer every time.
// It still resets it on the way out, so a click also postpones the next
// automatic attempt by 10 s — which is right, since the click just did
// that work.
export const REJECTION_RETRY_MIN_INTERVAL_MS = 10_000;

let lastAutoRetryAt = 0;
let retryInFlight: Promise<void> | null = null;
// Ids waiting for an attempt. A caller that arrives while one is
// running adds to this and rides the same promise; the running attempt
// drains it before finishing, so nobody's ids are dropped just because
// somebody else got there first.
const pendingRetryIds = new Set<string>();

// Swappable clock, so the rate limit is testable without sleeping.
let retryNow: () => number = () => Date.now();
export function _setRetryNowForTests(fn: () => number): void {
  retryNow = fn;
  resetRejectionRetryGate();
}

// Forget that we retried recently.
//
// The rate limit is module state, so it outlives a storage wipe — which
// means one e2e test's retry would silently suppress the next test's,
// exactly the kind of cross-test bleed `resetAllState` exists to
// prevent. Same category as the parse check's circuit breaker, and
// reset from the same place.
//
// Leaves `retryInFlight` alone: nulling it while an attempt is still
// running would let a second one start concurrently, which is the
// opposite of a clean slate. The running attempt clears it itself.
export function resetRejectionRetryGate(): void {
  lastAutoRetryAt = 0;
  pendingRetryIds.clear();
}

// Re-attempt registration for whichever of `scriptIds` Chrome is
// currently refusing. No-op when none of them is.
//
// Why the refresh paths need this at all: `syncRegistrations` is
// normally driven by `onCacheChanged`, which rides on
// `chrome.storage.onChanged` — and a Refresh that finds nothing new
// raises no such event, so it never re-offers the spec. Nothing fires
// by either of two routes: the refresh skips the write entirely for a
// row that didn't change (see `changedScriptRows` in script-store.ts),
// and Chrome raises no change event even when a `set` does write a
// value identical to what's already stored. For a healthy script that
// silence is right — its registration already matches. For a rejected
// one it left the row reading REJECTED with nothing retrying it.
//
// Deliberately NOT a scopeless `syncRegistrations()`. That rebuilds
// every spec and lists Chrome's whole set, which is far too heavy to
// run per navigation. A rejected script is by definition not
// registered, so re-offering just its own spec is both cheaper and
// touches nothing else.
export async function retryRejectedRegistrations(
  scriptIds: readonly string[],
  opts: { userInitiated?: boolean } = {},
): Promise<void> {
  if (scriptIds.length === 0) return;
  // Nothing to register into. Without this the register call below
  // throws a raw TypeError, which the catch would then write into the
  // user's Log as Chrome's reason for refusing the script.
  if (!isUserScriptsAvailable()) return;
  if (!opts.userInitiated && retryNow() - lastAutoRetryAt < REJECTION_RETRY_MIN_INTERVAL_MS) {
    return;
  }
  for (const id of scriptIds) pendingRetryIds.add(id);
  // One attempt at a time — concurrent register() calls for the same id
  // would race each other. Late callers ride this promise, and the
  // running attempt drains whatever they queued before it resolves, so
  // riding it is not the same as being dropped.
  if (retryInFlight) return retryInFlight;
  retryInFlight = (async () => {
    try {
      // Drain: a caller that queued ids while we were mid-attempt gets
      // them offered in this same run rather than waiting for whatever
      // triggers the next one (which, under the rate limit, could be
      // 10 s away — or never, for a script nothing else checks).
      while (pendingRetryIds.size > 0) {
        const ids = [...pendingRetryIds];
        pendingRetryIds.clear();
        // Under the same lock as a full sync: this re-offers ids the
        // sync also owns, and the two interleaving is precisely how a
        // registered script ends up reported as a duplicate.
        //
        // Which ids are still refused is read INSIDE the lock, because
        // waiting for it is exactly when that answer goes stale: a sync
        // that lands in the wait clears the map and places the scripts,
        // and a retry working from the older answer would then
        // unregister and re-register healthy ones — the mid-navigation
        // deregistration this path exists to avoid.
        await withRegistrationLock(async () => {
          const rejections = await readRejections();
          const refused = ids.filter((id) => rejections[id] !== undefined);
          if (refused.length === 0) return;
          // Stamped at attempt time, not queue time, for the same
          // reason: the rate limit counts attempts we actually made.
          lastAutoRetryAt = retryNow();
          await reregisterScripts(refused);
        });
      }
    } catch (err) {
      // Contained like the version probe beside it in script-updater:
      // this is incidental work hanging off a refresh, and a failure
      // here must not fail the Refresh the user actually asked for (the
      // collection paths await us) or surface as an unhandled rejection
      // (the per-script path does not).
      console.info('[SourceMonkey] registration retry failed:', describeError(err));
    } finally {
      retryInFlight = null;
    }
  })();
  return retryInFlight;
}

// Put one spec in place, whether or not Chrome already holds its id.
//
// `believedPresent` says which of `update` and `register` to try first;
// the other one is the fallback. Both calls place the spec, so getting
// the guess wrong costs a round trip and nothing else — and neither
// call ever leaves the id unregistered, which is the property the whole
// sync now rests on.
//
// That self-correction covers *presence* only. A belief carrying stale
// glob VALUES that happen to equal the spec's makes `needsReplace`
// false, `update` succeeds, and no second call ever disagrees — so
// Chrome can hold globs neither the record nor the header describes
// until the next full reconcile rebuilds `present` from `getScripts`.
// Bounded by the worker's life, and it takes another context placing a
// different glob set for the same id with no storage write behind it,
// so we live with it rather than spending a round trip per spec.
//
// Chrome answers a `register` for an id it already knows with
// "Duplicate script ID '<id>'" rather than replacing it, and there are
// two ordinary ways it already knows one of ours:
//
//   - **Another context placed it.** The collections page and the viewer
//     run `retryRejectedRegistrations` in their own JS context, so the
//     lock in this module — which is per-context — cannot order a
//     page-side retry against the SW's sync.
//   - **A stale rejection record.** We believe the id is unplaced, so
//     we rebuild and re-offer it; Chrome disagrees.
//
// Either way the duplicate is a fact about our own ordering, not about
// the script: reporting it badged a running script REJECTED and wrote a
// Log row blaming it for our sequencing. Which of the two specs is
// newer we can't tell from here, and don't need to — every `script:*` /
// `collection:*` write schedules a sync of its own, so the set
// converges on the last write either way.
//
// **Never unregister-then-register.** That arrangement turns any
// register failure into a script that WAS running and now isn't, and
// leaves a window — however short — in which a document created right
// then gets nothing injected. `chrome.userScripts.update` replaces a
// registration in place with no such window, so the pair here is
// update/register rather than unregister/register.
//
// A refusal isn't necessarily a duplicate: a spec Chrome rejects
// outright (a malformed `@match` port, say) lands in the same place.
// Which one it is gets answered by ASKING Chrome (`getScripts` for the
// one id) rather than by reading its wording for the refusal — a string
// match there would break the moment Chrome rephrases, and Chrome's own
// error is the one thing here we pass through to the user verbatim.
//
// Why ask rather than just try the other call: in the
// `believedPresent` direction the other call is `register`, which is
// *guaranteed* to answer `Duplicate script ID` when the id really is
// there. It would carry no information, and treating its failure as
// confirmation would let any transient `update` failure demote a
// registration that was working.
//
// Shared by the retry path and the sync's per-spec fallback so the two
// can't drift on this.
async function placeSpec(
  spec: RegistrationSpec,
  believed: PlacedPatterns | undefined,
): Promise<void> {
  if (believed) {
    // A spec whose pattern fields `update` won't apply — changed
    // globs, or a dropped `matches` — can't go through it at all. See
    // `needsReplace`.
    if (needsReplace(believed, spec)) return await replaceRegistration(spec);
    let refusal: unknown;
    try {
      await chrome.userScripts.update([spec]);
      return;
    } catch (err) {
      refusal = err;
    }
    const actual = await placedPatterns(spec.id);
    // It IS registered, so the refusal is about the spec. Report it.
    if (actual) throw refusal;
    dlog(`[SourceMonkey] script ${spec.id} was not registered after all; registering it`);
    try {
      await chrome.userScripts.register([spec]);
      return;
    } catch {
      // Our belief was wrong AND the register failed — or we couldn't
      // ask at all (`placedPatterns` answers "nothing there" when the
      // list call itself fails). Either way the update's reason is the
      // one that describes this spec.
      throw refusal;
    }
  }
  let refusal: unknown;
  try {
    await chrome.userScripts.register([spec]);
    return;
  } catch (err) {
    refusal = err;
  }
  const actual = await placedPatterns(spec.id);
  // Nothing is holding the id, so the spec itself is the problem and
  // its original reason is what the caller should report.
  if (!actual) throw refusal;
  dlog(`[SourceMonkey] script ${spec.id} was already registered; replacing it`);
  // Now we know the registration's real shape, which is what says
  // whether an update would silently keep the pattern fields it holds.
  if (needsReplace(actual, spec)) return await replaceRegistration(spec);
  await chrome.userScripts.update([spec]);
}

// The one place a live registration is deliberately dropped and put
// back, and the one place the closed window reopens — for one script,
// for the length of one call pair.
//
// Unavoidable: Chrome's `update` ignores `includeGlobs` /
// `excludeGlobs` outright and cannot clear `matches` (verified — see
// `PlacedPatterns`). A script that just gained an `@exclude` would
// otherwise keep running on the site its header now excludes, and one
// that just lost its last `@exclude` would keep an exclusion its header
// no longer declares — both with nothing in the UI to explain it.
//
// The trade is narrow and in the right direction: the gap costs one
// script one navigation, and only a script whose match set the user is
// actively rewriting; the alternative is Chrome and our own matcher
// disagreeing indefinitely.
async function replaceRegistration(spec: RegistrationSpec): Promise<void> {
  dlog(`[SourceMonkey] script ${spec.id} changed a pattern field; re-registering it outright`);
  try {
    await chrome.userScripts.unregister({ ids: [spec.id] });
  } catch { /* already gone; the register below is then the whole job */ }
  await chrome.userScripts.register([spec]);
}

// Put every spec in place, batching when we can and falling back to one
// at a time when Chrome refuses the batch — so one malformed pattern
// can't stop every other script from being registered. (Chrome applies
// a batch all-or-nothing: one bad spec and none of them land.)
//
// Ordering. Chrome moves an UPDATED registration to the END of its set,
// in batch order (verified), so grouping the calls by kind reorders the
// result. Our own two registrations have to precede every user script,
// so they are placed first and individually; the user specs then go out
// as batches, because the relative order of two user scripts is not
// something we promise anyway (see docs/injection.md#run-at-gating).
async function placeSpecs(
  specs: readonly RegistrationSpec[],
  present: ReadonlyMap<string, PlacedPatterns>,
): Promise<{ placed: string[]; refused: Map<string, string> }> {
  const placed: string[] = [];
  const refused = new Map<string, string>();
  const placeOne = async (
    spec: RegistrationSpec,
    beliefs: ReadonlyMap<string, PlacedPatterns> = present,
  ): Promise<void> => {
    try {
      await placeSpec(spec, beliefs.get(spec.id));
      placed.push(spec.id);
    } catch (err) {
      refused.set(spec.id, describeError(err));
    }
  };
  for (const spec of specs.filter((s) => !isUserScriptId(s.id))) await placeOne(spec);

  const users = specs.filter((s) => isUserScriptId(s.id));
  // A one-spec batch IS the per-spec pass, so trying it first would
  // just offer the same spec to Chrome twice. Matters beyond the wasted
  // round trip: the targeted retry offers exactly one spec, and its
  // whole rate-limiting story is about how many attempts we make.
  // What the per-spec fallback below believes about each id. Starts as
  // the caller's `present` and is corrected as the batch pass lands, so
  // a failure part-way through doesn't make the fallback redo work that
  // already succeeded.
  const believed = new Map(present);
  if (users.length > 1) {
    // One partition pass: `needsReplaceFrom` sorts two arrays per call,
    // so asking it twice per spec is worth avoiding.
    const replace: RegistrationSpec[] = [];
    const existing: RegistrationSpec[] = [];
    const fresh: RegistrationSpec[] = [];
    for (const spec of users) {
      if (!believed.has(spec.id)) fresh.push(spec);
      else if (needsReplaceFrom(believed, spec)) replace.push(spec);
      else existing.push(spec);
    }
    try {
      if (existing.length > 0) await chrome.userScripts.update(existing);
      if (fresh.length > 0) await chrome.userScripts.register(fresh);
      for (const spec of replace) {
        await replaceRegistration(spec);
        // Chrome now holds this spec outright. Recording that matters
        // for the catch below: without it, a later `replaceRegistration`
        // throwing would send the fallback back over this script with a
        // stale `present`, and it would be unregistered and registered a
        // second time — a second injection gap for a script that is
        // already correct.
        believed.set(spec.id, patternsOf(spec));
      }
      return { placed: [...placed, ...users.map((s) => s.id)], refused };
    } catch {
      // Either a spec is bad or our belief about who holds an id is
      // stale. Which, and whose, is what the per-spec pass answers.
      // Re-placing the ones that already went in is harmless.
    }
  }
  for (const spec of users) await placeOne(spec, believed);
  return { placed, refused };
}

// One sync's worth of changes to Chrome's registration set, plus the
// rejection-map bookkeeping that has to move with it.
interface RegistrationPlan {
  // Specs to put in place, in the order Chrome should receive them.
  specs: RegistrationSpec[];
  // Ids to drop, because storage no longer wants them registered.
  removeIds: string[];
  // Ids we believe Chrome currently holds. Only a hint — see
  // `placeSpec` — but a good one saves a round trip per spec.
  present: ReadonlyMap<string, PlacedPatterns>;
  // Whose rejection-map entries this plan is allowed to clear. `'all'`
  // for a full sync, which rebuilt everything and therefore owns the
  // whole map; a set of ids for an incremental one, which must leave
  // every other entry exactly as it found it.
  owned: 'all' | ReadonlySet<string>;
}

interface AppliedPlan {
  placed: string[];
  refused: Set<string>;
}

async function applyPlan(plan: RegistrationPlan): Promise<AppliedPlan> {
  const prior = await readRejections();
  const { placed, refused } = await placeSpecs(plan.specs, plan.present);
  // A spec Chrome refuses for an id it already holds leaves the
  // PREVIOUS registration in place, so the script would keep injecting
  // stale code while its row read REJECTED — and REJECTED says the
  // script will not run. Drop it, so the badge stays true.
  const drop = [...plan.removeIds];
  for (const id of refused.keys()) if (plan.present.has(id)) drop.push(id);
  await unregisterIds(drop);

  const next: RejectionMap = plan.owned === 'all' ? {} : { ...prior };
  if (plan.owned !== 'all') for (const id of plan.owned) delete next[id];
  for (const [id, msg] of refused) {
    console.info(`[SourceMonkey] script ${id} rejected: ${msg}`);
    // Our own bridge / GM-runtime specs get the console line above and
    // nothing else. They are not scripts: no row can render REJECTED
    // for them, no Log tab exists to read the entry, and
    // `retryRejectedRegistrations` could never clear the map entry
    // because `collectActiveSpecs` never produces their ids. A failure
    // here is ours to fix, not something to file against a script.
    if (!isUserScriptId(id)) continue;
    next[id] = msg;
    // A rejected registration means the script silently never runs.
    // Its status cell says so for as long as the rejection stands
    // (REJECTED, from the map we're building here); the Log is where
    // the reason gets a timestamp and a permanent home. See
    // `logRejection` for why every attempt gets a row.
    logRejection(id, msg);
  }
  await writeRejections(prior, next);
  logRecoveries(placed.filter((id) => prior[id] !== undefined));
  return { placed, refused: new Set(refused.keys()) };
}

// Rebuild and re-offer the specs for `ids`, updating the rejection map
// and the Log with whatever Chrome says this time. Caller must hold the
// registration lock.
async function reregisterScripts(ids: readonly string[]): Promise<void> {
  // Same precondition as the sync: `configureWorld` must precede
  // `register`. Guarded and idempotent, and `worldConfigured` is
  // per-JS-context — the collections page and the viewer reach this
  // without ever running a sync — so the retry can't assume someone
  // else did it.
  await ensureWorldConfigured();
  const { scripts, collections } = await readAll();
  const handlerVersion = chrome.runtime.getManifest().version;
  const wanted = new Set(ids);
  // Built through collectActiveSpecs rather than buildRegistrationSpec
  // directly so the retry can't drift from the sync on eligibility or
  // on dedup-aware log labels.
  // Only the user specs: the shared GM runtime and bridge registrations
  // belong to the last full sync, which built them for this same script
  // set — a targeted retry re-offers the refused script, not the
  // scaffolding already installed around it.
  const active = await collectActiveSpecs(scripts, collections, handlerVersion);
  const specs = active.specs.filter((s) => wanted.has(s.id));
  // `owned: wanted` is what makes this targeted: the rejection map is
  // re-read inside `applyPlan` and only these ids are touched, so a full
  // sync that landed while we were registering keeps every other entry.
  // It also covers a script that is rejected but no longer eligible
  // (disabled or gone since the map was written) — it produces no spec,
  // and being owned is what drops it so its row stops reading REJECTED.
  //
  // `present` is empty because a rejected script is by definition not
  // registered. When that's wrong, `placeSpec`'s fallback covers it.
  const applied = await applyPlan({
    specs, removeIds: [], present: new Map(), owned: wanted,
  });
  for (const id of applied.placed) {
    dlog(`[SourceMonkey] script ${id} registered on retry`);
    // Keep this context's record of the registration set honest, so a
    // later incremental sync knows to update rather than register.
    const spec = specs.find((s) => s.id === id);
    if (syncState && spec) {
      syncState.registered.set(id, {
        world: (spec.world ?? 'MAIN') as InjectionWorld,
        patterns: patternsOf(spec),
        gmRuntime: active.gmRuntime.get(id) ?? null,
      });
    }
  }
}

// The one place the rejection row is worded. Shared by the sync and the
// targeted retry so the two can't drift.
//
// Written on EVERY refused attempt, not just when the state changes. A
// suppressed retry is indistinguishable from no retry: the Log would go
// quiet while we were still trying, and "Clear log" followed by a
// Refresh would leave the row explaining nothing. Each entry is a real
// event — we offered the spec, Chrome said no. The retry rate limit
// above is what keeps that from becoming a burst; the answer is to make
// fewer attempts, not to hide the ones we make.
function logRejection(scriptId: string, reason: string): void {
  logScriptEvent(scriptId, {
    level: 'error',
    state: 'rejected',
    source: 'chrome-injector',
    message: describeRejection(reason),
  });
}

// The other half: a script Chrome had been refusing that just went in.
//
// Required by the rule that every surfaced failure has a matching
// recovery line — see
// [docs/script-log.md](../docs/script-log.md#recovery-is-logged-too).
// Without it the Log's last word on a fixed script is the refusal, and
// the user has no confirmation their fix took.
//
// Info level with `state: 'ok'`, like every other recovery row. The
// badge itself comes from the rejection map, which the caller has
// already rewritten; neither the refusal nor this row touches the
// `loglevel:` sentinel, so nothing residual is left once the map clears.
function logRecoveries(scriptIds: readonly string[]): void {
  for (const id of scriptIds) {
    logScriptEvent(id, {
      level: 'info',
      state: 'ok',
      source: 'chrome-injector',
      message: 'Chrome accepted this script\'s registration — it runs again',
    });
  }
}

// Place a complete registration set, none of whose ids Chrome is
// believed to hold, and rewrite the rejection map wholesale from the
// result. Returns the count of specs that actually went in.
//
// Thin wrapper over `applyPlan` — kept because it is the shape the unit
// tests exercise, and because "these specs are the whole set" is worth
// naming. A sync reaches `applyPlan` directly; it also has removals and
// a `present` set to pass, neither of which this shape can express.
//
// Caller must hold the registration lock.
export async function registerWithFallback(specs: RegistrationSpec[]): Promise<number> {
  const applied = await applyPlan({
    specs, removeIds: [], present: new Map(), owned: 'all',
  });
  return applied.placed.length;
}

// True for a stored script's registration id, false for the two
// reserved ids we register for our own plumbing.
function isUserScriptId(id: string): boolean {
  return id !== BRIDGE_SCRIPT_ID && id !== GM_RUNTIME_SCRIPT_ID;
}
