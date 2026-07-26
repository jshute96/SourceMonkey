// Userscript injection via the chrome.userScripts API.
//
// Chrome owns the actual matching + injection at navigation time. Our
// job is to keep its registration set in sync with our "effectively
// enabled ok scripts" view of the world. Whenever the script-store
// cache changes we re-sync (cheap full wipe + re-register at our
// scale).
//
// ---------- Injection shape (separate-entries mode) ----------
//
// Each registered userscript ships with a js[] array of separate
// entries that share an execution world (USER_SCRIPT or MAIN). All
// entries run in the same realm; they communicate via globals on
// `self.__smPrelude.*`. The layout per script is:
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
//   js[2..N-1] — one {code} per @require, wrapped in a thin
//                `if(__smActive(id)){try{<body>}catch(e){__smErr(...)}}`
//                with a trailing `//# sourceURL=<require URL>`. Each
//                require shows up as its own file in devtools with
//                pristine line numbers — the prefix sits on physical
//                line 1 so the require body's line N stays at
//                physical line N (column offset on line 1 only).
//   js[N]  — main body {code} wrapped in
//                `self.__smRun(id,function(__smE){<gm bindings>...<body>})`
//                with the GM bindings + GM prelude minified onto the
//                opening line so the body's line N stays at physical
//                line N. Trailing `//# sourceURL=sourcemonkey://<id>/<name>.user.js`.
//                Runs only after the prelude's matcher + check-pending
//                + @run-at gates resolve.
//
// Why split: stack traces for the main body no longer carry a
// require-source offset, and each `@require` shows up in devtools
// as its own file with the original URL. See docs/injection-modes.md
// for the design tradeoffs and the two alternative modes (concat,
// eval-per-require) that the wrap helpers are structured to allow.
//
// Caveats kept consistent with the old design:
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
// is off, chrome.userScripts.register throws; we surface that via
// getLastError() so the sources page can prompt the user.

import {
  describeError,
  isScriptEnabled,
  isSourceEnabled,
  type StartupLog,
  type StoredScript,
  type StoredSource,
} from './script-store.js';
import { getValue, getValues, joinFullSource, type ParsedHeader } from './userscript-header.js';
import {
  WRAPPER_BRIDGE,
  WRAPPER_GM_RUNTIME,
  WRAPPER_PRELUDE,
} from './generated-wrappers.js';
import { resolveGrants } from './gm-api-catalog.js';
import { emitGmBindings, type GmBindingEmit, type GmInfoInput } from './gm-bindings.js';
import { filterForwardableNames, parseExportedNames } from './require-exports.js';
import {
  BRIDGE_SOURCE_URL,
  GM_RUNTIME_SOURCE_URL,
  PRELUDE_SOURCE_URL,
  buildConfigSourceUrl,
  buildRequireSourceUrl,
  buildSourceUrl,
} from './script-source-url.js';
import { computeLogIds, type LogIdInput } from './script-log-id.js';
import { scriptBasename, scriptDisplayName } from './script-display.js';

const SCRIPT_PREFIX = 'script:';
const SOURCE_PREFIX = 'source:';

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

// Concatenate every prefetched `@require` body, in declaration order,
// in front of the **full on-disk script source** (leadingText +
// headerText + bodyText). Used by the reload-fast-path swap eval —
// `handleCheckPending` in background.ts sends this as the run-new
// body so the swap eval can pick up newly-changed requires too.
//
// The default-run path does NOT call this — it injects each require
// as its own js[] entry with its own `//# sourceURL=` (see
// `wrapRequireEntry` and `buildRegistrationSpec`'s use of
// `joinFullSource` for the main body). The concatenated form here
// only exists for the swap-eval scenario, where the eval runs at
// the prelude's function scope and can't peek into per-script js[]
// entries the way Chrome's userScripts injector can.
//
// A `;\n` separator between segments breaks any ASI hazard at the
// seam. The leading `// @require <url>` per require makes the
// concatenated code easier to scan in devtools. Line comment (not
// block) so URLs with `*/` in their path don't prematurely close it.
export function composeRequiredBody(script: StoredScript): string {
  const mainSource = joinFullSource(
    script.leadingText ?? '',
    script.headerText ?? '',
    script.bodyText,
  );
  const requires = script.requires ?? [];
  if (requires.length === 0) return mainSource;
  const parts: string[] = [];
  for (const r of requires) {
    parts.push(`// @require ${r.url}`);
    parts.push(r.source);
    parts.push(';');
  }
  parts.push(mainSource);
  return parts.join('\n');
}

