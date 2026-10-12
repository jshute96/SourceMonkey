// Userscript injection via the chrome.userScripts API.
//
// Chrome owns the actual matching + injection at navigation time. Our
// job is to keep its registration set in sync with our "effectively
// enabled ok scripts" view of the world. Whenever the script-store
// cache changes we re-sync just the rows that moved, updating their
// registrations in place; a full rebuild happens only when this worker
// has no record of what it last registered: at startup, when it can't
// take the last worker's record from session storage.
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
//            `self.__smRun(id,function(__smE){<gm bindings>…
//            return(()=>{<source>\n})();})` (the source in a
//            nested scope; see USER_SCOPE_OPEN), so it runs only after
//            the prelude's matcher +
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
//     prelude's send() falls back to a DOM event which
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

import { fromStorage, MISSING_BLOB_MESSAGE, type ScriptRow } from './script-blobs.js';
import {
  describeError,
  ensureCollectionKeysMigrated,
  isScriptEnabled,
  isCollectionEnabled,
  recordMissingBlobs,
  verifyParseChecks,
  withoutAnnotations,
  type ScriptMeta,
  type StartupLog,
  type StoredScript,
  type StoredCollection,
} from './script-store.js';
import { CONTEXT_MENU_RUN_AT, SUPPORTED_RUN_AT, getValue, getValues, hasTag, type ParsedHeader } from '../userscript-header.js';
import { isManualScript } from '../script-build.js';
import {
  WRAPPER_BRIDGE,
  WRAPPER_GM_RUNTIME,
  WRAPPER_PRELUDE,
} from '../generated-wrappers.js';
import { grantedSubsystems, resolveGrants } from '../gm-api-catalog.js';
import { resolveScriptWorld, runsSandboxed, type InjectionWorld } from '../script-world.js';
import { scanStorageRows } from './storage-scan.js';
import { cachedRows, sharedRows } from './row-cache.js';
import { isScratchUrl, scratchRunOf } from './directories.js';
import { evalHookKey, withEvalHook } from '../eval-hook.js';
import { canonicalMatchPatterns, hostEndsInTld, matchPatternProblem, tldCoarseGlob } from '../url-match.js';
import { dlog } from '../debug-log.js';
import { startPhaseTimer, type PhaseTimer } from '../phase-timing.js';
import {
  emitGmBindings, GM_INFO_PASSTHROUGH_TAGS, windowMethodBinding,
  type GmBindingEmit, type GmInfoInput, type GmInfoPassthroughTag, type UserAgentDataSnapshot,
} from './gm-bindings.js';
import { iconRefFromHeader } from '../script-icon.js';
import {
  buildSourceMap,
  inlineSourceMapComment,
} from '../source-map.js';
import {
  USER_SOURCE_START_LINE,
  composeRequiredBody,
  composeSource,
} from '../composed-source.js';
import {
  BRIDGE_SOURCE_URL,
  GM_RUNTIME_SOURCE_URL,
  PRELUDE_SOURCE_URL,
  buildConfigSourceUrl,
  buildRequireSourceUrl,
  buildSealSourceUrl,
  buildSourceUrl,
} from '../script-source-url.js';
import { computeLogIds, type LogIdInput } from './script-log-id.js';
import { numberMap, numbersFrom, readScriptNumbers, SCRIPT_NUMBERS_KEY } from './sticky-numbers.js';
import { scriptBasename, scriptDisplayName } from '../script-display.js';
import { logScriptEvent } from './script-log.js';
import { assertWorkerContext } from '../run-context.js';
import {
  describeRejection,
  readRejections,
  writeRejections,
  type RejectionMap,
} from './script-rejection.js';

const SCRIPT_PREFIX = 'script:';
const COLLECTION_PREFIX = 'collection:';

// Reserved registration ids. Chrome's userScripts API rejects ids
// that start with `_`, so we use a `sourcemonkey-` prefix; stored
// script ids are UUIDs and won't collide.
export const BRIDGE_SCRIPT_ID = 'sourcemonkey-bridge';

// Reserved registration id for the USER_SCRIPT-world GM_* shared
// runtime. Registered at document_start so its `window.__SM_GM__`
// global is in place before any userscript wrapper runs.
export const GM_RUNTIME_SCRIPT_ID = 'sourcemonkey-gm-runtime';

// MAIN-world flavor of the same runtime source. Needed whenever an
// active MAIN-world script grants a runtime-backed API, which is most
// granted scripts: MAIN is the default world. Its SW traffic rides
// `wrapper-bridge.js`.
export const GM_RUNTIME_MAIN_SCRIPT_ID = 'sourcemonkey-gm-runtime-main';

// Added to `matches` whenever a spec has `includeGlobs`. Two jobs:
//   - Chrome requires `matches`, and ORs it with `includeGlobs`, so a
//     script whose patterns are all globs needs a stand-in that no
//     real page's path has.
//   - Its host is `*` on purpose. Chrome kills the renderer ("Page
//     crashed") when `chrome.tabs.sendMessage` reaches a USER_SCRIPT-
//     world listener (the bridge, the GM runtime) in a page the spec
//     covers only through `includeGlobs`, on a host none of its
//     `matches` names. A `*` host keeps every page's host covered.
//     Measured; see tests/e2e/include-only.spec.ts.
// The wrapper's in-page matcher still runs for such a script, so even a
// page that did have this path wouldn't run it.
export const NO_PAGE_MATCH = '*://*/__sourcemonkey_no_page__/*';

export type RegistrationSpec = chrome.userScripts.RegisteredUserScript;

// The patterns one script is registered on, for the scripts whose world
// needs the shared `__SM_GM__` runtime. The runtime's own registration
// takes the union — see `buildGmRuntimeSpecs`.
export interface GmRuntimePatterns {
  matches: string[];
  includeGlobs: string[];
}

// The union of those patterns for one world. Also the bridge's scope:
// the union of every MAIN-world script's patterns, whatever it grants.
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
//
// Anything else (a typo) runs at `document-idle`; `extractStartupLogs`
// warns about it. `context-menu` passes through: a manual run's config
// carries it, and the prelude then runs the body at once.
export function normalizeDeclaredRunAt(value: string | undefined): string {
  const v = (value ?? '').trim().toLowerCase();
  if (v === CONTEXT_MENU_RUN_AT) return v;
  return SUPPORTED_RUN_AT.includes(v) ? v : 'document-idle';
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
  // Log label used by the URL builders — derives the
  // script's folder name in devtools. Not consumed by the prelude
  // itself (only the URL builders here read it).
  logLabel: string;
  name: string;
  sourceUrl: string;
  loadedAt: number;
  runAt: string;
  needsGmValues: boolean;
  // The sm-dev run a scratch script belongs to (`scratchRunOf`). Its
  // wrapper waits for the SW's check-pending answer unless the tab
  // vouches for that run (`smDevVouches` in userscript-prelude.js).
  run?: string;
  matching: { matches: string[]; includes: string[]; excludes: string[] } | null;
  startupLogs: ReadonlyArray<StartupLog>;
  // See `RegistrationSpecOptions.manualRun`.
  manualRun?: { gmValues?: Record<string, unknown> };
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
  if (cfg.run !== undefined) wire.run = cfg.run;
  if (cfg.manualRun) wire.manualRun = cfg.manualRun;
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

// The nested scope the user program (requires + body) runs in, inside
// the scope holding our own declarations: the `__sm*` preamble, the GM
// bindings (`const GM_info`, granted `GM_*`, `const unsafeWindow =
// window;`) and the GM prelude. Without it those shared ONE scope with
// the user program, and real scripts broke:
//
//   - `const window = unsafeWindow;` put our `const unsafeWindow =
//     window;` in the temporal dead zone (TDZ: a `let`/`const` read
//     before its declaration runs) of the script's `window`, a
//     ReferenceError that killed the script (GreasyFork 531756).
//   - `const unsafeWindow = …`, `let GM_info`, a `var GM_setValue`
//     polyfill or an own `function GM_addStyle` were duplicate-
//     declaration SyntaxErrors, so the script never ran. All of these
//     work under TM and VM, whose GM names live in an outer scope too.
//
// A granted page-world script's user program runs in a `with` over its
// sandbox `window` instead; see `SANDBOX_SCOPE_OPEN` below.
//
// Why an arrow FUNCTION, not a block:
//
//   - A block only scopes `let`/`const`/`class`. A `var` or a sloppy-
//     mode function declaration still lands in the enclosing function
//     scope and clashes with our `const`s there.
//   - An arrow keeps the wrap function's `this` and `arguments`, so
//     top-level `this` is unchanged. A `function` would need
//     `.call(this)`, a lookup a page can tamper with in MAIN world.
//   - Top-level `return` still works (it returns from the arrow), and
//     top-level `await` stays a SyntaxError, as it was.
//
// The user program is the arrow's first statement, so a leading
// `"use strict"` is a real directive and applies to the whole program,
// as in Tampermonkey and Violentmonkey (tests/examples/use-strict).
// Like theirs, it's the first file's: a first `@require` that starts
// with one makes the script strict too, and the script's own after a
// `@require` does nothing, even when that `@require` is empty (our `;`
// between files is then the first statement). (Before the nested scope it never applied:
// our own statements came first.)
//
// The opener goes on the head's line and the closer on the line that
// already holds the wrap's `});`, so no line moves: generated line
// numbers, the source map and the viewer's stack mapping are unchanged.
// The close starts with a newline so a body ending in a `//` comment
// can't swallow it.
//
// The registered wrap `return`s the arrow's result, so the wrap
// function still returns whatever a top-level `return` gave (the
// prelude ignores it; unit tests read it). The swap eval is global
// code, where `return` is illegal; its completion value is the arrow's
// result anyway.
const USER_SCOPE_OPEN = '(()=>{';
const USER_SCOPE_CLOSE = '\n})();';

// A sandboxed script's user scope (see `runsSandboxed`): the program
// runs inside `with (__smW)`, the scope over the prelude's sandbox
// `window` (`__smS`), and as a function called with the sandbox as
// `this`, as in Tampermonkey and Violentmonkey. See docs/injection.md,
// "The sandbox window".
//
//   - `with` is what makes a bare `$` find the copy a `@require` put on
//     `window` before the page's, and a bare `window` read as the
//     sandbox. The wrap and the swap eval are sloppy code, where `with`
//     is allowed; a `"use strict"` program inside the function is fine.
//   - A function rather than the arrow, so top-level `this` can be the
//     sandbox. `callAs` calls it through the prelude's captured
//     `Reflect.apply`, out of the way of a page that patched
//     `Function.prototype.call`.
//   - Top-level `arguments` is then the function's own (empty) list
//     rather than the wrap's.
//   - The `__sm*` names live outside the `with`, and the scope never
//     claims `__sm*` names, so they resolve to these.
//
// Same lines as the arrow form: the declaration and opener go on the
// head line, the closer on the wrap's last line.
const SANDBOX_SCOPE_OPEN = '__smC(function(){';
const SANDBOX_SCOPE_CLOSE = '\n},__smS);';

// What a sandbox `window` holds of its own: the script's bindings and
// its granted window-method replacements.
type SandboxOwn = Pick<GmBindingEmit, 'declared' | 'windowMethods'>;

// Declares the sandbox, holding the script's own bindings, ahead of
// the `with`.
function sandboxDeclaration(own: SandboxOwn): string {
  const exposed = own.declared.map((n) => `${n}:${n}`)
    .concat(own.windowMethods.map((m) => `${m}:${windowMethodBinding(m)}`))
    .join(',');
  return `const __smP=self.__smPrelude,__smS=__smP.sandbox({${exposed}}),__smW=__smP.scopeOf(__smS),__smC=__smP.callAs;`;
}

// The user scope's opener, after any `return`, and closer, for a script
// that is or isn't sandboxed. `declared` is what its bindings declare.
function userScope(own: SandboxOwn | null, withReturn: boolean): { open: string; close: string } {
  const ret = withReturn ? 'return' : '';
  if (!own) return { open: ret + USER_SCOPE_OPEN, close: USER_SCOPE_CLOSE };
  return {
    open: `${sandboxDeclaration(own)}with(__smW)${ret ? ret + ' ' : ''}${SANDBOX_SCOPE_OPEN}`,
    close: SANDBOX_SCOPE_CLOSE,
  };
}

// The eval hook key (src/eval-hook.ts) for a script in an sm-dev run's
// test collection (`scratch:///<run>/...`): its run's. None for any
// other script.
export function scratchEvalHookKey(fileUrl: string): string | undefined {
  const run = scratchRunOf(fileUrl);
  return run ? evalHookKey(run) : undefined;
}

// The composed user program with the eval hook under `key`, when there
// is one. `mainStart` is where the script's own source starts in it,
// after its requires: the IIFE the hook also goes into is looked for
// there, since a library's own wrapper isn't the script's scope.
function withScriptEvalHook(program: string, mainStart: number, scriptId: string, key: string | undefined): string {
  return key ? withEvalHook(program, key, scriptId, mainStart) : program;
}

// Wrap the whole user program — every `@require` plus the script's own
// body — as ONE js[] entry. Output shape:
//
//   self.__smRun("<id>",function(__smE){<DECL PREAMBLE><GM BINDINGS><GM PRELUDE>return(()=>{
//   // @require <url 1>
//   <require 1 line 1>
//   ...
//   ;
//   <main body line 1>
//   ...
//   })();});
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
// The user program runs in its own nested scope (`USER_SCOPE_OPEN` /
// `USER_SCOPE_CLOSE`), so its top-level declarations shadow ours rather
// than clashing. See the note on those constants.
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
  // sm-dev's eval hook (src/eval-hook.ts), under this key. None for the
  // person's own scripts.
  evalHookKey?: string;
  // What `gmBindings` declares for the sandbox, when the script runs
  // sandboxed (`runsSandboxed`); absent otherwise.
  sandboxed?: SandboxOwn;
}): string {
  const idLit = jsLit(args.scriptId);
  const hooked = (program: string, mainStart = 0): string => withScriptEvalHook(program, mainStart, args.scriptId, args.evalHookKey);
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
  const scope = userScope(args.sandboxed ?? null, true);
  const head = `self.__smRun(${idLit},function(__smE){${declPreamble}${args.gmBindings}${args.gmPrelude}${scope.open}`;

  if ((args.script.requires ?? []).length === 0) {
    // Nothing to concatenate, so nothing shifts and no map is needed.
    // No newline after `head`: the body's first line SHARES generated
    // line 0 with the wrap, which is what makes generated line N equal
    // original line N and lets the viewer pass refs through unmapped.
    // `buildSwapEvalBody` mirrors this exactly — see NO_REQUIRE_LAYOUT
    // in composed-source.ts.
    return head + hooked(composeRequiredBody(args.script)) + `${scope.close}});\n//# sourceURL=${args.sourceUrl}\n`;
  }

  // Head occupies generated line 0; user source starts below it.
  const composed = composeSource(args.script, {
    requireUrls: args.requireUrls,
    mainUrl: args.sourceUrl,
    startLine: USER_SOURCE_START_LINE,
  });
  const code = head + '\n' + hooked(composed.text, composed.mainStart) + `${scope.close}});\n`;
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
//     <folder-1>/                         (per-script — log label)
//       __config.js                       (per-script config blob)
//       <name>.user.js                    (per-script main body)
//       <host>/<path>                     (one subtree per @require)
//     <folder-2>/
//       ...
//
// Why `SourceMonkey` as the authority: devtools strips the URL
// scheme and uses the host as the first visible folder; without it
// our scripts would scatter at the top level of the Sources tree.
// Why the per-script folder is the log label (`foo.user.js#E4`) rather
// than the script's UUID: the UUID is a debug-grade hash that's useless
// when scanning the tree. See script-source-url.ts for the URL
// builders and the `#` → `%23` encoding for the suffix.
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
  // Headers TM copies onto `GM_info.script` by name. Absent → null.
  const passthrough = {} as Record<GmInfoPassthroughTag, string | null>;
  for (const tag of GM_INFO_PASSTHROUGH_TAGS) {
    passthrough[tag] = getValue(header, tag) ?? null;
  }
  // TM folds its aliases into the canonical key; do the same so
  // GM_info agrees with what the viewer shows for the icon.
  passthrough.homepage ??= firstValue(header, ['homepageURL', 'website', 'source']);
  passthrough.icon = iconRefFromHeader(header);
  passthrough.icon64 ??= getValue(header, 'icon64URL') ?? null;
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
    passthrough,
    // `.ref`, not `.url`: report the ref as written in the header, as
    // TM/VM do, rather than the resolved (possibly local file://) URL.
    // These are the *loaded* lists (deduped; and after a failed
    // refresh, the prior good set — same as the body they go with).
    requires: (script.requires ?? []).map((r) => r.ref),
    resourceList: (script.resources ?? []).map((r) => ({ name: r.name, url: r.ref })),
    connects: getValues(header, 'connect'),
    noframes: hasTag(header, 'noframes'),
    userAgentData: readUserAgentData(),
  };
}

