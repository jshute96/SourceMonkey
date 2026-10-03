// Building a script row from its text: parsing and validating the
// metadata block, deriving its matching rules and startup notes,
// loading its `@require` / `@resource` files, and the parse check.
//
// The half of the install pipeline that touches no storage, so the
// development harness (src/harness/prepare.ts) can run it under Node
// without the store around it. script-store.ts calls it for every add
// and refresh, and re-exports what its callers know it for.

import {
  getValue,
  getValues,
  isContextMenuRunAt,
  parseHeader,
  splitHeaderBody,
  unsupportedRunAt,
  NO_METADATA_BLOCK,
  type ParsedHeader,
} from './userscript-header.js';
import {
  attachFiles,
  distillRequires,
  distillResources,
  type FileFetchCache,
  type PushedFile,
  type StoredRequire,
  type StoredResource,
} from './external-files.js';
import { localSearchRoots, localRootsReady, type LocalFileScope } from './local-file-overrides.js';
import { canonicalizeGrant, findApi, resolveGrants } from './gm-api-catalog.js';
import { hasNoConnectRules } from './gm-connect.js';
import { sourceUsesUnsafeWindow } from './unsafe-window-use.js';
import {
  ignoredMatchMessage,
  matchPatternProblem,
  unusableMatchMessage,
} from './url-match.js';
import type { VersionProbe } from './version-probe.js';
import type { ParseVerdict } from './parse-check-protocol.js';
import {
  validLocation,
  type DiagnosticLocation,
} from './diagnostic-location.js';
import { sha256Hex } from './bytes.js';
import { dlog } from './debug-log.js';
import { timePhase } from './phase-timing.js';

// `invalid` is the umbrella for "we couldn't load/use this script":
// metadata-block parse failure, header validation failure, fetch
// failure, or a missing/broken @require / @resource. All of them
// surface in the UI as INVALID (the user-facing label) because from
// the user's perspective the script can't run. A script whose own file
// has vanished from its listing is not a status: the row is dropped
// (docs/file-changes.md).
export type ScriptStatus = 'ok' | 'invalid';

export interface ScriptMatching {
  matches: string[];   // @match values
  excludes: string[];  // @exclude values
  includes: string[];  // @include values
}

// Diagnostic produced at parse time and surfaced two ways:
//   1. spliced into the script's wrapper as a `console.<level>(...)`
//      that fires in the page DevTools console on every matching page
//      load (see buildStartupLogsSnippet in injector.ts), and
//   2. emitted as a Log-tab entry once per content version (see
//      emitScriptOutcomeLog in script-updater.ts).
// The producers are the header checks in extractStartupLogs.
export interface StartupLog {
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
  // The header line the diagnostic is about, so the Log tab can link
  // to it. Every producer here reads the metadata block, so the file is
  // always the script's own — but it is stored in full rather than
  // implied, because the Log tab resolves locations from every file
  // through one path and a special case would be the only entry that
  // couldn't name a `@require`.
  location?: DiagnosticLocation;
}

