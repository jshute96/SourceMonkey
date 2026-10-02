// Persistent userscript store backed by chrome.storage.local.
//
// Layout (one row per record, no monolithic blob):
//
//   "collections"      → string[]            index of collection IDs
//   "collection:<cid>" → StoredCollection     per-collection metadata
//   "script:<scid>"    → StoredScript         per-script content+header
//
// Collections own their scripts via `scriptIds`. Scripts back-reference
// their collection via `collectionId` so the viewer page can refresh a
// single script without first looking up its parent.
//
// All add/refresh flows go through one pipeline:
//   listing → fetch each file → splitHeaderBody → parseHeader →
//   validateHeader → distillMatching → buildScriptFromText.
// A script is `ok` iff fetch succeeded AND splitHeaderBody returned no
// error AND validateHeader returned null. Otherwise `status: 'invalid'`
// with an `errorMessage`. On refresh, files that were known before but
// no longer appear in the scan listing are dropped — row and storage key
// both — whatever kind of collection they sat in, and however many
// went: a successful scan is the collection saying what it holds now.
// (A listing that isn't one — an error page, a moved directory — fails
// the scan instead, and a failed scan touches nothing; see
// `isDirectoryListing`.) In every error case we preserve the
// previously loaded content so the viewer (and the injector) keep
// working.
//
// Refresh failures get special, gentler handling so a transient
// outage never disables a working script. When a prior `ok` row's
// refresh fails — a hard fetch failure (network / 404 / unreadable
// file / disconnected mount), an http(s) 200 that parses `invalid` (a
// login / error page in place of the script), or a failed
// `@require`/`@resource` fetch — we keep the last-known-good row
// running (`status` stays `ok`, still injectable) and record the
// reason in `refreshError`. The next clean refresh clears it. A
// file:// body that parses `invalid` is the one exception: a local
// read returns the file's real bytes, so that's a genuine edit and we
// flag it `invalid` immediately. See [docs/storage.md].
//
// If the scan step itself fails (unreadable listing, unreadable
// manifest, …), refreshCollection records the error in `scanError` on
// the collection row and leaves every existing script untouched — see
// that function's docstring for the rationale.

import {
  canonicalCollectionInput,
  containerKindForSingleFileInput,
  containerPath,
  fetchScriptFileUrlText,
  fetchHttpText,
  isContainerCollection,
  isHttpUrl,
  isLocalDirectoryCollection,
  isSingleFileInput,
  SCRATCH_CONTAINER_PATH,
  isScratchUrl,
  scratchTextKey,
  scratchUrl,
  baseName,
  isFileUrl,
  isManifestCollection,
  parentDir,
  type ListingEntry,
  newContainerPath,
  normalizeCollectionInput,
  SINGLE_SCRIPT_USE_ADD_FIELD,
  scanForUserScripts,
  scriptFileUrl,
  statFileByListing,
  collectionCanonicalUrl,
  locationFsPath,
  statFromListing,
  hasCachedListing,
  type DirectoryListingCache,
} from './directories.js';
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
  bindListingCache,
  distillRequires,
  distillResources,
  type FileFetchCache,
  type StoredRequire,
  type StoredResource,
} from './external-files.js';
import { localSearchRoots, localRootsReady, type LocalFileScope } from './local-file-overrides.js';
import { scanAllStorage } from './storage-scan.js';
import { wipeScriptValues } from './gm-values.js';
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
  describeDiagnostic,
  validLocation,
  type DiagnosticLocation,
} from './diagnostic-location.js';
import { displayLocation, stripSriFragment, type LoadState } from './script-display.js';
import {
  collectionNameInUse,
  inferDisplayName,
  mayUseReservedName,
  RESERVED_COLLECTION_NAME,
} from './collection-display.js';
import { appendScriptLog, forgetScriptLogs, type LogLevel } from './script-log.js';
import { sha256Hex } from './bytes.js';
import { setRefreshError, pruneRefreshErrors } from './refresh-error.js';
import {
  mapWithConcurrency,
  FETCH_SCRIPTS_PER_COLLECTION_CONCURRENCY,
  FETCH_COLLECTIONS_CONCURRENCY,
  PARSE_RECHECK_CONCURRENCY,
} from './concurrency.js';
import { dlog } from './debug-log.js';
import { startPhaseTimer, timePhase, formatMs, timingNow } from './phase-timing.js';

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
  // parse check (src/parse-check.ts): the body's `contentHash` plus
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

export interface StoredCollection {
  id: string;
  path: string;
  lastRefreshedAt: number;
  scriptIds: string[];
  scanError?: string;    // set when the scan itself failed (directory listing, manifest fetch, bad URL shape)
  enabled: boolean;      // per-collection toggle; defaults true on first load
  // Short, human-readable label for the collections page heading + the
  // viewer's Collection row. Backfilled from `inferDisplayName(path)`
  // on first read after upgrade (see `backfillCollectionDisplayNames`)
  // so every persisted row carries one. Treated as a future user-
  // overridable value: when set, the UI uses it verbatim; the inferred
  // form is only consulted when this field is absent/empty.
  displayName?: string;
  // Per-collection opt-OUT of local stand-ins for `@require` /
  // `@resource` files (see `src/local-file-overrides.ts` and
  // docs/local-file-overrides.md). Only an explicit `false` disables
  // it, so every row persisted before this field existed reads as
  // enabled — which is the behavior a local directory collection wants
  // by default.
  //
  // Off is for a directory of scripts you didn't write, where a file
  // sitting next to a script should NOT quietly stand in for the
  // library it names.
  localFiles?: boolean;
  // A `file://` manifest's own listing size and mtime at the last
  // successful scan, so a page can tell the manifest was edited without
  // re-reading it (file-changes.ts). Absent for every other kind, and
  // when the manifest's folder wouldn't list.
  manifestSize?: number;
  manifestMtime?: number;
}

// Treat any pre-`localFiles`-era stored entry as enabled, the same way
// `isCollectionEnabled` treats `enabled`.
export function collectionUsesLocalFiles(collection: StoredCollection): boolean {
  return collection.localFiles !== false;
}

// Everything the local-stand-in resolver needs from a collection row,
// in one value — so no caller can pass the toggle and forget the root.
export function localFileScope(collection: StoredCollection): LocalFileScope {
  return { enabled: collectionUsesLocalFiles(collection), collectionPath: collection.path };
}