function firstValue(header: ParsedHeader, tags: readonly string[]): string | null {
  for (const tag of tags) {
    const v = getValue(header, tag);
    if (v !== undefined) return v;
  }
  return null;
}

// Snapshot `navigator.userAgentData` once per SW lifetime. It
// describes the browser, not the page, so every script gets the same
// value. `null` where the API is missing (unit tests under Node).
let uaDataSnapshot: UserAgentDataSnapshot | null | undefined;

function readUserAgentData(): UserAgentDataSnapshot | null {
  if (uaDataSnapshot !== undefined) return uaDataSnapshot;
  const nav = (globalThis as { navigator?: { userAgentData?: UserAgentDataSnapshot } }).navigator;
  const data = nav?.userAgentData;
  uaDataSnapshot = data
    ? {
      brands: data.brands.map((b) => ({ brand: b.brand, version: b.version })),
      mobile: data.mobile,
      platform: data.platform,
    }
    : null;
  return uaDataSnapshot;
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
  if (!script.header) return { js: '', prelude: '', granted: [], needsValues: false, declared: [], windowMethods: [] };
  const grants = getValues(script.header, 'grant');
  const resolved = resolveGrants(grants);
  // `@grant none` and no-grants both fall through to emitGmBindings
  // with an empty set — emitGmBindings still emits GM_info (TM/VM
  // compat). `resolved.granted` is the set of real bindings (empty
  // for @grant none / no-grants); GM_info is implicit and not
  // reflected here.
  const grantedNames = resolved.hasNone ? [] : [...resolved.granted];
  // A body that names `unsafeWindow` with no grant for it gets the
  // binding anyway: without the `const` the reference is a
  // ReferenceError. TM and VM both expose the name ungranted, so this is
  // what a script written against either already expects.
  //
  // It joins the EMITTED set only. `GM_info.script.grant` keeps
  // reporting the `@grant` lines the file actually declares — a script
  // reading its own metadata must see its own metadata. And the name
  // buys nothing on the SW side: `unsafeWindow` has no subsystem the
  // bridge gate can be asked for (`grantedSubsystems` is header-derived
  // and unchanged), so this adds no capability, only a `window` alias.
  //
  // A `@require` that declares the name itself needs no special case:
  // the user program runs in a nested scope (see wrapCombinedEntry), so
  // the library's own `const unsafeWindow = …` shadows ours.
  const emittedNames = script.usesUnsafeWindow === true
    && !grantedNames.includes('unsafeWindow')
    ? [...grantedNames, 'unsafeWindow']
    : grantedNames;
  return emitGmBindings(emittedNames, buildGmInfoInput(script, scriptHandlerVersion, grantedNames), runsSandboxed(script));
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
// The composed source runs in the same nested scope as the registered
// entry (`USER_SCOPE_OPEN` / `USER_SCOPE_CLOSE`), so a body redeclaring
// a binding name shadows it here too. It also keeps the body's
// top-level `var`s and functions off the page's global object, which
// a bare indirect eval would otherwise create there.
//
// Line layout matches `wrapCombinedEntry` exactly: preamble on
// generated line 0, user source from `USER_SOURCE_START_LINE`. That
// costs a leading line holding only the scope opener when there are no
// bindings to prepend, and buys a single answer to "which file is generated line N?" for
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
  const scope = userScope(runsSandboxed(script) ? gmEmit : null, false);
  const head = gmEmit.js + scope.open;
  // An sm-dev test collection's script keeps its eval hook when swapped.
  const hookKey = scratchEvalHookKey(script.fileUrl);
  const hooked = (program: string, mainStart = 0): string => withScriptEvalHook(program, mainStart, script.id, hookKey);
  if (requires.length === 0) {
    // No newline, matching the registered path's no-require branch:
    // the body's first line shares line 0 with the preamble, so
    // generated line N is original line N and the viewer's
    // pass-through is correct. Adding one here would silently shift
    // every logged stack line for the majority of scripts, which have
    // no `@require` — and with no segments to map by, the viewer
    // could not detect it, let alone correct it.
    return { body: head + hooked(composeRequiredBody(script)) + scope.close, needsValues: gmEmit.needsValues };
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
    // head + user source + the scope's closing line
    totalLines: 1 + composed.lineCount + 1,
  });
  return {
    body: head + '\n' + hooked(composed.text, composed.mainStart) + scope.close + '\n' + inlineSourceMapComment(map),
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
// production callers pass the log label from
// `computeLogIds` (via `collectActiveSpecs`) so two scripts sharing
// a basename get distinct devtools folders.
//
// Async because storage-granting scripts read their persisted values
// from chrome.storage.local at register time (see
// buildGmBindingsForScript).
export interface RegistrationSpecOptions {
  // Give the script sm-dev's eval hook under this key (see
  // src/eval-hook.ts). A script in an sm-dev test collection gets its
  // run's without being asked; the person's own scripts never get one.
  evalHookKey?: string;
  // Build for one on-request run of a manual script rather than a
  // registration: the config carries the run decision, with the GM
  // values snapshot a storage script seeds from (what a registered
  // script gets from its check-pending answer).
  manualRun?: { gmValues?: Record<string, unknown> };
}

export async function buildRegistrationSpec(
  script: StoredScript,
  scriptHandlerVersion: string = '0.0.0',
  logLabel: string = scriptBasename(script.relativePath),
  options: RegistrationSpecOptions = {},
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
  const usableMatches = [
    ...new Set(
      script.matching.matches
        .flatMap((m) => canonicalMatchPatterns(m))
        .filter((m) => matchPatternProblem(m) === null),
    ),
  ];
  // A `.tld` host (`*://www.google.tld/*`, "any public suffix") is
  // one Chrome would take, but as a literal host named `…tld` that no
  // page has, and a match pattern can't put `*` there instead. So a
  // `.tld` rule registers as a coarse glob (`*://www.google.*/*`, see
  // `tldCoarseGlob`), which Chrome ORs with `matches` (measured; see
  // below), and the wrapper's matcher narrows it to the exact rule.
  const matches = usableMatches.filter((m) => !hostEndsInTld(m));
  const tldMatches = usableMatches.filter((m) => hostEndsInTld(m));
  // Deduplicated like `matches` above, and for a reason beyond tidiness:
  // `needsReplace` compares the glob lists we sent against the ones
  // `getScripts` reports back, and a header repeating an `@exclude`
  // would leave those two disagreeing forever if Chrome collapsed the
  // duplicate — re-registering the script, and costing it an injection
  // gap, on every sync.
  const includeGlobSet = new Set<string>();
  const excludeGlobSet = new Set<string>();
  // A `.tld` `@include` registers its coarse glob, like a `.tld`
  // `@match`. A `.tld` `@exclude` goes with the regexes, enforced only
  // in-page: widened to `.*`, it would exclude pages it shouldn't.
  let hasRegexInclude = false;
  let hasRegexExclude = false;
  let hasTldRule = tldMatches.length > 0;
  for (const m of tldMatches) includeGlobSet.add(tldCoarseGlob(m, true));
  for (const inc of script.matching.includes) {
    if (isRegexLiteral(inc)) hasRegexInclude = true;
    else if (hostEndsInTld(inc)) {
      includeGlobSet.add(tldCoarseGlob(inc, false));
      hasTldRule = true;
    } else includeGlobSet.add(inc);
  }
  for (const ex of script.matching.excludes) {
    if (isRegexLiteral(ex) || hostEndsInTld(ex)) hasRegexExclude = true;
    else excludeGlobSet.add(ex);
  }
  const includeGlobs = [...includeGlobSet];
  const excludeGlobs = [...excludeGlobSet];

  // Chrome refuses a registration without `matches` ("must specify
  // 'matches'"), so a script whose header carries only `@include`s
  // needs a stand-in (see `NO_PAGE_MATCH` below), with the wrapper's
  // in-page matcher holding it to its header.
  //
  // How the globs and `matches` combine matters, because Chrome's own
  // reading of `includeGlobs` is not what the docs for
  // content scripts say. Measured rather than assumed — the probe in
  // tests/e2e/include-only.spec.ts re-checks it on whatever Chrome the
  // suite runs: `chrome.userScripts` ORs
  // `includeGlobs` with `matches` — userscript `@include` semantics —
  // rather than filtering within them. So:
  //   - `<all_urls>` as the stand-in would run a glob-only script on
  //     every page. The stand-in is `NO_PAGE_MATCH` instead (added to
  //     any spec with globs, for the reason given there), and the
  //     globs say where Chrome injects.
  //   - Were it ever the documented AND, that would inject nowhere.
  //     The probe would fail first.
  //   - A regex `@include` still needs `<all_urls>` (below): no glob
  //     can stand for it.
  // `excludeGlobs` is a true AND under both readings, so it needs no
  // such care.
  //
  // A script with no match/include patterns whatsoever shouldn't reach
  // here — validateHeader stores it `invalid`.
  //
  // A script can land here with `@match` patterns that Chrome's
  // grammar refused (dropped above) alongside its includes. Chrome then
  // injects only where the globs reach, so the refused patterns run
  // nowhere, as when a script has valid `@match`es beside them.
  let usedAllUrlsFallback = false;
  let usedNoPageStandIn = false;
  if (hasRegexInclude) {
    // A regex `@include` can cover pages no registered `@match` or
    // glob does, and Chrome can't read it, so registering the rest
    // alone would never inject there. Every page instead, narrowed by
    // the wrapper, which checks the whole rule set.
    matches.splice(0, matches.length, '<all_urls>');
    usedAllUrlsFallback = true;
  } else if (includeGlobs.length > 0) {
    matches.push(NO_PAGE_MATCH);
    usedNoPageStandIn = true;
  } else if (matches.length === 0) {
    return null;
  }

  const declaredRunAt = normalizeDeclaredRunAt(
    script.header ? getValue(script.header, 'run-at') : undefined,
  );
  const name = scriptDisplayName(script);
  // A script with globs keeps the in-page check too: Chrome's glob
  // reading isn't ours (case, `?`), a `.tld` glob is coarse, and
  // `NO_PAGE_MATCH` is a real (if unlikely) path.
  const needsWrapperFilter = hasRegexInclude || hasRegexExclude || usedAllUrlsFallback
    || usedNoPageStandIn || hasTldRule;
  const sourceUrl = buildSourceUrl(logLabel);

  const world = resolveScriptWorld(script);
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
    ...(isScratchUrl(script.fileUrl) ? { run: scratchRunOf(script.fileUrl) ?? '' } : {}),
    matching: needsWrapperFilter ? script.matching : null,
    startupLogs: script.startupLogs ?? [],
    ...(options.manualRun ? { manualRun: options.manualRun } : {}),
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
    evalHookKey: options.evalHookKey ?? scratchEvalHookKey(script.fileUrl),
    ...(runsSandboxed(script) ? { sandboxed: gmEmit } : {}),
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
    // Every frame whose own URL matches, as in TM and VM, unless the
    // script opts out. See docs/frames.md.
    allFrames: !(script.header && hasTag(script.header, 'noframes')),
  };
  if (matches.length > 0) spec.matches = matches;
  if (includeGlobs.length > 0) spec.includeGlobs = includeGlobs;
  if (excludeGlobs.length > 0) spec.excludeGlobs = excludeGlobs;
  return spec;
}