export interface StoredScript {
  id: string;            // UUID, stable across refreshes (keyed on relativePath)
  collectionId: string;
  relativePath: string;
  fileUrl: string;
  status: ScriptStatus;
  errorMessage?: string;
  // Where in the script's own files `errorMessage` is about, when it
  // was derived from their content — a bad `@require` line, an
  // unterminated metadata block, the token a syntax error stopped on.
  // Absent when there is nothing to point at — including a failure to
  // load the SCRIPT itself, where we never got the bytes. A `@require`
  // that wouldn't load is the exception: the file has no content to
  // point into, but the line that declared it does, and that is the
  // line the reader has to change.
  //
  // Never written on its own: `setScriptError` writes the pair, because
  // a location that outlives the message it belongs to would send the
  // reader to a line that has nothing to do with what the row now says.
  errorLocation?: DiagnosticLocation;
  // Set when the latest refresh attempt failed but we still hold a
  // last-known-good copy that's running. Distinct from `errorMessage`
  // (which pairs with `status: 'invalid'` and means "can't run"):
  // a row with `refreshError` keeps `status: 'ok'` and stays injected
  // from its cached body — only the *update* failed. Triggers:
  //   - a hard fetch failure (network error, 404, unreadable file /
  //     disconnected mount) against a prior `ok` row, and
  //   - an http(s) refresh that fetched a 200 but parsed `invalid`
  //     (a login / error page served in place of the script).
  // Cleared automatically the next time a refresh lands valid content
  // (or proves the cached content unchanged). See [docs/storage.md].
  refreshError?: string;
  // UTF-8 byte length of the cached content. `0` is a valid value for
  // an empty file. `null` only on a never-loaded-successfully initial-
  // error row (no body to size); `missing` rows keep their last known
  // size so the UI reflects the cached body.
  size: number | null;
  // Universal "last-change token": a content-derived hash of the
  // fetched source text on the last successful load. Lets the refresh
  // pipeline decide "did anything actually change?" uniformly across
  // collection kinds and schemes — the per-scheme cheap-skip paths
  // (size+fsMtime, conditional GET) avoid the fetch entirely when the
  // collection/server cooperates; this hash catches the cases where a
  // fetch did happen but the content turned out identical (a manifest
  // entry whose server returns no ETag / Last-Modified, or a file://
  // entry inside a manifest where the scan has no per-file stat).
  // Absent only on never-loaded rows.
  contentHash?: string;
  // Fingerprint of the exact source last handed to the compile-only
  // parse check (src/extension/parse-check.ts): the body's `contentHash` plus
  // each `@require`'s. Lets a refresh skip a re-check when nothing
  // that could affect parsing changed, which is the common case on the
  // opportunistic path. Absent means "never checked" — including on
  // rows written before this existed, and on rows whose check could
  // not run.
  parseCheckedHash?: string;
  // Modification time as reported by Chrome's directory listing on the
  // last successful scan. Opaque integer used only for equality —
  // combined with `size`, it lets refresh skip refetching a file whose
  // listing-reported size+mtime are unchanged. Optional because older
  // listings / older stored rows may not have it.
  fsMtime?: number;
  // HTTP-collection validators captured from the last successful fetch.
  // Sent back as If-None-Match / If-Modified-Since on the next refresh
  // so the server can answer 304 instead of resending the body. The
  // 304 path lands in fetchOrSkipInParallel as `unchanged`, mirroring
  // the local size+mtime skip.
  httpEtag?: string;
  httpLastModified?: string;
  // Anything in the source file above the `// ==UserScript==` line.
  // Optional because pre-leadingText stored rows won't carry it; the
  // viewer must treat `undefined` as empty.
  leadingText?: string;
  headerText: string;
  bodyText: string;
  header: ParsedHeader | null;
  matching: ScriptMatching;
  loadedAt: number;      // epoch ms — bumped each time fresh content lands
  enabled: boolean;      // per-script toggle; defaults true on first load
  // Prefetched `@require` bodies, in declaration order, deduped by
  // canonical URL. Optional because pre-`@require`-era stored rows
  // won't carry it; downstream code must treat `undefined` as empty.
  // See [docs/requires.md] / src/external-files.ts for the lifecycle.
  requires?: StoredRequire[];
  // Prefetched `@resource` blobs, in declaration order, deduped by
  // resource name (first declaration wins). Optional because
  // pre-`@resource`-era stored rows won't carry it. Resources share
  // the same fetch + storage pipeline as requires (external-files.ts)
  // but carry raw bytes (base64) rather than decoded text — so they
  // can serve images, fonts, JSON, CSS, etc. via GM_getResource*.
  resources?: StoredResource[];
  // Parse-time diagnostics (today: unknown @grant names). Only
  // populated for `status === 'ok'` rows; error rows don't run so the
  // diagnostics would be dead bytes, and applyFetchError inherits
  // whatever the prior `ok` row had (correct because it also
  // preserves the body the diagnostics were derived from). Persisted so
  // the wrapper rebuild at every SW startup doesn't have to re-derive
  // them — and so the Log-tab emission at content-change time can read
  // them straight off the freshly built row.
  startupLogs?: readonly StartupLog[];
  // True when the script's own body names `unsafeWindow`
  // (`sourceUsesUnsafeWindow`) — derived from the body alone, with no
  // regard to `@grant`; every consumer re-checks the grant itself. When
  // there is no grant line for it, both halves of the grant apply
  // anyway: the script resolves to MAIN world and
  // gets the `const unsafeWindow = window;` binding, which is what
  // Tampermonkey and Violentmonkey do — neither keys the name off a
  // grant line. Derived from `bodyText`, and persisted rather than
  // recomputed: `resolveScriptWorld` sits on the per-sync spec-build
  // path, and every caller has to get the same answer. Absent on rows
  // written before this existed and on error rows (which never run), and
  // reads as false there until the next refresh.
  usesUnsafeWindow?: boolean;
  // What the script's `@updateURL` / `@downloadURL` last claimed, when
  // those point somewhere other than where we load the script from.
  // Purely an annotation: nothing here affects whether the script runs,
  // what gets injected, or the row's `status`. Written only by the
  // probe path (`setVersionProbes`), never by the load pipeline — see
  // [docs/updates.md] and src/version-probe.ts.
  versionProbes?: VersionProbe[];
}

// ---------- Pure helpers (exported for unit tests) ----------

// What the orchestrator hands back from each per-file load attempt.
//   - `ok` : freshly fetched content (with HTTP validators when available)
//   - `error`: fetch attempted and failed
//   - `unchanged`: we skipped the fetch because either (file://) the
//     listing reported the same size+mtime as the stored entry, or
//     (http) the server answered 304 to our conditional GET
export type FetchResult =
  | { ok: true; text: string; httpEtag?: string; httpLastModified?: string }
  | { ok: false; errorMessage: string }
  | { unchanged: true };

// Compute the universal change-detection token for a fetched script
// source. Uses the Web Crypto SubtleCrypto SHA-256 — available
// uniformly in service workers, page contexts, and Node ≥19, so the
// same helper works in production and in unit tests with no
// per-environment polyfill. Async by necessity (SubtleCrypto has no
// sync form on the web platform); buildScriptFromText and
// rebuildCollection (script-store.ts) are async in turn.
export async function hashSource(text: string): Promise<string> {
  return sha256Hex(text);
}

// Pull `@match` / `@exclude` / `@include` lists out of a parsed header.
// These feed the future page-matching/injection logic.
export function distillMatching(header: ParsedHeader | null): ScriptMatching {
  if (!header) return { matches: [], excludes: [], includes: [] };
  return {
    matches: getValues(header, 'match'),
    excludes: getValues(header, 'exclude'),
    includes: getValues(header, 'include'),
  };
}