// Treat any pre-`enabled`-era stored entry as enabled. The schema now
// requires `enabled: boolean`, but rows persisted before this field was
// introduced will read back as undefined; only an explicit `false`
// should count as disabled.
export function isCollectionEnabled(collection: StoredCollection): boolean {
  return collection.enabled !== false;
}
export function isScriptEnabled(script: StoredScript): boolean {
  return script.enabled !== false;
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
// rebuildCollection are async in turn.
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
    // value via the merge in rebuildCollection / refreshScript.
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
function locationIn(file: string, line: number | undefined): DiagnosticLocation {
  return line === undefined ? { file } : { file, line };
}

// Two states that used to share the message `not loaded`, which read as
// the same fact but isn't: one is a row waiting for its first fetch, the
// other is a row whose fetch never happened and won't be retried until
// the next refresh.
const NOT_LOADED_YET = 'Not loaded yet';
const NOT_READ = 'Could not be read';

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

// The per-script Log entry a row's *persisted load state* warrants, or
// null when the row is healthy (`ok` with no `refreshError`).
//
// Single source of truth for "how do we phrase this failure in the
// Log tab", shared by every path that can surface one: the add path
// (script-store), the refresh outcome path and the startup replay
// (script-updater), and the deferred parse check. Sharing it means the
// same failure reads the same way whichever path reported it, so a
// user comparing two rows can tell "the same problem again" from "a
// different problem".
//
// Each entry carries the `state` it moved the row into — the same word
// the Status badge shows — so the Log tab's status column and the badge
// agree (see `LogEntry.state`). Because it carries a state, the entry
// never bumps the `loglevel:` sentinel: the badge comes from the row
// and clears when the row recovers.
//
// Levels (still recorded on the entry, though the Log tab's Status
// cell shows the `state` word instead):
//   - `invalid` → **error**. The script cannot run: the injector skips
//     `invalid` rows outright.
//   - `refreshError` → **warning**. The script IS still running, from
//     its last-known-good copy; only the *update* failed.
export function loadStateLogEntry(
  script: Pick<StoredScript, 'status' | 'errorMessage' | 'refreshError' | 'errorLocation'>,
): { level: LogLevel; state: LoadState; message: string; location?: DiagnosticLocation } | null {
  if (script.status === 'invalid') {
    // The location travels as its own field rather than being baked
    // into the text, so the Log tab can link it — and so this entry
    // says exactly what the status badge's hover text says.
    return {
      level: 'error',
      state: 'invalid',
      message: script.errorMessage ?? 'Unknown error',
      ...(script.errorLocation ? { location: script.errorLocation } : {}),
    };
  }
  if (script.refreshError) {
    return { level: 'warning', state: 'refresh-failed', message: `Refresh failed: ${script.refreshError}` };
  }
  return null;
}

// Log lines for local stand-ins that started, stopped, or changed on
// disk between two versions of a row.
//
// Why log this at all: running something other than what the `@require`
// line names is exactly the kind of substitution that must not be
// silent. The viewer marks it too (a `local` chip on the tab and in the
// details panel), but the Log is what says *when* it happened, and a
// re-read after an edit is the signal a developer is actually watching
// for.
//
// Why it isn't noisy: `contentHash` gates the "still using it" case, so
// a stand-in that hasn't changed says nothing on the dozens of
// opportunistic refreshes between edits.
//
// All `info`, losing a stand-in included: the script is back on the
// code its `@require` line names, which is not a fault. The line says
// what is loaded now, so the switch is still on record.
// How a declared reference reads in a Log line: the SRI hash tail
// dropped (it's most of the line's width and nothing the reader can act
// on) and percent-escapes decoded, so a URL carrying a script's name
// reads as `my lib/util.js` rather than `my%20lib/util.js`. Same
// treatment every other URL a human sees already gets.
const refText = (ref: string): string => displayLocation(stripSriFragment(ref));

export function localFileLogMessages(
  prior: StoredScript | undefined,
  next: StoredScript,
): { level: LogLevel; message: string }[] {
  const out: { level: LogLevel; message: string }[] = [];
  // Keyed by KIND + declared URL. The URL alone would collide: a
  // `@require` and a `@resource` pointing at the same URL is an
  // explicitly supported case (they share one fetch — see
  // external-files.ts), and a single map would hand the require the
  // resource's record on a last-write-wins basis.
  //
  // The URL rather than the ref is the right half of the key: it's the
  // field that stays put while the stand-in appears and disappears
  // underneath it.
  const priorFiles = new Map<string, { localUrl?: string; contentHash: string }>();
  const priorKey = (kind: string, url: string): string => `${kind}\n${url}`;
  for (const f of prior?.requires ?? []) {
    priorFiles.set(priorKey('require', f.url), { localUrl: f.localUrl, contentHash: f.contentHash });
  }
  for (const f of prior?.resources ?? []) {
    priorFiles.set(priorKey('resource', f.url), { localUrl: f.localUrl, contentHash: f.contentHash });
  }
  for (const kind of ['require', 'resource'] as const) {
    const list = kind === 'require' ? (next.requires ?? []) : (next.resources ?? []);
    for (const f of list) {
      const was = priorFiles.get(priorKey(kind, f.url));
      if (f.localUrl) {
        // Same file, same bytes as last pass → nothing happened.
        if (was?.localUrl === f.localUrl && was.contentHash === f.contentHash) continue;
        out.push({
          level: 'info',
          message: `@${kind} ${refText(f.ref)} is loading from ${displayLocation(f.localUrl)}`,
        });
      } else if (was?.localUrl) {
        out.push({
          level: 'info',
          message: `@${kind} ${refText(f.ref)} is no longer loading from a local file; `
            + 'the remote version is loaded instead',
        });
      }
    }
  }
  // A declaration the script dropped isn't reported — the `@require`
  // line going away is the event, and it isn't this function's to tell.
  //
  // Deduped because two `@resource` lines may name the same URL under
  // different names (deliberately — see `distillResources`), and both
  // entries would otherwise produce the identical line.
  const seen = new Set<string>();
  return out.filter((e) => !seen.has(e.message) && seen.add(e.message));
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
  if (recheck === 'preserve' && prior && localRoots.length === 0) {
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
// The check needs the exact text the *injector* would compile, so the
// natural call would be `injector.buildParseCheckSource`. But
// `injector.ts` imports runtime helpers from this module, and a real
// (not type-only) cycle between them is something this codebase
// deliberately avoids — see the note on `collection-display.ts`.
//
// So the dependency is inverted: whoever owns both modules installs
// the checker. `background.ts` does it for the service worker,
// `parse-check-client.ts` for extension pages — and both are needed,
// because this pipeline runs in whichever context called it.
//
// A context with no checker skips the check. That is NOT a benign
// degradation: the rebuild below resets `status` to `ok`, so a skipped
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
//                (`checkParsesInBackground`). The row keeps no
//                `parseCheckedHash`, so it reads as "never checked" to
//                everything downstream — including the gate in
//                `verifyParseChecks` that runs before registration.
//
// 'defer' exists for one caller: the reload fast path, where a wrapper
// in the page is blocking on the reply and the check's round trip (a
// compile in the offscreen document, plus opening that document the
// first time) is most of the budget. See
// [docs/injection.md](../docs/injection.md#reload-fast-path).
export type ParseCheckMode = 'await' | 'defer';

let parseChecker: ParseChecker | null = null;

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
function parseCheckKey(script: StoredScript): string {
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
// apply their own preservation policy on top; `rebuildCollection` keeps
// a prior good copy running when an *http* refresh comes back invalid
// (a login page served in place of the script), while a file:// edit
// flags immediately, which is what a local dev wants.
//
// Fails open. `checkParses` returns null when the machinery is
// unavailable, and null must never become `invalid` — a working script
// must not break because our offscreen document didn't open. The seal
// entry remains the backstop for anything missed here.
async function applyParseCheck(
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
  // catches the row before registration either way.
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
function applyVerdictFields(current: StoredScript, checked: StoredScript): StoredScript {
  const merged: StoredScript = { ...current, status: checked.status };
  setScriptError(merged, checked.errorMessage, checked.errorLocation);
  if (checked.parseCheckedHash) merged.parseCheckedHash = checked.parseCheckedHash;
  else delete merged.parseCheckedHash;
  return merged;
}

// Re-derive the parse verdict for rows that carry none, and persist
// what comes back.
//
// ---------- Why a second entry point ----------
//
// `applyParseCheck` runs inside the load pipeline, so it only ever
// sees rows that are being *built* — added, refreshed, edited. A row
// that was stored before the check existed, or while the check was
// failing open (no offscreen document, sandbox unavailable), keeps
// `status: 'ok'` with no `parseCheckedHash` and is never revisited
// until something rebuilds it. Registering one of those is how
// unparsable source reaches Chrome.
//
// That matters beyond the script not running. A registered entry that
// V8 refuses to compile raises an uncaught `SyntaxError` attributed to
// the extension, which Chrome files under
// `chrome://extensions/?errors` — nothing can catch it in-page, and it
// reads as SourceMonkey being broken rather than the script being
// broken. Not registering it is the only way to keep it out of there;
// the seal entry (`__smSealed`) stays as the backstop for whatever
// still gets through.
//
// Caller passes the rows it is about to register — checking a
// disabled script would spend a round trip on code nothing will run.
//
// Returns, keyed by id, the rows whose STORED state differs from the
// copy the caller passed in — the ones this pass wrote, and the ones it
// refused to write because someone else had already moved the row. The
// caller's job is the same either way: swap ours in. Returning only the
// rows we WROTE is what made the refusal branches below a bug —
// `revalidateCandidates` falls back to the snapshot it read before the
// check, which is the row that still says `ok`, and registers the very
// body we just declined to write a verdict over.
//
// One case is deliberately not covered: a row DELETED while the check
// was out is absent from the result, because there is no stored row to
// hand back. The caller keeps its snapshot and registers a script that
// no longer exists for one cycle, until the write that deleted it
// schedules the sync that drops it.
//
// Fails open exactly like the pipeline check: no checker, an
// inconclusive verdict, or a throw all leave the row alone.
export async function verifyParseChecks(
  scripts: StoredScript[],
): Promise<Map<string, StoredScript>> {
  const changed = new Map<string, StoredScript>();
  if (!parseChecker) return changed;
  // A row the check couldn't decide on records nothing, so it stays
  // stale and is asked about again on the next sync. That is
  // deliberate: the two ways to be undecided are "the machinery isn't
  // there" (answered without compiling anything, and it can come back
  // — the off-switch the tests use lives here) and "V8 ran out of
  // parser budget", which the sandbox's own circuit breaker already
  // rations. Remembering the verdict-free attempt instead would mean a
  // row checked while the machinery was down never gets checked again.
  const stale = scripts.filter(
    (s) => s.status === 'ok' && s.parseCheckedHash !== parseCheckKey(s),
  );
  if (stale.length === 0) return changed;
  // Rows another pass is already compiling are joined rather than
  // compiled again. Both entry points reach the same bytes on the
  // reload path — the deferred check the refresh started, and the sync
  // that same refresh's write scheduled — and a compile is the
  // expensive part of this whole feature. See `inFlightChecks`.
  const own: StoredScript[] = [];
  const joined: Promise<void>[] = [];
  for (const s of stale) {
    const running = inFlightChecks.get(inFlightCheckKey(s));
    if (running) joined.push(running.then((row) => { if (row) changed.set(s.id, row); }));
    else own.push(s);
  }
  // Declared out here and filled inside the `try` so a throw partway
  // through the claim loop still reaches the `finally` that settles it.
  // A claimed key with no resolver would wedge every later pass over
  // that row on a promise that never settles. (`const settle =` inside
  // the `try` cannot work — the `finally` would read it in its TDZ.)
  const settle = new Map<string, InFlightCheck>();
  try {
    claimInFlightChecks(own, settle);
    await Promise.all([runOwnParseChecks(own, changed), ...joined]);
  } finally {
    // Resolve with the row as it now stands so a joiner gets what a
    // caller of its own would have got — including the refusal cases,
    // where the row we hand back is someone else's write rather than
    // ours. A throw resolves them with the input row, which is what
    // "nothing was recorded" looks like to every reader.
    for (const [key, entry] of settle) {
      entry.resolve(changed.get(entry.id) ?? null);
      inFlightChecks.delete(key);
    }
  }
  return changed;
}

// The compile-and-store half of `verifyParseChecks`, for the rows this
// call owns. Fills `changed` in place.
async function runOwnParseChecks(
  own: StoredScript[],
  changed: Map<string, StoredScript>,
): Promise<void> {
  if (own.length === 0) return;
  // `prior` is deliberately undefined: the short-circuit it exists for
  // is the one the staleness filter already applied.
  //
  // Capped rather than `Promise.all`: `own` is normally empty or tiny,
  // but the first sync after an extension update finds the whole
  // library stale at once (the version is part of the key), and each
  // compile composes a whole program in memory.
  const checked = await mapWithConcurrency(
    own,
    PARSE_RECHECK_CONCURRENCY,
    (s) => applyParseCheck({ ...s }, undefined),
  );
  const verdicts = new Map<string, StoredScript>();
  for (const next of checked) {
    // Nothing to record when the check couldn't decide — no verdict,
    // no fingerprint, and the row is untouched.
    if (next.status === 'ok' && !next.parseCheckedHash) continue;
    verdicts.set(next.id, next);
  }
  if (verdicts.size === 0) return;
  // Rows this pass wrote and that can no longer run. Collected inside
  // the lock, reported outside it — a Log append is not storage-row
  // work and has its own queue.
  const flipped: StoredScript[] = [];
  await mutate(async () => {
    const keys = [...verdicts.keys()].map(scriptKey);
    const got = await getMany(keys);
    const toSet: Record<string, unknown> = {};
    for (const [id, next] of verdicts) {
      // Re-read rather than trusting the copy we checked: the check is
      // a round trip to another context, and a refresh could have
      // rewritten the row while it was out. A row whose fingerprint
      // inputs moved is one our verdict is no longer about.
      const current = got[scriptKey(id)] as StoredScript | undefined;
      // The row was deleted while the check was out. Nothing to write
      // and nothing to hand back — a row that isn't stored is not a row
      // the caller can be given a fresher copy of.
      if (!current) continue;
      if (parseCheckKey(current) !== parseCheckKey(next)) {
        // Refused, not dropped: the caller is holding a copy from
        // before this row moved, and letting it fall back to that is
        // how an unchecked body gets registered.
        changed.set(id, current);
        continue;
      }
      // The verdict was formed against a row that was `ok`. A row that
      // has since left that state left it for a reason this check knows
      // nothing about — a read failed, a `@require` stopped loading —
      // and writing our `status` over it would resurrect a state that
      // is no longer true. The fingerprint alone doesn't catch this:
      // `applyFetchError` preserves the content the fingerprint is made
      // of.
      if (current.status !== 'ok') {
        changed.set(id, current);
        continue;
      }
      // Merge the verdict ONTO the row we just read, rather than
      // writing the copy we checked. Same fingerprint doesn't mean same
      // row: `enabled`, `versionProbes` and the rest can have moved
      // while the check was out, and writing our copy would roll them
      // back.
      const merged = applyVerdictFields(current, next);
      changed.set(id, merged);
      toSet[scriptKey(id)] = merged;
      if (merged.status !== 'ok') flipped.push(merged);
    }
    if (Object.keys(toSet).length > 0) await writeLocal(toSet);
  });
  // Say so in the Log. This lives here rather than at a caller because
  // whichever pass wins the write is the one that knows — the deferred
  // check, the sync's gate before registration, or a later sync after
  // the worker was evicted mid-check. Keyed off what was WRITTEN, so a
  // refused verdict stays quiet rather than announcing a state it
  // didn't put there.
  for (const row of flipped) {
    const entry = loadStateLogEntry(row);
    if (entry) void appendScriptLog(row.id, { ...entry, source: 'parser' });
  }
}

// Parse checks in flight, keyed by row id + fingerprint, so two passes
// over the same bytes compile once. The reload path produces exactly
// that overlap by design: the refresh defers its check and starts one
// here, and its storage write schedules a sync whose registration gate
// finds the same row unchecked ~50 ms later.
//
// Keyed on the fingerprint as well as the id because a row that moved
// again is different work, not the same work twice.
//
// Per JS context, like every other module-level table here: the viewer
// and the collections page import this module into their own contexts
// and get their own map. Nothing is wrong with that — each context has
// its own checker and its own sandbox — it just means the dedupe is
// within a context, not across the extension.
interface InFlightCheck {
  id: string;
  resolve: (row: StoredScript | null) => void;
}
const inFlightChecks = new Map<string, Promise<StoredScript | null>>();
const inFlightCheckKey = (s: StoredScript): string => `${s.id}|${parseCheckKey(s)}`;

// Register `own` as in flight, recording into `settle` the resolvers the
// caller must settle when it is done. Claimed synchronously, before the
// first await, so a pass starting later in the same turn joins rather
// than duplicating.
//
// Fills a caller-owned map rather than returning one so a throw
// mid-loop still leaves the caller holding what was claimed so far —
// see the `finally` in `verifyParseChecks`.
function claimInFlightChecks(
  own: StoredScript[],
  settle: Map<string, InFlightCheck>,
): void {
  for (const s of own) {
    const key = inFlightCheckKey(s);
    if (inFlightChecks.has(key)) continue;   // same row twice in one call
    let resolve!: (row: StoredScript | null) => void;
    inFlightChecks.set(key, new Promise<StoredScript | null>((r) => { resolve = r; }));
    settle.set(key, { id: s.id, resolve });
  }
}

// No reset hook for `inFlightChecks`, unlike the other worker module
// state `resetAllState` clears by name: an entry only exists while a
// check is running and its `finally` removes it, so there is nothing
// for a storage wipe to strand. A wipe landing mid-check leaves at most
// one already-started compile whose write is refused when the row it
// judged is gone.

// Run the check a `ParseCheckMode: 'defer'` refresh skipped, after that
// refresh has already stored its row. Not awaited by its caller — the
// point of deferring is that nothing waits for the verdict.
//
// `verifyParseChecks` is the whole implementation: it re-reads the row
// inside the write lock, refuses to apply a verdict the row has moved
// out from under, and merges only the verdict's own fields. That is
// exactly the race a late verdict has to survive, so this deliberately
// does not open a second path to the same write.
//
// If the worker dies before the verdict lands, the row simply stays
// unchecked: it carries no `parseCheckedHash`, so the gate every
// registration sync runs (`revalidateCandidates` in injector.ts) finds
// it stale and derives the verdict before Chrome is offered the body.
// What is lost is timeliness, not the check.
export function checkParsesInBackground(script: StoredScript): void {
  if (script.status !== 'ok') return;
  if (script.parseCheckedHash === parseCheckKey(script)) return;
  void verifyParseChecks([script]).catch((err) => {
    // Same failing-open contract as the pipeline check: the row stays
    // unchecked, and the gate before registration asks again.
    dlog(`[SourceMonkey] deferred parse check failed for ${script.relativePath}: ${describeError(err)}`);
  });
}

interface ScanEntry {
  relativePath: string;
  size?: number;
  mtime?: number;
}

// Does an `invalid` parse of this entry keep the PRIOR copy running,
// rather than becoming the row's new state?
//
// True for an http(s) entry with a prior `ok` copy: a 200 that doesn't
// parse is usually a login or error page served in place of the script,
// so it is a *refresh* failure (`refreshError`, still injecting the
// cached body) and not a content replacement. A `file://` read returns
// the file's real bytes, so an `invalid` parse there is a genuine local
// edit the user wants flagged immediately.
//
// One predicate, two readers: the rule itself in `rebuildCollection`,
// and the decision about whether that entry's parse check may be
// deferred. Deferring is only safe where the verdict lands on the row
// directly, so the two have to answer the same question — hence one
// function rather than two spellings of it 60 lines apart.
function keepsPriorOnInvalid(
  fileUrl: string,
  prior: StoredScript | undefined,
): prior is StoredScript {
  return isHttpUrl(fileUrl) && prior?.status === 'ok';
}

interface RebuildArgs {
  collectionId: string;
  collectionPath: string;
  existing: StoredScript[];
  scan: ScanEntry[];
  fetchResults: Map<string, FetchResult>;  // keyed by relativePath
  now: number;
  newId?: () => string;
  // `@require` + `@resource` recheck policy:
  //   - 'all'     : refetch every declared dep regardless of whether
  //                 the script body changed. Used by explicit Refresh
  //                 so users can pick up remote updates even when the
  //                 main script body is unchanged.
  //   - 'preserve': reuse cached priors verbatim; only fetch refs the
  //                 script newly declares. Used by opportunistic
  //                 (background) refresh to keep page-load cost
  //                 bounded — the user can always click Refresh to
  //                 pick up remote dep updates.
  // Defaults to 'all' so the conservative behavior is the fallback.
  recheckFiles?: 'all' | 'preserve';
  // Cross-script file-fetch cache. Two scripts referencing the same
  // canonical URL share one fetch — and a require + resource pointing
  // at the same URL also share. Caller passes a fresh map per top-
  // level refresh entry point (refreshCollection / refreshScript /
  // refreshAllCollections); rebuildCollection itself never mutates the
  // entry semantics, just hands the cache to attachFiles.
  fileFetchCache?: FileFetchCache;
  // What this collection says about local stand-ins for the files its
  // scripts declare — the `StoredCollection.localFiles` toggle plus the
  // root to search. One value rather than the whole collection row, and
  // `localFileScope` is the one thing that builds it. Defaults to
  // disabled so a caller that hasn't thought about it gets the
  // declared-URL-only behavior.
  localFiles?: LocalFileScope;
  // Whether the rows this returns carry a parse verdict. Defaults to
  // 'await'; see `ParseCheckMode`. A 'defer' caller owes the rows a
  // `checkParsesInBackground` after it has written them.
  parseCheck?: ParseCheckMode;
}

// Pure orchestrator: given the prior state for a collection plus a
// fresh scan and the per-file fetch results, return the new list of
// `StoredScript`s in canonical order (scan order). Stable IDs come
// from looking up by relativePath in `existing`. No I/O — easy to test.
//
// Vanished-entry handling — an entry the scan no longer reports is
// dropped entirely (the `refreshCollection` caller then deletes the
// storage row), because a successful scan is the collection telling us
// what it holds now: a renamed or deleted file would otherwise linger
// as a row the user has to clear by hand. That holds for a scan that
// found nothing at all, too — an empty directory, or one with no
// `.user.js` files left in it, is as definite as an empty manifest.
// What it does NOT hold for is a scan that failed, and that never
// reaches here: `refreshCollection` records the `scanError` and leaves
// every row alone. The listing reader is what keeps the two apart
// (`isDirectoryListing` in directories.ts).
export async function rebuildCollection(args: RebuildArgs): Promise<StoredScript[]> {
  const newId = args.newId ?? (() => crypto.randomUUID());
  const recheckFiles = args.recheckFiles ?? 'all';
  const fileFetchCache: FileFetchCache = args.fileFetchCache ?? new Map();
  const localFiles: LocalFileScope = args.localFiles ?? { enabled: false };
  const parseCheck = args.parseCheck ?? 'await';
  // Deferring is only safe where the deferred verdict does exactly what
  // an awaited one would have done — and where `keepsPriorOnInvalid`
  // holds it would not, because that rule reads the status the pipeline
  // hands back and a verdict arriving after it has run would replace a
  // working script with the garbage instead of preserving it. Same
  // predicate as the rule itself, so the two cannot drift apart.
  const parseCheckFor = (
    fileUrl: string, prior: StoredScript | undefined,
  ): ParseCheckMode =>
    parseCheck === 'defer' && !keepsPriorOnInvalid(fileUrl, prior) ? 'defer' : 'await';
  const existingByPath = new Map<string, StoredScript>();
  for (const e of args.existing) existingByPath.set(e.relativePath, e);

  // Each scanned entry resolves to one StoredScript. Most paths are
  // synchronous (unchanged, error, defensive fallbacks); the `ok`
  // path goes through buildScriptFromText which is async because the
  // content-hash uses SubtleCrypto, and applyFiles which fetches this
  // entry's `@require` / `@resource` bodies. We collect every branch as
  // a thunk and run them with bounded concurrency at the end, so the
  // async work overlaps without putting every entry's dependency
  // payloads in flight at once, and the output order matches scan order.
  const entryTasks: (() => Promise<StoredScript>)[] = [];
  for (const found of args.scan) {
    const prior = existingByPath.get(found.relativePath);
    const id = prior?.id ?? newId();
    const fileUrl = scriptFileUrl(args.collectionPath, found.relativePath);
    const fr = args.fetchResults.get(found.relativePath);
    if (fr && 'ok' in fr && fr.ok) {
      entryTasks.push(async (): Promise<StoredScript> => {
        const built = await timePhase('build', () => buildScriptFromText({
          id,
          collectionId: args.collectionId,
          relativePath: found.relativePath,
          fileUrl,
          text: fr.text,
          now: args.now,
          // Pass prior so buildScriptFromText can preserve loadedAt when
          // the freshly fetched bytes hash to the same value — the
          // post-fetch leg of the unified change-detection path.
          prior,
          httpEtag: fr.httpEtag,
          httpLastModified: fr.httpLastModified,
        }));
        // Preserve the user's per-script enabled choice across refreshes.
        // `versionProbes` is deliberately NOT carried here — it's
        // re-applied from the persisted row by preserveConcurrentEdits
        // inside the write lock, which is strictly more current than
        // this pre-fetch snapshot.
        if (prior) built.enabled = prior.enabled;
        // Record the listing's mtime so the next refresh can decide to
        // skip a refetch.
        if (found.mtime !== undefined) built.fsMtime = found.mtime;
        const withFiles = await applyFiles(
          built, prior, recheckFiles, fileFetchCache, args.now, localFiles,
          parseCheckFor(fileUrl, prior));
        // Soft-failure preservation — see `keepsPriorOnInvalid`. Keep
        // the prior good body running and annotate `refreshError`
        // instead of clobbering it with what came back.
        if (withFiles.status === 'invalid' && keepsPriorOnInvalid(fileUrl, prior)) {
          return {
            ...prior,
            // Described, not bare: `refreshError` is a plain string
            // with no location field of its own, so flattening the
            // location into the text is the only way "where" survives
            // — and where in the fetched copy it went wrong is the
            // useful half of this message.
            refreshError: `Fetched copy is not a valid userscript (${
              withFiles.errorMessage
                ? describeDiagnostic(withFiles.errorMessage, withFiles.errorLocation)
                // Capitalized to match the `describeDiagnostic` string
                // it stands in for — the two share this slot, so a
                // lowercase fallback would read as a different kind of
                // thing depending on which branch ran.
                : 'Parse failed'
            })`,
          };
        }
        return withFiles;
      });
    } else if (fr && 'unchanged' in fr) {
      // Optimization path: the listing's size+mtime matched the prior
      // entry, so we never fetched. Reuse the prior entry verbatim.
      // (Defensive fallback if there's somehow no prior: treat as a
      // fresh-fetch failure — shouldn't happen because the orchestrator
      // only emits `unchanged` when prior exists.)
      if (prior) {
        // Recompute fileUrl unconditionally — if the collection's
        // path/URL ever changes (e.g. a future edit-collection UI), the
        // prior's fileUrl would silently lie. Cheap to recompute here.
        const next = { ...prior, fileUrl };
        if (found.mtime !== undefined) next.fsMtime = found.mtime;
        if (found.size !== undefined) next.size = found.size;
        // A proven-unchanged refetch (HTTP 304 or matching size+mtime)
        // means the collection is reachable and serving the same good
        // bytes again — clear any stale "refresh failed" annotation. If
        // a dep recheck below fails again, applyFiles re-sets
        // refreshError.
        delete next.refreshError;
        // Even when the body is unchanged, explicit Refresh still
        // rechecks @require + @resource bodies (the user may want to
        // pick up remote dep updates without touching the main
        // script). The opportunistic path passes 'preserve' which
        // short-circuits.
        entryTasks.push(
          () => applyFiles(
            next, prior, recheckFiles, fileFetchCache, args.now, localFiles,
            parseCheckFor(fileUrl, prior)),
        );
      } else {
        entryTasks.push(() => Promise.resolve(buildInitialInvalidEntry({
          id,
          collectionId: args.collectionId,
          relativePath: found.relativePath,
          fileUrl,
          // Prefixed as internal because it is: the orchestrator told us
          // "unchanged" for a file we have never held. Nothing the user
          // can do about it, and saying so beats an accusation.
          errorMessage: 'Internal error: unchanged marker with no prior entry',
          now: args.now,
        })));
      }
    } else if (fr) {
      // Failed fetch. If we had prior content, keep it.
      const errorMessage =
        'errorMessage' in fr ? fr.errorMessage : 'Could not be read (no reason reported)';
      if (prior) {
        entryTasks.push(() => Promise.resolve(applyFetchError(prior, errorMessage)));
      } else {
        entryTasks.push(() => Promise.resolve(buildInitialInvalidEntry({
          id,
          collectionId: args.collectionId,
          relativePath: found.relativePath,
          fileUrl,
          errorMessage,
          now: args.now,
        })));
      }
    } else {
      // No fetch attempted at all. Treat like a fetch error with a
      // generic message; this branch is mostly defensive — the
      // orchestrator should always supply a result.
      entryTasks.push(() => Promise.resolve(prior
        ? applyFetchError(prior, NOT_READ)
        : buildInitialInvalidEntry({
            id, collectionId: args.collectionId, relativePath: found.relativePath,
            fileUrl, errorMessage: NOT_READ, now: args.now,
          })));
    }
  }

  const out = await mapWithConcurrency(
    entryTasks, FETCH_SCRIPTS_PER_COLLECTION_CONCURRENCY, (task) => task());

  // Anything in `existing` that the scan didn't see is dropped: it is
  // simply not in `out`. See the header comment.
  return out;
}

// ---------- chrome.storage.local I/O ----------

const COLLECTIONS_INDEX_KEY = 'collections';
const COLLECTION_PREFIX = 'collection:';
const SCRIPT_PREFIX = 'script:';
const collectionKey = (id: string) => `${COLLECTION_PREFIX}${id}`;
const scriptKey = (id: string) => `${SCRIPT_PREFIX}${id}`;

// Does a `chrome.storage.local` change touch the structural rows — the
// collection index, a collection, or a script? Exported so pages
// watching for "something I display moved" ask the module that owns the
// key layout instead of re-deriving the prefixes, where a rename here
// would leave them silently watching keys that no longer exist.
export function touchesStructuralRows(keys: Iterable<string>): boolean {
  for (const key of keys) {
    if (
      key === COLLECTIONS_INDEX_KEY ||
      key.startsWith(collectionKey('')) ||
      key.startsWith(scriptKey(''))
    ) {
      return true;
    }
  }
  return false;
}

// Serialize every read-modify-write of the structural rows (the
// collection index, collection rows, script rows). chrome.storage.local
// has no compare-and-swap, so two operations that each read a row,
// derive a new value, and write it back would otherwise drop one
// another's change — e.g. a user's enable toggle reverted by a refresh
// that captured the old flag before the fetch, or an addCollection
// racing a removeCollection on the shared index. Callers run their read
// AND write inside one `mutate()` so the pair is atomic with respect to
// other mutators.
//
// The critical sections here are short (no network) — slow fetches stay
// OUTSIDE the lock (refresh fetches, then re-reads + writes inside it),
// so this doesn't serialize I/O. IMPORTANT: a `mutate()` block must
// never call another mutator (refreshCollection / addCollection / a set*),
// since this mutex is non-reentrant — keep orchestrator calls outside.
//
// SCOPE: `mutateChain` is module state, so the lock is PER JS CONTEXT.
// The service worker, the collections page, and the viewer each hold
// their own — and pages call these mutators directly (a Remove click, a
// move, an enable toggle) while the worker refreshes in the background.
// So a section is atomic against other mutators in the SAME context
// only. Two rules follow:
//
//   - Re-read inside the lock and merge, rather than writing values
//     captured before it. That is what actually survives a writer in
//     another context — see `preserveConcurrentEdits` and the
//     joined/departed reconcile in `writeRefreshedCollection`.
//   - Keep sections short for the same reason. A wide section doesn't
//     buy exclusion against the other context; it only widens the
//     window in which that context can interleave.
//
// See docs/storage.md#write-serialization-mutate for what remains
// unguarded across contexts.
let mutateChain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: () => Promise<T>): Promise<T> {
  // Run after the prior section settles, regardless of its outcome.
  const run = mutateChain.then(fn, fn);
  // Advance the chain, swallowing the result so one section's rejection
  // doesn't reject the next waiter's gate (the rejection still
  // propagates to THIS caller via `run`).
  mutateChain = run.then(() => undefined, () => undefined);
  return run;
}

// Set to `true` the first time the SW seeds the default collections, so
// the seeding never runs again even after the user removes those
// collections.
const FIRST_RUN_DONE_KEY = 'firstRunComplete';

// Collections seeded on the very first run (by the collections page —
// see `seedDefaultCollectionsViaUi` in collections.ts). Each is fed
// through the normal add → Refresh flow, so any input shape
// `addCollection` accepts (github-dir / http(s) `.user.js` / manifest
// URL, or an absolute directory path) works here. `addCollection`
// dedupes by canonical collection path, so any accidental repeat
// collapses to one collection.
export const DEFAULT_COLLECTIONS: readonly string[] = [
  'https://github.com/jshute96/SourceMonkey/tree/main/tests/examples',
];

// ---------- Legacy key migration (temporary — see TODO.md) ----------
//
// Collections were called "sources" before the August 2026 rename, and
// a profile written then holds a `"sources"` index, `source:<id>` rows,
// and a `sourceId` back-reference on every script. Without this, an
// upgrade would read as a wiped profile: every collection gone, every
// script unregistered. Rewrite the rows once, on the first storage read
// in each JS context, and drop the old keys.
const LEGACY_INDEX_KEY = 'sources';
const LEGACY_COLLECTION_PREFIX = 'source:';

let migrationPromise: Promise<void> | null = null;

// Idempotent, memoized per context. Awaited by every read path in this
// module, and exported for the two SW modules that read the structural
// rows straight out of `chrome.storage.local` (`match-index.ts` and
// `injector.ts`) rather than through here. `script-log-id.ts` reads
// `script:*` rows directly too and deliberately does NOT await: script
// keys don't move, and it reads only `relativePath`.
export function ensureCollectionKeysMigrated(): Promise<void> {
  migrationPromise ??= migrateLegacyCollectionKeys().catch((err: unknown) => {
    // Never let a failed migration wedge every read behind it: clear the
    // memo so the next reader retries, and leave the old rows in place.
    console.info('[SourceMonkey] collection-key migration failed', err);
    migrationPromise = null;
  });
  return migrationPromise;
}

// Forget that this context has already checked. Only for the test
// surface's `resetAllState`, which wipes storage — the memo describes a
// profile that no longer exists, and a test seeding pre-rename rows
// afterwards would otherwise never see them migrated.
//
// Scope is the calling context only: `resetAllState` runs in the service
// worker, so an extension page already open keeps its own resolved memo.
// A test that seeds pre-rename rows has to open the page afterwards.
export function resetCollectionKeyMigrationForTests(): void {
  migrationPromise = null;
}

async function migrateLegacyCollectionKeys(): Promise<void> {
  // Cheap gate first. A profile with any collection at all has the old
  // index row, so its absence means there is nothing to move. The memo
  // means this runs at most once per context — but that is still once
  // per service-worker wake and once per page load, and the `get(null)`
  // below drags back every script body and the whole favicon cache.
  const probe = await chrome.storage.local.get(LEGACY_INDEX_KEY);
  if (!(LEGACY_INDEX_KEY in probe)) return;

  const all = await scanAllStorage('key migration');
  const toSet: Record<string, unknown> = {};
  const toRemove: string[] = [LEGACY_INDEX_KEY];
  // Seed the index ONLY when the new spelling isn't there yet. This runs
  // outside `mutate()`, so a context that read `all` before another one
  // finished migrating would otherwise write the stale legacy id list
  // over an index a later add had already extended — orphaning that
  // collection's row from the index.
  if (!(COLLECTIONS_INDEX_KEY in all)) {
    const ids = all[LEGACY_INDEX_KEY];
    toSet[COLLECTIONS_INDEX_KEY] = Array.isArray(ids) ? ids : [];
  }

  let scriptsMoved = 0;
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(LEGACY_COLLECTION_PREFIX)) {
      toSet[collectionKey(key.slice(LEGACY_COLLECTION_PREFIX.length))] = value;
      toRemove.push(key);
      continue;
    }
    if (!key.startsWith('script:')) continue;
    const row = value as StoredScript & { sourceId?: string };
    if (row?.sourceId === undefined) continue;
    const { sourceId, ...rest } = row;
    toSet[key] = { ...rest, collectionId: rest.collectionId ?? sourceId };
    scriptsMoved++;
  }

  // Write the new rows before dropping the old ones: an interrupted
  // migration then leaves both spellings present, and the re-run is a
  // no-op over the rows it already moved.
  await writeLocal(toSet);
  await chrome.storage.local.remove(toRemove);
  console.log(
    `[SourceMonkey] migrated ${toRemove.length - 1} collections and `
    + `${scriptsMoved} scripts to the collection:* key spelling`,
  );
}

async function getRaw<T>(key: string): Promise<T | undefined> {
  await ensureCollectionKeysMigrated();
  const result = await chrome.storage.local.get(key);
  return result[key] as T | undefined;
}

async function getMany(keys: string[]): Promise<Record<string, unknown>> {
  if (keys.length === 0) return {};
  await ensureCollectionKeysMigrated();
  return await chrome.storage.local.get(keys);
}

async function readCollectionIndex(): Promise<string[]> {
  return (await getRaw<string[]>(COLLECTIONS_INDEX_KEY)) ?? [];
}

// Test-only: while set, EVERY collection-refresh write throws this
// message instead of touching storage.
//
// Module state, so it only arms the context that set it. The service
// worker and each extension page run their own copy of this module, and
// the collections page does its own storage work — so a test arming
// this over the SW test surface does NOT affect an add or refresh the
// page performs itself. Sticky until cleared with null —
// the out-of-quota case it stands in for fails every collection, not
// just the next one, and a test covering that needs one arming call.
//
// Exists because the failure it stands in for — an exhausted
// `chrome.storage.local` quota — is impractical to produce honestly in a
// test. Filling 10 MB means writing ~10 MB of userscripts through the
// real pipeline on every run, which is slow, and it leaves the profile
// wedged for whatever runs next. The reporting path is the same either
// way: the write throws, and everything downstream reacts to that.
let collectionWriteFailure: string | null = null;
export function _setCollectionWriteFailureForTests(message: string | null): void {
  collectionWriteFailure = message;
}

// How full `chrome.storage.local` is, or null when the browser won't
// say. `quota` is Chrome's own `QUOTA_BYTES` — 10 MB shared by the whole
// extension, because the manifest does not take `unlimitedStorage`.
//
// That coupling is load-bearing and unenforced: `QUOTA_BYTES` reads the
// same 10485760 whether or not the permission is held, so taking
// `unlimitedStorage` (still an open option in TODO.md) would leave this
// reporting a ceiling that no longer applies, and the collections page
// calling a healthy profile full. Revisit here if that permission lands.
//
// Read live rather than tracked, so it needs nothing persisted and is
// correct after a write from any context. The collections page uses it
// to explain a refresh that couldn't be saved: "the write failed" is a
// symptom, "storage is full" is the cause and the thing the user can
// act on.
export async function readLocalStorageUsage(): Promise<
  { used: number; quota: number } | null
> {
  try {
    const quota = chrome.storage.local.QUOTA_BYTES;
    if (typeof quota !== 'number' || quota <= 0) return null;
    return { used: await chrome.storage.local.getBytesInUse(null), quota };
  } catch {
    // Purely advisory — a page that can't measure simply doesn't show
    // the banner.
    return null;
  }
}

// Fraction of the quota at which the page starts warning. Below this a
// refresh that failed to save had some other cause, and pointing at
// storage would send the reader somewhere useless.
export const STORAGE_NEARLY_FULL = 0.9;

// Read every registered collection's metadata (without scripts). Order
// preserved from the index.
export async function getCollections(): Promise<StoredCollection[]> {
  const ids = await readCollectionIndex();
  const got = await getMany(ids.map(collectionKey));
  return ids
    .map((id) => got[collectionKey(id)] as StoredCollection | undefined)
    .filter((s): s is StoredCollection => s != null);
}

// Read a collection plus all its scripts in declared order.
export async function getCollectionWithScripts(
  id: string,
): Promise<{ collection: StoredCollection; scripts: StoredScript[] } | null> {
  const collection = await getRaw<StoredCollection>(collectionKey(id));
  if (!collection) return null;
  const got = await getMany(collection.scriptIds.map(scriptKey));
  const scripts = collection.scriptIds
    .map((sid) => got[scriptKey(sid)] as StoredScript | undefined)
    .filter((s): s is StoredScript => s != null);
  return { collection, scripts };
}

export async function getScript(scriptId: string): Promise<StoredScript | undefined> {
  return await getRaw<StoredScript>(scriptKey(scriptId));
}

// Read every stored script (across all collections, regardless of
// status). One `get(null)` scan rather than N per-collection reads;
// used by the collections page + viewer to compute global log IDs in
// one pass.
export async function getAllScripts(): Promise<StoredScript[]> {
  await ensureCollectionKeysMigrated();
  const all = await scanAllStorage('all scripts');
  const out: StoredScript[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith('script:')) out.push(value as StoredScript);
  }
  return out;
}

export async function getCollection(id: string): Promise<StoredCollection | undefined> {
  return await getRaw<StoredCollection>(collectionKey(id));
}

// Result of `addCollection` / `createCollection` / `installScript`.
// Three outcomes:
//   - newCollection: a brand-new collection row was created (a directory /
//     manifest / github-dir collection, a user-created scripts
//     collection, or a built-in default container auto-created by the
//     first install that targeted it). The caller appends a fresh
//     section to the DOM.
//   - existingContainer: a single script was installed into a container
//     that already existed. The caller re-renders that container's
//     section in place.
//   - null: the input was a duplicate (an already-registered collection
//     path, or a script URL/path already present in the target
//     container). The caller surfaces the duplicate message and jumps
//     to the existing section.
export type AddCollectionResult =
  | { kind: 'newCollection'; collection: StoredCollection }
  | { kind: 'existingContainer'; collection: StoredCollection; scriptId: string }
  | null;

// Messages shared by the store's collection-shape checks and the
// collection dialog's live validation, so the dialog can't say one
// thing and the store another.
export const COLLECTION_ALREADY_REGISTERED = 'This collection is already registered';
export const COLLECTION_NAME_REQUIRED = 'Name is required for scripts collections';
export const COLLECTION_GONE = 'This collection no longer exists';
export function collectionNameInUseMessage(name: string): string {
  return `Collection named "${name.trim()}" already exists`;
}

// What `createCollection` is asked to make.
export type NewCollectionSpec =
  | {
      // A folder of individually installed scripts. Named by the user.
      kind: 'scripts';
      name: string;
      localFiles?: boolean;
    }
  | {
      // A scanned directory, a GitHub tree, or a `script_manifest.json`.
      kind: 'location';
      path: string;
      // Blank → inferred from the path, as the Add field always did.
      name?: string;
      localFiles?: boolean;
    };

// Register a new collection from a raw user input — the Add field's
// one-string entry point. Dispatches by input shape:
//   - single-file `.user.js` URL/path → installed into the built-in
//     default container for its scheme (created on demand). The script
//     is added to the container's `scriptIds` and its initial fetch
//     runs immediately so the table populates without a manual
//     Refresh.
//   - everything else (directory, manifest, github-dir URL) → a new
//     location-backed collection, as `createCollection` would make.
//
// `normalizeCollectionInput` runs first so a github.com
// `/blob/.../foo.user.js` (or `/blob/.../script_manifest.json`) URL
// gets rewritten to its raw counterpart before we hit the duplicate
// check. The github blob URL serves HTML, not raw bytes, so storing it
// verbatim would silently load the page chrome instead of the script —
// see [docs/http-collections.md].
export async function addCollection(rawPath: string): Promise<AddCollectionResult> {
  const path = await canonicalLocation(rawPath);
  if (isSingleFileInput(path)) {
    return await addScriptToContainer(path, { schemeDefault: true });
  }
  return await createLocationCollection(path, {});
}

// Two canonicalizations, in order: provider rewriting (github blob →
// raw), then the one-spelling-per-location rule. The second is what
// keeps `/x/a.user.js` typed into the collections page and
// `file:///x/a.user.js` arriving from a captured navigation from
// becoming two rows for one file — see `canonicalCollectionInput`.
async function canonicalLocation(rawPath: string): Promise<string> {
  return canonicalCollectionInput(await normalizeCollectionInput(rawPath));
}

// Create a collection the collection dialog described. A scripts
// collection is an empty container row with the user's name; a
// location collection is what `addCollection` makes, plus the name and
// local-files choice from the dialog.
export async function createCollection(spec: NewCollectionSpec): Promise<AddCollectionResult> {
  if (spec.kind === 'scripts') {
    const name = spec.name.trim();
    if (!name) throw new Error(COLLECTION_NAME_REQUIRED);
    const created = await mutate(async () => {
      const collections = await getCollections();
      if (!mayUseReservedName(name, null)) throw new Error(RESERVED_COLLECTION_NAME);
      if (collectionNameInUse(name, collections)) {
        throw new Error(collectionNameInUseMessage(name));
      }
      const id = crypto.randomUUID();
      const seed: StoredCollection = {
        id,
        path: newContainerPath(),
        lastRefreshedAt: 0,
        scriptIds: [],
        enabled: true,
        displayName: name,
      };
      if (spec.localFiles === false) seed.localFiles = false;
      await writeLocal({
        [COLLECTIONS_INDEX_KEY]: [...collections.map((s) => s.id), id],
        [collectionKey(id)]: seed,
      });
      return seed;
    });
    return { kind: 'newCollection', collection: created };
  }
  const path = await canonicalLocation(spec.path);
  if (isSingleFileInput(path)) throw new Error(SINGLE_SCRIPT_USE_ADD_FIELD);
  return await createLocationCollection(path, spec);
}

// What the collection dialog runs before creating a location-backed
// collection: the same listing / manifest fetch / GitHub lookup a
// refresh does, so a location that can't be read is refused in the
// dialog instead of landing as a collection stuck in a scan error.
// Nothing is written. The count lets the dialog warn about an empty
// directory without refusing it — a directory can fill up later.
export async function probeCollectionLocation(
  rawPath: string,
): Promise<{ path: string; scriptCount: number }> {
  const path = await canonicalLocation(rawPath);
  if (isSingleFileInput(path)) throw new Error(SINGLE_SCRIPT_USE_ADD_FIELD);
  const found = await scanForUserScripts(path);
  return { path, scriptCount: found.length };
}

// Mint a UUID, persist an empty collection row for an already-canonical
// location, then refresh to populate the scripts.
async function createLocationCollection(
  path: string,
  opts: { name?: string; localFiles?: boolean },
): Promise<AddCollectionResult> {
  // Only a name the user actually chose is held to the uniqueness rule.
  // Inferred names can legitimately collide — two refs of one GitHub
  // tree both read as `<owner>/<repo>/<path>` — and refusing those
  // would block adding a real, distinct collection.
  const inferred = inferDisplayName(path);
  const chosen = opts.name?.trim() || '';
  const explicitName = chosen && chosen !== inferred ? chosen : '';
  // Dedup-and-register atomically so two concurrent adds of the same
  // path can't both create a collection (and so this index write can't
  // lose a race with another index mutator). The refresh runs OUTSIDE
  // the lock (it acquires the lock itself for its own write).
  const created = await mutate(async () => {
    const collections = await getCollections();
    // Canonicalize the stored side too, for the same reason the
    // container check does: a collection row written before
    // `addCollection` collapsed `file://` inputs still carries the URL
    // spelling.
    if (collections.some((s) => canonicalCollectionInput(s.path) === path)) return null;
    if (explicitName) {
      if (!mayUseReservedName(explicitName, null)) throw new Error(RESERVED_COLLECTION_NAME);
      if (collectionNameInUse(explicitName, collections)) {
        throw new Error(collectionNameInUseMessage(explicitName));
      }
    }
    const id = crypto.randomUUID();
    const seed: StoredCollection = {
      id,
      path,
      lastRefreshedAt: 0,
      scriptIds: [],
      enabled: true,
      // Seed a displayName at add-time so a viewer opened mid-add (or
      // any other reader) doesn't briefly see a row whose name only
      // materialises on the next backfill pass.
      displayName: explicitName || inferred,
    };
    if (opts.localFiles === false) seed.localFiles = false;
    const nextIndex = [...collections.map((s) => s.id), id];
    await writeLocal({
      [COLLECTIONS_INDEX_KEY]: nextIndex,
      [collectionKey(id)]: seed,
    });
    return { id, seed };
  });
  if (!created) return null;
  const { id, seed } = created;
  const refreshed = await refreshCollection(id);
  // The updater-driven refresh paths already emit per-script Log
  // entries when a script's load state goes bad. This initial-add path
  // bypasses the updater, so anything that lands already broken would
  // otherwise have an empty Log tab. Emit once per non-OK script here
  // so the user can always click the row's badge and read what went
  // wrong. Awaited so the loglevel sentinel write lands before the
  // caller's `getAllMaxLogLevels` read — otherwise the first paint of
  // the row would briefly show OK and only flip on the storage-change
  // listener.
  if (refreshed) {
    await Promise.all(refreshed.scripts.map(emitInitialLoadLog));
  }
  return { kind: 'newCollection', collection: refreshed?.collection ?? seed };
}

// First-run gate. Seeding the default collections is driven from the
// collections page (so the user watches the normal add → Refresh flow,
// rather than scripts appearing silently from the SW); the SW only
// opens that page on install. These two helpers are the persisted flag
// the page and SW share.
export async function isFirstRunComplete(): Promise<boolean> {
  return (await getRaw<boolean>(FIRST_RUN_DONE_KEY)) === true;
}

// Record that first-run handling is done so the SW stops opening the
// seeding page and the collections page stops re-seeding — including
// after the user deletes the seeded collections. Also called by the
// test-surface reset so a cleared store isn't re-seeded.
export async function markFirstRunComplete(): Promise<void> {
  await writeLocal({ [FIRST_RUN_DONE_KEY]: true });
}

// Where a single script should be installed: a specific container by
// id, or the built-in default container for the script's own scheme
// (created if it doesn't exist).
export type InstallTarget = { collectionId: string } | { schemeDefault: true } | { scratch: true };

// Install one `.user.js` location into a container collection. Returns
// null if the location is already a script in THAT container — the
// same location may be installed into several containers, which is
// what the "Other versions" panel and its exclusive-enable rule exist
// for. The fetch runs as part of `refreshCollection` so the new row
// lands populated.
export async function installScript(
  rawLocation: string,
  target: InstallTarget,
): Promise<AddCollectionResult> {
  const path = await canonicalLocation(rawLocation);
  if (!isSingleFileInput(path)) {
    throw new Error('Internal error: only a .user.js location can be installed into a collection');
  }
  return await addScriptToContainer(path, target);
}

// ---------- Scratch scripts ----------
//
// Scripts whose only copy is their text in storage (see directories.ts).
// For now only the development harness writes them
// (docs/harness-design.md, "Extension backend"). They live in one
// container, `container:scratch`, shown on the collections page like any
// other; their text is a storage row the fetcher reads back, so every
// refresh path treats them as ordinary scripts.

export const SCRATCH_COLLECTION_NAME = 'Scratch';

export interface WriteScratchScriptResult {
  scriptId: string;
  collectionId: string;
  status: ScriptStatus;
  errorMessage?: string;
  errorLocation?: DiagnosticLocation;
  /** True when a scratch script of this name already existed and got replaced. */
  replaced: boolean;
}

// Install or replace a scratch script. The name (the `@name`, or one the
// caller gives) is the identity: writing it again replaces the earlier
// text in place, keeping the row's id and its GM values, which is what
// lets a page reload hot-swap the new version.
export async function writeScratchScript(args: { text: string; name?: string }): Promise<WriteScratchScriptResult> {
  const header = parseHeader(args.text);
  const name = args.name?.trim() || (header ? getValue(header, 'name')?.trim() : '') || 'script';
  const url = scratchUrl(name);
  await writeLocal({ [scratchTextKey(url)]: args.text });
  const container = (await getCollections()).find((c) => c.path === SCRATCH_CONTAINER_PATH);
  let scriptId: string | undefined;
  let collectionId: string | undefined;
  let replaced = false;
  if (container) {
    const rows = await getMany(container.scriptIds.map(scriptKey));
    for (const sid of container.scriptIds) {
      const row = rows[scriptKey(sid)] as StoredScript | undefined;
      if (row?.relativePath === url) {
        scriptId = sid;
        collectionId = container.id;
        replaced = true;
      }
    }
  }
  if (scriptId === undefined) {
    let result: AddCollectionResult;
    try {
      result = await installScript(url, { scratch: true });
    } catch (err) {
      // The install took its seed back out; the text row goes with it.
      await chrome.storage.local.remove(scratchTextKey(url));
      throw err;
    }
    if (!result) throw new Error('Internal error: the scratch script was neither installed nor found');
    collectionId = result.collection.id;
    scriptId = result.kind === 'existingContainer'
      ? result.scriptId
      : result.collection.scriptIds[result.collection.scriptIds.length - 1];
  } else {
    // Re-read the text; the scratch fetcher has no size or mtime to skip
    // on, so the new content lands and the hash says whether it changed.
    await refreshScript(scriptId);
  }
  const row = await getScript(scriptId);
  if (!row) throw new Error('Internal error: the scratch script vanished during install');
  const out: WriteScratchScriptResult = { scriptId, collectionId: collectionId!, status: row.status, replaced };
  if (row.errorMessage) out.errorMessage = row.errorMessage;
  if (row.errorLocation) out.errorLocation = row.errorLocation;
  return out;
}

// Remove the Scratch container, its rows, their GM values, and the text
// rows behind them. Returns what went, for the caller's registration
// sync. `removeCollection` deletes the text rows, keeping any that a
// copy moved into another collection still reads.
export async function clearScratchScripts(): Promise<{ scriptIds: string[]; collectionId: string | null }> {
  const container = (await getCollections()).find((c) => c.path === SCRATCH_CONTAINER_PATH);
  if (!container) return { scriptIds: [], collectionId: null };
  for (const sid of container.scriptIds) await wipeScriptValues(sid);
  await removeCollection(container.id);
  return { scriptIds: container.scriptIds, collectionId: container.id };
}

// Does this container already hold `canonicalPath`?
//
// A container holds one row per location, and both the install and the
// move path have to agree on what "the same location" means — so the
// rule lives here rather than being spelled twice. The STORED value is
// canonicalized too: rows written before `addCollection` started
// collapsing `file://` inputs still carry the URL spelling, and
// comparing raw would offer a second copy of a file we already have.
//
// `canonicalPath` must already be through `canonicalCollectionInput`.
// Caller-side, because both callers have it in hand.
async function containerHoldsLocation(
  container: StoredCollection,
  canonicalPath: string,
): Promise<boolean> {
  const rows = await getMany(container.scriptIds.map(scriptKey));
  for (const sid of container.scriptIds) {
    const s = rows[scriptKey(sid)] as StoredScript | undefined;
    if (s && canonicalCollectionInput(s.relativePath) === canonicalPath) return true;
  }
  return false;
}

// A brand-new container row. One spelling of the default field values,
// so an install-created container and a move-created one can't drift
// apart on `enabled`, the inferred name, or the never-refreshed marker.
function newContainerRow(
  id: string,
  path: string,
  scriptIds: string[],
): StoredCollection {
  return {
    id,
    path,
    lastRefreshedAt: 0,
    scriptIds,
    enabled: true,
    displayName: inferDisplayName(path),
  };
}

async function addScriptToContainer(
  path: string,
  target: InstallTarget,
): Promise<AddCollectionResult> {
  // Dedup-check and seed the container + script atomically so a
  // concurrent install (or index mutator) can't lose this scriptIds/index
  // write. The refresh runs OUTSIDE the lock. Returns null on duplicate.
  const seeded = await mutate(async () => {
    const collections = await getCollections();
    let existingContainer: StoredCollection | undefined;
    let cPath: string;
    if ('collectionId' in target) {
      existingContainer = collections.find((s) => s.id === target.collectionId);
      // The dropdown was built from a snapshot; the row can have been
      // removed from another tab since.
      if (!existingContainer) throw new Error(COLLECTION_GONE);
      if (!isContainerCollection(existingContainer.path)) {
        throw new Error('Internal error: scripts can only be installed into a scripts collection');
      }
      cPath = existingContainer.path;
    } else if ('scratch' in target) {
      cPath = SCRATCH_CONTAINER_PATH;
      existingContainer = collections.find((s) => s.path === cPath);
    } else {
      cPath = containerPath(containerKindForSingleFileInput(path));
      existingContainer = collections.find((s) => s.path === cPath);
    }
    const isNew = !existingContainer;
    // Each container script's `relativePath` is the full URL/path the
    // user added; any prior row with the same value is a duplicate.
    // `path` arrived canonical (see `installScript`).
    if (existingContainer && await containerHoldsLocation(existingContainer, path)) return null;

    const now = Date.now();
    const containerId = existingContainer?.id ?? crypto.randomUUID();
    const scriptId = crypto.randomUUID();
    const priorScriptIds = existingContainer?.scriptIds ?? [];
    const nextContainer: StoredCollection = existingContainer
      ? { ...existingContainer, scriptIds: [...priorScriptIds, scriptId] }
      : newContainerRow(containerId, cPath, [scriptId]);
    if (isNew && cPath === SCRATCH_CONTAINER_PATH) nextContainer.displayName = SCRATCH_COLLECTION_NAME;
    const seedScript = buildInitialInvalidEntry({
      id: scriptId,
      collectionId: containerId,
      relativePath: path,
      fileUrl: scriptFileUrl(cPath, path),
      errorMessage: NOT_LOADED_YET,
      now,
    });

    // Single set call so a SW restart between writes can never leave a
    // half-populated container — either the new script lands with its
    // container's scriptIds pointing at it (and, for a new container,
    // the collections index pointing at the container), or nothing does.
    const toSet: Record<string, unknown> = {
      [collectionKey(containerId)]: nextContainer,
      [scriptKey(scriptId)]: seedScript,
    };
    if (isNew) {
      toSet[COLLECTIONS_INDEX_KEY] = [...collections.map((s) => s.id), containerId];
    }
    await writeLocal(toSet);
    return { isNew, containerId, scriptId, nextContainer };
  });
  if (!seeded) return null;
  const { isNew, containerId, scriptId, nextContainer } = seeded;

  let refreshed: Awaited<ReturnType<typeof refreshCollection>>;
  try {
    refreshed = await refreshCollection(containerId);
  } catch (err) {
    // The seed above is a placeholder with no content and no header —
    // it only becomes a script once this refresh writes the fetched
    // body. When that write is refused (an exhausted storage quota is
    // the realistic case — though anything the refresh throws lands
    // here), leaving the seed behind installs a row that
    // matches nothing, runs nothing, and shows "Not loaded yet" until
    // the user notices and refreshes it by hand. Nothing else about the
    // install has happened yet, so take the seed back out and let the
    // install fail as the failure it is. A fetch that fails is
    // different: the refresh then WRITES the row with its error, and
    // that row is the honest record of an install that landed.
    await unseedScript(scriptId, containerId, isNew);
    throw err;
  }
  if (refreshed) {
    await Promise.all(refreshed.scripts.map(emitInitialLoadLog));
  }
  const finalCollection = refreshed?.collection ?? nextContainer;
  if (isNew) return { kind: 'newCollection', collection: finalCollection };
  return { kind: 'existingContainer', collection: finalCollection, scriptId };
}

// Undo `addScriptToContainer`'s seed after its refresh could not be
// saved: drop the placeholder row and its slot in the container, and
// the container itself (plus its index entry) when this install created
// it. Re-read under the lock rather than replayed from the seed: another
// tab can have installed into, or removed, the same container since.
//
// Every write here makes storage smaller — a `remove`, or a `set` of a
// row with one id fewer — which Chrome accepts on a full quota, so this
// works in exactly the state that made it necessary. Best effort all the
// same: the caller is already reporting a failure, and a rollback that
// can't land must not replace that report with its own.
async function unseedScript(
  scriptId: string,
  containerId: string,
  createdContainer: boolean,
): Promise<void> {
  try {
    await mutate(async () => {
      const container = await getRaw<StoredCollection>(collectionKey(containerId));
      const remaining = container?.scriptIds.filter((id) => id !== scriptId) ?? [];
      const dropContainer = createdContainer && remaining.length === 0;
      const toRemove = [scriptKey(scriptId)];
      const toSet: Record<string, unknown> = {};
      if (container) {
        if (dropContainer) {
          toRemove.push(collectionKey(containerId));
          const index = await readCollectionIndex();
          toSet[COLLECTIONS_INDEX_KEY] = index.filter((id) => id !== containerId);
        } else if (remaining.length !== container.scriptIds.length) {
          toSet[collectionKey(containerId)] = { ...container, scriptIds: remaining };
        }
      }
      // The `set` first: it is the only step Chrome can refuse, so if
      // it does, nothing has changed. A `remove` can't be refused, so
      // the pair only splits if the worker dies between them — leaving
      // an unlisted row, which `reconcileScriptMembership` re-lists.
      if (Object.keys(toSet).length > 0) await writeLocal(toSet);
      await chrome.storage.local.remove(toRemove);
      if (dropContainer) await setRefreshError(containerId, null);
    });
  } catch (err) {
    // Not debug-gated: the state this leaves (a "Not loaded yet" row
    // nothing will explain) is otherwise invisible.
    console.info(`[SourceMonkey] could not undo a failed install: ${describeError(err)}`);
  }
}

export const SCRIPT_GONE = 'This script no longer exists';

// The one thing both `installScript` and `moveScript` decline: the
// target container already holds this location. Shared, so the install
// callout and the viewer's Move picker can't word the same refusal two
// ways.
export const ALREADY_INSTALLED_IN_TARGET = 'This script is already installed there';

// Both ends of a move have to be container collections. A directory or
// manifest script's `relativePath` is relative to its collection root,
// so moving it would mean rewriting it to an absolute location — a
// different feature. The UI never offers the button in that case, so
// this is a wiring error, not something the user can act on.
export const NOT_A_MOVABLE_SCRIPT =
  'Internal error: only a script in an individual scripts collection can be moved';

// Move one already-installed script from its container collection into
// another. The stored row keeps its `id`, so its Chrome registration,
// its `gmval:` rows, and its Log all follow it untouched — only the
// `collectionId` and the two `scriptIds` lists change.
//
// Returns null when the destination already holds this location (the
// same case `installScript` returns null for) or is the collection the
// script is already in.
//
// What DOES change with the parent: whether the script runs at all
// (`isRegistrationCandidate` requires the collection to be enabled
// too), and the local-stand-in policy — so a move between collections
// that disagree about `localFiles` ends with a refresh, because the
// `@require` / `@resource` bodies were resolved under the old rule.
export async function moveScript(
  scriptId: string,
  target: InstallTarget,
): Promise<StoredScript | null> {
  const moved = await mutate(async () => {
    const script = await getRaw<StoredScript>(scriptKey(scriptId));
    if (!script) throw new Error(SCRIPT_GONE);
    const source = await getRaw<StoredCollection>(collectionKey(script.collectionId));
    if (!source || !isContainerCollection(source.path)) throw new Error(NOT_A_MOVABLE_SCRIPT);
    const collections = await getCollections();
    let dest: StoredCollection | undefined;
    let destPath: string;
    if ('collectionId' in target) {
      dest = collections.find((c) => c.id === target.collectionId);
      // The dropdown was built from a snapshot; the row can have been
      // removed from another tab since.
      if (!dest) throw new Error(COLLECTION_GONE);
      if (!isContainerCollection(dest.path)) throw new Error(NOT_A_MOVABLE_SCRIPT);
      destPath = dest.path;
    } else {
      destPath = containerPath(containerKindForSingleFileInput(script.relativePath));
      dest = collections.find((c) => c.path === destPath);
    }
    if (dest?.id === source.id) return null;
    // Same dedup rule as an install, via the same helper — the stored
    // `relativePath` needs canonicalizing here because it may predate
    // the store doing so on the way in.
    const here = canonicalCollectionInput(script.relativePath);
    if (dest && await containerHoldsLocation(dest, here)) return null;

    const destId = dest?.id ?? crypto.randomUUID();
    const nextDest: StoredCollection = dest
      ? { ...dest, scriptIds: [...dest.scriptIds, scriptId] }
      : newContainerRow(destId, destPath, [scriptId]);
    const nextScript: StoredScript = { ...script, collectionId: destId };
    // One set call: a SW restart between writes must never leave the
    // row listed by both collections, or by neither.
    const toSet: Record<string, unknown> = {
      [collectionKey(source.id)]: {
        ...source,
        scriptIds: source.scriptIds.filter((id) => id !== scriptId),
      } satisfies StoredCollection,
      [collectionKey(destId)]: nextDest,
      [scriptKey(scriptId)]: nextScript,
    };
    if (!dest) toSet[COLLECTIONS_INDEX_KEY] = [...collections.map((c) => c.id), destId];
    await writeLocal(toSet);
    return {
      script: nextScript,
      localFilesChanged: collectionUsesLocalFiles(source) !== collectionUsesLocalFiles(nextDest),
    };
  });
  if (!moved) return null;
  if (!moved.localFilesChanged) return moved.script;
  try {
    // Outside the lock: `refreshScript` takes it itself.
    return (await refreshScript(scriptId)) ?? moved.script;
  } catch (err) {
    // The move itself landed and is what the caller asked for; only the
    // re-resolve of the declared files failed. Reporting it as a failed
    // move would be wrong, and the user can click Refresh.
    dlog(`[SourceMonkey] refresh after move failed: ${describeError(err)}`);
    return moved.script;
  }
}

// Copy a freshly-added script's load failure — and any local stand-in
// it picked up — into its Log tab. (Named for what it does now: it
// also runs for a perfectly healthy script that resolved a stand-in.)
//
// The updater-driven refresh paths do this themselves; the add path
// bypasses the updater, so without this a script that lands broken on
// its very first load would show a red badge over an empty Log, and a
// script running a local file in place of a declared URL would never
// have said so.
//
// Plain append. Adding a single file to an *existing* container
// refreshes every sibling, and we run over all of them — so a sibling
// that is still broken logs that again. It was genuinely re-read, so
// saying so is honest, and the add path is a deliberate user action
// rather than something that fires on its own.
async function emitInitialLoadLog(script: StoredScript): Promise<void> {
  // `undefined` prior: everything this row loaded is news at add time.
  for (const entry of localFileLogMessages(undefined, script)) {
    await appendScriptLog(script.id, { ...entry, source: 'add' });
  }
  const entry = loadStateLogEntry(script);
  if (!entry) return;
  await appendScriptLog(script.id, { ...entry, source: 'add' });
}

// Fill in `displayName` on any collection row that doesn't have one
// yet. Runs at collections-page boot (and at any other entry point that
// wants stable display labels for older rows). Cheap — one read of the
// collection index plus one bulk write iff anything was missing. The
// pure-inference rules live in `collection-display.ts`; that module
// only imports a TYPE from this file so the cycle is compile-time only.
export async function backfillCollectionDisplayNames(): Promise<void> {
  const collections = await getCollections();
  const toSet: Record<string, unknown> = {};
  for (const s of collections) {
    if (s.displayName && s.displayName.trim()) continue;
    const next: StoredCollection = { ...s, displayName: inferDisplayName(s.path) };
    toSet[collectionKey(s.id)] = next;
  }
  if (Object.keys(toSet).length > 0) {
    await writeLocal(toSet);
  }
}

// One-time pass over stored script rows to fill `usesUnsafeWindow` for
// rows written before the field existed. Returns how many rows changed.
//
// Why it can't wait for a refresh: `buildScriptFromText` derives the flag
// on every load, but a row is only rebuilt when a fetch actually happens.
// The cheap-skip paths (unchanged size+mtime on disk, a conditional GET
// answered 304) keep an untouched script's row exactly as it was, so a
// script that uses `unsafeWindow` ungranted could sit broken
// indefinitely after the upgrade that would have fixed it.
//
// Idempotent and cheap to repeat: every row whose body doesn't contain
// the name at all costs one `indexOf`. Rows that already carry the flag,
// and error rows (which never run), are skipped. `startupLogs` is
// re-derived for the rows that change so the row stays self-consistent
// with what the injector will do with it.
export async function backfillUsesUnsafeWindow(): Promise<number> {
  const scripts = await getAllScripts();
  const toSet: Record<string, unknown> = {};
  for (const script of scripts) {
    if (script.status !== 'ok' || script.usesUnsafeWindow === true) continue;
    if (!sourceUsesUnsafeWindow(script.bodyText)) continue;
    const next: StoredScript = { ...script, usesUnsafeWindow: true };
    const logs = extractStartupLogs(script.header, script.relativePath, true);
    if (logs.length > 0) next.startupLogs = logs;
    else delete next.startupLogs;
    toSet[scriptKey(script.id)] = next;
  }
  const changed = Object.keys(toSet).length;
  if (changed > 0) await writeLocal(toSet);
  return changed;
}

// Re-derive `startupLogs` on stored rows, so a new parse-time check
// (e.g. the no-`@connect` warning) reaches scripts already installed.
// Same reason as `backfillUsesUnsafeWindow`: an unchanged script's row
// is never rebuilt. Runs after that backfill, so `usesUnsafeWindow` is
// current. Writes only rows whose logs changed; returns how many.
export async function backfillStartupLogs(): Promise<number> {
  const scripts = await getAllScripts();
  const toSet: Record<string, unknown> = {};
  for (const script of scripts) {
    if (script.status !== 'ok') continue;
    const logs = extractStartupLogs(script.header, script.relativePath, script.usesUnsafeWindow === true);
    if (JSON.stringify(logs) === JSON.stringify(script.startupLogs ?? [])) continue;
    const next: StoredScript = { ...script };
    if (logs.length > 0) next.startupLogs = logs;
    else delete next.startupLogs;
    toSet[scriptKey(script.id)] = next;
  }
  const changed = Object.keys(toSet).length;
  if (changed > 0) await writeLocal(toSet);
  return changed;
}

// Re-run all of `validateHeader` on stored `ok` rows, so a header check
// added in an update (e.g. refusing `@run-at context-menu`) stops
// scripts already installed rather than only new or changed ones. Same
// reason as the backfills above: an unchanged script's row is never
// rebuilt. Writes only rows that now fail; returns how many.
//
// Each flipped row gets its error in the Log here: the boot replay
// runs on the same wake and may have read the row while it was still
// `ok`, which would leave an INVALID badge over a Log that says nothing.
export async function backfillHeaderProblems(): Promise<number> {
  const scripts = await getAllScripts();
  const toSet: Record<string, unknown> = {};
  for (const script of scripts) {
    if (script.status !== 'ok') continue;
    const problem = validateHeader(script.header);
    if (!problem) continue;
    const next: StoredScript = { ...script, status: 'invalid' };
    setScriptError(next, problem.message, locationIn(script.relativePath, problem.line));
    // Same shape as a freshly built invalid row (see
    // `buildScriptFromText`): no startup logs, parse verdict or world
    // flag, and no stale refresh failure competing with the error.
    delete next.startupLogs;
    delete next.parseCheckedHash;
    delete next.usesUnsafeWindow;
    delete next.refreshError;
    toSet[scriptKey(script.id)] = next;
  }
  const flipped = Object.values(toSet) as StoredScript[];
  if (flipped.length > 0) await writeLocal(toSet);
  for (const row of flipped) {
    const entry = loadStateLogEntry(row);
    if (entry) await appendScriptLog(row.id, { ...entry, source: 'extension-update' });
  }
  return flipped.length;
}

// Reorder the collections index by moving the given collection one
// position up or down. No-op if the collection is already at the
// boundary in the requested direction (caller-side Up/Down buttons
// disable themselves at the ends, but the function tolerates a
// redundant call). Only the index row is rewritten; per-collection rows
// are untouched.
export async function moveCollection(
  id: string,
  direction: 'up' | 'down',
): Promise<void> {
  await mutate(async () => {
    const ids = await readCollectionIndex();
    const idx = ids.indexOf(id);
    if (idx < 0) return;
    const swapWith = direction === 'up' ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= ids.length) return;
    const next = ids.slice();
    [next[idx], next[swapWith]] = [next[swapWith]!, next[idx]!];
    await writeLocal({ [COLLECTIONS_INDEX_KEY]: next });
  });
}