// Pure: would this script be registered right now? Both the script's
// own enabled flag and its parent collection's flag must be true, and
// the script must be `ok` — `invalid` scripts never run. A manual
// script never registers: it runs only on request (`isManualRunCandidate`).
//
// Shared with `runSync`'s parse re-verification, which spends a compile
// round trip per row and so must ask about exactly the rows that are
// about to be registered — one predicate, so "eligible" can't come to
// mean two different things.
export function isRegistrationCandidate(
  script: ScriptMeta,
  collections: Map<string, StoredCollection>,
): boolean {
  return isRunnable(script, collections) && !isManualScript(script);
}

// Pure: could this manual script be run on request right now? The same
// rules as registering one, apart from being manual.
export function isManualRunCandidate(
  script: ScriptMeta,
  collections: Map<string, StoredCollection>,
): boolean {
  return isRunnable(script, collections) && isManualScript(script);
}

function isRunnable(script: ScriptMeta, collections: Map<string, StoredCollection>): boolean {
  if (script.status !== 'ok') return false;
  if (!isScriptEnabled(script)) return false;
  const collection = collections.get(script.collectionId);
  return !!collection && isCollectionEnabled(collection);
}

// Pick the scripts that should be registered right now and build a
// spec for each. Async because each spec build is async (storage
// pre-load). We parallelize the per-script builds with Promise.all
// rather than awaiting sequentially.
//
// `logIds` is the {script id → label} map. Every sync passes one built
// with the script numbers; the default, from `scripts` alone and with
// no numbers, is for tests. An incremental sync passes a subset of rows,
// so its map comes from the whole library, because an unnumbered
// script's `#N` that depends on which rows this sync happened to read
// would disagree with every other surface that shows the label.
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
// the prelude's send() falls back to dispatching a
// "sourcemonkey-bridge-sync" DOM event. The bridge runs in USER_SCRIPT
// world on the same page, hears the event in the same task, and
// forwards the payload to the SW.
//
// Ordering matters here. The request path is a synchronous dispatch,
// not a queued message, so an event dispatched before this spec's
// listener exists is dropped rather than delivered later. We emit our
// own specs ahead of the user scripts' for that reason (see
// `orderWithOwnSpecs`). When it still races (a sync that widened the
// bridge re-registered it behind them), the wrapper sends its
// check-pending again when the bridge announces itself.
//
// Scoping. The bridge registers on the union of every MAIN-world
// script's patterns — the same rule as the GM runtime, and for the
// same reason in a different currency: the runtime's cost on an
// unrelated page is a page-visible global, the bridge's is a whole
// USER_SCRIPT world created for that document (a V8 context per
// navigation) plus its listeners. Neither belongs on pages where no
// MAIN-world script can run. Unlike the runtime, every MAIN-world
// script counts, granted or not: telemetry and the reload handshake
// ride the bridge too.
export function buildBridgeSpec(activeSpecs: RegistrationSpec[]): RegistrationSpec | null {
  const scope = bridgeScopeOf(activeSpecs.map((spec) => ({
    world: (spec.world ?? 'MAIN') as InjectionWorld,
    patterns: patternsOf(spec),
    injectsOn: injectsOnOf(spec),
    gmRuntime: null,
  })));
  return scope ? bridgeSpec(scope) : null;
}

// The helpers (the bridge, the GM runtime) go into frames whatever
// their scripts' `@noframes`: they're scoped by a pattern union, not
// per script, and one missing from a frame where a script runs breaks
// it, while one in a frame where only `@noframes` scripts match just
// sits idle. See docs/frames.md.
const HELPER_ALL_FRAMES = true;

// The spec itself, with no "is it wanted?" question attached — the
// incremental sync answers that from the whole registration set rather
// than from one sync's spec list. `scope` is never empty: a MAIN-world
// script that reached registration had at least one pattern.
function bridgeSpec(scope: GmRuntimeScope): RegistrationSpec {
  const spec: RegistrationSpec = {
    id: BRIDGE_SCRIPT_ID,
    js: [{ code: WRAPPER_BRIDGE + `\n//# sourceURL=${BRIDGE_SOURCE_URL}\n` }],
    runAt: 'document_start',
    world: 'USER_SCRIPT',
    // In frames too, whether or not its scripts are: see `HELPER_ALL_FRAMES`.
    allFrames: HELPER_ALL_FRAMES,
  };
  applyScope(spec, scope);
  return spec;
}

// Put a pattern union on a spec. Chrome refuses a registration with
// neither field; `<all_urls>` is the unreachable defensive answer (a
// script that reached registration always had at least one pattern),
// kept because a silent refusal here takes every GM_* call down.
function applyScope(spec: RegistrationSpec, scope: GmRuntimeScope): void {
  if (scope.matches.size > 0) spec.matches = [...scope.matches];
  if (scope.includeGlobs.size > 0) spec.includeGlobs = [...scope.includeGlobs];
  if (!spec.matches && !spec.includeGlobs) spec.matches = ['<all_urls>'];
}


// Pure: build the registration specs for the shared `__SM_GM__` GM_*
// runtime — one per world in `scope`. See the module-level comment in
// src/wrapper-gm-runtime.js for the runtime's design.
//
// The SAME source is registered in both worlds; the runtime detects at
// init time whether `chrome.runtime` is reachable and picks its
// transport accordingly (direct `sendMessage` in USER_SCRIPT, the
// DOM-event bridge in MAIN). One implementation, two transports —
// rather than a second MAIN-only copy that would drift.
//
// Registration ids differ per world because `chrome.userScripts`
// namespaces ids globally, not per world.
//
// Patterns: the union of the owning scripts' own, NOT `<all_urls>` —
// the runtime's cost on an unrelated page is a page-visible
// `window.__SM_GM__` global, a fingerprint and an attack surface, so
// it goes only where its scripts go (the bridge is scoped the same
// way; see `buildBridgeSpec`). Excludes are deliberately NOT unioned:
// `@exclude` is per-script, and a runtime present on a page where no
// script runs is harmless, whereas one missing from a page where a
// script DOES run breaks every GM_* call it makes.
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
      allFrames: HELPER_ALL_FRAMES,
    };
    applyScope(spec, s);
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

// ---------- Manual runs ----------
//
// A manual script (`@run-at context-menu`) is never registered. Each
// "Run this script" injects it into the tab's top frame with
// `chrome.userScripts.execute`, built from the same pieces a
// registration is, so it runs the same way. See docs/manual-scripts.md.

export interface ManualRunInjection {
  world: InjectionWorld;
  js: { code: string }[];
}