// Derive parse-time diagnostics from the metadata block (plus one fact
// about the body: whether it names `unsafeWindow` ungranted). Producers
// so far: unknown `@grant` names, `unsafeWindow` combined with
// `@inject-into content`, an ungranted `unsafeWindow` reference
// moving the script into the page, `GM_xmlhttpRequest` with no
// `@connect`, an unsupported `@run-at`, and bad `@match` patterns. Add others here as they come up (e.g.
// deprecated header tags, soft `@resource` failures,
// `@grant`-but-never-called dead grants). Anything that blocks
// `validateHeader` belongs in there instead — error rows skip the
// startup-logs attachment in `buildScriptFromText`.
// Said when a script asks for `unsafeWindow` — by `@grant` or by using
// the name — and also declares `@inject-into content`. Exported so the
// tests and any other surface recognize it by identity rather than by
// matching its wording.
export const ISOLATED_UNSAFE_WINDOW_WARNING =
  'This script cannot reach the page through unsafeWindow. '
  + '@inject-into content makes the script run isolated from main page content, so the '
  + "page's variables read as undefined. Remove @inject-into content to reach them.";

// Said when a script uses `unsafeWindow` with no grant for it and that
// is what put it in the page's world. Exported for the same reason as
// the warning above: recognized by identity, never by its wording.
export const IMPLICIT_UNSAFE_WINDOW_INFO =
  'This script uses unsafeWindow without declaring @grant unsafeWindow. '
  + 'The script runs directly in the page, without isolation.';

// Said when a script grants an API that `@connect` gates (today only
// `GM_xmlhttpRequest`) but declares no `@connect` line: our strict
// default blocks all its requests (see gm-connect.ts). `grant` is the
// name as the script wrote it (`GM.xmlHttpRequest` or the legacy form).
export function noConnectWarning(grant: string): string {
  return `This script has no @connect lines, so all its ${grant} requests are blocked. `
    + 'Add @connect for each host it contacts, or @connect * to allow any host.';
}

// Said for a `@run-at` value we don't honor (a typo). `context-menu`
// is refused instead: see `CONTEXT_MENU_UNSUPPORTED`.
export function unsupportedRunAtWarning(value: string): string {
  return `@run-at ${value} is not supported. The script runs at document-idle instead.`;
}

export function extractStartupLogs(
  header: ParsedHeader | null,
  relativePath: string,
  // `sourceUsesUnsafeWindow(bodyText)` — the body names `unsafeWindow`,
  // grant or no grant. Passed in rather than derived here so the scan
  // happens once per load, on the same text the row stores.
  usesUnsafeWindow = false,
): StartupLog[] {
  if (!header) return [];
  const logs: StartupLog[] = [];
  const grants = getValues(header, 'grant');
  const resolved = resolveGrants(grants);
  const injectInto = (getValue(header, 'inject-into') ?? '').trim().toLowerCase();
  const pinnedIsolated = injectInto === 'content';
  // The two ways a script asks for the page's window: the grant line,
  // and naming `unsafeWindow` in its body without one. Everything below
  // treats them alike — what the script needs is the same either way.
  const wantsUnsafeWindow = resolved.granted.has('unsafeWindow') || usesUnsafeWindow;
  if (grants.length > 0) {
    // `none` wins over every other `@grant` line — no bindings, MAIN
    // world — in both `resolveGrants` and `resolveWorld`. The author
    // probably meant the other lines, so say what happened to them.
    // Only the grants we'd otherwise have honored; a typo'd name gets
    // its own "unsupported" line below and shouldn't be counted twice.
    const overridden = grants
      .map((g) => g.trim())
      .filter((g) => g !== '' && g.toLowerCase() !== 'none' && canonicalizeGrant(g) !== null);
    if (resolved.hasNone && overridden.length > 0) {
      const log: StartupLog = {
        level: 'warn',
        message:
          `@grant none overrides @grant ${overridden.join(', ')}, so the script runs in the ` +
          'page with no GM APIs. Remove the none line to use them.',
      };
      const line = headerTagLine(header, 'grant', 'none');
      if (line !== undefined) log.location = { file: relativePath, line };
      logs.push(log);
    }
    if (resolved.unknown.length > 0) {
      const log: StartupLog = {
        level: 'warn',
        message: `Ignoring unsupported @grant ${resolved.unknown.join(', ')}`,
      };
      // One message can name several bad grants, and they may be spread
      // over several `@grant` lines — so the location is the FIRST one,
      // which is where a reader fixing them starts. The others are named
      // in the message and are a line or two away.
      const line = headerTagLine(header, 'grant', resolved.unknown[0]);
      if (line !== undefined) log.location = { file: relativePath, line };
      logs.push(log);
    }
  }
  // `unsafeWindow` means "the page's real window". That only exists in
  // MAIN world, and `@inject-into content` pins the script to the
  // isolated USER_SCRIPT world, where `unsafeWindow` can only be the
  // isolated realm's own `window` — page globals read as `undefined`.
  // We keep the binding (matching Violentmonkey's content mode) but say
  // so out loud, because the alternative is a script that quietly does
  // nothing. See docs/injection.md#unsafewindow-forces-main-world.
  if (wantsUnsafeWindow && pinnedIsolated) {
    logs.push({ level: 'warn', message: ISOLATED_UNSAFE_WINDOW_WARNING });
  }
  // An ungranted reference moved the script into the page. Said at
  // `info` because nothing is wrong — this is what TM/VM do with the
  // same source — but the world is worth knowing: the script is no
  // longer isolated from page content, and in MAIN world the page can
  // see (and call) the GM runtime the script's other grants need.
  //
  // Only when the reference is what moved it. A script already headed
  // for MAIN (`@inject-into page`, no grants, `@grant none`) gains the
  // binding and stays where it was, so there is nothing to report.
  const movedByReference =
    usesUnsafeWindow
    && !resolved.granted.has('unsafeWindow')
    && !pinnedIsolated
    && injectInto !== 'page'
    && grants.length > 0
    && !resolved.hasNone;
  if (movedByReference) {
    logs.push({ level: 'info', message: IMPLICIT_UNSAFE_WINDOW_INFO });
  }
  // A granted API that needs `@connect`, with none declared. One row
  // even when both spellings are granted: they are one API.
  if (hasNoConnectRules(header)) {
    const needsConnect = grants
      .map((g) => g.trim())
      .find((g) => {
        const name = canonicalizeGrant(g);
        return name !== null && resolved.granted.has(name)
          && (findApi(name)?.requires ?? []).includes('connect');
      });
    if (needsConnect) {
      const log: StartupLog = { level: 'warn', message: noConnectWarning(needsConnect) };
      const line = headerTagLine(header, 'grant', needsConnect);
      if (line !== undefined) log.location = { file: relativePath, line };
      logs.push(log);
    }
  }
  const runAt = unsupportedRunAt(header);
  if (runAt !== undefined) {
    const log: StartupLog = { level: 'warn', message: unsupportedRunAtWarning(runAt) };
    const line = headerTagLine(header, 'run-at', runAt);
    if (line !== undefined) log.location = { file: relativePath, line };
    logs.push(log);
  }
  // A `@match` Chrome's grammar refuses. One of these would take the
  // whole registration down (Chrome refuses the spec, not the pattern),
  // so `buildRegistrationSpec` drops it — and this is what says so, on
  // the line that declared it.
  //
  // One row per bad pattern, unlike the grants above: each has its own
  // reason and its own line, so collapsing them would leave the
  // location pointing at one of several unrelated problems.
  for (const pattern of getValues(header, 'match')) {
    const problem = matchPatternProblem(pattern);
    if (!problem) continue;
    const log: StartupLog = { level: 'warn', message: ignoredMatchMessage(problem) };
    const line = headerTagLine(header, 'match', pattern);
    if (line !== undefined) log.location = { file: relativePath, line };
    logs.push(log);
  }
  return logs;
}