export async function removeCollection(id: string): Promise<void> {
  const nextIndex = await mutate(async () => {
    const collection = await getRaw<StoredCollection>(collectionKey(id));
    const ids = await readCollectionIndex();
    const next = ids.filter((sid) => sid !== id);
    const scriptIds = collection?.scriptIds ?? [];
    const rows = await getMany(scriptIds.map(scriptKey));
    const removed = scriptIds.map((sid) => rows[scriptKey(sid)] as StoredScript | undefined)
      .filter((r): r is StoredScript => r !== undefined);
    const removeKeys = [
      collectionKey(id),
      ...scriptIds.map(scriptKey),
      ...await unreferencedScratchTextKeys(removed),
    ];
    await writeLocal({ [COLLECTIONS_INDEX_KEY]: next });
    await chrome.storage.local.remove(removeKeys);
    return next;
  });
  // Session-storage bookkeeping, so a removed collection can't leave a
  // banner counting a section that is no longer on the page. After the
  // write, not inside it: the local write is the one that has to be
  // atomic, and a failure here must not undo a removal that succeeded.
  await pruneRefreshErrors(nextIndex);
}

// Drop a single script row from storage and remove its ID from the
// parent collection's scriptIds list. Used by the collections-page
// trash-cans (container rows, `missing` rows from older versions), the
// delete-local-file dialog, and `refreshScript` when a directory no
// longer lists the file — refreshCollection won't recreate the row
// because it only adds entries the scan currently reports.
export async function removeScript(id: string): Promise<void> {
  await mutate(async () => {
    const script = await getRaw<StoredScript>(scriptKey(id));
    if (!script) return;
    const collection = await getRaw<StoredCollection>(collectionKey(script.collectionId));
    const toSet: Record<string, unknown> = {};
    if (collection) {
      const nextIds = collection.scriptIds.filter((sid) => sid !== id);
      if (nextIds.length !== collection.scriptIds.length) {
        toSet[collectionKey(collection.id)] = { ...collection, scriptIds: nextIds };
      }
    }
    if (Object.keys(toSet).length > 0) await writeLocal(toSet);
    await chrome.storage.local.remove([scriptKey(id), ...await unreferencedScratchTextKeys([script])]);
  });
  // After the write, not inside it: the local write is the one that has
  // to be atomic, and a failure here must not undo a removal that
  // succeeded. The refresh path drops rows the same way and clears their
  // logs the same way.
  await forgetScriptLogs([id]);
}

