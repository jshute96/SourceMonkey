// Userscript injection via the chrome.userScripts API.
//
// Chrome owns the actual matching + injection at navigation time. Our
// job is to keep its registration set in sync with our "effectively
// enabled ok scripts" view of the world. Whenever the script-store
// cache changes we re-sync (cheap full wipe + re-register at our
// scale).
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
// the user must enable the "Allow User Scripts" toggle (Chrome ≥138) or
// developer mode (Chrome 120–137) on chrome://extensions. If the toggle
// is off, chrome.userScripts.register throws. The collections page
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
import { resolveGrants } from './gm-api-catalog.js';
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

// Reserved registration ids. Chrome's userScripts API rejects ids
// that start with `_`, so we use a `sourcemonkey-` prefix; stored
// script ids are UUIDs and won't collide.
export const BRIDGE_SCRIPT_ID = 'sourcemonkey-bridge';

// Reserved registration id for the USER_SCRIPT-world GM_* shared
// runtime. Registered at document_start so its `window.__SM_GM__`
// global is in place before any userscript wrapper runs.
export const GM_RUNTIME_SCRIPT_ID = 'sourcemonkey-gm-runtime';

export type RegistrationSpec = chrome.userScripts.RegisteredUserScript;
export type InjectionWorld = 'MAIN' | 'USER_SCRIPT';

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
// so the wrapper's `sm:start` / `sm:error` reports route through the
// bridge instead. See docs/injection.md.
export function resolveWorld(header: ParsedHeader | null | undefined): InjectionWorld {
  if (!header) return 'MAIN';
  const injectInto = (getValue(header, 'inject-into') ?? '').trim().toLowerCase();
  if (injectInto === 'page') return 'MAIN';
  if (injectInto === 'content') return 'USER_SCRIPT';
  const grants = getValues(header, 'grant').map((g) => g.trim().toLowerCase());
  if (grants.length === 0) return 'MAIN';
  if (grants.every((g) => g === 'none' || g === '')) return 'MAIN';
  return 'USER_SCRIPT';
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
// calling this. Production callers (`buildGmBindingsForScript`,
// `buildMainWorldGmInfoOnly`) early-return for headerless scripts.
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

// Build the full GM-binding source string for one USER_SCRIPT-world
// script: a const declaration per granted API plus the implicit
// `GM_info`. Async because we may eventually need to read persisted
// values at register time (not today; the storage snapshot path
// runs through the check-pending reply). For MAIN-world scripts use
// `buildMainWorldGmInfoOnly` — most of the GM_* surface delegates
// to `window.__SM_GM__`, which only exists in USER_SCRIPT world.
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

// MAIN-world variant: emit ONLY GM_info — the other GM_* bindings
// can't work because `window.__SM_GM__` lives in USER_SCRIPT world.
// (See the TODO in docs/GM-API-strategy.md for the work to bridge
// the rest into MAIN.) This is what makes `GM_info` available to
// every script regardless of world / grants, matching TM/VM.
function buildMainWorldGmInfoOnly(
  script: StoredScript,
  scriptHandlerVersion: string,
): GmBindingEmit {
  if (!script.header) return { js: '', prelude: '', granted: [], needsValues: false };
  return emitGmBindings([], buildGmInfoInput(script, scriptHandlerVersion, []));
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
  const world = resolveWorld(script.header);
  const gmEmit = world === 'USER_SCRIPT'
    ? await buildGmBindingsForScript(script, scriptHandlerVersion)
    : buildMainWorldGmInfoOnly(script, scriptHandlerVersion);
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
// What's NOT prepended: the gm `prelude` (storage.init etc.). It
// references `__smE` / `__smDecision`, which the swap-eval scope
// doesn't have. Storage-granting scripts (`needsValues: true`) are
// excluded from run-new upstream in `handleCheckPending` for the
// same reason.
//
// Line layout matches `wrapCombinedEntry` exactly: preamble on
// generated line 0, user source from `USER_SOURCE_START_LINE`. That
// costs a leading blank line when there are no bindings to prepend,
// and buys a single answer to "which file is generated line N?" for
// both run paths — the viewer's Log tab maps stack refs without
// knowing whether the script was registered or hot-swapped. See
// src/composed-source.ts.
export async function buildSwapEvalBody(
  script: StoredScript,
  scriptHandlerVersion: string,
  logLabel: string = scriptBasename(script.relativePath),
): Promise<string> {
  const world = resolveWorld(script.header);
  const gmEmit = world === 'USER_SCRIPT'
    ? await buildGmBindingsForScript(script, scriptHandlerVersion)
    : buildMainWorldGmInfoOnly(script, scriptHandlerVersion);
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
    return head + composeRequiredBody(script);
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
  return head + '\n' + composed.text + '\n' + inlineSourceMapComment(map);
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
  const name = scriptDisplayName(script);
  const needsWrapperFilter = hasRegexInclude || hasRegexExclude;
  const sourceUrl = buildSourceUrl(logLabel);

  const world = resolveWorld(script.header);
  // GM_info is implicit in TM/VM — available in every world, with or
  // without an `@grant` line. We mirror that. The rest of the GM_*
  // surface only makes sense in USER_SCRIPT world today (the
  // `window.__SM_GM__` runtime is registered there): a script that
  // mixes `@grant something` with `@inject-into page` lands in MAIN
  // and gets only GM_info — its other GM_* calls produce a natural
  // ReferenceError. This is a documented limitation (see
  // docs/GM-API-strategy.md).
  const gmEmit = world === 'USER_SCRIPT'
    ? await buildGmBindingsForScript(script, scriptHandlerVersion)
    : buildMainWorldGmInfoOnly(script, scriptHandlerVersion);

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
export async function collectActiveSpecs(
  scripts: StoredScript[],
  collections: Map<string, StoredCollection>,
  scriptHandlerVersion: string = '0.0.0',
): Promise<RegistrationSpec[]> {
  // Dedup-aware log labels are computed against ALL stored scripts
  // (not just the active subset) so two scripts sharing a basename
  // get the same `#N` suffixes everywhere — the SW's getScriptLogLabel
  // cache, the options UI, and these URLs all agree.
  const logIds = computeLogIds(scripts.map((s): LogIdInput => ({
    id: s.id, relativePath: s.relativePath,
  })));
  const promises: Array<Promise<RegistrationSpec | null>> = [];
  for (const s of scripts) {
    if (!isRegistrationCandidate(s, collections)) continue;
    const label = logIds.get(s.id) ?? scriptBasename(s.relativePath);
    promises.push(buildRegistrationSpec(s, scriptHandlerVersion, label));
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
  const hasMainWorld = activeSpecs.some((s) => s.world === 'MAIN');
  if (!hasMainWorld) return null;
  return {
    id: BRIDGE_SCRIPT_ID,
    matches: ['<all_urls>'],
    js: [{ code: WRAPPER_BRIDGE + `\n//# sourceURL=${BRIDGE_SOURCE_URL}\n` }],
    runAt: 'document_start',
    world: 'USER_SCRIPT',
  };
}


// Pure: build the registration spec for the USER_SCRIPT-world GM_*
// shared runtime, or return null when no USER_SCRIPT-world script is
// active. See the original module-level comment in src/wrapper-gm-runtime.js
// for the runtime's design.
export function buildGmRuntimeSpec(activeSpecs: RegistrationSpec[]): RegistrationSpec | null {
  const hasUserScriptWorld = activeSpecs.some((s) => s.world === 'USER_SCRIPT');
  if (!hasUserScriptWorld) return null;
  return {
    id: GM_RUNTIME_SCRIPT_ID,
    matches: ['<all_urls>'],
    js: [{ code: WRAPPER_GM_RUNTIME + `\n//# sourceURL=${GM_RUNTIME_SOURCE_URL}\n` }],
    runAt: 'document_start',
    world: 'USER_SCRIPT',
  };
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
  const all = await chrome.storage.local.get(null);
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

// ---------- Serializing registration work ----------
//
// `chrome.userScripts` is a single mutable set, and every path that
// changes it does so with a read-modify-write — `getScripts()`, then
// `unregister`, then `register` — that Chrome does not make atomic. Two
// of those interleaving is what produces
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

// Drop every registration Chrome currently holds. Caller must already
// hold the registration lock.
//
// Chrome fails the WHOLE `unregister` call when any single id in the
// list is unknown, and an id can go missing between our `getScripts`
// and this call — an extension page runs the retry path in its own
// context, where our lock doesn't reach. So the batch failing is not
// evidence that the other ids are gone; it usually means one of them
// already was.
//
// Neither of the obvious answers is safe on its own:
//
//   - Aborting the sync leaves the whole script set unregistered.
//   - Swallowing the failure leaves every registration in place. The
//     ones we're about to re-register are replaced anyway, but a script
//     that was disabled, deleted, or flipped to INVALID is not in the
//     new spec list — nothing would replace it, and it would keep
//     injecting until some later sync's batch happened to succeed.
//
// So fall back to unregistering one id at a time, where an id that has
// already gone takes only itself down.
async function unregisterAll(): Promise<void> {
  const existing = await chrome.userScripts.getScripts();
  if (existing.length === 0) return;
  const ids = existing.map((e) => e.id);
  try {
    await chrome.userScripts.unregister({ ids });
    return;
  } catch (err) {
    // console.info, like the other contained failures in this module:
    // rare, worth seeing in the SW console, and not something the user
    // can act on or that any one script is to blame for.
    console.info(
      '[SourceMonkey] unregister-all failed as a batch; dropping ids one at a time:',
      describeError(err),
    );
  }
  for (const id of ids) {
    try {
      await chrome.userScripts.unregister({ ids: [id] });
    } catch { /* already gone, which is what made the batch fail */ }
  }
}

// Same, for callers outside this module — today only the test surface's
// `resetAllState`, which wants a deterministic teardown instead of
// waiting for the storage-change sync. Exported so that teardown is
// ordered against any sync already in flight rather than racing it.
export async function unregisterAllRegistrations(): Promise<void> {
  if (!isUserScriptsAvailable()) return;
  await withRegistrationLock(unregisterAll);
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
    if (row.status === 'ok') continue;   // re-checked and fine, nothing to say
    console.info(
      `[SourceMonkey] not registering ${row.relativePath}: ${row.errorMessage ?? 'it does not parse'}`,
    );
  }
  return scripts.map((s) => changed.get(s.id) ?? s);
}

// Wipe Chrome's current registration set and replace it with `specs`.
// Cheap full resync — simpler than a diff and fine at the script counts
// we expect.
//
// Serialized against every other registration operation in this
// context, and collapsed with any sync that is queued but hasn't begun
// — see the lock above for what the overlap used to cost.
export function syncRegistrations(): Promise<void> {
  if (pendingSync) return pendingSync;
  const sync = withRegistrationLock(async () => {
    // We're starting: a caller arriving from here on needs its own sync,
    // because our storage read is about to happen without whatever they
    // just wrote.
    pendingSync = null;
    await runSync();
  });
  pendingSync = sync;
  return sync;
}

async function runSync(): Promise<void> {
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
    return;
  }
  // The sweep nobody clicked: any single script row changing triggers a
  // full unregister-all + register-all across EVERY script, each spec
  // rebuilt from scratch. It runs on a debounce after the write, so it
  // lands just after a Refresh button releases rather than inside it —
  // which makes it easy to blame the refresh for time spent here.
  const timer = startPhaseTimer('registration sync');
  try {
    await ensureWorldConfigured();
    const { scripts, collections } = await readAll();
    timer.mark('read');
    const handlerVersion = chrome.runtime.getManifest().version;
    const effective = await revalidateCandidates(scripts, collections);
    const userSpecs = await collectActiveSpecs(effective, collections, handlerVersion);
    // Covers the revalidation too — it is per-script work on the same
    // critical path, and splitting it out would imply the two can be
    // acted on separately when the sync always does both.
    timer.mark('build-specs');
    const bridge = buildBridgeSpec(userSpecs);
    const gmRuntime = buildGmRuntimeSpec(userSpecs);
    // GM runtime first so it installs window.__SM_GM__ ahead of any
    // USER_SCRIPT-world wrapper that compiles in GM_* bindings.
    // Bridge next so MAIN wrappers' postMessages have a listener.
    // Then the user scripts. (Cross-registration ordering isn't
    // guaranteed by the userScripts API, but in practice Chrome
    // runs registrations in order. We rely on this for the bridge:
    // a MAIN-world wrapper's postMessage queues to the message task
    // queue, so the bridge's listener — installed during its IIFE
    // at document_start — is in place by the time delivery
    // happens. For GM_*: the per-script bindings emitted by
    // gm-bindings.ts only dereference `window.__SM_GM__` from inside
    // their function bodies, which means the lookup is deferred to
    // the user's first GM_* call; that fires no earlier than the
    // prelude's awaitDecision + run-at gate resolves, by which time
    // the runtime spec has had a microtask or more to install.)
    const specs: RegistrationSpec[] = [];
    if (gmRuntime) specs.push(gmRuntime);
    if (bridge) specs.push(bridge);
    specs.push(...userSpecs);
    await unregisterAll();
    timer.mark('unregister');
    const registered = await registerWithFallback(specs);
    timer.mark('register');
    timer.note(`${specs.length} specs, ${scripts.length} stored scripts`);
    timer.done();
    const failed = specs.length - registered;
    if (failed > 0) {
      console.info(
        `[SourceMonkey] registered ${registered}/${specs.length} userscript(s); ${failed} rejected by chrome.userScripts (see per-script errors)`,
      );
    } else {
      console.log(`[SourceMonkey] registered ${registered} userscript(s) with chrome.userScripts`);
    }
  } catch (err) {
    console.info('[SourceMonkey] userScripts sync failed:', describeError(err));
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
// Deliberately NOT `syncRegistrations()`. That wipes and re-registers
// everything, which (a) is far too heavy to run per navigation and (b)
// would briefly deregister healthy scripts while a page is committing,
// so an unrelated script could miss its injection. A rejected script is
// by definition not registered, so re-offering just its own spec is
// both cheaper and safe for everything else.
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

// Register one spec, replacing whatever registration is already
// holding its id.
//
// Chrome answers a `register` for an id it already knows with
// "Duplicate script ID '<id>'" rather than replacing it, and there are
// two ordinary ways it already knows one of ours:
//
//   - **Another context placed it.** The collections page and the viewer
//     run `retryRejectedRegistrations` in their own JS context, so the
//     lock in this module — which is per-context — cannot order a
//     page-side retry against the SW's sync. A retry that lands between
//     the sync's unregister-all and its register-all leaves the sync
//     offering an id that now exists.
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
// Register first, and only on a refusal try to drop the id and place
// it again. The obvious arrangement — unregister, then register —
// costs a guaranteed-to-fail unregister on every spec (by the time a
// sync reaches its per-spec fallback the set is already empty), and
// turns any register failure into a script that WAS running and now
// isn't.
//
// A refusal isn't necessarily a duplicate: a spec Chrome rejects
// outright (a malformed `@match` port, say) lands in the same place.
// Which one it is gets answered by trying the unregister rather than by
// reading Chrome's wording for the refusal — a string match there would
// break the moment Chrome rephrases, and Chrome's own error is the one
// thing here we pass through to the user verbatim. Nothing to drop
// means nothing was holding the id, so the spec itself is the problem
// and its original reason is what the caller should report.
//
// Shared by the retry path and the sync's per-spec fallback so the two
// can't drift on this.
async function registerReplacing(spec: RegistrationSpec): Promise<void> {
  let refusal: unknown;
  try {
    await chrome.userScripts.register([spec]);
    return;
  } catch (err) {
    refusal = err;
  }
  try {
    await chrome.userScripts.unregister({ ids: [spec.id] });
  } catch {
    throw refusal;
  }
  dlog(`[SourceMonkey] script ${spec.id} was already registered; replacing it`);
  await chrome.userScripts.register([spec]);
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
  const specs = (await collectActiveSpecs(scripts, collections, handlerVersion))
    .filter((s) => wanted.has(s.id));
  const placed: string[] = [];
  const refused = new Map<string, string>();
  for (const spec of specs) {
    try {
      await registerReplacing(spec);
      placed.push(spec.id);
      dlog(`[SourceMonkey] script ${spec.id} registered on retry`);
    } catch (err) {
      const msg = describeError(err);
      refused.set(spec.id, msg);
      logRejection(spec.id, msg);
    }
  }
  // Re-read rather than mutating the snapshot this attempt started
  // from, and touch only the ids we handled. A full syncRegistrations
  // that landed while we were registering owns every other entry; a
  // whole-snapshot write-back would resurrect the ones it just cleared.
  const prior = await readRejections();
  const next = { ...prior };
  for (const id of placed) delete next[id];
  for (const [id, msg] of refused) next[id] = msg;
  // A script that is rejected but no longer eligible (disabled or gone
  // since the map was written) produces no spec here; drop it so its
  // row stops reading REJECTED.
  for (const id of ids) if (!specs.some((s) => s.id === id)) delete next[id];
  await writeRejections(prior, next);
  logRecoveries(placed.filter((id) => prior[id] !== undefined));
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
// Info level, like every other recovery row. Note this does NOT pull
// the row's badge back to OK on its own: `loglevel:` is monotonic
// within a session, so the earlier error rows keep it at ERROR until
// the log is cleared. That limitation is shared with every other
// recovered failure and is tracked in TODO.md.
function logRecoveries(scriptIds: readonly string[]): void {
  for (const id of scriptIds) {
    logScriptEvent(id, {
      level: 'info',
      source: 'chrome-injector',
      message: 'Chrome accepted this script\'s registration — it runs again',
    });
  }
}

// Register a list of specs, falling back from batch to per-script on a
// batch failure so one malformed pattern doesn't take everything down.
// Returns the count of specs that actually registered. Per-spec failure
// reasons go into the session-storage rejection map, which is what the
// UI renders as REJECTED — see script-rejection.ts.
//
// `specs` is the complete set the current sync wants registered, so the
// rejection map is rewritten wholesale: a script that has since been
// disabled, deleted, or flipped to INVALID drops out of the map instead
// of leaving a stale REJECTED badge on a row nobody tried to register.
//
// Caller must hold the registration lock (`syncRegistrations` does).
//
// Exported for unit tests — reaching it through `syncRegistrations`
// would mean stubbing the whole store + userScripts surface.
export async function registerWithFallback(specs: RegistrationSpec[]): Promise<number> {
  const prior = await readRejections();
  if (specs.length === 0) {
    await writeRejections(prior, {});
    return 0;
  }
  try {
    await chrome.userScripts.register(specs);
    // The whole batch registered, so nothing here is rejected any more.
    // This is the path a previously-broken script recovers through —
    // the usual one, in fact: fixing the file changes its content, which
    // triggers a sync. Without it, a script that breaks, is fixed, and
    // breaks again the same way would never log the second failure.
    await writeRejections(prior, {});
    logRecoveries(specs.filter((s) => prior[s.id] !== undefined).map((s) => s.id));
    return specs.length;
  } catch {
    // Batch rejected — at least one spec is bad. Find the good ones.
  }
  const next: RejectionMap = {};
  const placed: string[] = [];
  let ok = 0;
  for (const spec of specs) {
    try {
      // Replacing, not plain register: the batch may have failed
      // because some id is already placed, and re-offering it as-is
      // would report a script that runs fine as REJECTED. See
      // `registerReplacing`.
      await registerReplacing(spec);
      ok++;
      placed.push(spec.id);
    } catch (err) {
      const msg = describeError(err);
      console.info(`[SourceMonkey] script ${spec.id} rejected: ${msg}`);
      // Our own bridge / GM-runtime specs get the console line above and
      // nothing else. They are not scripts: no row can render REJECTED
      // for them, no Log tab exists to read the entry, and
      // `retryRejectedRegistrations` could never clear the map entry
      // because `collectActiveSpecs` never produces their ids. A failure
      // here is ours to fix, not something to file against a script.
      if (!isUserScriptId(spec.id)) continue;
      next[spec.id] = msg;
      // A rejected registration means the script silently never runs.
      // Its status cell says so for as long as the rejection stands
      // (REJECTED, from the map we're building here); the Log is where
      // the reason gets a timestamp and a permanent home. See
      // `logRejection` for why every attempt gets a row.
      logRejection(spec.id, msg);
    }
  }
  await writeRejections(prior, next);
  logRecoveries(placed.filter((id) => prior[id] !== undefined));
  return ok;
}

// True for a stored script's registration id, false for the two
// reserved ids we register for our own plumbing.
function isUserScriptId(id: string): boolean {
  return id !== BRIDGE_SCRIPT_ID && id !== GM_RUNTIME_SCRIPT_ID;
}