// The line of the `@<tag>` declaration whose value is `value`.
//
// No "near enough" fallback to the first `@<tag>` line: that line is
// usually a perfectly good declaration, and pointing at valid code is
// worse than pointing at nothing — it sends the reader somewhere with
// nothing wrong with it. `HeaderTag.value` is trimmed by `TAG_LINE`
// and the caller reports the trimmed text, so the match holds.
function headerTagLine(
  header: ParsedHeader,
  tag: string,
  value: string,
): number | undefined {
  for (const t of header.tags) {
    if (t.tag !== tag || t.locale) continue;
    if (t.value.trim() === value) return t.line;
  }
  return undefined;
}

// A header problem, and the line worth pointing at.
//
// `line` is in the script's own source; the caller pairs it with the
// file, since this function is deliberately ignorant of which script it
// is looking at. Absent when nothing in the file is the answer.
export interface HeaderProblem {
  message: string;
  line?: number;
}

// The messages `validateHeader` can return. Exported for the same
// reason the split errors are (see `userscript-header.ts`): the corpus
// validator groups failures by message, so these are the strings it
// matches against rather than literals maintained in two places.
//
// Same phrasing rule too — each has to read correctly alone in the
// viewer's message bar and after the preview's `This file cannot be
// installed: ` prefix.
export const NO_NAME = 'No @name in the metadata block';
export const NO_MATCH_OR_INCLUDE =
  'No @match or @include in the metadata block, so this script would never run on any page';
export const CONTEXT_MENU_UNSUPPORTED =
  '@run-at context-menu (run from the right-click menu) is not supported, so this script can\'t run';

// Opens every parse-check verdict (`Syntax error: <what V8 said>`).
// Exported for the same reason as the constants above: the corpus
// validator groups its survey by the message AFTER this prefix, so it
// has to strip exactly what we wrote. It used to carry its own regex,
// which stopped matching the moment this string was recased — and a
// stale recognizer mislabels a whole bucket instead of failing.
export const SYNTAX_ERROR_PREFIX = 'Syntax error: ';

// Verify the parsed header has the fields we require to consider a
// script `ok`. Returns null on success, otherwise a human-readable
// problem. Required: an `@name` plus at least one usable
// `@match` / `@include` (otherwise the script can never match a page).
//
// The missing-tag failures are about something that ISN'T there, so
// none of them has a line of its own. They point at the
// `// ==UserScript==` marker instead: that's the block the missing tag
// belongs in, and where the reader has to go to add it. The unusable
// `@match` case is the exception — the offending text is right there in
// the file, so it gets that line.
export function validateHeader(header: ParsedHeader | null): HeaderProblem | null {
  // No block at all — the whole file is the answer, so no line.
  if (!header) return { message: NO_METADATA_BLOCK };
  const line = header.startLine;
  if (!getValue(header, 'name')) return { message: NO_NAME, line };
  const matches = getValues(header, 'match');
  const includes = getValues(header, 'include');
  if (matches.length === 0 && includes.length === 0) {
    return { message: NO_MATCH_OR_INCLUDE, line };
  }
  // Refused rather than run at load: see `CONTEXT_MENU_RUN_AT`.
  if (isContextMenuRunAt(header)) {
    return {
      message: CONTEXT_MENU_UNSUPPORTED,
      line: headerTagLine(header, 'run-at', (getValue(header, 'run-at') ?? '').trim()) ?? line,
    };
  }
  // Patterns Chrome's grammar refuses are dropped rather than run (see
  // `matchPatternProblem`), so a script whose every `@match` is one of
  // those — with no `@include` to fall back on — is in the same
  // position as one that declared no pattern at all: it can never match
  // a page. Say so with the FIRST bad pattern's own reason, which is
  // more use than the generic sentence above and points at a real line.
  //
  // Only the first: the others' reasons ride on `startupLogs` for an
  // `ok` script, and an `invalid` row doesn't carry those. A reader who
  // fixes this one sees the next on the following load, which is the
  // same one-at-a-time path every other header failure takes.
  if (includes.length === 0) {
    const problems = matches.map((m) => matchPatternProblem(m));
    const first = problems[0];
    if (first && problems.every((p) => p !== null)) {
      return {
        message: unusableMatchMessage(first),
        line: headerTagLine(header, 'match', first.pattern) ?? line,
      };
    }
  }
  return null;
}

