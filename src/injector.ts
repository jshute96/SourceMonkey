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
import {
  buildSourceMap,
  inlineSourceMapComment,
  type MappedSegment,
} from './source-map.js';
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

// ---------- Concatenated user source (requires + body) ----------
//
// Every prefetched `@require` body, in declaration order, in front of
// the **full on-disk script source** (leadingText + headerText +
// bodyText). This is the single arrangement both run paths use:
//
//   - the default registration (`wrapCombinedEntry` → one js[] entry);
//   - the reload-fast-path swap eval, where `handleCheckPending` in
//     background.ts sends the same text as the run-new body.
//
// Concatenation IS the feature, not an implementation detail: one
// script means one lexical scope, so a library's top-level
// `const`/`let`/`class` is simply visible to the main body — the same
// thing TM/VM get by concatenating into one IIFE. See
// docs/injection-modes.md for what the separate-entries arrangement
// cost us instead.
//
// A `;\n` separator between segments guards the seam against ASI
// (Automatic Semicolon Insertion). ASI won't fire when the next line
// could continue the previous statement, so a library ending in an
// expression followed by a body opening with `(`, `[`, `` ` ``, `+`,
// `-` or `/` would parse as a single statement. Each file was fine on
// its own; concatenation is what creates the hazard.
//
// The leading `// @require <url>` per require makes the
// concatenated code easier to scan when no source map is applied.
// Line comment (not block) so URLs with `*/` in their path don't
// prematurely close it.

// Where each original file's text lands in the concatenated output.
// `opts.requireUrls[i]` is the synthetic devtools URL for
// `requires[i]` and `opts.mainUrl` the one for the body; callers that
// don't need a source map (the swap-eval path) omit both.
interface ComposedSource {
  text: string;
  // Line-level provenance, ready for src/source-map.ts. Empty when
  // there are no requires, and also whenever the caller omitted the
  // URLs (nothing to attribute lines to).
  segments: MappedSegment[];
  lineCount: number;
}

function composeSource(
  script: StoredScript,
  opts: { requireUrls?: readonly string[]; mainUrl?: string; startLine?: number } = {},
): ComposedSource {
  const mainSource = joinFullSource(
    script.leadingText ?? '',
    script.headerText ?? '',
    script.bodyText,
  );
  const requires = script.requires ?? [];
  const startLine = opts.startLine ?? 0;
  if (requires.length === 0) {
    return {
      text: mainSource,
      segments: [],
      lineCount: countLines(mainSource),
    };
  }

  // Build the text incrementally and derive every line number from
  // what has ACTUALLY been emitted, rather than adding up expected
  // line counts alongside a `join()`. The two drift: a require whose
  // source ends in a lone `\r` fuses with a joining `\n` into a single
  // CRLF, so one terminator appears where the arithmetic assumed two
  // and every mapping from that seam onward — including the whole user
  // body — shifts by a line. CR-only line endings are exactly the
  // population `\r` is in `LINE_TERMINATORS` for, and nothing
  // normalizes newlines on the way in (file-loader stores the decoded
  // bytes verbatim).
  const segments: MappedSegment[] = [];
  let text = '';
  // 0-based generated line that the NEXT character appended will land
  // on. `countLines('')` is 1, so an empty buffer is line 0.
  const nextLine = (): number => startLine + countLines(text) - 1;

  for (const [i, r] of requires.entries()) {
    text += `// @require ${r.url}\n`;
    const url = opts.requireUrls?.[i];
    if (url) {
      segments.push({
        url,
        content: r.source,
        generatedLine: nextLine(),
        lineCount: countLines(r.source),
      });
    }
    // The trailing-`\r` guard: append the extra `\n` here so the
    // source's own last line stays a line of its own, instead of being
    // swallowed by the separator that follows.
    text += r.source.endsWith('\r') ? `${r.source}\n` : r.source;
    // Terminate the source's last line, then the `;` seam guard on a
    // line of its own.
    text += '\n;\n';
  }
  if (opts.mainUrl) {
    segments.push({
      url: opts.mainUrl,
      content: mainSource,
      generatedLine: nextLine(),
      lineCount: countLines(mainSource),
    });
  }
  text += mainSource;

  return { text, segments, lineCount: countLines(text) };
}


// Count lines the way V8 does, which is what the source map has to
// agree with. Counting only `\n` is wrong in three ways that all
// silently shift every mapping after the offending character:
//
//   - a lone `\r` is a line terminator (files with mangled endings);
//   - so are U+2028 / U+2029, and V8 counts a RAW U+2028 as a break
//     even inside a string literal (legal since ES2019, and minified
//     CDN bundles do embed them).
//
// `\r\n` must count as one, hence the alternation order.
const LINE_TERMINATORS = /\r\n|[\n\r\u2028\u2029]/g;

function countLines(text: string): number {
  if (text === '') return 1;
  const matches = text.match(LINE_TERMINATORS);
  return matches ? matches.length + 1 : 1;
}

// Public entry point for the swap-eval path, which needs the text only.
export function composeRequiredBody(script: StoredScript): string {
  return composeSource(script).text;
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
  if (cfg.startupLogs && cfg.startupLogs.length > 0) wire.startupLogs = cfg.startupLogs;
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
    const body = joinFullSource(
      args.script.leadingText ?? '',
      args.script.headerText ?? '',
      args.script.bodyText,
    );
    return head + body + `\n});\n//# sourceURL=${args.sourceUrl}\n`;
  }

  // Head occupies generated line 0; user source starts at line 1.
  const composed = composeSource(args.script, {
    requireUrls: args.requireUrls,
    mainUrl: args.sourceUrl,
    startLine: 1,
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
  // directly, with a newline so the composed source starts at line 2.
  //
  // NOTE: the swap path emits no source map — the prelude's
  // `(0,eval)` only appends `//# sourceURL=`. So a hot-swapped script
  // with `@require`s reports concatenated line numbers where a fresh
  // registration would report original ones. Folded into the Log-tab
  // mapping follow-up in TODO.md.
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