// The text rows of the scratch scripts among `removed` that no other
// script row still reads. A scratch script moved into another collection
// keeps reading its text row, so a URL some remaining row names keeps
// its text. Reads nothing more when no scratch script is among those
// removed, and otherwise only the container collections' rows: a
// scratch script can only be moved into another container. Call
// inside `mutate`, before the rows are deleted.
async function unreferencedScratchTextKeys(removed: readonly StoredScript[]): Promise<string[]> {
  const urls = new Set(removed.map((r) => r.relativePath).filter(isScratchUrl));
  if (urls.size === 0) return [];
  const removedIds = new Set(removed.map((r) => r.id));
  const collectionRows = await getMany((await readCollectionIndex()).map(collectionKey));
  const others: string[] = [];
  for (const value of Object.values(collectionRows)) {
    const c = value as StoredCollection | undefined;
    if (!c || !isContainerCollection(c.path)) continue;
    for (const sid of c.scriptIds) if (!removedIds.has(sid)) others.push(sid);
  }
  const rows = await getMany(others.map(scriptKey));
  for (const value of Object.values(rows)) {
    urls.delete((value as StoredScript).relativePath);
  }
  return [...urls].map(scratchTextKey);
}

// ---------- Membership reconciliation ----------

// The rows `reconcileScriptMembership` needs when the caller hasn't
// already read them: every script row, and every collection row the
// INDEX still lists.
//
// Index-filtered so this agrees with the collections page, which passes
// what `getCollections` gave it. A `collection:` row the index has lost
// is not somewhere a script can be put back — nothing renders or
// refreshes it — so both callers have to treat scripts naming one as
// collectionless rather than re-link them into a collection no surface
// shows.
//
// The filter also means a de-indexed row's stale cross-listing is left
// alone rather than dropped. That listing is invisible either way, and
// leaving one row of garbage beats writing to a collection we've just
// decided isn't real.
async function scanMembershipRows(): Promise<{
  collections: StoredCollection[]; scripts: StoredScript[];
}> {
  const all = await scanAllStorage('membership reconcile');
  // Out of the scan rather than a second read, so the index and the rows
  // it filters are one snapshot. `ensureCollectionKeysMigrated` already
  // ran, so this is the post-rename spelling.
  const index = all[COLLECTIONS_INDEX_KEY];
  const indexed = new Set(Array.isArray(index) ? index as string[] : []);
  const collections: StoredCollection[] = [];
  const scripts: StoredScript[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(COLLECTION_PREFIX)) {
      if (indexed.has(key.slice(COLLECTION_PREFIX.length))) {
        collections.push(value as StoredCollection);
      }
    } else if (key.startsWith(SCRIPT_PREFIX)) {
      scripts.push(value as StoredScript);
    }
  }
  return { collections, scripts };
}