// JSON-encode for embedding in a JS source context. Same `</script>`
// escape as in gm-bindings.ts — chrome.userScripts takes raw code so
// the escape is paranoid, but the cost is zero.
function jsLit(value: unknown): string {
  return JSON.stringify(value).replace(/<\/script>/gi, '<\\/script>');
}

// ---------- Mode-neutral wrap helpers ----------
//
// Each helper returns the wrapped source for ONE conceptual unit
// (config blob, one @require, main body). They are pure string
// functions and don't know how they'll be assembled. The default
// assembler places each as its own js[] entry (Mode B); alternative
// assemblers could concatenate (Mode A) or eval-wrap (Mode C). See
// docs/injection-modes.md.

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
  // Synthetic `sourcemonkey://` URLs for each @require — what the
  // prelude's async-error filter substring-matches against.
  requireUrls: readonly string[];
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
  if (cfg.startupLogs && cfg.startupLogs.length > 0) wire.startupLogs = cfg.startupLogs;
  if (cfg.requireUrls.length > 0) wire.requireUrls = cfg.requireUrls;
  // (Re)create the per-script require-scope object before any of this
  // script's require entries run. Per registration (incl. refresh) we
  // want a fresh empty object — the requires re-execute and re-fill
  // it. Lives on `self` (the realm global of whatever world we're
  // injected into); ID-keyed so two scripts in the same world don't
  // step on each other. See wrapRequireEntry / wrapMainBodyEntry for
  // the producer + consumer sides.
  const call =
    `(function(c){(self.__smReqScope=self.__smReqScope||{})[c.id]={};` +
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

// Wrap one @require body. Output shape:
//
//   if(self.__smActive("<id>")){try{<GM BINDINGS><BODY LINE 1>
//   <BODY LINE 2>
//   ...
//   ;Object.assign(self.__smReqScope["<id>"],{X,Y,Z});
//   }catch(__smE){self.__smErr("<id>",__smE);}}
//   //# sourceURL=<synthetic sourcemonkey:// URL>
//
// Line preservation: the `if(...)` prefix, the inline GM bindings,
// and the body's first line all share physical line 1; subsequent
// body lines stay at their original numbers. Column offset on line
// 1 only. The trailing `//# sourceURL=` is on its own line at the
// bottom — JS engines honor it for the entire entry (each js[]
// entry is its own "script").
//
// `exportedNames` is the list of identifiers the require declared at
// its own top level (`const`/`let`/`class`) that the main body needs
// to see. Each `js[]` entry is its own V8 script, so those bindings
// don't cross the boundary — we lift them by writing them into a
// per-script `self.__smReqScope[<id>]` object that the main body's
// wrap destructures back out. See docs/requires.md for the protocol
// and src/require-exports.ts for how the names are sourced (from a
// `/* exported X, Y */` JSHint directive in the require body). When
// the list is empty the tail is byte-identical to the pre-feature
// shape — no perf or layout impact on requires that don't need it.
//
// `sourceUrl` is the synthetic `sourcemonkey://SourceMonkey/<folder>/...`
// URL the caller computed via `buildRequireSourceUrl`. We don't ship
// the require's real fetch URL because (a) we're not actually
// re-fetching at runtime (the bytes live in storage), and (b) the
// synthetic URL clusters the require with its owning script in
// devtools instead of scattering it under cdn.example.com.
//
// `gmBindings` is the SAME single-line `const GM_* = ...` block the
// main body gets (from `buildGmBindingsForScript` / `emitGmBindings`).
// Each js[] entry is its own V8 script with its own lexical scope, so
// we have to declare the bindings in every entry that wants them —
// the main body's `const`s are NOT visible here. TM/VM concatenate
// everything into one IIFE and so don't need to repeat. The cost can
// be non-trivial — the block bakes in the full GM_info JSON literal
// (`scriptMetaStr` plus matches/includes/excludes) and a const per
// granted API — so a script with a verbose header, many grants, and
// many requires ships tens of KB of duplicated prefix. Not visible
// to the user (minified onto physical line 1, body line N → physical
// line N) and within chrome.userScripts' limits in practice.
//
// We do NOT splice the gm `prelude` (storage.init etc.) into requires
// — that block reads `__smDecision` / `__smName` / `__smE`, which
// only exist inside the main-body wrap function (passed by
// `self.__smRun`). Require entries fire at document_start as part of
// Chrome's userScripts injection burst; the storage cache is
// initialized later, by the main-body wrap's `__SM_GM__.storage.init`
// call, before the body runs. So require *top-level* code that calls
// `GM_setValue` will see an uninitialized cache (rare in practice —
// requires are libraries that DEFINE functions for the main body to
// call later, and by then the cache is live).
export function wrapRequireEntry(args: {
  scriptId: string;
  source: string;
  sourceUrl: string;
  gmBindings?: string;
  exportedNames?: readonly string[];
}): string {
  const idLit = jsLit(args.scriptId);
  const head = `if(self.__smActive(${idLit})){try{${args.gmBindings ?? ''}`;
  // The forwarding statement goes AFTER the body, inside the try, on
  // its own line (leading `;` defeats any ASI hazard at the seam, in
  // case the body's last line doesn't terminate). Body line numbers
  // are unaffected — we only append.
  //
  // Splicing exportedNames verbatim into a `{X,Y,Z}` shorthand relies
  // on every name being a valid JS identifier AND not a reserved word
  // / wrap-emitted const. `parseExportedNames` + `filterForwardableNames`
  // in src/require-exports.ts enforce both; if either ever loosens, the
  // wrap shape is the thing that breaks.
  const exportStmt = args.exportedNames && args.exportedNames.length > 0
    ? `\n;Object.assign(self.__smReqScope[${idLit}],{${args.exportedNames.join(',')}});`
    : '';
  const tail = `${exportStmt}\n}catch(__smE){self.__smErr(${idLit},__smE);}}\n//# sourceURL=${args.sourceUrl}\n`;
  return head + args.source + tail;
}