interface BuildArgs {
  id: string;
  collectionId: string;
  relativePath: string;
  fileUrl: string;
  text: string;
  now: number;
  // Prior row, if any. Used purely for the content-hash compare: if
  // the freshly fetched bytes hash to the same value as the prior
  // row's `contentHash`, we preserve the prior `loadedAt` so callers
  // (notably the collections page's row-highlight code) can tell that
  // nothing actually changed. This is the universal post-fetch
  // change-detection path — it catches cases the cheap pre-fetch
  // skips (size+mtime, HTTP 304) couldn't handle, e.g. manifest
  // entries or servers that don't return validators.
  prior?: StoredScript;
  httpEtag?: string;
  httpLastModified?: string;
}

// Compose a `StoredScript` from freshly fetched source text. Always
// records the new content (so the viewer reflects what's on disk),
// then determines status by running it through split + parse +
// validate. Any failure along that chain lands in `errorMessage` while
// the content fields stay populated. Async because hashing the source
// for the universal change-detection token uses SubtleCrypto.
export async function buildScriptFromText(args: BuildArgs): Promise<StoredScript> {
  const split = splitHeaderBody(args.text);
  const header = parseHeader(args.text);
  const matching = distillMatching(header);
  // UTF-16 string length ≠ file byte length for non-ASCII content;
  // TextEncoder gives us the wire-accurate UTF-8 byte count.
  const size = new TextEncoder().encode(args.text).length;
  const contentHash = await hashSource(args.text);

  let status: ScriptStatus = 'ok';
  let errorMessage: string | undefined;
  let errorLine: number | undefined;
  if (split.error) {
    status = 'invalid';
    errorMessage = split.error;
    // UNTERMINATED_METADATA_BLOCK gets the line that opened the block
    // that never closed. NO_METADATA_BLOCK gets nothing — there is no
    // marker to point at, and the answer is the file as a whole.
    errorLine = split.headerStartLine;
  } else {
    const problem = validateHeader(header);
    if (problem) {
      status = 'invalid';
      errorMessage = problem.message;
      errorLine = problem.line;
    }
  }

  // Same bytes as last time → preserve the prior load timestamp so
  // the collections page's "what changed" highlight stays accurate even
  // when the cheap skip paths didn't fire. Status still reflects the
  // current parse outcome (parser fixes between refreshes are rare
  // but shouldn't be silently masked).
  const unchanged = args.prior?.contentHash === contentHash;
  const loadedAt = unchanged && args.prior ? args.prior.loadedAt : args.now;

  const entry: StoredScript = {
    id: args.id,
    collectionId: args.collectionId,
    relativePath: args.relativePath,
    fileUrl: args.fileUrl,
    status,
    size,
    contentHash,
    headerText: split.headerText,
    bodyText: split.bodyText,
    header,
    matching,
    loadedAt,
    // New rows default enabled; existing rows preserve their prior
    // value via the merge in rebuildCollection / refreshScript
    // (script-store.ts).
    enabled: true,
  };
  if (errorMessage) {
    setScriptError(entry, errorMessage, locationIn(args.relativePath, errorLine));
  }
  if (args.httpEtag) entry.httpEtag = args.httpEtag;
  if (args.httpLastModified) entry.httpLastModified = args.httpLastModified;
  // Only persist leadingText when non-empty so the vast majority of
  // scripts (which start at `// ==UserScript==`) don't carry an
  // empty-string field.
  if (split.leadingText) entry.leadingText = split.leadingText;
  // Parse-time diagnostics. Only attached when status is `ok` — error
  // rows don't run and never reach the wrapper, so the diagnostics
  // would just be dead bytes in storage. Same shape filter for the
  // empty case keeps the persisted row free of empty arrays.
  if (status === 'ok') {
    // Derived once, here, from the text this row stores — the world
    // decision and the emitted bindings both read the persisted flag.
    const usesUnsafeWindow = sourceUsesUnsafeWindow(split.bodyText);
    if (usesUnsafeWindow) entry.usesUnsafeWindow = true;
    const startupLogs = extractStartupLogs(header, args.relativePath, usesUnsafeWindow);
    if (startupLogs.length > 0) entry.startupLogs = startupLogs;
  }
  return entry;
}