//
// Make `collection.scriptIds` agree with the `collectionId` on each
// script row. Every mutator writes both together, so a disagreement is
// a bug state rather than a shape the store means to represent — but a
// refresh that raced an install or a move used to overwrite the list
// from its pre-fetch snapshot and leave one behind (both directions
// now handled in `writeRefreshedCollection`).
//
// This heals profiles that already hit it. The row's own `collectionId`
// is the authority, because that is what the injector and the viewer
// read — a row unlisted by it is invisible on the collections page and
// never refreshed again, and one listed by a collection it doesn't name
// shows up under a collection it doesn't belong to.
//
// Finding a row nothing points at needs a whole-storage scan, so this
// does not run on a schedule of its own. The collections page — the
// surface where an unlisted row is missing, and the one the user is
// looking at when they notice — already scans the whole store on every
// full render, and hands what it read to `prescanned` so this costs it
// no extra reads.
//
// A row whose collection is GONE is left alone: `removeCollection`
// drops both together so it shouldn't arise, there is nowhere to put
// such a row back, and quietly deleting a user's script on a hunch is
// worse than leaving an inert row.
export async function reconcileScriptMembership(
  prescanned?: { collections: readonly StoredCollection[]; scripts: readonly StoredScript[] },
): Promise<number> {
  await ensureCollectionKeysMigrated();
  // Only the caller that has no rows in hand pays for the scan.
  const rows = prescanned ?? await scanMembershipRows();

  // {script id → the collections currently listing it}. Built over
  // every collection row rather than a flat "is listed" set, so a row
  // listed by the WRONG collection is caught too.
  const listedBy = new Map<string, string[]>();
  const known = new Set<string>();
  for (const collection of rows.collections) {
    known.add(collection.id);
    for (const sid of collection.scriptIds ?? []) {
      const owners = listedBy.get(sid);
      if (owners) owners.push(collection.id);
      else listedBy.set(sid, [collection.id]);
    }
  }

  // Per collection: ids it should list but doesn't, and ids it lists
  // that name somewhere else.
  const toAdd = new Map<string, string[]>();
  const toDrop = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, cid: string, sid: string): void => {
    const ids = map.get(cid);
    if (ids) ids.push(sid);
    else map.set(cid, [sid]);
  };
  let collectionless = 0;
  for (const script of rows.scripts) {
    const owners = listedBy.get(script.id) ?? [];
    const cid = script.collectionId;
    if (cid === undefined || !known.has(cid)) {
      collectionless++;
      continue;
    }
    if (!owners.includes(cid)) push(toAdd, cid, script.id);
    for (const other of owners) if (other !== cid) push(toDrop, other, script.id);
  }
  if (collectionless > 0) {
    console.log(
      `[SourceMonkey] membership: ${collectionless} script row(s) name no `
      + 'existing collection; left in place',
    );
  }
  if (toAdd.size === 0 && toDrop.size === 0) return 0;

  // Re-read inside the lock: the scan is stale by now, and a concurrent
  // refresh or move may already have adopted (or legitimately removed)
  // one of these rows. Read every row this pass touches in two batched
  // gets rather than one per id — the mutex is held throughout, and the
  // rest of the module keeps its critical sections short.
  return await mutate(async () => {
    const cids = new Set([...toAdd.keys(), ...toDrop.keys()]);
    const sids = new Set([...toAdd.values(), ...toDrop.values()].flat());
    const collections = await getMany([...cids].map(collectionKey));
    const scripts = await getMany([...sids].map(scriptKey));
    const ownerOf = (sid: string): string | undefined =>
      (scripts[scriptKey(sid)] as StoredScript | undefined)?.collectionId;

    const toSet: Record<string, unknown> = {};
    let moved = 0;
    for (const cid of cids) {
      const collection = collections[collectionKey(cid)] as StoredCollection | undefined;
      if (!collection) continue;
      const before = collection.scriptIds ?? [];
      const has = new Set(before);
      // Re-checked against the row as it stands now, so a move that
      // landed since the scan isn't undone by acting on stale reads.
      const add = (toAdd.get(cid) ?? []).filter((sid) => !has.has(sid) && ownerOf(sid) === cid);
      const drop = new Set((toDrop.get(cid) ?? []).filter((sid) => ownerOf(sid) !== cid));
      const after = [...before.filter((sid) => !drop.has(sid)), ...add];
      if (after.length === before.length && add.length === 0) continue;
      toSet[collectionKey(cid)] = { ...collection, scriptIds: after } satisfies StoredCollection;
      moved += add.length + drop.size;
    }
    if (moved === 0) return 0;
    await writeLocal(toSet);
    console.log(
      `[SourceMonkey] membership: reconciled ${moved} script listing(s) across `
      + `${Object.keys(toSet).length} collection(s)`,
    );
    return moved;
  });
}