// What one run injects, in order. The script's world may not have our
// own pieces yet, since they're registered only where registered
// scripts run, so they go first. Both are no-ops where already present.
//   - The bridge, for a MAIN-world script (its reports and GM calls
//     reach the worker through it).
//   - The GM runtime, for a script that needs one.
// Null when the script has nothing Chrome could match on.
export async function buildManualRunInjections(
  script: StoredScript,
  scriptHandlerVersion: string,
  logLabel: string,
  gmValues: Record<string, unknown> | undefined,
): Promise<ManualRunInjection[] | null> {
  const spec = await buildRegistrationSpec(script, scriptHandlerVersion, logLabel, {
    manualRun: gmValues !== undefined ? { gmValues } : {},
  });
  if (!spec) return null;
  const world = (spec.world ?? 'USER_SCRIPT') as InjectionWorld;
  const out: ManualRunInjection[] = [];
  if (world === 'MAIN') {
    out.push({ world: 'USER_SCRIPT', js: [{ code: WRAPPER_BRIDGE + `\n//# sourceURL=${BRIDGE_SOURCE_URL}\n` }] });
  }
  if (needsGmRuntime(script.header)) {
    out.push({ world, js: [{ code: WRAPPER_GM_RUNTIME + `\n//# sourceURL=${GM_RUNTIME_SOURCE_URL}\n` }] });
  }
  out.push({ world, js: spec.js.map((j) => ({ code: (j as { code: string }).code })) });
  return out;
}

// What to inject to run MAIN-world script `script` in USER_SCRIPT world
// instead, on a page that turns off script in its own world (a CSP
// `sandbox` without `allow-scripts`, where Chrome injects nothing in
// MAIN). Built as a registration of the same script with
// `@inject-into content` ahead of its own headers, so it runs as an
// isolated script would, with the runtime first (a no-op where
// present). Null when the script has nothing Chrome could match on.
// See `runBlockedMainScripts` in background.ts.
export async function buildIsolatedFallbackInjections(
  script: StoredScript,
  scriptHandlerVersion: string,
  logLabel: string,
): Promise<ManualRunInjection[] | null> {
  if (!script.header) return null;
  const isolated: StoredScript = {
    ...script,
    header: { ...script.header, tags: [{ tag: 'inject-into', value: 'content' }, ...script.header.tags] },
  };
  const spec = await buildRegistrationSpec(isolated, scriptHandlerVersion, logLabel);
  if (!spec) return null;
  const out: ManualRunInjection[] = [];
  if (needsGmRuntime(script.header)) {
    out.push({ world: 'USER_SCRIPT', js: [{ code: WRAPPER_GM_RUNTIME + `\n//# sourceURL=${GM_RUNTIME_SOURCE_URL}\n` }] });
  }
  out.push({ world: 'USER_SCRIPT', js: spec.js.map((j) => ({ code: (j as { code: string }).code })) });
  return out;
}

// Chrome 135's `chrome.userScripts.execute`, which our @types/chrome
// predates.
interface UserScriptsExecute {
  execute(injection: {
    target: { tabId: number; frameIds?: number[]; documentIds?: string[] };
    js: { code: string }[];
    world?: InjectionWorld;
    injectImmediately?: boolean;
  }): Promise<unknown>;
}

// Inject a manual run (or a sandboxed page's fallback) into document
// `documentId` of `tabId`. Throws what Chrome says when it can't: a
// page it won't inject into, or one that's gone (the tab closed or
// navigated).
export async function executeManualRun(
  tabId: number,
  documentId: string,
  injections: readonly ManualRunInjection[],
): Promise<void> {
  await ensureWorldConfigured();
  const api = chrome.userScripts as unknown as UserScriptsExecute;
  for (const injection of injections) {
    await api.execute({
      target: { tabId, documentIds: [documentId] },
      js: injection.js,
      world: injection.world,
      injectImmediately: true,
    });
  }
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

// Every script and collection row, without the scripts' bodies: those
// are read by `withBodies`, for the scripts that get a spec.
async function readAll(): Promise<{ scripts: ScriptMeta[]; collections: Map<string, StoredCollection>; numbers: Map<string, number> }> {
  // See match-index's loadAll: the pre-rename key spelling has to be
  // moved before anything reads the structural rows directly.
  await ensureCollectionKeysMigrated();
  // From the worker's row cache (frozen rows, read only), with the
  // numbers row, which it doesn't keep, read beside it.
  const isRow = (k: string): boolean => k.startsWith(SCRIPT_PREFIX) || k.startsWith(COLLECTION_PREFIX);
  const cached = await sharedRows(isRow);
  const all = cached
    ? { ...cached, ...await chrome.storage.local.get(SCRIPT_NUMBERS_KEY) }
    : await scanStorageRows('registration sync', (k) => isRow(k) || k === SCRIPT_NUMBERS_KEY);
  const scripts: ScriptMeta[] = [];
  const collections = new Map<string, StoredCollection>();
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(SCRIPT_PREFIX)) scripts.push(v as ScriptMeta);
    else if (k.startsWith(COLLECTION_PREFIX)) {
      const s = v as StoredCollection;
      collections.set(s.id, s);
    }
  }
  return { scripts, collections, numbers: numberMap(numbersFrom(all[SCRIPT_NUMBERS_KEY])) };
}

// The rows among `rows` that would be registered, with their bodies:
// a spec carries the code, and nothing else in a sync needs it. A row
// that isn't a candidate (disabled, invalid, manual, or under a
// disabled collection) is left out without reading its bodies, so a
// sync that only removes registrations reads none.
//
// A candidate whose blob is missing comes back `invalid`
// (`MISSING_BLOB_MESSAGE`), so `collectActiveSpecs` skips it, and its
// row is saved that way (`recordMissingBlobs`) for the readers that
// don't load bodies. That write's change event then syncs it again,
// as a row that's no longer a candidate.
async function withBodies(
  rows: readonly ScriptMeta[],
  collections: Map<string, StoredCollection>,
): Promise<StoredScript[]> {
  const scripts = await fromStorage(rows.filter((s) => isRegistrationCandidate(s, collections)) as ScriptRow[]);
  const missing = scripts.filter((s) => s.status === 'invalid' && s.errorMessage === MISSING_BLOB_MESSAGE);
  if (missing.length > 0) {
    console.info(`[SourceMonkey] not registering ${missing.map((s) => s.relativePath).join(', ')}: ${MISSING_BLOB_MESSAGE}`);
    try {
      await recordMissingBlobs(missing.map((s) => s.id));
    } catch (err) {
      console.info('[SourceMonkey] could not save the missing-file state:', describeError(err));
    }
  }
  return scripts;
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
//     An unnumbered script's `#N` depends on the whole library, so a
//     subset can't compute labels — and a script being numbered, or an
//     unnumbered one arriving, re-registers scripts whose rows never
//     moved.
//   - **Which collection is each script in, and is it enabled?** A
//     collection toggle moves every script under it, and eligibility
//     needs the parent row.
//
// None of it includes a script body — the expensive part of a full read
// — so this stays small next to the `get(null)` it replaces.
//
// Null until a sync has run in THIS JS context, which is what makes the
// state safe to trust: the service worker is evicted freely and rows
// change while it's dead, so a fresh worker's first sync is a full
// reconcile against `chrome.userScripts.getScripts()`, unless it takes
// the last worker's record (`restoreRecord`). A sync that fails part-way
// drops the state for the same reason. The record itself is
// `RegistrationState`, below.

// What we last placed under one registration id.
interface Placement {
  world: InjectionWorld;
  // Which pattern fields it carries — see `PlacedPatterns` for why an
  // update has to know.
  patterns: PlacedPatterns;
  // The patterns Chrome injects this script on. Tracked so an
  // incremental sync can compute the bridge's scope from the WHOLE
  // registration set, not just the slice it is rebuilding.
  injectsOn: GmRuntimePatterns;
  // The same patterns when the script's world needs the shared
  // `__SM_GM__` runtime; null when it doesn't. The runtime's scope is
  // the union of these. Always null for our own registrations.
  gmRuntime: GmRuntimePatterns | null;
  // A user script's registration as placed, code and settings
  // (`specHash`), so an incremental sync can leave one alone that it
  // rebuilt the same: a row change the registration doesn't show costs
  // Chrome nothing. Set by incremental syncs only; absent for our own
  // registrations, for one a full sync placed, and in a record from an
  // older build.
  specHash?: string;
}

interface RegistrationState {
  // Every id we believe Chrome holds, including our own reserved ids.
  registered: Map<string, Placement>;
  // The pattern union each of our own registrations (bridge and
  // GM runtimes) was last placed with, keyed by registration id. Their
  // patterns follow the scripts, so an incremental sync has to notice
  // when they move — see `gmRuntimeFingerprint`.
  gmRuntimeScopes: Map<string, string>;
  // Every stored script — regardless of status, because log labels are
  // assigned across all of them.
  scriptIndex: Map<string, { relativePath: string; collectionId: string }>;
  // The log label each script was last registered with. A
  // script ARRIVING can change another script's label (a lone
  // `main.user.js` becomes `main.user.js#1` once a second one shows
  // up), and the label is baked into the registered `//# sourceURL=`
  // directives — so the other script has to be re-registered even
  // though its own row never moved.
  labels: Map<string, string>;
  collections: Map<string, StoredCollection>;
  // A fingerprint of each script and collection row as the syncs that
  // placed it read it, keyed by storage key: what a worker started later
  // compares the rows with, to find the ones that changed while no
  // worker was watching (see `restoreRecord`).
  fingerprints: Map<string, string>;
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
// Bumped by `forgetRegistrationState`, which a sync in flight checks.
let stateGeneration = 0;

export function forgetRegistrationState(): void {
  stateGeneration++;
  syncState = null;
  lastSyncKind = null;
  // The next sync reconciles in full, in this worker or the next: the
  // session record goes too.
  dropRecord();
}

// Test-only: as a worker just started, which has no record in memory
// and may take the one in session storage. Waits for a pending save.
export async function forgetRegistrationStateAsNewWorkerForTests(): Promise<void> {
  if (recordSaveTimer !== null) {
    clearTimeout(recordSaveTimer);
    recordSaveTimer = null;
    await withRegistrationLock(saveRecord);
  }
  syncState = null;
  lastSyncKind = null;
  mayRestoreRecord = true;
  recordMarkedStale = false;
  recordUnsaved = false;
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
// tests use it to reproduce a record that is wrong about what Chrome
// holds (a reset, a record lost with a stopped worker).
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

// Read just the rows named, rather than the whole store. Script rows
// come back without their bodies (see `withBodies`).
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
  const cached = cachedRows(keys);
  if (cached) return cached.found;
  return await chrome.storage.local.get(keys);
}

// The placements for user scripts only — our own registrations are the
// thing being decided, so they can't be part of the input. (The bridge
// itself runs in USER_SCRIPT world, so counting it would keep the
// USER_SCRIPT runtime registered forever once a MAIN-world script had
// ever been active.)
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
    addToScope(scope, p.gmRuntime);
  }
  return out;
}

// Where the bridge has to be registered: the union of every MAIN-world
// script's patterns, or null when there is no MAIN-world script and so
// no bridge. Every such script counts, whatever it grants — the reload
// handshake and error reports ride the bridge too.
function bridgeScopeOf(placements: Iterable<Placement>): GmRuntimeScope | null {
  let scope: GmRuntimeScope | null = null;
  for (const p of placements) {
    if (p.world !== 'MAIN') continue;
    if (!scope) scope = { matches: new Set(), includeGlobs: new Set() };
    addToScope(scope, p.injectsOn);
  }
  return scope;
}

function addToScope(scope: GmRuntimeScope, patterns: GmRuntimePatterns): void {
  for (const m of patterns.matches) scope.matches.add(m);
  for (const g of patterns.includeGlobs) scope.includeGlobs.add(g);
}