// Wrap the main body. Output shape:
//
//   self.__smRun("<id>",function(__smE){<DECL PREAMBLE><GM BINDINGS><GM PRELUDE><REQ SCOPE><BODY LINE 1>
//   <BODY LINE 2>
//   ...
//   });
//   //# sourceURL=<main url>
//
// __smE is the per-script entry the prelude passes in. The DECL
// PREAMBLE pulls __smDecision / __smName / __smId / __smLoadedAt /
// __smSend out of it so the GM bindings + GM prelude (generated by
// gm-bindings.ts, which references those identifiers) work unchanged.
// REQ SCOPE destructures any cross-entry names from `@require`s'
// `/* exported */` lists out of `self.__smReqScope[<id>]` — see
// `wrapRequireEntry` for the other half of the protocol and
// docs/requires.md for the design.
// All of the preamble + bindings + prelude + req scope is minified
// onto the opening line so body line N → physical line N.
export function wrapMainBodyEntry(args: {
  scriptId: string;
  sourceUrl: string;
  body: string;
  gmBindings: string;
  gmPrelude: string;
  requireExports?: readonly string[];
}): string {
  const idLit = jsLit(args.scriptId);
  // Declaration preamble — pulls per-script values out of the entry
  // the prelude passes in. The names match what gm-bindings.ts's
  // prelude expects (`__smDecision`, `__smName`, `__smId`,
  // `__smLoadedAt`, `__smSend`) so we don't have to rewrite that
  // module for the new wrapper shape.
  const declPreamble =
    `var __smDecision=__smE.decision;` +
    `var __smName=__smE.cfg.name;` +
    `var __smId=__smE.cfg.id;` +
    `var __smLoadedAt=__smE.cfg.loadedAt;` +
    `var __smSend=self.__smPrelude.send;`;
  // Require-scope destructure — empty when no require exported
  // anything, so a script without /* exported */ requires emits the
  // pre-feature byte sequence. Stays on the same physical line as
  // declPreamble + gmBindings + gmPrelude.
  const reqScope = args.requireExports && args.requireExports.length > 0
    ? `var{${args.requireExports.join(',')}}=self.__smReqScope[${idLit}];`
    : '';
  // gmBindings and gmPrelude are already single-line strings (or
  // empty). Concatenate without newlines so the body's line N lands
  // at physical line N.
  const head = `self.__smRun(${idLit},function(__smE){${declPreamble}${args.gmBindings}${args.gmPrelude}${reqScope}`;
  const tail = `\n});\n//# sourceURL=${args.sourceUrl}\n`;
  return head + args.body + tail;
}