// Rescan a collection + refetch all of its scripts. Adds new files,
// keeps known files (status updated based on fetch result), and drops
// the ones the scan no longer reports (see `rebuildCollection`).
// Persists the updated collection row plus every
// script row that actually changed, in one set call — see
// `changedScriptRows`.
//
// Scan failure (unreadable directory listing, unreadable manifest, bad
// URL) records a `scanError` on the collection and **leaves every script
// untouched** — content, status, and enabled state all preserved. We
// can't tell whether a collection that won't list is actually empty or
// just temporarily unreachable (remote mount with timed-out creds,
// flaky network, …), so we err on the side of keeping the user's
// scripts running until we see definitive evidence they're gone.
//
// Optimisation: skip the fetch and reuse the prior entry verbatim when
// the collection can prove a file is unchanged — file:// uses Chrome's
// directory-listing size+mtime; http(s):// uses a conditional GET
// (304 from the server). This keeps "Refresh All" cheap when most
// scripts are unchanged.
export interface RefreshOptions {
  // `@require` + `@resource` recheck policy. Defaults to 'all'
  // (explicit-Refresh semantics) so callers that don't care get the
  // conservative behavior. The script-updater passes 'preserve' on
  // the opportunistic path so background checks don't redownload
  // every dep on every navigation.
  recheckFiles?: 'all' | 'preserve';
  // Shared cross-script file-fetch cache. When refreshAllCollections
  // calls multiple refreshCollection concurrently, threading one cache
  // through them lets two scripts (across two collections) referencing
  // the same URL share one fetch. Single refreshCollection calls let it
  // default to an empty fresh map.
  fileFetchCache?: FileFetchCache;
}

export async function refreshCollection(
  id: string,
  opts: RefreshOptions = {},
): Promise<{ collection: StoredCollection; scripts: StoredScript[] } | null> {
  const timer = startPhaseTimer('collection refresh');
  const prior = await getCollectionWithScripts(id);
  if (!prior) return null;
  const { collection, scripts: existingScripts } = prior;
  timer.mark('read');
  timer.note(collection.path);

  let scan: { relativePath: string; size?: number; mtime?: number }[] = [];
  let scanError: string | undefined;
  let manifestStat: ListingEntry | null = null;
  if (isContainerCollection(collection.path)) {
    // Container collections have no scan step — their child scripts are
    // explicit. Build a synthetic scan from the existing rows so the
    // rest of the pipeline can refetch each URL/path. A `file://` child
    // gets the same listing stat a directory scan would give it (one
    // listing per folder), so an unchanged one is skipped and a page
    // can tell an edited one; HTTP children skip via conditional GET.
    const listings: DirectoryListingCache = new Map();
    scan = await Promise.all(existingScripts.map(async (s) => {
      const entry: { relativePath: string; size?: number; mtime?: number } = { relativePath: s.relativePath };
      if (isFileUrl(s.fileUrl)) {
        const stat = await statFileByListing(locationFsPath(s.fileUrl), listings);
        if (stat?.size !== undefined) entry.size = stat.size;
        if (stat?.mtime !== undefined) entry.mtime = stat.mtime;
      }
      return entry;
    }));
  } else {
    // A `file://` manifest's own stat, recorded beside the scan it
    // produced so the collections page can tell the manifest was
    // edited since. Taken BEFORE the read: an edit landing between the
    // two then shows as a change rather than being silently folded
    // into this refresh. The listing is shared with the scan, whose
    // entries usually sit in the same folder.
    const listings: DirectoryListingCache = new Map();
    if (isManifestCollection(collection.path) && isFileUrl(collectionCanonicalUrl(collection.path))) {
      manifestStat = await statFileByListing(locationFsPath(collection.path), listings);
    }
    try {
      scan = await scanForUserScripts(collection.path, 0, '', listings);
    } catch (err) {
      scanError = describeError(err);
    }
  }

  timer.mark('scan');
  const now = Date.now();

  // Scan failure (unreadable manifest, unreadable top-level directory,
  // bad URL shape) is treated as "we don't actually know what's there
  // right now" — keep every existing script row, its content, and its
  // enabled state untouched. The collection row records the scanError so
  // the collections page can surface it. Without this guard, the
  // rebuildCollection path below would drop every script — silently
  // taking the scripts away. That's the wrong call when the collection might
  // just be a remote mount with timed-out credentials, a flaky network,
  // etc.; the user wants the scripts to stay enabled until the collection
  // is actually proven gone.
  if (scanError) {
    return await mutate(async () => {
      // Re-read inside the lock so a concurrent setCollectionEnabled
      // (or displayName backfill) that landed during the scan isn't
      // reverted — we only own lastRefreshedAt + scanError here.
      const curCollection = await getRaw<StoredCollection>(collectionKey(id)) ?? collection;
      const nextCollection: StoredCollection = {
        ...curCollection,
        lastRefreshedAt: now,
        scanError,
      };
      await writeLocal({ [collectionKey(id)]: nextCollection });
      return { collection: nextCollection, scripts: existingScripts };
    });
  }

  // Fetch every scanned file — with bounded concurrency — except those
  // whose size+mtime are already current.
  const fetchResults = await fetchOrSkipInParallel(
    collection.path,
    scan,
    existingScripts,
  );
  // Marked here so the breakdown says whether the time went to reading
  // files or to everything downstream of having read them (dependency
  // fetches, hashing, the parse check).
  timer.mark('fetch');

  const scripts = await rebuildCollection({
    collectionId: collection.id,
    collectionPath: collection.path,
    existing: existingScripts,
    scan,
    fetchResults,
    now,
    recheckFiles: opts.recheckFiles,
    fileFetchCache: opts.fileFetchCache,
    localFiles: localFileScope(collection),
  });
  timer.mark('rebuild');
  // Thunked: counting the skips walks every fetch result, which a
  // disabled timer must not pay for.
  timer.note(() => {
    const skipped = [...fetchResults.values()].filter((r) => 'unchanged' in r).length;
    return `${scripts.length} scripts, ${skipped} unchanged`;
  });

  // Re-read the current rows INSIDE the lock and write atomically, so a
  // concurrent enable toggle (setCollectionEnabled / setScriptEnabled)
  // that landed during the fetch isn't reverted by stale values
  // captured before it. Content (and any deliberate refresh-owned
  // `enabled` change) is kept; we only re-apply the user's toggle when the
  // persisted `enabled` actually changed vs the snapshot this refresh
  // started from — that's the signal a setScriptEnabled landed
  // mid-fetch.
  const priorById = new Map(existingScripts.map((s) => [s.id, s]));
  // The write is the last thing that can fail, and it is the one failure
  // `chrome.storage.local` can't record — an exhausted quota rejects the
  // error row for the same reason it rejected the refresh. The reason
  // goes to `chrome.storage.session` instead, where the collections page
  // reads it. Every refresh path funnels through here, including the one
  // `addCollection` runs directly, so this is the only place that needs
  // to know. See src/refresh-error.ts.
  try {
    const written = await writeRefreshedCollection();
    timer.mark('write');
    timer.done();
    // Clears on the way out, so a collection that recovers stops
    // reporting a failure the next refresh already fixed.
    await setRefreshError(id, null);
    if (!written) return null;
    // After the write, not inside it — same rule `removeScript` follows:
    // the storage.local write is the one that has to be atomic, and a
    // log we failed to clear must not undo a refresh that landed.
    await forgetScriptLogs(written.droppedIds);
    return { collection: written.collection, scripts: written.scripts };
  } catch (err) {
    await setRefreshError(id, describeError(err));
    throw err;
  }

  // Reports `droppedIds` alongside the written state so the caller can
  // clear those scripts' logs outside the lock.
  async function writeRefreshedCollection(): Promise<
    { collection: StoredCollection; scripts: StoredScript[]; droppedIds: string[] } | null
  > {
    return await mutate(async () => {
      const curCollection = await getRaw<StoredCollection>(collectionKey(id));
      if (!curCollection) {
        // Collection was removed during the refresh — abandon the write
        // rather than resurrect a deleted collection row.
        return null;
      }
      const curScripts = await getMany(scripts.map((s) => scriptKey(s.id)));
      const priorIds = new Set(existingScripts.map((s) => s.id));

      // Membership moves under us in both directions, and the freshly
      // re-read row is the authority on both. `scripts` was rebuilt
      // from a snapshot taken before the fetch (for a container, that
      // snapshot IS the synthetic scan), so it describes a membership
      // that may be minutes stale.
      //
      // LEFT during the fetch — the row is gone (`removeScript`) or now
      // names another collection (`moveScript`). Writing the rebuilt
      // row back would resurrect a deleted script, or revert the move
      // AND leave the destination still listing it, so the same script
      // shows under two collections. `preserveConcurrentEdits` can't
      // rescue this: it re-applies fields onto the rebuilt row, and
      // what's wrong here is that the row belongs to someone else now.
      const departed = new Set<string>();
      for (const s of scripts) {
        const cur = curScripts[scriptKey(s.id)] as StoredScript | undefined;
        // A row the scan found for the first time has no stored
        // counterpart yet — that's a new script, not a departure.
        if (!cur) {
          if (priorIds.has(s.id)) departed.add(s.id);
        } else if (cur.collectionId !== id) {
          departed.add(s.id);
        }
      }
      const kept = scripts.filter((s) => !departed.has(s.id));
      const finalScripts = kept.map((s) => preserveConcurrentEdits(
        s,
        priorById.get(s.id),
        curScripts[scriptKey(s.id)] as StoredScript | undefined,
      ));

      // JOINED during the fetch — an `installScript` / `moveScript`
      // into this collection that the snapshot never saw. Writing the
      // rebuilt list verbatim would erase its id while leaving the
      // `script:` row in storage — unlisted: still pointing here via
      // `collectionId`, still injected, but shown by no collection and
      // never refreshed again.
      const rebuiltIds = finalScripts.map((s) => s.id);
      const rebuilt = new Set(rebuiltIds);
      const joinedDuringRefresh = curCollection.scriptIds.filter(
        (sid) => !rebuilt.has(sid) && !priorIds.has(sid) && !departed.has(sid),
      );

      const nextCollection: StoredCollection = {
        ...curCollection,
        lastRefreshedAt: now,
        scriptIds: [...rebuiltIds, ...joinedDuringRefresh],
      };
      // Clear any scanError left by a previous failed refresh — control
      // only reaches here when the scan succeeded (the early-return above
      // handles the failure case).
      delete nextCollection.scanError;
      // Both or neither, like a script row's size + fsMtime: a lone
      // value can't be compared against a listing.
      if (manifestStat?.size !== undefined && manifestStat.mtime !== undefined) {
        nextCollection.manifestSize = manifestStat.size;
        nextCollection.manifestMtime = manifestStat.mtime;
      } else {
        delete nextCollection.manifestSize;
        delete nextCollection.manifestMtime;
      }

      // Drop rows whose IDs are no longer referenced — an entry that
      // fell off the listing, or a manifest entry the user removed. Of
      // the ids the snapshot had, since a row that joined mid-refresh
      // was never reconciled against the scan; and never a departed
      // one, whose row is either already deleted or now owned by the
      // collection it moved to.
      const droppedIds = [...priorIds]
        .filter((sid) => !rebuilt.has(sid) && !departed.has(sid));

      // The collection row always goes: `lastRefreshedAt` moved, and
      // that's the record of the check having happened at all. The
      // script rows only go if they actually changed — see
      // `changedScriptRows`.
      const toSet: Record<string, unknown> = { [collectionKey(id)]: nextCollection };
      const changed = changedScriptRows(finalScripts, curScripts);
      for (const s of changed) toSet[scriptKey(s.id)] = s;
      timer.note(`rows written: ${changed.length}`);
      // Placed where a real quota rejection lands — after everything was
      // fetched and reconciled, with nothing written — so the test
      // exercises the same state the production failure produces.
      if (collectionWriteFailure !== null) {
        throw translateStorageError(new Error(collectionWriteFailure));
      }
      await writeLocal(toSet);
      if (droppedIds.length > 0) {
        await chrome.storage.local.remove(droppedIds.map(scriptKey));
      }

      return { collection: nextCollection, scripts: finalScripts, droppedIds };
    });
  }
}