// The patterns Chrome will inject a spec on, as the runtime and bridge
// scopes want them.
function injectsOnOf(spec: RegistrationSpec): GmRuntimePatterns {
  return { matches: [...(spec.matches ?? [])], includeGlobs: [...(spec.includeGlobs ?? [])] };
}

// Our own specs for a registration set: the bridge, then a runtime per
// world that wants one. In the order Chrome should receive them.
function ownSpecsFor(placements: Placement[]): RegistrationSpec[] {
  const out = buildGmRuntimeSpecs(gmRuntimeScopeOf(placements));
  const bridge = bridgeScopeOf(placements);
  if (bridge) out.push(bridgeSpec(bridge));
  return out;
}

// Same question against a freshly built spec list, where the answer
// lives beside the specs rather than on them.
function gmRuntimeScopeOfSpecs(
  specs: readonly RegistrationSpec[],
  gmRuntime: ReadonlyMap<string, GmRuntimePatterns>,
): Map<InjectionWorld, GmRuntimeScope> {
  return gmRuntimeScopeOf(placementsForSpecs(specs, gmRuntime));
}

// Placements as a freshly built spec list implies them, before Chrome
// has been asked — what the own-spec builders take.
function placementsForSpecs(
  specs: readonly RegistrationSpec[],
  gmRuntime: ReadonlyMap<string, GmRuntimePatterns>,
): Placement[] {
  return specs.map((spec) => ({
    world: (spec.world ?? 'MAIN') as InjectionWorld,
    patterns: patternsOf(spec),
    injectsOn: injectsOnOf(spec),
    gmRuntime: gmRuntime.get(spec.id) ?? null,
  }));
}