// Assembler: Mode B (separate entries). Default and only implemented
// mode today. See docs/injection-modes.md for the design of Modes A
// (concatenated single blob) and C (eval-per-require) — the wrap
// helpers above are structured so either could be slotted in by
// writing a different assembler.
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
function assembleSeparateEntries(parts: {
  configBlob: string;
  preludeCode: string;
  requireEntries: Array<{ code: string; url: string }>;
  mainCode: string;
}): RegistrationSpec['js'] {
  const js: Array<{ code: string }> = [];
  js.push({ code: parts.configBlob });
  js.push({ code: parts.preludeCode });
  for (const r of parts.requireEntries) js.push({ code: r.code });
  js.push({ code: parts.mainCode });
  return js;
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

// Build the body string for the reload-fast-path swap eval. Prepends
// the script's GM bindings to `composeRequiredBody(script)` so the
// indirect eval — which runs at runMain's function scope, NOT inside
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
export async function buildSwapEvalBody(
  script: StoredScript,
  scriptHandlerVersion: string,
): Promise<string> {
  const world = resolveWorld(script.header);
  const gmEmit = world === 'USER_SCRIPT'
    ? await buildGmBindingsForScript(script, scriptHandlerVersion)
    : buildMainWorldGmInfoOnly(script, scriptHandlerVersion);
  const composed = composeRequiredBody(script);
  // gmEmit.js is single-line and ends with a space; safe to prepend
  // directly. Add a newline so the composed body's own line numbers
  // line up the same way they would in a fresh registration's main
  // body entry (binding prefix on line 1, body content from line 2).
  if (!gmEmit.js) return composed;
  return gmEmit.js + '\n' + composed;
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
    requireUrls: requireSourceUrls,
  });

  // One {code} per @require (entries 2..N-1). Each gets the same
  // single-line GM-binding prefix the main body gets so library code
  // sees `GM_info` / `GM_setValue` / etc. — the polyfill-style
  // helper requires (e.g. greasemonkey-polyfill) need this to load
  // without ReferenceErrors.
  //
  // Per-require exported names come from a `/* exported X, Y */`
  // JSHint directive in the require source. Each entry forwards its
  // own list onto `self.__smReqScope[<id>]`; the union (last-write-
  // wins on collision) gets destructured back out at the top of the
  // main body. See src/require-exports.ts + docs/requires.md.
  const requireExportLists: string[][] = requires.map(
    (r) => filterForwardableNames(parseExportedNames(r.source)),
  );
  const requireExportsUnion: string[] = [];
  const seenExport = new Set<string>();
  for (const list of requireExportLists) {
    for (const name of list) {
      if (seenExport.has(name)) continue;
      seenExport.add(name);
      requireExportsUnion.push(name);
    }
  }
  const requireEntries = requires.map((r, i) => ({
    code: wrapRequireEntry({
      scriptId: script.id,
      source: r.source,
      sourceUrl: requireSourceUrls[i],
      gmBindings: gmEmit.js,
      exportedNames: requireExportLists[i],
    }),
    url: r.url,
  }));

  // Main body (entry N). Inject the FULL on-disk source (leadingText
  // + headerText + bodyText) — not just bodyText — so the line
  // numbers V8 reports in stack traces line up with the original
  // file. The header block is comment-only JS and parses as inert
  // noise; same trick `composeRequiredBody` uses for the swap path.
  const mainSource = joinFullSource(
    script.leadingText ?? '',
    script.headerText ?? '',
    script.bodyText,
  );
  const mainCode = wrapMainBodyEntry({
    scriptId: script.id,
    sourceUrl,
    body: mainSource,
    gmBindings: gmEmit.js,
    gmPrelude: gmEmit.prelude,
    requireExports: requireExportsUnion,
  });

  // Register at document_start regardless of the declared @run-at. The
  // prelude itself awaits the matching lifecycle event (DOMContentLoaded
  // for document-end, load for document-idle, etc.) before invoking
  // the user body. See docs/injection.md.
  const spec: RegistrationSpec = {
    id: script.id,
    js: assembleSeparateEntries({
      configBlob: cfgBlob,
      preludeCode: wrapPreludeEntry(),
      requireEntries,
      mainCode,
    }),
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
// awaiting sequentially.
export async function collectActiveSpecs(
  scripts: StoredScript[],
  sources: Map<string, StoredSource>,
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
    if (s.status !== 'ok' && s.status !== 'missing') continue;
    if (!isScriptEnabled(s)) continue;
    const src = sources.get(s.sourceId);
    if (!src || !isSourceEnabled(src)) continue;
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

// Wipe Chrome's current registration set and replace it with `specs`.
// Cheap full resync — simpler than a diff and fine at the script counts
// we expect.
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