// ---------- Batched single-script refreshes ----------
//
// The `refreshScript` calls one navigation starts — the reload fast
// path's one-per-matching-script fan-out and the opportunistic sweep
// queued off the same commit (see
// docs/injection.md#shared-work-across-the-batch). Scripts matching one
// page usually live in one collection and one folder, so without
// sharing each check re-reads the same collection row and re-lists the
// same directory, and on the worker's single thread each duplicate
// lands inside its siblings' measured time.
//
// **Scoped to one commit, never global, never with a TTL.** That bound
// is the whole safety argument, so state it as what it actually is
// rather than as "the calls all start together" — they don't:
//
//   - The fast path fans out after a single `ensureLoaded()`.
//   - The sweep runs inside `enqueueTabWork` and does `ensureLoaded()`
//     plus two session-storage round-trips first.
//
// So an entry can be written at T0 and read at T0+Δ, where Δ is
// page-load scale and widest when the worker is cold or the tab's work
// queue is backed up. Bounded by the commit, but not zero — and the
// consequence is real: a script that joined the match set inside Δ sees
// a listing captured before it started, so a save landing in that
// window reads as "unchanged" and waits for the next check. One
// navigation late, which is the same lateness a non-reload navigation
// has always had.
//
// A cache that outlived the commit would turn that bounded window into
// an unbounded one, and would need invalidation to be safe at all.
export interface RefreshBatch {
  // Collection rows by collection id. Promise-keyed so concurrent
  // starters join one read.
  collectionRows: Map<string, Promise<StoredCollection | undefined>>;
  // `file://` directory listings by absolute directory path.
  listings: DirectoryListingCache;
  // `@require` / `@resource` bodies by URL — the same sharing
  // `refreshAllCollections` already threads through its collections.
  fileFetchCache: FileFetchCache;
}

export function createRefreshBatch(): RefreshBatch {
  const listings: DirectoryListingCache = new Map();
  const fileFetchCache: FileFetchCache = new Map();
  bindListingCache(fileFetchCache, listings);
  return { collectionRows: new Map(), listings, fileFetchCache };
}

// How many collection rows `refreshScript` has actually read from
// storage since the last reset — batch hits excluded. The other half of
// what a `RefreshBatch` shares, and the phase (`read-collection`) that
// motivated it, so it gets the same kind of counter the listings do:
// without one, a change that stopped threading the batch into the row
// read would leave every test green. Same scoping caveats as
// `getDirectoryListingFetches` — per JS context, reset around the window
// under test.
let collectionRowReads = 0;
export function getCollectionRowReads(): number {
  return collectionRowReads;
}
export function resetCollectionRowReads(): void {
  collectionRowReads = 0;
}

// The batch's copy of a collection row, or a fresh read when there is no
// batch. Returns whether it was shared so the caller's phase timer can
// say so rather than just reporting a suspiciously fast phase.
async function batchCollectionRow(
  batch: RefreshBatch | undefined,
  collectionId: string,
): Promise<CollectionRowRead> {
  const hit = batch?.collectionRows.get(collectionId);
  if (hit) return { row: await hit, shared: true, ownReadMs: 0 };
  collectionRowReads += 1;
  const started = timingNow();
  const finish = async (p: Promise<StoredCollection | undefined>): Promise<CollectionRowRead> =>
    ({ row: await p, shared: false, ownReadMs: timingNow() - started });
  if (!batch) return finish(getRaw<StoredCollection>(collectionKey(collectionId)));
  const pending = getRaw<StoredCollection>(collectionKey(collectionId));
  batch.collectionRows.set(collectionId, pending);
  // A failed read must not be remembered. A cached rejection is rethrown
  // into every later sibling, so each one throws out of `refreshScript`
  // and `runScriptCheck` writes it a `Could not check for updates` Log
  // row — one transient storage failure reported once per script on the
  // page, with nothing ever retrying it. Dropping the entry restores the
  // pre-batch blast radius: the read that failed fails, its siblings try
  // again. The identity check keeps a late rejection from evicting a
  // newer entry that has already replaced it.
  void pending.catch(() => {
    if (batch.collectionRows.get(collectionId) === pending) {
      batch.collectionRows.delete(collectionId);
    }
  });
  return finish(pending);
}

interface CollectionRowRead {
  row: StoredCollection | undefined;
  shared: boolean;
  // How long THIS call's own storage read took. Zero for a sharer,
  // which performed none, and zero whenever debug logging is off.
  //
  // Separate from the `read-collection` phase on purpose. That phase
  // spans from the caller's own script-row read to this promise
  // settling, so a sharer's copy measures waiting, and even the
  // reader's includes any time the worker's single thread spent on
  // unrelated work before the read's callback could run. When the two
  // disagree the phase is not describing this code — which is exactly
  // what a full-namespace `scanAllStorage` elsewhere in the worker did
  // to it once already.
  ownReadMs: number;
}

// Only the single-script path can defer the parse check: it is the one
// with a caller (the reload fast path) that a page is blocking on, and
// deferring means one row to re-check afterwards rather than a
// collection's worth.
export interface ScriptRefreshOptions extends RefreshOptions {
  parseCheck?: ParseCheckMode;
  // Work shared with the other `refreshScript` calls started alongside
  // this one. Single-script only: `refreshCollection` /
  // `refreshAllCollections` have their own sharing story (one scan, one
  // `fileFetchCache` threaded across collections) and must not be given
  // one of these.
  batch?: RefreshBatch;
}

// Refetch a single script. Goes through the same per-file pipeline as
// the directory-level Refresh (fetchOrSkipInParallel →
// rebuildCollection) so the two paths can't drift — same skip rules,
// same fsMtime handling, same enabled-preservation, same error shape.
// The single- file path additionally lists the file's parent dir once
// so it has the size+mtime needed by the skip check.
//
// A local-directory script whose file the parent listing no longer
// shows, and whose read then fails, is dropped here, the same as the
// directory-level Refresh would drop it: the listing is the directory
// saying what it holds now, and this path lists it anyway for the
// size+mtime skip. Only a listing that was read — a failed listing
// leaves the scan bare and the row alone — and only in a directory
// collection: a manifest entry or a single file is listed for the
// skip too, but its row is the manifest's or the user's to drop, so a
// vanished one fails its fetch and keeps running from the cached body
// with a `refreshError`. The read is required too because this path
// runs on every navigation and tab focus, so it can catch a file in
// the gap of an unlink-and-rename save; one that reads fine is not
// gone.
//
// Timed, because this is what the reload fast-path races against a
// 500 ms window (docs/injection.md#reload-fast-path) and "it didn't
// make it" was previously unattributable. The phases mirror the
// collection-refresh timer's so the two lines read the same way.
export async function refreshScript(
  scriptId: string,
  opts: ScriptRefreshOptions = {},
): Promise<StoredScript | null> {
  const timer = startPhaseTimer('script check');
  // Two point reads, necessarily in series: the collection key comes
  // out of the script row. Measured at ~150-190ms combined on the
  // reload fast path — by far its largest fixed cost, and paid by
  // unchanged scripts too — so they are marked separately. The script
  // row carries the whole source; the collection row is a few fields,
  // and it used to read SLOWER — which was never about either row. A
  // full-namespace storage scan elsewhere in the worker was holding
  // the only thread, so the read's callback couldn't run. Neither
  // payload nor the batch's duplicate reads explained it; both were
  // guessed first and both were wrong.
  //
  // The `gets:` note is what settled it, and is why it stays: it
  // measures the read itself, next to a phase that measures the read
  // PLUS whoever else owns the thread. When those two disagree, the
  // phase is not describing this code. See
  // docs/diagnostics.md#read-collection-is-still-slow.
  //
  // "The read itself" is really `getRaw`, which gates on
  // `ensureCollectionKeysMigrated`. Memoised, so free after the first
  // call in a worker generation — but the first check after a wake
  // attributes the migration probe to `gets: script`, and on an
  // unmigrated profile the whole migration scan with it.
  const scriptReadStarted = timingNow();
  const prior = await getScript(scriptId);
  const scriptReadMs = timingNow() - scriptReadStarted;
  if (!prior) return null;
  timer.mark('read-script');
  // Shared across the batch when there is one: the scripts a page
  // matches are usually all in the same collection, so this row is read
  // once for the group instead of once per script.
  const collection = await batchCollectionRow(opts.batch, prior.collectionId);
  const collectionRow = collection.row;
  if (!collectionRow) return null;
  timer.mark('read-collection');
  if (collection.shared) timer.note('collection row shared with batch');
  else timer.note(() => `gets: script ${formatMs(scriptReadMs)}, collection ${formatMs(collection.ownReadMs)}`);
  timer.note(prior.relativePath);
  timer.note(() => `${Math.round((prior.size ?? 0) / 1024)} KB row`);

  // Build a single-entry scan. Any `file://` script gets the targeted
  // size+mtime listing lookup, the same stat its collection's refresh
  // would give it; HTTP entries rely on the conditional GET inside
  // fetchOrSkipInParallel.
  const scan: { relativePath: string; size?: number; mtime?: number }[] = [
    { relativePath: prior.relativePath },
  ];
  const fileUrl = scriptFileUrl(collectionRow.path, prior.relativePath);
  const usesListingStat = isFileUrl(fileUrl);
  // The parent listing was read and does not show the file.
  let unlisted = false;
  if (usesListingStat) {
    const fsPath = locationFsPath(fileUrl);
    const dirAbs = parentDir(fsPath);
    // Read BEFORE the call, which is what populates the cache.
    const sharedListing = hasCachedListing(opts.batch?.listings, dirAbs);
    let stat: ListingEntry | null | undefined;
    try {
      stat = await statFromListing(dirAbs, baseName(fsPath), opts.batch?.listings);
    } catch {
      /* listing failed; scan stays bare → always-fetch */
    }
    if (sharedListing) timer.note('listing shared with batch');
    // Listed, and not there. Not dropped yet: the fetch below runs
    // anyway (a bare scan means always-fetch), and a file that is back
    // by the time its body is read is a file mid-save — an editor that
    // writes by unlink + rename — not a deleted one. Only a listing
    // that lacked it AND a read that failed drops the row.
    unlisted = stat === null;
    if (stat) {
      if (stat.size !== undefined) scan[0].size = stat.size;
      if (stat.mtime !== undefined) scan[0].mtime = stat.mtime;
    }
  }
  // One `file://` directory listing, shared across the batch when there
  // is one — so N scripts in the same folder list it once between them
  // rather than N times. Unbatched callers still list per script.
  timer.mark('stat');

  const fetchResults = await fetchOrSkipInParallel(collectionRow.path, scan, [prior]);
  // Cheap when size+mtime match the stored row (no body read at all),
  // expensive when they don't. The `skipped` note is what separates
  // "the file really changed" from "we re-read it for no reason".
  timer.mark('fetch');
  timer.note(() => {
    const one = [...fetchResults.values()][0];
    return one && 'unchanged' in one ? 'unchanged' : 'refetched';
  });
  const fetched = fetchResults.get(prior.relativePath);
  // Only a directory collection mirrors the disk. A manifest entry
  // whose file is gone is still the manifest's to keep or drop, so it
  // stays — running from its cached body with a `refreshError`.
  if (unlisted && isLocalDirectoryCollection(collectionRow.path)
    && fetched && 'ok' in fetched && !fetched.ok) {
    // The directory doesn't list it and it can't be read: the file is
    // gone. Dropped the way the collection-level refresh drops it
    // (row, storage key, logs) — see the header comment. Callers
    // already handle a null result as "the row went away during the
    // check".
    console.info(`[SourceMonkey] ${prior.relativePath}: file no longer in its directory; dropping the script`);
    timer.note('file not in listing and unreadable; dropping');
    await removeScript(scriptId);
    timer.mark('drop');
    timer.done();
    return null;
  }
  const result = await rebuildCollection({
    collectionId: prior.collectionId,
    collectionPath: collectionRow.path,
    existing: [prior],
    scan,
    fetchResults,
    now: Date.now(),
    recheckFiles: opts.recheckFiles,
    // The batch's, when there is one — so two scripts on the same page
    // `@require`ing one library fetch it once between them. The `??`
    // only reflects that `fileFetchCache` is part of the inherited
    // `RefreshOptions`; no caller of `refreshScript` sets it today.
    fileFetchCache: opts.fileFetchCache ?? opts.batch?.fileFetchCache,
    localFiles: localFileScope(collectionRow),
    parseCheck: opts.parseCheck,
  });
  const next = result[0];
  if (!next) return null;
  // Covers the header parse, the `@require`/`@resource` pass (which
  // reaches the network in `recheckFiles: 'all'` mode), the source
  // hash, and the parse check.
  timer.mark('rebuild');
  // Re-read inside the lock and write atomically so edits that landed
  // during the fetch (an enable toggle, an update probe) aren't
  // reverted by values captured before them.
  const written = await mutate(async () => {
    const cur = await getRaw<StoredScript>(scriptKey(scriptId));
    // The row is gone. We read it at the top of this function, so its
    // absence now means something deleted it while we were fetching —
    // `removeCollection` (which drops the collection row and every
    // script under it) or a per-script removal. Writing would resurrect
    // an orphan: a script row no collection's `scriptIds` references,
    // invisible to the UI and never refreshed again.
    //
    // The window pre-dates the batch — the collection row was always
    // read long before this write, with the fetch and rebuild in
    // between — but a shared row widens it, because a sibling that
    // starts after the removal now takes the cached collection row
    // instead of reading `undefined` and bailing early. Checked here
    // rather than by re-reading the collection row: this covers both
    // removal paths, and costs nothing since we needed `cur` anyway.
    if (!cur) return null;
    const merged = preserveConcurrentEdits(next, prior, cur);
    // Same rule as the collection path: a check that found nothing new
    // doesn't rewrite the row. This one matters most — it's the
    // opportunistic path, so it runs on navigations rather than clicks.
    // There's no collection row here to carry a "we checked" timestamp,
    // and that's fine: nothing reads a per-script one.
    if (!sameStoredValue(merged, cur)) {
      await writeLocal({ [scriptKey(scriptId)]: merged });
    }
    return merged;
  });
  timer.mark('write');
  timer.done();
  // Deferred check, started AFTER the write and deliberately not
  // awaited: the caller that asked to defer is one a page is waiting
  // on. Started from the row as written, so the verdict is judged
  // against what is actually stored.
  //
  // Asks about the row rather than about the mode the ENTRY ran in, so
  // an http(s) entry that `rebuildCollection` downgraded to `'await'`
  // reaches here too. It is a no-op unless that awaited check failed
  // open, in which case this retries it — one extra compile the pure-
  // await path wouldn't have made, on a row that genuinely has no
  // verdict. Not worth plumbing the per-entry decision back out for.
  // `null` when the row was deleted mid-refresh (see the write above).
  // Callers already have a story for it: `runScriptCheck` logs "row
  // vanished" to the SW console, and nothing to the script's Log, which
  // went with the row.
  if (!written) return null;
  if (opts.parseCheck === 'defer') checkParsesInBackground(written);
  return written;
}