// Apply a hard fetch failure (network error, 404, unreadable file,
// disconnected mount) to an existing entry, preserving the prior
// content either way.
//
//   - prior was `ok`: this is a *refresh* failure, not a content
//     problem — we have a last-known-good copy. Keep it running
//     (`status: 'ok'`) and record `refreshError` so the UI can flag
//     REFRESH FAILED. A transient logout / network blip must never
//     silently disable a working script.
//   - prior was anything else (already invalid): no good copy to
//     protect, so flip to `invalid` with the message as before.
export function applyFetchError(
  existing: StoredScript,
  errorMessage: string,
): StoredScript {
  if (existing.status === 'ok') {
    return { ...existing, refreshError: errorMessage };
  }
  const next: StoredScript = { ...existing, status: 'invalid' };
  // No location: we never got the bytes, so there is no content this
  // message is about. Routed through the setter so the prior row's
  // location can't survive into a message it has nothing to do with.
  setScriptError(next, errorMessage, undefined);
  return next;
}

// Write a row's error message and its location together. They are one
// fact stored in two fields, and every path that changes one has to
// change the other: a location left behind by a previous failure would
// point the reader at a line that has nothing to do with what the row
// now says. Passing `undefined` for the message clears both.
//
// The location is validated on the way in rather than at each of the
// surfaces that renders it — these rows are persisted and reloaded, and
// a click target is not the place to discover a malformed line number.
export function setScriptError(
  entry: StoredScript,
  message: string | undefined,
  location: DiagnosticLocation | undefined,
): void {
  if (message === undefined) delete entry.errorMessage;
  else entry.errorMessage = message;
  const valid = validLocation(location);
  if (valid) entry.errorLocation = valid;
  else delete entry.errorLocation;
}

// A place in the script's own source. `file` is the relative path
// because that is the identity the source map gives a script's own body
// (`buildParseCheckSource` passes it as `mainUrl`) and what the viewer
// matches its main tab against — see `DiagnosticLocation`.
//
// Returns a location even with no line: "this file" is still somewhere
// to go, and it is the honest answer for a file with no metadata block
// at all.
export function locationIn(file: string, line: number | undefined): DiagnosticLocation {
  return line === undefined ? { file } : { file, line };
}

// Build an `invalid` entry for a brand-new (never-loaded-successfully)
// script whose first fetch failed. No content to preserve, so the
// content fields stay empty and size is null.
export function buildInitialInvalidEntry(args: {
  id: string;
  collectionId: string;
  relativePath: string;
  fileUrl: string;
  errorMessage: string;
  now: number;
}): StoredScript {
  return {
    id: args.id,
    collectionId: args.collectionId,
    relativePath: args.relativePath,
    fileUrl: args.fileUrl,
    status: 'invalid',
    errorMessage: args.errorMessage,
    size: null,
    headerText: '',
    bodyText: '',
    header: null,
    matching: { matches: [], excludes: [], includes: [] },
    loadedAt: args.now,
    enabled: true,
  };
}