// What a registration says, hashed: everything Chrome is given for it.
// A spec is built by the same code each sync, so equal registrations
// serialize alike. Memoized per spec object: a sync asks twice.
//
// Only an incremental sync computes it, for the few scripts it rebuilds:
// it stringifies the whole code, which a full sync of every script
// shouldn't pay on a worker start. A script a full sync placed has no
// hash, so the first incremental sync of it sends it, as before.
const specHashes = new WeakMap<RegistrationSpec, string>();
function specHash(spec: RegistrationSpec): string {
  let hash = specHashes.get(spec);
  if (hash === undefined) {
    hash = hashText(JSON.stringify(spec));
    specHashes.set(spec, hash);
  }
  return hash;
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
// So: one registration operation at a time, in the worker, the only
// context that places registrations. The queue is
// a promise chain rather than a flag because callers must be able to
// await their own work; a rejected operation is isolated so it can't
// break the ones behind it.
let registrationLock: Promise<unknown> = Promise.resolve();

function withRegistrationLock<T>(run: () => Promise<T>): Promise<T> {
  // Every placement runs under this lock, so this is where a page that
  // reached one is stopped (docs/worker-writes.md).
  assertWorkerContext('change script registrations');
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
  //   - 'unsafe-inline' and * — Chrome checks <script> elements
  //     inserted from this world against this CSP rather than the
  //     page's. Without these, a userscript's page-code injection
  //     (createElement('script'), GM_addElement) is refused on every
  //     page, CSP or not: inline code, and any `src` not on the
  //     extension's own origin.
  //   - The new capability: <script> elements a userscript inserts
  //     run in the page realm even under a strict page script-src.
  //     Tampermonkey 5.5 sets the same world CSP, so it allows this
  //     too. (A userscript could already run any code in its own
  //     world and change the whole DOM.)
  //   - Only <script> elements: inline event handlers and javascript:
  //     URLs a userscript adds stay under the page CSP (see
  //     user-script-world-csp.spec.ts).
  // Idempotent — Chrome accepts repeated calls but we still guard so
  // we don't issue them on every sync.
  await chrome.userScripts.configureWorld({
    messaging: true,
    csp: "script-src 'self' 'unsafe-eval' 'unsafe-inline' *",
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
// list is unknown, and an id can go missing before this call: what this
// worker believes Chrome holds can be wrong (a reset, a lost record).
// So the batch failing is not evidence that the other ids are gone; it
// usually means one of them already was.
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
  if (!isUserScriptsAvailable()) {
    dropRecord();
    return;
  }
  await withRegistrationLock(async () => {
    await unregisterAll();
    // Our record of Chrome's set is now a lie, and an incremental sync
    // built on it would leave every script unregistered. Forget it, so
    // the next sync is a full reconcile. The session copy too.
    syncState = null;
    dropRecord();
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
    // a disabled row is `ok` without being a candidate — which would
    // print this line for a row that was never going to register.
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
// Run at the start of each sync, before anything is read: the service
// worker numbers new scripts here (`assignNumbers`), so a script
// is registered under its numbered label from the start. Unset in unit
// tests that don't number scripts.
//
// Resolves to the script numbers by id, as just assigned, so the sync
// takes them from here rather than reading them again. The worker is the
// numbers' only writer, and this runs inside the registration lock, so
// nothing renumbers a script while the sync uses them.
let beforeSync: (() => Promise<ReadonlyMap<string, number>>) | null = null;

export function setBeforeSync(hook: (() => Promise<ReadonlyMap<string, number>>) | null): void {
  beforeSync = hook;
}

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

// ---------- The record across worker restarts ----------
//
// A worker that starts with no record of what Chrome holds has to
// reconcile in full: read every row and body, build every spec, and
// compare them with Chrome's. Within one browser session the last
// worker's record says the same thing, so it is kept in session storage
// (which outlives a stopped worker, not a browser or extension restart)
// and a new worker picks it up, syncing only the rows that changed since
// (docs/injection.md#startup-the-record-or-a-full-reconcile).
//
// - A small marker (`SYNC_DIRTY_KEY`) is written before anything changes
//   Chrome's set, if it isn't there already. The record is saved once
//   syncs have been quiet for a moment (`RECORD_SAVE_DELAY_MS`), and the
//   marker removed with it. A worker that finds the marker reconciles in
//   full: the record may not describe what Chrome holds.
//   - So a burst of syncs costs one marker write and one record write,
//     not a record write each. Every session write reaches every open
//     extension page's listener.
// - Taken only when made by this extension version, and when Chrome
//   still holds our helpers as it last placed them (`stillHeld`).
// - The changed rows: those whose fingerprint differs from the one the
//   record kept, or that appeared or went away.

const SYNC_RECORD_KEY = 'registrationRecord';
const SYNC_DIRTY_KEY = 'registrationRecordStale';
const RECORD_SAVE_DELAY_MS = 2_000;

// A caller's scope plus the restored record's. No caller scope means the
// caller asked for no particular rows (a worker's first sync), so the
// record's alone.
function mergeScopes(a: SyncScope | undefined, b: SyncScope): SyncScope {
  if (!a) return b;
  return {
    scriptIds: [...new Set([...a.scriptIds, ...b.scriptIds])],
    collectionIds: [...new Set([...a.collectionIds, ...b.collectionIds])],
  };
}

interface SyncRecord {
  version: string;
  registered: [string, Placement][];
  gmRuntimeScopes: [string, string][];
  scriptIndex: [string, { relativePath: string; collectionId: string }][];
  labels: [string, string][];
  // Collection id and whether it's enabled: all the sync reads of one.
  collections: [string, boolean][];
  fingerprints: [string, string][];
}

// False once this worker has synced, or its record was dropped on
// purpose: a record is only for a worker's first sync.
let mayRestoreRecord = true;
// Whether the session marker says the saved record may be stale: set
// before this worker changes Chrome's set, cleared when it saves.
let recordMarkedStale = false;
// Whether this worker's record has something the saved one lacks: it
// changed Chrome's set, or it was built by a full sync.
let recordUnsaved = false;
let recordSaveTimer: ReturnType<typeof setTimeout> | null = null;

function noteFingerprint(state: RegistrationState, key: string, fingerprint: string | undefined): void {
  if (fingerprint === undefined) state.fingerprints.delete(key);
  else state.fingerprints.set(key, fingerprint);
}

// What a sync reads of a script row: all of it except the annotations
// a write can move without a sync (`onlyAnnotationsChanged`).
//
// Plain JSON, without sorting keys: rows come from the row cache or from
// storage, both of which keep an object's keys sorted (they can differ
// only for keys mixing unusual characters, none of ours). A row whose
// keys came in another order would only read as changed, and be synced
// again.
function scriptFingerprint(row: ScriptMeta): string {
  return hashText(JSON.stringify(withoutAnnotations(row)));
}

// What a sync reads of a collection row: whether it is enabled. A
// refresh rewrites the rest without a sync.
function collectionFingerprint(row: StoredCollection): string {
  return isCollectionEnabled(row) ? 'on' : 'off';
}

// Two 32-bit FNV-1a-style hashes and the length: not for security, only
// to tell a changed row from the same one.
function hashText(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 13);
  }
  return `${text.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}

// Before this worker changes Chrome's set. A failure is logged and the
// change goes ahead: the saved record is removed instead, and if that
// fails too, a worker stopped before the next save may take a stale one.
async function markRecordStale(): Promise<void> {
  if (recordMarkedStale) return;
  recordUnsaved = true;
  try {
    await chrome.storage.session.set({ [SYNC_DIRTY_KEY]: true });
    recordMarkedStale = true;
  } catch (err) {
    console.info('[SourceMonkey] could not mark the registration record stale:', describeError(err));
    await chrome.storage.session.remove(SYNC_RECORD_KEY).catch(() => undefined);
  }
}

function scheduleRecordSave(): void {
  if (recordSaveTimer !== null) clearTimeout(recordSaveTimer);
  recordSaveTimer = setTimeout(() => {
    recordSaveTimer = null;
    // Under the registration lock, so no sync changes the set meanwhile.
    void withRegistrationLock(saveRecord).catch((err: unknown) => {
      // The marker stays, so the next worker reconciles in full.
      console.info('[SourceMonkey] could not save the registration record:', describeError(err));
    });
  }, RECORD_SAVE_DELAY_MS);
}

async function saveRecord(): Promise<void> {
  const state = syncState;
  if (!state || !recordUnsaved) return;
  const record: SyncRecord = {
    version: chrome.runtime.getManifest().version,
    registered: [...state.registered],
    gmRuntimeScopes: [...state.gmRuntimeScopes],
    scriptIndex: [...state.scriptIndex],
    labels: [...state.labels],
    collections: [...state.collections].map(([id, c]) => [id, isCollectionEnabled(c)]),
    fingerprints: [...state.fingerprints],
  };
  await chrome.storage.session.set({ [SYNC_RECORD_KEY]: record });
  if (recordMarkedStale) await chrome.storage.session.remove(SYNC_DIRTY_KEY);
  recordMarkedStale = false;
  recordUnsaved = false;
}

// When this worker can't vouch for the saved record any more.
function dropRecord(): void {
  mayRestoreRecord = false;
  // Written again before the next change: the marker may have gone with
  // the storage it was in (a test reset).
  recordMarkedStale = false;
  recordUnsaved = false;
  if (recordSaveTimer !== null) clearTimeout(recordSaveTimer);
  recordSaveTimer = null;
  void chrome.storage.session.remove(SYNC_RECORD_KEY).catch(() => undefined);
}

// Whether Chrome still holds the record's last registration: our own
// helpers, with the patterns the record last gave them (their code ships
// with the extension, and the record is from this version). Not every
// registration: there is no ids-only call, and each one comes back with
// its code. Losing the helpers is what a wipe of the set would show.
// With no helpers, one user script stands in; with nothing registered,
// Chrome must hold nothing.
async function stillHeld(
  registered: ReadonlyMap<string, Placement>,
  ownScopes: ReadonlyMap<string, string>,
): Promise<boolean> {
  const ids = [...registered.keys()];
  if (ids.length === 0) return (await chrome.userScripts.getScripts()).length === 0;
  const own = ids.filter((id) => !isUserScriptId(id));
  const asked = own.length > 0 ? own : ids.slice(0, 1);
  const held = new Map((await chrome.userScripts.getScripts({ ids: asked })).map((s) => [s.id, s] as const));
  return asked.every((id) => held.has(id))
    && own.every((id) => ownScopes.get(id) === gmRuntimeFingerprint(held.get(id)!));
}

// The last worker's record and the rows that changed since, or null when
// there is none this worker can take.
async function restoreRecord(): Promise<{ state: RegistrationState; scope: SyncScope } | null> {
  const timer = startPhaseTimer('registration record');
  const got = await chrome.storage.session.get([SYNC_RECORD_KEY, SYNC_DIRTY_KEY]);
  const record = got[SYNC_RECORD_KEY] as SyncRecord | undefined;
  const why = !record || !Array.isArray(record.fingerprints) ? 'none saved'
    : got[SYNC_DIRTY_KEY] ? 'may be stale'
      : record.version !== chrome.runtime.getManifest().version ? 'another version'
        : null;
  timer.mark('read');
  if (why || !record) {
    timer.note(`not taken: ${why}`);
    timer.done();
    return null;
  }
  const registered = new Map(record.registered);
  if (!(await stillHeld(registered, new Map(record.gmRuntimeScopes)))) {
    timer.mark('list');
    timer.note('not taken: Chrome no longer holds the helpers it names');
    timer.done();
    return null;
  }
  timer.mark('list');

  await ensureCollectionKeysMigrated();
  const isRow = (k: string): boolean => k.startsWith(SCRIPT_PREFIX) || k.startsWith(COLLECTION_PREFIX);
  const rows = (await sharedRows(isRow)) ?? await scanStorageRows('registration record', isRow);
  const kept = new Map(record.fingerprints);
  const scriptIds = new Set<string>();
  const collectionIds = new Set<string>();
  const changed = (key: string): void => {
    if (key.startsWith(SCRIPT_PREFIX)) scriptIds.add(key.slice(SCRIPT_PREFIX.length));
    else collectionIds.add(key.slice(COLLECTION_PREFIX.length));
  };
  for (const [key, row] of Object.entries(rows)) {
    const now = key.startsWith(SCRIPT_PREFIX)
      ? scriptFingerprint(row as ScriptMeta)
      : collectionFingerprint(row as StoredCollection);
    if (kept.get(key) !== now) changed(key);
  }
  for (const key of kept.keys()) if (!(key in rows)) changed(key);
  timer.mark('compare');
  timer.note(`taken; ${scriptIds.size} script(s) and ${collectionIds.size} collection(s) changed`);
  timer.done();
  return {
    state: {
      registered,
      gmRuntimeScopes: new Map(record.gmRuntimeScopes),
      scriptIndex: new Map(record.scriptIndex),
      labels: new Map(record.labels),
      // Only what the sync reads of a collection: `isRunnable`.
      collections: new Map(record.collections.map(([id, enabled]) => [id, { id, enabled } as StoredCollection])),
      fingerprints: kept,
    },
    scope: { scriptIds: [...scriptIds], collectionIds: [...collectionIds] },
  };
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
      console.info('[SourceMonkey] chrome.userScripts is unavailable, so nothing was registered');
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
    dropRecord();
    return;
  }
  let state = syncState;
  // A `forgetRegistrationState` while this runs (it doesn't take the
  // lock) means its result mustn't be kept.
  const generation = stateGeneration;
  try {
    const numbers = (await beforeSync?.()) ?? null;
    await ensureWorldConfigured();
    // A worker's first sync: the last worker's record, if this one can
    // take it, stands in for a full reconcile.
    if (!syncState && mayRestoreRecord) {
      mayRestoreRecord = false;
      const restored = await restoreRecord().catch((err: unknown) => {
        console.info('[SourceMonkey] could not read the last registration record:', describeError(err));
        return null;
      });
      if (restored) {
        state = syncState = restored.state;
        scope = mergeScopes(scope, restored.scope);
      }
    }
    // A scope is only actionable against a record of what we last left
    // registered. Without one — a fresh service worker, or a sync that
    // failed part-way and dropped it — the only safe answer is to
    // reconcile against Chrome's own list.
    if (scope && state) {
      await runIncrementalSync(scope, state, numbers);
      lastSyncKind = 'incremental';
    } else {
      syncState = await runFullSync(numbers);
      lastSyncKind = 'full';
      // Built from scratch: saved even if it sent Chrome nothing, or a
      // worker after a browser start would never find one.
      recordUnsaved = true;
    }
    // Saved when this sync changed something (`applyPlan` marks the
    // record stale first), built it afresh, or an earlier one did.
    if (generation !== stateGeneration) {
      syncState = null;
      dropRecord();
    } else if (recordUnsaved) scheduleRecordSave();
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
// Runs whenever this context has no trustworthy record of the
// registration set: at service-worker startup unless the last worker's
// record was taken (`restoreRecord`). Chrome retains
// registrations across SW restarts and rows change while the worker is
// dead, so the post-startup set has to be proven equal to storage
// rather than diffed against nothing.
//
// It is still not a wipe: everything that should stay registered is
// updated in place, and the only unregisters are for ids Chrome holds
// that storage no longer wants.
async function runFullSync(assigned: ReadonlyMap<string, number> | null): Promise<RegistrationState> {
  const timer = startPhaseTimer('registration sync');
  const all = await readAll();
  const { scripts, collections } = all;
  // As in `runIncrementalSync`: the numbers just assigned, when there are.
  const numbers = assigned ?? all.numbers;
  const candidates = await withBodies(scripts, collections);
  timer.mark('read');
  const handlerVersion = chrome.runtime.getManifest().version;
  const effective = await revalidateCandidates(candidates, collections);
  const logIds = computeLogIds(scripts.map((s): LogIdInput => ({
    id: s.id, relativePath: s.relativePath,
  })), numbers);
  const active = await collectActiveSpecs(effective, collections, handlerVersion, logIds);
  const userSpecs = active.specs;
  // Covers the revalidation too — it is per-script work on the same
  // critical path, and splitting it out would imply the two can be
  // acted on separately when the sync always does both.
  timer.mark('build-specs');
  // Chrome's own list, patterns included — the authority on both what
  // is there and what shape it is in.
  const held = await chrome.userScripts.getScripts();
  const present = new Map(held.map((s) => [s.id, patternsOf(s)] as const));
  timer.mark('list');
  const specs = orderWithOwnSpecs(
    userSpecs,
    ownSpecsFor(placementsForSpecs(userSpecs, active.gmRuntime)),
    // Empty rather than `present`: the bridge and the GM runtime stay in
    // the spec list even when Chrome already holds them, since the
    // removal list is everything Chrome holds that the list doesn't
    // name. Whether each is sent again is `inPlace`'s call: their code
    // ships with the extension, so an update changes it.
    new Set(),
  );
  const wanted = new Set(specs.map((s) => s.id));
  // Most of a full sync re-places what Chrome already holds, from rows
  // that haven't changed since. One held exactly as specified gets no
  // call at all; where only the code is the same, the update leaves it
  // out (see `withoutCode`).
  // Unless Chrome's order has a helper behind a user script: then
  // everything is placed again, helpers first, which restores it (see
  // `retryRefusedOwnSpecs`).
  const inPlace = keepHelpersFirst(specs, held);
  const codeInPlace = sameCode(specs, held);
  const removeIds = [...present.keys()].filter((id) => !wanted.has(id));
  timer.mark('compare');
  const applied = await applyPlan({
    specs,
    removeIds,
    present,
    codeInPlace,
    inPlace,
    // The whole set was rebuilt, so the rejection map is rewritten
    // wholesale — a script that has since been disabled, deleted or
    // flipped to INVALID stops being REJECTED instead of stranding a
    // badge nobody can clear.
    owned: 'all',
  }, timer);
  timer.note(
    `full; ${specs.length} specs (${inPlace.size} in place, ${codeInPlace.size - inPlace.size} more with code in place), `
    + `${removeIds.length} dropped, ${scripts.length} stored scripts`,
  );
  timer.done();
  const registered = placementsOf(specs, applied, active.gmRuntime);
  const gmRuntimeScopes = ownFingerprints(specs);
  await retryRefusedOwnSpecs(applied, registered, gmRuntimeScopes, present);
  reportSyncResult(specs, applied.placed, inPlace);
  return {
    registered,
    gmRuntimeScopes,
    scriptIndex: new Map(scripts.map((s) => [
      s.id, { relativePath: s.relativePath, collectionId: s.collectionId },
    ])),
    labels: logIds,
    collections,
    fingerprints: new Map([
      ...scripts.map((s) => [SCRIPT_PREFIX + s.id, scriptFingerprint(s)] as const),
      ...[...collections.values()].map((c) => [COLLECTION_PREFIX + c.id, collectionFingerprint(c)] as const),
    ]),
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
//
// `assigned`: the script numbers `beforeSync` just assigned, or null
// where nothing assigns them (unit tests), which reads them.
async function runIncrementalSync(
  scope: SyncScope,
  state: RegistrationState,
  assigned: ReadonlyMap<string, number> | null,
): Promise<void> {
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
    noteFingerprint(state, COLLECTION_PREFIX + id, row && collectionFingerprint(row));
  }
  const scripts: ScriptMeta[] = [];
  for (const id of affected) {
    const row = rows[SCRIPT_PREFIX + id] as ScriptMeta | undefined;
    noteFingerprint(state, SCRIPT_PREFIX + id, row && scriptFingerprint(row));
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
      noteFingerprint(state, COLLECTION_PREFIX + id, row && collectionFingerprint(row));
    }
  }
  // Labels come from the whole index rather than from the handful of
  // rows this sync read, and from the script numbers as `beforeSync`
  // just assigned them: it may have just numbered a script this sync
  // didn't read.
  if (unseen.length > 0) timer.mark('read collections');
  let numbers = assigned;
  if (!numbers) {
    numbers = numberMap(await readScriptNumbers());
    timer.mark('read numbers');
  }
  const logIds = computeLogIds([...state.scriptIndex].map(([id, info]): LogIdInput => ({
    id, relativePath: info.relativePath,
  })), numbers);
  // A script being numbered, or an unnumbered one arriving or leaving
  // (which can renumber its basename's `#N` group), changes labels —
  // and the label is baked into the registered `//# sourceURL=`
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
      const row = extra[SCRIPT_PREFIX + id] as ScriptMeta | undefined;
      if (!row) {
        const stale = state.labels.get(id);
        if (stale !== undefined) nextLabels.set(id, stale);
        continue;
      }
      scripts.push(row);
      affected.add(id);
      noteFingerprint(state, SCRIPT_PREFIX + id, scriptFingerprint(row));
    }
  }
  timer.mark('labels');
  const handlerVersion = chrome.runtime.getManifest().version;
  const candidates = await withBodies(scripts, state.collections);
  timer.mark('read bodies');
  const effective = await revalidateCandidates(candidates, state.collections);
  const active = await collectActiveSpecs(
    effective, state.collections, handlerVersion, logIds,
  );
  const userSpecs = active.specs;
  timer.mark('build-specs');

  const wanted = new Set(userSpecs.map((s) => s.id));
  // Every affected script that no longer wants a registration, whether
  // or not WE believe it has one. The belief can be wrong (a reset, a
  // record lost with a stopped worker), and guarding on it would leave
  // such a script injecting after the user disabled or deleted it.
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
  for (const [id, placement] of placementsForSpecs(userSpecs, active.gmRuntime).map(
    (p, i) => [userSpecs[i].id, p] as const,
  )) {
    projected.set(id, placement);
  }
  const ownSpecs = ownSpecsFor(userPlacements(projected));
  // Our own registrations are dropped independently — the bridge when
  // no MAIN-world script is left, each world's runtime when no script
  // there needs it; a page can end up wanting the MAIN runtime and not
  // the USER_SCRIPT one.
  const ownWanted = new Set(ownSpecs.map((spec) => spec.id));
  for (const id of OWN_IDS) {
    if (!ownWanted.has(id) && state.registered.has(id)) removeIds.push(id);
  }

  const present = new Map([...state.registered].map(([id, p]) => [id, p.patterns] as const));
  // Our own registrations are normally not re-offered (see
  // `orderWithOwnSpecs`), but their patterns follow the scripts: adding
  // the first script on a new host moves the union, and a skipped
  // update would leave the bridge or `window.__SM_GM__` absent on
  // exactly the page that just started needing it. So one whose
  // fingerprint moved counts as not-yet-placed.
  const nextScopes = ownFingerprints(ownSpecs);
  const alreadyPlaced = {
    has: (id: string) => present.has(id) && state.gmRuntimeScopes.get(id) === nextScopes.get(id),
  };
  const specs = orderWithOwnSpecs(userSpecs, ownSpecs, alreadyPlaced);
  state.gmRuntimeScopes = nextScopes;
  // Rebuilt exactly as placed: nothing to send. A row change the
  // registration doesn't carry, such as a refresh that only moved the
  // file's modified time. Trusts the record, as the rest of an
  // incremental sync does; a full reconcile corrects a wrong one.
  //
  // None when one of our own registrations is sent: an updated helper
  // can move behind the user scripts in Chrome's order, and sending
  // these again puts them after it, as `keepHelpersFirst` does for a
  // full sync.
  const helperSent = specs.some((spec) => !isUserScriptId(spec.id));
  const inPlace = helperSent ? new Set<string>() : new Set(userSpecs
    .filter((spec) => state.registered.get(spec.id)?.specHash === specHash(spec))
    .map((spec) => spec.id));
  const applied = await applyPlan({
    specs,
    removeIds,
    present,
    inPlace,
    // An own spec offered here that Chrome holds is one whose patterns
    // moved. Its code is fixed when the extension is built, and this
    // worker's first sync placed it with this code: a full one did, and
    // a taken record comes only from a worker of the same version, whose
    // first sync did. Only the specs being offered: the rest aren't sent.
    codeInPlace: new Set(specs.filter((spec) => !isUserScriptId(spec.id) && present.has(spec.id)).map((spec) => spec.id)),
    // Only the rows this sync considered. An id it never looked at
    // keeps whatever the map already says: dropping those would clear a
    // REJECTED badge for a script Chrome is still refusing, and
    // rewriting them wholesale would resurrect ones already cleared.
    owned: affected,
  }, timer);
  timer.note(`incremental; ${specs.length} specs (${inPlace.size} in place), ${removeIds.length} dropped`);
  timer.done();
  for (const id of removeIds) state.registered.delete(id);
  const specsById = new Map(specs.map((spec) => [spec.id, spec] as const));
  for (const [id, placement] of placementsOf(specs, applied, active.gmRuntime)) {
    const spec = specsById.get(id);
    state.registered.set(id, spec && isUserScriptId(id) ? { ...placement, specHash: specHash(spec) } : placement);
  }
  for (const id of applied.refused) state.registered.delete(id);
  await retryRefusedOwnSpecs(applied, state.registered, state.gmRuntimeScopes, present);
  state.labels = nextLabels;
  // A sync that sent nothing has nothing to say.
  if (inPlace.size < specs.length || removeIds.length > 0) {
    reportSyncResult(specs, applied.placed, inPlace, 'incremental');
  }
}

// Prepend our own GM-runtime / bridge specs to the user specs, when
// they're wanted and not already in place.
//
// GM runtimes first (one per world) so each installs window.__SM_GM__
// ahead of any wrapper in its world that compiles in GM_* bindings.
// Bridge next so MAIN wrappers have a listener for their requests.
// Then the user scripts. (Cross-registration ordering isn't guaranteed
// by the userScripts API, but in practice Chrome runs registrations in
// order. The bridge benefits from it: a request is a synchronous DOM event,
// so one dispatched before the bridge's IIFE installed its listener is
// dropped, not queued. The exposure is one message, `sm:check-pending`,
// which the wrapper sends again when the bridge announces itself
// (`sourcemonkey-bridge-ready`); every other request originates from
// code that runs only after that handshake settles. For GM_*: everything gm-bindings.ts emits — both
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
// would silently invert this — `placeSpecs` therefore places our own
// specs first and individually, before any user spec.
//
// An incremental sync that moves an own spec's pattern union UPDATES
// it, which puts it after every user script already registered. That
// is tolerated rather than repaired: a wrapper ahead of the bridge
// sends its check-pending again when the bridge announces itself
// (above), and a wrapper only decides whether it can use a hot-swapped
// body once the body is about to run, by which point every
// document_start registration has executed — see `needsRuntime` in
// `handleCheckPending` and `runMain` in the prelude. Re-placing the
// world's user scripts behind the runtime would cost each of them an
// injection gap for an ordering nothing depends on.
//
// `alreadyPlaced` names ids not worth re-offering — an incremental sync
// passes what it believes is registered, so an ordinary script edit
// doesn't churn our own registrations. A full sync passes nothing.
function orderWithOwnSpecs(
  userSpecs: RegistrationSpec[],
  ownSpecs: readonly RegistrationSpec[],
  alreadyPlaced: { has(id: string): boolean },
): RegistrationSpec[] {
  const specs: RegistrationSpec[] = [];
  for (const spec of ownSpecs) {
    if (!alreadyPlaced.has(spec.id)) specs.push(spec);
  }
  specs.push(...userSpecs);
  return specs;
}

// The pattern-union fingerprint of each of our own specs in a list.
function ownFingerprints(specs: readonly RegistrationSpec[]): Map<string, string> {
  return new Map(
    specs.filter((spec) => !isUserScriptId(spec.id))
      .map((spec) => [spec.id, gmRuntimeFingerprint(spec)] as const),
  );
}

// Our own specs are placed before the user scripts (for injection
// order), so they are built from patterns Chrome hasn't ruled on yet.
// One pattern Chrome refuses takes the whole union — and with it the
// bridge or a runtime for every page in that world — while the script
// that carried it is refused separately and reads REJECTED. So a
// refused own spec is rebuilt from what Chrome actually accepted (the
// registered placements, which exclude the refused scripts) and
// offered again; every pattern in that union was just accepted, so
// only a non-pattern failure can refuse it twice, and that is logged.
//
// The retried spec lands after the user scripts in Chrome's order.
// That is survivable: a script's body only touches `__SM_GM__` after
// its async check-pending decision, by which point the runtime has
// run too; the next full sync restores the order (`helpersFirst`).
async function retryRefusedOwnSpecs(
  applied: AppliedPlan,
  registered: Map<string, Placement>,
  fingerprints: Map<string, string>,
  present: ReadonlyMap<string, PlacedPatterns>,
): Promise<void> {
  const refusedOwn = [...applied.refused].filter((id) => !isUserScriptId(id));
  if (refusedOwn.length === 0) return;
  const rebuilt = ownSpecsFor(userPlacements(registered)).filter((spec) => refusedOwn.includes(spec.id));
  if (rebuilt.length === 0) return;
  console.info(
    `[SourceMonkey] re-offering ${rebuilt.map((s) => s.id).join(', ')} on the patterns Chrome accepted`,
  );
  // `present` minus the refused ids: `applyPlan` unregistered whatever
  // Chrome held under them.
  const believed = new Map([...present].filter(([id]) => !applied.refused.has(id)));
  const again = await applyPlan({ specs: rebuilt, removeIds: [], present: believed, owned: new Set() });
  for (const [id, placement] of placementsOf(rebuilt, again, new Map())) registered.set(id, placement);
  for (const spec of rebuilt) {
    if (!again.refused.has(spec.id)) fingerprints.set(spec.id, gmRuntimeFingerprint(spec));
  }
  applied.placed.push(...again.placed);
}

// What Chrome now holds, for the specs that actually went in.
function placementsOf(
  specs: readonly RegistrationSpec[],
  applied: AppliedPlan,
  gmRuntime: ReadonlyMap<string, GmRuntimePatterns>,
): Map<string, Placement> {
  const out = new Map<string, Placement>();
  const placements = placementsForSpecs(specs, gmRuntime);
  for (let i = 0; i < specs.length; i++) {
    if (applied.refused.has(specs[i].id)) continue;
    out.set(specs[i].id, placements[i]);
  }
  return out;
}

// `held`: specs Chrome already held exactly, counted as placed but not
// sent (a full sync's `inPlace`).
function reportSyncResult(
  specs: readonly RegistrationSpec[],
  placed: readonly string[],
  held: ReadonlySet<string> = new Set(),
  kind: 'full' | 'incremental' = 'full',
): void {
  // A sync whose scope turned out to hold nothing offered nothing, and
  // "registered 0 userscript(s)" would read as though it had emptied
  // the set. Say nothing instead.
  if (specs.length === 0) return;
  // Counted apart from the user's scripts: a toggle that re-registers
  // one script also re-registers each helper whose pattern union it
  // moved, and a single total read as more scripts than the page has.
  const offered = specs.filter((s) => isUserScriptId(s.id)).length;
  const registered = placed.filter(isUserScriptId).length;
  const helpers = placed.filter((id) => !isUserScriptId(id)).map(helperName);
  // `placed` includes a helper `retryRefusedOwnSpecs` got in on its
  // second try, so this is what Chrome is still refusing.
  const refusedHelpers = specs
    .filter((s) => !isUserScriptId(s.id) && !placed.includes(s.id))
    .map((s) => helperName(s.id));
  const failed = offered - registered;
  const parts = [
    ...(offered > 0 ? [`${failed > 0 ? `${registered}/${offered}` : registered} userscript(s)`] : []),
    ...(helpers.length > 0 ? [`helper(s): ${helpers.join(', ')}`] : []),
  ];
  const what = parts.join(' and ') || 'nothing';
  const problems = [
    ...(failed > 0 ? [`${failed} userscript(s) rejected by chrome.userScripts (see per-script errors)`] : []),
    ...(refusedHelpers.length > 0 ? [`helper(s) refused by chrome.userScripts: ${refusedHelpers.join(', ')}`] : []),
  ];
  // How many of those went to Chrome, when some it already held.
  const sent = held.size > 0
    ? ` (${placed.filter((id) => !held.has(id)).length} registration(s) sent, ${held.size} already held)`
    : '';
  // A full sync states the whole set; an incremental one, what it
  // registered (its `held` are only the scripts it rebuilt).
  const verb = held.size > 0 && kind === 'full' ? 'in place' : 'registered';
  if (problems.length > 0) {
    console.info(`[SourceMonkey] ${verb}: ${what}${sent}; ${problems.join('; ')}`);
  } else {
    console.log(`[SourceMonkey] ${verb} with chrome.userScripts: ${what}${sent}`);
  }
}

// How the sync log names one of our own registrations.
function helperName(id: string): string {
  switch (id) {
    case BRIDGE_SCRIPT_ID: return 'bridge';
    case GM_RUNTIME_MAIN_SCRIPT_ID: return 'GM runtime (MAIN world)';
    case GM_RUNTIME_SCRIPT_ID: return 'GM runtime (USER_SCRIPT world)';
    default: return id;
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
// Bounded by the worker's life, and it takes something other than this
// worker's syncs placing a different glob set for the same id with no
// storage write behind it, so we live with it rather than spending a
// round trip per spec.
//
// Chrome answers a `register` for an id it already knows with
// "Duplicate script ID '<id>'" rather than replacing it, and there are
// two ordinary ways it already knows one of ours:
//
//   - **Our record of what Chrome holds is wrong.** A reset, or a
//     record lost with a stopped worker. (Pages used to place
//     registrations too; only the worker does now, docs/worker-writes.md.)
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
//
// `codeInPlace`: Chrome already holds this id with the same code, so the
// update leaves the code out (`withoutCode`). The register and replace
// fallbacks still send it, since they start from nothing.
async function placeSpec(
  spec: RegistrationSpec,
  believed: PlacedPatterns | undefined,
  codeInPlace = false,
): Promise<void> {
  if (believed) {
    // A spec whose pattern fields `update` won't apply — changed
    // globs, or a dropped `matches` — can't go through it at all. See
    // `needsReplace`.
    if (needsReplace(believed, spec)) return await replaceRegistration(spec);
    let refusal: unknown;
    try {
      await chrome.userScripts.update([codeInPlace ? withoutCode(spec) : spec]);
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

// The specs whose code is exactly what Chrome holds under their id.
function sameCode(
  specs: readonly RegistrationSpec[],
  held: readonly chrome.userScripts.RegisteredUserScript[],
): Set<string> {
  const byId = new Map(held.map((s) => [s.id, s] as const));
  return new Set(specs.filter((spec) => {
    const h = byId.get(spec.id);
    return h !== undefined && sameJs(spec.js, h.js);
  }).map((spec) => spec.id));
}

// Compared field by field, not as JSON: the code runs to megabytes, and
// a string `===` compares it in place, where JSON would copy and escape
// it first.
function sameJs(a: RegistrationSpec['js'] | undefined, b: RegistrationSpec['js'] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((part, i) => part.code === y[i].code && part.file === y[i].file);
}

// The specs to count as placed without a call, keeping our helpers ahead
// of the user scripts in Chrome's order. Chrome moves an updated
// registration to the end of its list, so:
//   - if a helper is behind a user script already, nothing is skipped:
//     everything is placed again, helpers first;
//   - if a helper is about to be sent, no user script is skipped either,
//     or the helper would land behind the skipped ones.
function keepHelpersFirst(
  specs: readonly RegistrationSpec[],
  held: readonly chrome.userScripts.RegisteredUserScript[],
): Set<string> {
  if (!helpersFirst(held)) return new Set();
  const same = sameRegistrations(specs, held);
  const helperSent = specs.some((s) => !isUserScriptId(s.id) && !same.has(s.id));
  return helperSent ? new Set([...same].filter((id) => !isUserScriptId(id))) : same;
}

// Whether every one of our own registrations comes before every user
// script in Chrome's list, the order the sync places them in.
function helpersFirst(held: readonly chrome.userScripts.RegisteredUserScript[]): boolean {
  const firstUser = held.findIndex((s) => isUserScriptId(s.id));
  return firstUser < 0 || held.slice(firstUser).every((s) => isUserScriptId(s.id));
}

// The specs Chrome holds exactly as given: the same code and every
// setting. Fields left out compare as Chrome's defaults, and pattern
// lists as sets. A difference this misses only costs an update, so it
// errs toward "different".
function sameRegistrations(
  specs: readonly RegistrationSpec[],
  held: readonly chrome.userScripts.RegisteredUserScript[],
): Set<string> {
  const byId = new Map(held.map((s) => [s.id, s] as const));
  return new Set(specs.filter((spec) => {
    const h = byId.get(spec.id);
    return h !== undefined && sameSettings(spec, h) && sameJs(spec.js, h.js);
  }).map((spec) => spec.id));
}

function sameSettings(a: chrome.userScripts.RegisteredUserScript, b: chrome.userScripts.RegisteredUserScript): boolean {
  const set = (v: readonly string[] | undefined): string => JSON.stringify([...new Set(v ?? [])].sort());
  const worldId = (s: object): string => (s as { worldId?: string }).worldId ?? '';
  return set(a.matches) === set(b.matches)
    && set(a.excludeMatches) === set(b.excludeMatches)
    && set(a.includeGlobs) === set(b.includeGlobs)
    && set(a.excludeGlobs) === set(b.excludeGlobs)
    && (a.runAt ?? 'document_idle') === (b.runAt ?? 'document_idle')
    && (a.allFrames ?? false) === (b.allFrames ?? false)
    && (a.world ?? 'USER_SCRIPT') === (b.world ?? 'USER_SCRIPT')
    && worldId(a) === worldId(b);
}

// An update that changes only the patterns. `update` keeps any property
// it isn't given, and our helpers' code (the GM runtime's is over
// 100 KB) would otherwise go to Chrome again on a toggle that moved one
// pattern. Chrome then stores it and sends it on to renderers, which
// was most of the sync's register time.
function withoutCode(spec: RegistrationSpec): RegistrationSpec {
  const { js: _js, ...rest } = spec;
  // `js` is required by the type, which describes a registration, not
  // an update.
  return rest as RegistrationSpec;
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
// result. Our own registrations have to precede every user script, so
// they are placed first and individually; the user specs then go out
// as batches, because the relative order of two user scripts is not
// something we promise anyway (see docs/injection.md#run-at-gating).
async function placeSpecs(
  specs: readonly RegistrationSpec[],
  present: ReadonlyMap<string, PlacedPatterns>,
  codeInPlace: ReadonlySet<string> = new Set(),
): Promise<{ placed: string[]; refused: Map<string, string> }> {
  const placed: string[] = [];
  const refused = new Map<string, string>();
  const placeOne = async (
    spec: RegistrationSpec,
    beliefs: ReadonlyMap<string, PlacedPatterns> = present,
  ): Promise<void> => {
    try {
      await placeSpec(spec, beliefs.get(spec.id), codeInPlace.has(spec.id));
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
      if (existing.length > 0) {
        await chrome.userScripts.update(existing.map((spec) => (codeInPlace.has(spec.id) ? withoutCode(spec) : spec)));
      }
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
  // Ids Chrome already holds with this same code, whose update can leave
  // the code out: our own helpers when only their patterns moved (see
  // `withoutCode`).
  codeInPlace?: ReadonlySet<string>;
  // Ids Chrome already holds exactly as specified, code and every
  // setting (`sameRegistrations`): counted as placed without a call. A
  // full sync on a new worker finds most of the set this way.
  inPlace?: ReadonlySet<string>;
}

interface AppliedPlan {
  placed: string[];
  refused: Set<string>;
}

// `items` split by `test`: those it holds for, then the rest.
function partition<T>(items: readonly T[], test: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const item of items) (test(item) ? yes : no).push(item);
  return [yes, no];
}

// `timer`, when given, gets one mark per step: each is its own round
// trip to Chrome, and a sync's register time is usually one of them.
async function applyPlan(plan: RegistrationPlan, timer?: PhaseTimer): Promise<AppliedPlan> {
  // Read alongside the Chrome calls below, which don't depend on it.
  // Never rejects (`readRejections` answers {} on failure), so nothing
  // is left unhandled if a call below throws first.
  const priorRead = readRejections();
  // Removals before registering. When a change swaps one copy of a
  // script for another, registering first left a moment in which a page
  // that loaded got both copies and ran the script twice. This order
  // leaves a moment in which it gets neither, which a reload fixes. The
  // two lists never share an id, so no registration is replaced this way
  // (see `placeSpec` on why that would be wrong).
  //
  // Only the ids we believe Chrome holds, which covers the old copy in a
  // swap. The rest are dropped in case our record is wrong about them, and
  // usually Chrome holds none of them: that fails the batch call, and
  // the one-at-a-time fallback in `unregisterIds` would hold up the
  // registering.
  const [held, unsure] = partition(plan.removeIds, (id) => plan.present.has(id));
  // Before the first change to Chrome's set, and only when there is one:
  // a sync with nothing to do leaves the saved record as it is.
  const inPlaceIds = plan.inPlace ?? new Set<string>();
  if (plan.removeIds.length > 0 || plan.specs.some((s) => !inPlaceIds.has(s.id))) await markRecordStale();
  await unregisterIds(held);
  timer?.mark('unregister');
  const inPlace = plan.inPlace ?? new Set<string>();
  const sent = await placeSpecs(plan.specs.filter((s) => !inPlace.has(s.id)), plan.present, plan.codeInPlace);
  const refused = sent.refused;
  const placedNow = new Set(sent.placed);
  const placed = plan.specs.map((s) => s.id).filter((id) => inPlace.has(id) || placedNow.has(id));
  timer?.mark('register');
  // A spec Chrome refuses for an id it already holds leaves the
  // PREVIOUS registration in place, so the script would keep injecting
  // stale code while its row read REJECTED — and REJECTED says the
  // script will not run. Drop it, so the badge stays true. Only known
  // once the registering is done, so it comes after.
  const after = [...unsure, ...[...refused.keys()].filter((id) => plan.present.has(id))];
  if (after.length > 0) {
    await unregisterIds(after);
    timer?.mark('unregister after');
  }
  const prior = await priorRead;
  timer?.mark('read rejections');

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
  timer?.mark('write rejections');
  logRecoveries(placed.filter((id) => prior[id] !== undefined));
  return { placed, refused: new Set(refused.keys()) };
}

// Rebuild and re-offer the specs for `ids`, updating the rejection map
// and the Log with whatever Chrome says this time. Caller must hold the
// registration lock.
async function reregisterScripts(ids: readonly string[]): Promise<void> {
  // Same precondition as the sync: `configureWorld` must precede
  // `register`. Guarded and idempotent: a retry can run before this
  // worker's first sync has configured it.
  await ensureWorldConfigured();
  const { scripts, collections, numbers } = await readAll();
  const handlerVersion = chrome.runtime.getManifest().version;
  const wanted = new Set(ids);
  // Bodies for the scripts being retried only.
  const candidates = await withBodies(scripts.filter((s) => wanted.has(s.id)), collections);
  // Built through collectActiveSpecs rather than buildRegistrationSpec
  // directly so the retry can't drift from the sync on eligibility or
  // on log labels.
  // Only the user specs: the shared GM runtime and bridge registrations
  // belong to the last full sync, which built them for this same script
  // set — a targeted retry re-offers the refused script, not the
  // scaffolding already installed around it.
  const logIds = computeLogIds(scripts.map((s): LogIdInput => ({ id: s.id, relativePath: s.relativePath })), numbers);
  const active = await collectActiveSpecs(candidates, collections, handlerVersion, logIds);
  const specs = active.specs;
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
  if (recordUnsaved) scheduleRecordSave();
  for (const id of applied.placed) {
    dlog(`[SourceMonkey] script ${id} registered on retry`);
    // Keep this context's record of the registration set honest, so a
    // later incremental sync knows to update rather than register.
    const spec = specs.find((s) => s.id === id);
    if (syncState && spec) {
      syncState.registered.set(id, placementsForSpecs([spec], active.gmRuntime)[0]);
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
      message: 'Chrome accepted this script\'s registration, so it runs again',
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
  if (recordUnsaved) scheduleRecordSave();
  return applied.placed.length;
}

// True for a stored script's registration id, false for the reserved
// ids we register for our own plumbing: the bridge and one runtime per
// world. Derived from the world list so a new world can't be missed —
// every piece of own-spec bookkeeping (placement order, fingerprints,
// the rejection map, the refusal retry, the bridge scope) turns on this.
const OWN_IDS: ReadonlySet<string> = new Set([BRIDGE_SCRIPT_ID, ...GM_RUNTIME_WORLDS.map(gmRuntimeIdFor)]);
function isUserScriptId(id: string): boolean {
  return !OWN_IDS.has(id);
}