// Re-apply the parts of a script row that a refresh doesn't own, onto
// the row it just built. Called inside the write lock by both refresh
// entry points, against the row as it stands right now (`cur`) and the
// snapshot the refresh started from (`prior`).
//
//   - `enabled` — only when it actually changed under us, which is the
//     signal that a setScriptEnabled landed mid-fetch. Otherwise a
//     deliberate refresh-owned change has to win.
//   - `versionProbes` — always, because no refresh path ever produces
//     them. They arrive only from setVersionProbes, so whatever is
//     persisted now is by definition newer than what the refresh
//     started with.
//   - `collectionId` — always, for the same reason: only `moveScript`
//     writes it, so the stored value is a move that landed during the
//     fetch. A refresh rebuilds the row under the collection it was
//     asked about, and writing that back would silently revert the
//     move and leave the two collections disagreeing about who owns
//     the row. (The collection path drops such a row before it gets
//     here — see `departed` in `writeRefreshedCollection`; this is
//     what covers the single-script path.)
function preserveConcurrentEdits(
  next: StoredScript,
  prior: StoredScript | undefined,
  cur: StoredScript | undefined,
): StoredScript {
  if (!cur) return next;
  const out: StoredScript = { ...next };
  if (prior && cur.enabled !== prior.enabled) out.enabled = cur.enabled;
  out.collectionId = cur.collectionId;
  if (cur.versionProbes) out.versionProbes = cur.versionProbes;
  else delete out.versionProbes;
  return out;
}

// Which of `finalScripts` actually differ from what's already stored.
//
// Every refresh path rebuilds a full row per script — including the ones
// that took the size+mtime / 304 skip and came back byte-identical — so
// without this a refresh of N scripts writes N rows to answer a question
// about one. The rows are not small: a `@resource` rides in the row as
// base64, so re-persisting an unchanged script means re-serializing its
// payloads too.
//
// Chrome already declines to fire `storage.onChanged` for a `set` whose
// value matches what's stored (the behavior `retryRejectedRegistrations`
// in injector.ts is built around), so this changes no downstream
// listener — it drops the serialize-and-store cost that happens before
// Chrome gets far enough to compare.
//
// Callers must still return the FULL list to their own callers: what
// gets written narrows, what a refresh reports does not.
//
// Takes the rows as read inside the write lock, never the pre-fetch
// snapshot — comparing against a stale read would skip a write that a
// concurrent edit had made necessary.
function changedScriptRows(
  finalScripts: readonly StoredScript[],
  curByKey: Record<string, unknown>,
): StoredScript[] {
  return finalScripts.filter(
    (s) => !sameStoredValue(s, curByKey[scriptKey(s.id)]),
  );
}

// Structural equality over the JSON shapes `chrome.storage.local` round-
// trips: objects, arrays, and primitives.
//
// Key ORDER is deliberately not significant. A stored row's order comes
// from however it was last serialized, while a rebuilt one's comes from
// the spread-and-delete sequence that built it (`{...prior}` then
// `delete next.refreshError`, say) — so two rows that mean the same
// thing routinely disagree on order, and a `JSON.stringify` comparison
// would call every one of them changed and quietly do nothing.
//
// `undefined`-valued keys are treated as absent, matching what a storage
// round-trip does to them: a freshly built row carrying `foo: undefined`
// and a stored row with no `foo` at all are the same row.
//
// Exported for unit tests.
export function sameStoredValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => sameStoredValue(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bKeys = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  // `hasOwnProperty`, not `k in bo`: a row that came back through
  // `JSON.parse` can carry an own `__proto__`, and `in` would answer for
  // the prototype chain — comparing a stored value against an inherited
  // function. That direction only ever yields "changed" (a redundant
  // write), but own-keys-only is what this means, so it says so.
  return aKeys.every(
    (k) => Object.prototype.hasOwnProperty.call(bo, k) && sameStoredValue(ao[k], bo[k]),
  );
}

// Fetch each scanned file, at most
// FETCH_SCRIPTS_PER_COLLECTION_CONCURRENCY at a time.
//
// Dispatch is per *entry URL*, not per collection: a manifest
// collection may list http(s):// entries, file:// entries, or a mix, so
// each entry picks its fetcher and skip strategy based on the resolved
// URL scheme.
//
// Scheme behaviors:
//   - http(s)://: conditional GET. We send the prior row's ETag /
//     Last-Modified as If-None-Match / If-Modified-Since; a server 304
//     becomes `unchanged`, a 200 carries new validators back through
//     FetchResult.ok for rebuildCollection to persist.
//   - file://: direct fetch. If the scan supplied size+mtime (every
//     scan does for a local file whose folder listed), we apply the
//     pre-fetch listing skip when those match the prior row.
//
// In both modes a prior error/missing entry always refetches so it has
// a chance to recover.
export async function fetchOrSkipInParallel(
  collectionPath: string,
  scan: { relativePath: string; size?: number; mtime?: number }[],
  existing: StoredScript[],
): Promise<Map<string, FetchResult>> {
  const byPath = new Map(existing.map((s) => [s.relativePath, s]));
  // Bounded, not `Promise.all`: an unbounded fan-out over a large
  // collection holds every fetched body live at once. See
  // src/concurrency.ts.
  const results = await mapWithConcurrency(
    scan, FETCH_SCRIPTS_PER_COLLECTION_CONCURRENCY,
    async (found): Promise<[string, FetchResult]> => {
      const prior = byPath.get(found.relativePath);
      const url = scriptFileUrl(collectionPath, found.relativePath);
      if (isHttpUrl(url)) {
        try {
          const fetched = await fetchHttpText(url, prior?.status === 'ok' ? {
            etag: prior.httpEtag,
            lastModified: prior.httpLastModified,
          } : {});
          if (fetched.kind === 'unchanged') {
            return [found.relativePath, { unchanged: true }];
          }
          const ok: FetchResult = { ok: true, text: fetched.text };
          if (fetched.etag) ok.httpEtag = fetched.etag;
          if (fetched.lastModified) ok.httpLastModified = fetched.lastModified;
          return [found.relativePath, ok];
        } catch (err) {
          return [found.relativePath, { ok: false, errorMessage: describeError(err) }];
        }
      }
      // file:// (or any other non-HTTP URL the file fetcher can handle).
      const canSkip =
        prior != null &&
        prior.status === 'ok' &&
        found.size !== undefined && found.mtime !== undefined &&
        prior.size === found.size &&
        prior.fsMtime === found.mtime;
      if (canSkip) {
        return [found.relativePath, { unchanged: true }];
      }
      try {
        const text = await fetchScriptFileUrlText(url);
        return [found.relativePath, { ok: true, text }];
      } catch (err) {
        return [found.relativePath, { ok: false, errorMessage: describeError(err) }];
      }
    },
  );
  return new Map(results);
}

// Refresh every registered collection, a bounded few at a time. Returns
// the new state per collection so callers can compute "what changed"
// without a second read.
//
// One collection failing never takes the pass down, and never costs the
// others their results — its slot in the result map is simply absent.
// Both failure kinds have a durable home to be read from afterwards, so
// dropping the throw loses nothing:
//   - a scan failure → the collection row's `scanError`
//   - a write failure → the session-storage map in src/refresh-error.ts
//
// Rethrowing instead would reject the caller at the first failure while
// the remaining collections were still being written, so their outcomes
// could never be reported — and on an exhausted quota EVERY collection
// fails, which made that the normal case rather than the rare one.
export async function refreshAllCollections(
  opts: RefreshOptions = {},
): Promise<Map<string, { collection: StoredCollection; scripts: StoredScript[] }>> {
  const collections = await getCollections();
  // One shared file-fetch cache across every collection in this pass so
  // two scripts (across two collections) referencing the same canonical
  // URL share one fetch. Caller can override by passing their own.
  const fileFetchCache = opts.fileFetchCache ?? new Map();
  // Bounded like the per-file fan-out inside each collection: without a
  // cap here, N collections would each run their own in-flight set at
  // the same time and the per-collection bound wouldn't cap anything.
  // Deliberately the smaller limit of the pair, because each slot here
  // expands into a whole collection's worth of fetches — and because a
  // profile with many collections is the rarer case. See
  // src/concurrency.ts.
  const entries = await mapWithConcurrency(
    collections, FETCH_COLLECTIONS_CONCURRENCY, async (s) => {
      try {
        const r = await refreshCollection(s.id, { ...opts, fileFetchCache });
        return [s.id, r] as const;
      } catch (err) {
        // `refreshCollection` already recorded the reason where the UI
        // reads it; all this has to do is keep the sibling collections
        // running. The console line is for the SW log, not the user —
        // named, because the motivating case fails every collection at
        // once and an unattributed line would be noise. Says "failed"
        // rather than naming a cause: most throws here are the write,
        // but this catch doesn't verify that.
        console.info(`[SourceMonkey] collection refresh failed: ${s.path}: ${describeError(err)}`);
        return [s.id, null] as const;
      }
    },
  );
  const out = new Map<string, { collection: StoredCollection; scripts: StoredScript[] }>();
  for (const [id, r] of entries) {
    if (r) out.set(id, r);
  }
  return out;
}

// Coerce a caught throw into a printable string. Exported so other
// modules (notably the injector) don't have to duplicate the helper.
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Chrome's own wording for a `chrome.storage.local` write that would
// exceed the extension's quota. The text has changed across versions
// (`QUOTA_BYTES quota exceeded`, `Resource::kQuotaBytes quota
// exceeded`), so match the constant part.
const CHROME_QUOTA_REJECTION = /quota exceeded/i;

// The one message for a write that didn't fit. Names the cause and the
// fix, and takes the place of the internal-vocabulary wording Chrome
// gives — a user reading `Resource::kQuotaBytes quota exceeded` in a
// Log entry has nothing to act on. Two sentences, so both are
// punctuated (docs/diagnostics.md#wording).
export function storageFullMessage(): string {
  const quota = chrome.storage.local.QUOTA_BYTES;
  const limit = typeof quota === 'number' && quota > 0
    ? ` (Chrome allows ${Math.round(quota / (1024 * 1024))} MB)`
    : '';
  // "Out of storage space" is also the collections banner's heading
  // (`renderStorageBanner`), so the two read as one condition.
  return `SourceMonkey is out of storage space${limit}. `
    + 'Remove a script or collection you no longer need to free space.';
}

// Every `chrome.storage.local.set` in this module goes through here, so
// an out-of-quota rejection reads the same wherever it surfaces — the
// install callout, a Log entry, the collections banner. Any other
// rejection is passed through as Chrome worded it.
async function writeLocal(items: Record<string, unknown>): Promise<void> {
  try {
    await chrome.storage.local.set(items);
  } catch (err) {
    throw translateStorageError(err);
  }
}

// Chrome's error rides along as `cause` for DevTools; `describeError`
// reads only `.message`, so it never reaches a user-facing string.
function translateStorageError(err: unknown): unknown {
  return CHROME_QUOTA_REJECTION.test(describeError(err))
    ? new Error(storageFullMessage(), { cause: err })
    : err;
}

// Flip a collection's enabled flag without touching anything else. The
// match-index listens for `collection:<id>` changes and re-evaluates
// the effective enabled state of every script under this collection.
export async function setCollectionEnabled(
  id: string,
  enabled: boolean,
): Promise<StoredCollection | null> {
  return mutate(async () => {
    const collection = await getRaw<StoredCollection>(collectionKey(id));
    if (!collection) return null;
    const next: StoredCollection = { ...collection, enabled };
    await writeLocal({ [collectionKey(id)]: next });
    return next;
  });
}

// The per-collection settings the collection dialog edits.
export interface CollectionOptions {
  // The name shown everywhere. For a scripts collection it is required
  // and must be unique; for a location collection blank means "back to
  // the name inferred from the path".
  displayName?: string;
  // Per-collection opt-out of local stand-ins. Writing the field only —
  // nothing is refetched here, because the flag changes what the NEXT
  // refresh resolves to, and the collections page follows a change with
  // its own Refresh so the user sees the effect immediately.
  localFiles?: boolean;
}

export async function setCollectionOptions(
  id: string,
  options: CollectionOptions,
): Promise<StoredCollection | null> {
  return mutate(async () => {
    const collection = await getRaw<StoredCollection>(collectionKey(id));
    if (!collection) return null;
    const next: StoredCollection = { ...collection };
    if (options.displayName !== undefined) {
      const name = options.displayName.trim();
      const inferred = inferDisplayName(collection.path);
      if (!name && !inferred) throw new Error(COLLECTION_NAME_REQUIRED);
      // Same rule as `createLocationCollection`: only a name the user
      // chose is held unique; the inferred one may collide.
      if (name && name !== inferred) {
        // The default that already owns a reserved name is exempt — it
        // keeps it — but nothing else may take it.
        if (!mayUseReservedName(name, collection.path)) throw new Error(RESERVED_COLLECTION_NAME);
        const all = await getCollections();
        if (collectionNameInUse(name, all, id)) throw new Error(collectionNameInUseMessage(name));
      }
      next.displayName = name || inferred;
    }
    if (options.localFiles !== undefined) next.localFiles = options.localFiles;
    await writeLocal({ [collectionKey(id)]: next });
    return next;
  });
}

// Test-surface convenience; the dialog goes through `setCollectionOptions`.
export async function setCollectionLocalFiles(
  id: string,
  localFiles: boolean,
): Promise<StoredCollection | null> {
  return setCollectionOptions(id, { localFiles });
}

// Record what a script's upstream `@updateURL` / `@downloadURL` last
// claimed. Separate from every refresh entry point on purpose: a probe
// annotates, it never changes what runs, so this touches exactly one
// field and leaves `status`, `refreshError`, and the body alone.
//
// The caller is expected to have already decided a probe was due (see
// `probesAreFresh` and `ProbePolicy`), so this always writes: the
// refreshed `checkedAt` is what stops the next check from probing
// again. Every write costs a storage.onChanged, and thus a userscript
// re-registration pass in the background SW — so the only thing
// keeping that off the per-navigation and per-reload paths is the
// caller's staleness gate. Don't hand this a probe you didn't pace.
//
// Passing an empty list clears the field, which is how a script that
// dropped its `@updateURL` sheds a stale annotation.
export async function setVersionProbes(
  id: string,
  probes: VersionProbe[],
): Promise<StoredScript | null> {
  return mutate(async () => {
    const script = await getRaw<StoredScript>(scriptKey(id));
    if (!script) return null;
    if (probes.length === 0 && !script.versionProbes) return script;
    const next: StoredScript = { ...script };
    if (probes.length > 0) next.versionProbes = probes;
    else delete next.versionProbes;
    await writeLocal({ [scriptKey(id)]: next });
    return next;
  });
}

export async function setScriptEnabled(
  id: string,
  enabled: boolean,
): Promise<StoredScript | null> {
  return mutate(async () => {
    const script = await getRaw<StoredScript>(scriptKey(id));
    if (!script) return null;
    const next: StoredScript = { ...script, enabled };
    await writeLocal({ [scriptKey(id)]: next });
    return next;
  });
}

// Flip many scripts' enabled flags in a single storage write. This is
// the bulk-toggle path: it fires exactly one `storage.onChanged` event
// (instead of N), so the background SW's syncRegistrations runs once
// instead of once per script — turning a 15-script toggle from
// quadratic-feeling into a single round-trip.
export async function setScriptsEnabled(
  updates: { id: string; enabled: boolean }[],
): Promise<void> {
  if (updates.length === 0) return;
  await mutate(async () => {
    const keys = updates.map((u) => scriptKey(u.id));
    const got = await getMany(keys);
    const toSet: Record<string, unknown> = {};
    for (const u of updates) {
      const script = got[scriptKey(u.id)] as StoredScript | undefined;
      if (!script) continue;          // row vanished; skip silently
      if (script.enabled === u.enabled) continue;  // already in target state
      toSet[scriptKey(u.id)] = { ...script, enabled: u.enabled };
    }
    if (Object.keys(toSet).length === 0) return;
    await writeLocal(toSet);
  });
}