// Resolve + fetch a script's `@require` bodies AND `@resource` blobs,
// attaching both lists onto the StoredScript. On any failure preserves
// the prior's last-known-good state and flips status to 'invalid' with a
// message naming the offending URL — mirrors `applyFetchError`'s
// content-preservation policy for body-fetch failures, so a flaky
// dependency doesn't clobber the user's working version. Without
// declared deps a userscript usually breaks worse than not injecting,
// so erroring out is safer than running headless.
//
// `recheck === 'preserve'` reuses every cached prior verbatim and only
// fetches refs the script newly declares. `recheck === 'all'` refetches
// every declared file (used by explicit Refresh). The fetchCache is
// shared across all scripts in a single refresh pass so two scripts
// referencing the same canonical URL share one fetch — and a require
// + a resource pointing at the same URL also share a single fetch.
//
// Exported for the development harness (`src/harness/prepare.ts`),
// which runs this half of the pipeline under Node for `sm-dev` and the
// corpus validator. The point is to exercise the production path, so
// it calls this rather than restating the sequence.
export async function applyFiles(
  built: StoredScript,
  prior: StoredScript | undefined,
  recheck: 'all' | 'preserve',
  fetchCache: FileFetchCache,
  now: number,
  // What this script's collection says about local stand-ins — whether
  // they're allowed, and the collection's own root. Defaults to
  // disabled so a caller outside the extension keeps the plain
  // declared-URL behavior.
  localFiles: LocalFileScope = { enabled: false },
  // Whether to wait for the parse verdict before returning. Defaults to
  // 'await' so every caller that hasn't thought about it keeps today's
  // behavior; see `ParseCheckMode`.
  parseCheck: ParseCheckMode = 'await',
  // A scratch script's pushed bodies (sm-dev's local files), which the
  // store reads from the script's `scratchFiles:` row on every pass,
  // like a local stand-in, since a push may have changed them.
  pushedFiles?: Record<string, PushedFile>,
): Promise<StoredScript> {
  const priorRequires = new Map((prior?.requires ?? []).map((r) => [r.url, r]));
  const priorResources = new Map((prior?.resources ?? []).map((r) => [r.url, r]));
  // Configured roots come from storage, so make sure that read has
  // landed before asking — a refresh racing SW startup would otherwise
  // resolve as if none were set and persist that.
  if (localFiles.enabled) await localRootsReady();
  const localRoots = localSearchRoots(built.fileUrl, localFiles);
  // `recheck: 'preserve'` short-circuits when both lists are identical
  // to the prior's: no resolve work, no fetch, just keep what we had.
  // This is the hot path on opportunistic refresh.
  //
  // Skipped entirely when the script has local search roots: a stand-in
  // has to be re-read every pass or an edit on disk wouldn't surface
  // until the user clicked Refresh, which is the workflow the whole
  // feature exists for. The per-entry loaders still preserve cached
  // REMOTE entries in that case, so only local reads are paid for.
  if (recheck === 'preserve' && prior && localRoots.length === 0 && !pushedFiles) {
    const newReqRefs = distillRequires(built.header);
    const sameReqs =
      newReqRefs.length === (prior.requires?.length ?? 0) &&
      newReqRefs.every((ref, i) => prior.requires?.[i]?.ref === ref);
    const newResDecls = distillResources(built.header);
    const sameRess =
      newResDecls.length === (prior.resources?.length ?? 0) &&
      newResDecls.every((d, i) => {
        const p = prior.resources?.[i];
        return p && p.name === d.name && p.ref === d.ref;
      });
    if (sameReqs && sameRess) {
      if (prior.requires) built.requires = prior.requires;
      else delete built.requires;
      if (prior.resources) built.resources = prior.resources;
      else delete built.resources;
      // Still route through the parse check. `built` is a fresh row,
      // so returning here directly would drop `parseCheckedHash` and
      // make every later refresh re-compile content that never moved.
      // The check itself is usually free on this path: the deps are
      // the prior's by construction, so the fingerprint matches unless
      // the BODY changed — which is exactly when a re-check is right.
      return timePhase('parse-check', () => applyParseCheck(built, prior, parseCheck));
    }
  }
  const result = await timePhase('deps', () => attachFiles({
    scriptFileUrl: built.fileUrl,
    header: built.header,
    priorRequires,
    priorResources,
    recheck,
    fetchCache,
    now,
    localRoots,
    ...(pushedFiles ? { pushedFiles } : {}),
  }));
  if (result.errorMessage) {
    // Preserve the last-known-good script state when we have one.
    // This rolls the *entire* refresh back to the prior — the new
    // body isn't applied either, because injecting a fresh body
    // against partial/stale dependencies would be unsafe.
    //
    // A failed @require/@resource fetch against a prior `ok` row is a
    // *refresh* failure, not a content problem: keep the script
    // running on its cached deps (`status: 'ok'`) and record
    // `refreshError` so the UI flags REFRESH FAILED. A flaky dep host
    // (or a logged-out CDN) must never silently disable a working
    // script. Note we can only catch dep *fetch* failures this way —
    // a 200 returning a login page in place of a @require is caught by
    // the require markup gate (HTML rejected) in external-files;
    // @resource bodies are arbitrary bytes and can't be validated.
    if (prior && prior.status === 'ok') {
      return { ...prior, refreshError: result.errorMessage };
    }
    built.status = 'invalid';
    // The file that failed has no content to point into, so the
    // location is the `@require` / `@resource` line that named it —
    // which is the line the reader has to change anyway.
    setScriptError(
      built,
      result.errorMessage,
      locationIn(built.relativePath, result.errorLine),
    );
    delete built.requires;
    delete built.resources;
    return built;
  }
  if (result.requires.length > 0) built.requires = result.requires;
  else delete built.requires;
  if (result.resources.length > 0) built.resources = result.resources;
  else delete built.resources;
  return timePhase('parse-check', () => applyParseCheck(built, prior, parseCheck));
}

// ---------- Parse check hook ----------
//
// The check composes the text the injector would compile
// (`buildParseCheckSource`), but what compiles it depends on the
// context: an offscreen sandbox for the service worker, an iframe for
// an extension page, `new Function` under Node for the harness.
//
// So whoever runs this pipeline installs the checker. `background.ts`
// does it for the service worker, `parse-check-client.ts` for extension
// pages, and `harness/prepare.ts` for the harness.
//
// A context with no checker skips the check. That is NOT a benign
// degradation: building a row resets `status` to `ok`, so a skipped
// check on a row that was `invalid` clears the verdict and reports a
// recovery that never happened. It's tolerable only as a failure mode,
// never as a design — a row left unchecked carries no
// `parseCheckedHash`, so the next refresh re-derives it.
export type ParseChecker = (script: StoredScript) => Promise<ParseVerdict | null>;

// Does the load pipeline wait for the verdict, or hand the row back
// without one?
//
//   - 'await'  — the verdict is part of the row the caller receives.
//                Everything a user is watching (Install, the Refresh
//                buttons, Refresh All, the harness) uses this.
//   - 'defer'  — skip the round trip, return the row unchecked, and let
//                the caller run the check afterwards
//                (`checkParsesInBackground`, script-store.ts). The row keeps no
//                `parseCheckedHash`, so it reads as "never checked" to
//                everything downstream — including the gate in
//                `verifyParseChecks` (script-store.ts) that runs before
//                registration.
//
// 'defer' exists for one caller: the reload fast path, where a wrapper
// in the page is blocking on the reply and the check's round trip (a
// compile in the offscreen document, plus opening that document the
// first time) is most of the budget. See
// [docs/injection.md](../docs/injection.md#reload-fast-path).
export type ParseCheckMode = 'await' | 'defer';

// Exported (read-only by convention) for script-store.ts's rechecks.
export let parseChecker: ParseChecker | null = null;

export function setParseChecker(fn: ParseChecker | null): void {
  parseChecker = fn;
}

// Fingerprint of everything that can affect whether the injected entry
// parses: the body, each `@require` body in order, and our own
// extension version.
//
// The body's `contentHash` covers the WHOLE file including the header,
// so `@grant` / `@require` / `@inject-into` edits all move the key.
//
// The version leg is there because how WE compose and wrap the user
// program decides what parses, and that can change between releases
// with nothing about the script itself changing. (Moving the user
// program into its own nested scope, for one, turned scripts that
// redeclare a `GM_*` name from failures into passes; see
// `wrapCombinedEntry` in injector.ts.) Without the version in the key,
// a cached verdict would survive the upgrade.
export function parseCheckKey(script: StoredScript): string {
  const reqs = (script.requires ?? []).map((r) => r.contentHash).join(',');
  return `${extensionVersion()}|${script.contentHash ?? ''}|${reqs}`;
}

// Guarded because this module is also loaded by the unit suite, which
// runs the compiled output under plain Node with no `chrome` global.
// An empty version there just means the version leg contributes
// nothing to the key, which is correct for a context that never runs
// the check anyway.
function extensionVersion(): string {
  if (typeof chrome === 'undefined' || !chrome.runtime?.getManifest) return '';
  return chrome.runtime.getManifest().version;
}

// Compile the script's user program without running it, and flip the
// row to `invalid` if V8 refuses it.
//
// Why here: this is the last point in the load pipeline where the body
// and every `@require` are both present and final. Before this
// existed, a syntax error anywhere in the concatenated program was
// only discovered at injection time — on a page the script matched,
// reported by the seal entry, and only as "a @require or the script
// body has a syntax error". See [docs/parse-check.md].
//
// `invalid` is deliberate rather than `refreshError`: unlike a failed
// dependency fetch, this is not transient and re-running won't help —
// the content we hold genuinely cannot run. Callers upstream still
// apply their own preservation policy on top; `rebuildCollection`
// (script-store.ts) keeps
// a prior good copy running when an *http* refresh comes back invalid
// (a login page served in place of the script), while a file:// edit
// flags immediately, which is what a local dev wants.
//
// Fails open. `checkParses` returns null when the machinery is
// unavailable, and null must never become `invalid` — a working script
// must not break because our offscreen document didn't open. The seal
// entry remains the backstop for anything missed here.
export async function applyParseCheck(
  built: StoredScript,
  prior: StoredScript | undefined,
  mode: ParseCheckMode = 'await',
): Promise<StoredScript> {
  // Nothing to check on a row that already failed for another reason
  // (missing file, bad header) — there may be no body at all.
  if (built.status !== 'ok') return built;
  const key = parseCheckKey(built);
  // Unchanged since the last check, so the previous verdict still
  // holds. This is what keeps opportunistic refreshes from paying a
  // round trip per script for content that didn't move. Applies in
  // 'defer' mode too — reusing a cached verdict costs nothing, so a
  // deferring caller only leaves the row unchecked when the content
  // really moved.
  if (prior?.parseCheckedHash === key && prior.status === 'ok') {
    built.parseCheckedHash = key;
    return built;
  }
  // Deferred: return the row with no `parseCheckedHash`, which is the
  // same state a row is in when the check couldn't run. The caller runs
  // `checkParsesInBackground` after its write, and `verifyParseChecks`
  // catches the row before registration either way (both in
  // script-store.ts).
  if (mode === 'defer') return built;
  if (!parseChecker) return built;
  let verdict: ParseVerdict | null;
  try {
    verdict = await parseChecker(built);
  } catch (err) {
    // The checker itself failed (a storage read for a storage-granting
    // script's baked-in values, the offscreen document refusing to
    // open). Not the script's fault; skip rather than accuse it.
    dlog(`[SourceMonkey] parse check skipped for ${built.relativePath}: ${describeError(err)}`);
    return built;
  }
  if (!verdict) return built;
  // `unknown` is the machinery saying it couldn't decide — a stack
  // overflow in the parser, a sandbox that lost its CSP. It must not
  // become `invalid`, and it must not be cached as a pass either.
  if (verdict.status === 'unknown') {
    dlog(`[SourceMonkey] parse check inconclusive for ${built.relativePath}: ${verdict.message ?? ''}`);
    return built;
  }
  if (verdict.status === 'ok') {
    built.parseCheckedHash = key;
    return built;
  }
  built.status = 'invalid';
  // The message carries no `(in …)` suffix any more — the location
  // rides alongside it so surfaces can make it clickable, and each of
  // them appends the suffix itself via `describeDiagnostic`. Anything
  // reading `errorMessage` on its own therefore has to pair it with
  // `errorLocation` to say the whole thing.
  setScriptError(
    built,
    // No "script source has a…" prefix: `errorLocation` names the file,
    // and that file is routinely a `@require` rather than the script.
    `${SYNTAX_ERROR_PREFIX}${verdict.message ?? 'unknown'}`,
    verdict.location,
  );
  // Don't record the fingerprint: the row is invalid, and a future
  // refresh that produces the same bytes should re-derive that rather
  // than inherit a stale pass. (`prior` above only short-circuits on a
  // prior `ok`.)
  delete built.parseCheckedHash;
  return built;
}

// The fields a parse verdict owns, copied from the checked row onto
// the stored one. Everything else on the stored row is left as it is
// found — the check has no opinion about it.
export function applyVerdictFields(current: StoredScript, checked: StoredScript): StoredScript {
  const merged: StoredScript = { ...current, status: checked.status };
  setScriptError(merged, checked.errorMessage, checked.errorLocation);
  if (checked.parseCheckedHash) merged.parseCheckedHash = checked.parseCheckedHash;
  else delete merged.parseCheckedHash;
  return merged;
}

// Coerce a caught throw into a printable string. Exported so other
// modules (notably the injector) don't have to duplicate the helper.
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
