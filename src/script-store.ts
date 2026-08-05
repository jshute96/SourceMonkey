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
// no longer appear in the scan listing are reconciled per collection kind:
// directory collections mark them `status: 'missing'` (file may come
// back); manifest collections delete the row (user explicitly removed the
// entry). In every error/missing case we preserve the previously
// loaded content so the viewer (and the injector) keep working.
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
  fetchFileUrlText,
  fetchHttpText,
  isContainerCollection,
  isHttpUrl,
  isManifestCollection,
  isSingleFileInput,
  joinPath,
  normalizeCollectionInput,
  scanForUserScripts,
  scriptFileUrl,
  locationFsPath,
  statFromListing,
} from './directories.js';
import {
  getValue,
  getValues,
  parseHeader,
  splitHeaderBody,
  NO_METADATA_BLOCK,
  type ParsedHeader,
} from './userscript-header.js';
import {
  attachFiles,
  distillRequires,
  distillResources,
  type FileFetchCache,
  type StoredRequire,
  type StoredResource,
} from './external-files.js';
import { localSearchRoots, localRootsReady } from './local-file-overrides.js';
import { resolveGrants, suggestGrant } from './gm-api-catalog.js';
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
import { displayLocation, stripSriFragment } from './script-display.js';
import { inferDisplayName } from './collection-display.js';
import { appendScriptLog, type LogLevel } from './script-log.js';
import { sha256Hex } from './bytes.js';
import { dlog } from './debug-log.js';

// `invalid` is the umbrella for "we couldn't load/use this script":
// metadata-block parse failure, header validation failure, fetch
// failure, or a missing/broken @require / @resource. All of them
// surface in the UI as INVALID (the user-facing label) because from
// the user's perspective the script can't run. `missing` is reserved
// for the narrower case where the script's own file vanished from
// its listing — the row is preserved with its last-known content but the
// file is gone.
export type ScriptStatus = 'ok' | 'invalid' | 'missing';

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
// Today's only producer is the unknown-`@grant` check; future
// detectors (header validation warnings, deprecated-tag notices, etc.)
// can append in extractStartupLogs.
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
  // diagnostics would be dead bytes, and applyMissing / applyFetchError
  // inherit whatever the prior `ok` row had (correct because they also
  // preserve the body the diagnostics were derived from). Persisted so
  // the wrapper rebuild at every SW startup doesn't have to re-derive
  // them — and so the Log-tab emission at content-change time can read
  // them straight off the freshly built row.
  startupLogs?: readonly StartupLog[];
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
}

// Treat any pre-`localFiles`-era stored entry as enabled, the same way
// `isCollectionEnabled` treats `enabled`.
export function collectionUsesLocalFiles(collection: StoredCollection): boolean {
  return collection.localFiles !== false;
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

// Derive parse-time diagnostics from the metadata block. Today this
// only flags unknown `@grant` names; add other producers here as
// they come up (e.g. deprecated header tags, soft `@resource`
// failures, `@grant`-but-never-called dead grants). Anything that
// blocks `validateHeader` belongs in there instead — error rows skip
// the startup-logs attachment in `buildScriptFromText`.
export function extractStartupLogs(
  header: ParsedHeader | null,
  relativePath: string,
): StartupLog[] {
  if (!header) return [];
  const logs: StartupLog[] = [];
  const grants = getValues(header, 'grant');
  if (grants.length > 0) {
    const resolved = resolveGrants(grants);
    if (resolved.unknown.length > 0) {
      // Name the near miss when the only thing wrong is capitalization
      // (`GM_xmlHttpRequest` → `GM_xmlhttpRequest`). Grant matching itself
      // stays byte-exact, matching TM/VM; without the hint the author's
      // only signal is a `ReferenceError` at call time, which says
      // nothing about the header.
      const described = resolved.unknown.map((name) => {
        const near = suggestGrant(name);
        return near ? `${name} (did you mean ${near}?)` : name;
      });
      const log: StartupLog = {
        level: 'warn',
        message: `Ignoring @grant ${described.join(', ')} — unsupported APIs`,
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
// reason the split errors are (see `userscript-header.ts`): the offline
// validator groups failures by message, so these are the strings it
// matches against rather than literals maintained in two places.
//
// Same phrasing rule too — each has to read correctly alone in the
// viewer's message bar and after the preview's `This file cannot be
// installed: ` prefix.
export const NO_NAME = 'No @name in the metadata block';
export const NO_MATCH_OR_INCLUDE =
  'No @match or @include in the metadata block, so this script would never run on any page';

// Opens every parse-check verdict (`Syntax error: <what V8 said>`).
// Exported for the same reason as the constants above: the offline
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
    const startupLogs = extractStartupLogs(header, args.relativePath);
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
//   - prior was anything else (already invalid / a re-enabled missing
//     row whose refetch failed): no good copy to protect, so flip to
//     `invalid` with the message as before.
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

// Flip an existing entry to `missing`. Preserves content (including
// the size of the cached body) for the viewer and the injector — the
// file is gone but we still hold what we last read, so the size column
// reflects that and is distinct from genuine "unknown size" rows.
//
// `enabled` only flips to false on the FIRST ok→missing transition —
// i.e. only when `existing.status === 'ok'`. Once a row has left `ok`
// (it's already `missing`, or it's `error` because an opportunistic
// per-script refetch hit a vanished file before the directory-level
// refresh ran), applyMissing leaves `enabled` alone. Otherwise we'd
// silently clobber a user who has re-enabled a missing row to run from
// the cached body: any subsequent refresh while the file is still gone
// would re-disable it. If the file later returns, rebuildCollection
// preserves whatever `enabled` value the user left in place.
//
// HTTP validators (httpEtag / httpLastModified) ride along untouched.
// The conditional-GET path is gated on `prior.status === 'ok'`, so
// stale validators are dormant; if the entry returns and fetches
// cleanly, buildScriptFromText overwrites them from the fresh response.
export function applyMissing(existing: StoredScript): StoredScript {
  const next: StoredScript = { ...existing, status: 'missing' };
  if (existing.status === 'ok') next.enabled = false;
  setScriptError(next, undefined, undefined);
  // A confirmed-vanished file subsumes any prior "refresh failed"
  // annotation — the row is now MISSING, not "running but stale".
  delete next.refreshError;
  return next;
}

// The per-script Log entry a row's *persisted load state* warrants, or
// null when the row is healthy (`ok` with no `refreshError`).
//
// Single source of truth for "how do we phrase this failure in the
// Log tab", shared by every path that can surface one: the add path
// (script-store), the refresh outcome path and the startup replay
// (script-updater). Sharing it means the same failure reads the same
// way whichever path reported it, so a user comparing two rows can
// tell "the same problem again" from "a different problem".
//
// Levels:
//   - `invalid` / `missing` → **error**. The script cannot run: the
//     injector skips `invalid` rows outright, and a `missing` row is
//     auto-disabled on the transition. That is the same severity the
//     status badge already claims.
//   - `refreshError` → **warning**. The script IS still running, from
//     its last-known-good copy; only the *update* failed. Calling that
//     an error would overstate it, and would also poison the
//     monotonic `loglevel:` sentinel so the row still read ERROR long
//     after the collection came back. (The badge is unaffected either way:
//     `effectiveScriptStatus` returns REFRESH FAILED before it ever
//     consults the max log level — see src/script-display.ts.)
export function loadStateLogEntry(
  script: Pick<StoredScript, 'status' | 'errorMessage' | 'refreshError' | 'errorLocation'>,
): { level: LogLevel; message: string; location?: DiagnosticLocation } | null {
  if (script.status === 'invalid') {
    // The location travels as its own field rather than being baked
    // into the text, so the Log tab can link it — and so this entry
    // says exactly what the status badge's hover text says.
    return {
      level: 'error',
      message: script.errorMessage ?? 'Unknown error',
      ...(script.errorLocation ? { location: script.errorLocation } : {}),
    };
  }
  if (script.status === 'missing') {
    // Deliberately no location: a vanished file has no content, and
    // `applyMissing` clears any location the row used to carry.
    return { level: 'error', message: script.errorMessage ?? 'Script file is missing' };
  }
  if (script.refreshError) {
    return { level: 'warning', message: `Refresh failed: ${script.refreshError}` };
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
// How a declared reference reads in a Log line: the SRI hash tail
// dropped (it's most of the line's width and nothing the reader can act
// on) and percent-escapes decoded, so a URL carrying a script's name
// reads as `my lib/util.js` rather than `my%20lib/util.js`. Same
// treatment every other URL a human sees already gets.
const refText = (ref: string): string => displayLocation(stripSriFragment(ref));

export function localFileLogMessages(
  prior: StoredScript | undefined,
  next: StoredScript,
): string[] {
  const out: string[] = [];
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
        out.push(
          `@${kind} ${refText(f.ref)} is loading from ${displayLocation(f.localUrl)}`,
        );
      } else if (was?.localUrl) {
        out.push(`@${kind} ${refText(f.ref)} is no longer loading from a local file`);
      }
    }
  }
  // A declaration the script dropped isn't reported — the `@require`
  // line going away is the event, and it isn't this function's to tell.
  //
  // Deduped because two `@resource` lines may name the same URL under
  // different names (deliberately — see `distillResources`), and both
  // entries would otherwise produce the identical line.
  return [...new Set(out)];
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
// Exported for `scripts/validate-userscripts.mjs`, which runs this
// half of the pipeline over a corpus of files on disk — the point of
// that tool is to exercise the production path, so it calls this
// rather than restating the sequence.
export async function applyFiles(
  built: StoredScript,
  prior: StoredScript | undefined,
  recheck: 'all' | 'preserve',
  fetchCache: FileFetchCache,
  now: number,
  // Whether this script's collection allows local stand-ins. Defaults
  // to false so the offline validator (and any other caller outside the
  // extension) keeps the plain declared-URL behavior.
  useLocalFiles = false,
): Promise<StoredScript> {
  const priorRequires = new Map((prior?.requires ?? []).map((r) => [r.url, r]));
  const priorResources = new Map((prior?.resources ?? []).map((r) => [r.url, r]));
  // Configured roots come from storage, so make sure that read has
  // landed before asking — a refresh racing SW startup would otherwise
  // resolve as if none were set and persist that.
  if (useLocalFiles) await localRootsReady();
  const localRoots = localSearchRoots(built.fileUrl, useLocalFiles);
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
      return applyParseCheck(built, prior);
    }
  }
  const result = await attachFiles({
    scriptFileUrl: built.fileUrl,
    header: built.header,
    priorRequires,
    priorResources,
    recheck,
    fetchCache,
    now,
    localRoots,
  });
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
    // the require Content-Type gate (HTML rejected) in external-files;
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
  return applyParseCheck(built, prior);
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
// The version leg is there because the checked text also contains code
// WE emit — the `GM_*` bindings, whose set of `const` names comes from
// `gm-api-catalog.ts`. Add a binding in a future release and a script
// that already declares that name becomes a parse failure, with
// nothing about the script itself having changed. Without the version
// in the key, the cached pass would survive the upgrade.
//
// Future hazard: `buildGmBindingsForScript` is async against the day it
// bakes persisted `GM_*` values into the bindings. If that lands, those
// values become part of the checked text and belong in this key — and
// the install preview, which checks a synthetic row with a placeholder
// id (`runPreviewParseCheck` in userscript.ts), would start reading
// some other script's values.
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
): Promise<StoredScript> {
  // Nothing to check on a row that already failed for another reason
  // (missing file, bad header) — there may be no body at all.
  if (built.status !== 'ok') return built;
  const key = parseCheckKey(built);
  // Unchanged since the last check, so the previous verdict still
  // holds. This is what keeps opportunistic refreshes from paying a
  // round trip per script for content that didn't move.
  if (prior?.parseCheckedHash === key && prior.status === 'ok') {
    built.parseCheckedHash = key;
    return built;
  }
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

interface ScanEntry {
  relativePath: string;
  size?: number;
  mtime?: number;
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
  // Does this collection allow local stand-ins for the files its scripts
  // declare (`StoredCollection.localFiles`)? Passed as a plain flag rather
  // than the whole collection row because the roots are derived per script,
  // from each script's own `fileUrl`. Defaults to false so a caller that
  // hasn't thought about it gets the declared-URL-only behavior.
  useLocalFiles?: boolean;
}

// Pure orchestrator: given the prior state for a collection plus a
// fresh scan and the per-file fetch results, return the new list of
// `StoredScript`s in canonical order (scan order, then any entries that
// fell off the listing tagged `missing`). Stable IDs come from looking
// up by relativePath in `existing`. No I/O — easy to test.
//
// Vanished-entry handling depends on the collection kind:
//   - Manifest collections: an entry that's no longer listed is treated
//     as an explicit user removal — the row is dropped entirely (the
//     `refreshCollection` caller then deletes the storage row).
//   - Other collections (local directory): the prior row is tagged
//     `missing` and auto-disabled. The file might come back; the row
//     stays so the viewer keeps working.
export async function rebuildCollection(args: RebuildArgs): Promise<StoredScript[]> {
  const newId = args.newId ?? (() => crypto.randomUUID());
  const recheckFiles = args.recheckFiles ?? 'all';
  const fileFetchCache: FileFetchCache = args.fileFetchCache ?? new Map();
  const useLocalFiles = args.useLocalFiles ?? false;
  const existingByPath = new Map<string, StoredScript>();
  for (const e of args.existing) existingByPath.set(e.relativePath, e);

  // Each scanned entry resolves to one StoredScript. Most paths are
  // synchronous (unchanged, error, defensive fallbacks); the `ok`
  // path goes through buildScriptFromText which is async because the
  // content-hash uses SubtleCrypto. We wrap every branch in a Promise
  // and Promise.all at the end so the hash work overlaps and the
  // output order matches scan order.
  const entryPromises: Promise<StoredScript>[] = [];
  const handledPaths = new Set<string>();
  for (const found of args.scan) {
    handledPaths.add(found.relativePath);
    const prior = existingByPath.get(found.relativePath);
    const id = prior?.id ?? newId();
    const fileUrl = scriptFileUrl(args.collectionPath, found.relativePath);
    const fr = args.fetchResults.get(found.relativePath);
    if (fr && 'ok' in fr && fr.ok) {
      entryPromises.push((async (): Promise<StoredScript> => {
        const built = await buildScriptFromText({
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
        });
        // Preserve the user's per-script enabled choice across refreshes.
        // `versionProbes` is deliberately NOT carried here — it's
        // re-applied from the persisted row by preserveConcurrentEdits
        // inside the write lock, which is strictly more current than
        // this pre-fetch snapshot.
        if (prior) built.enabled = prior.enabled;
        // Record the listing's mtime so the next refresh can decide to
        // skip a refetch.
        if (found.mtime !== undefined) built.fsMtime = found.mtime;
        const withFiles = await applyFiles(built, prior, recheckFiles, fileFetchCache, args.now, useLocalFiles);
        // Soft-failure preservation: an http(s) fetch that returned 200
        // but parsed `invalid`, when we have a prior `ok` copy, is a
        // refresh failure — a login / error page served in place of the
        // script — not a real content replacement. Keep the prior good
        // body running and annotate `refreshError` instead of clobbering
        // it with the garbage. Scoped to http(s): a file:// read returns
        // the file's real bytes, so an `invalid` parse there is a genuine
        // local edit the user wants to see flagged immediately.
        if (
          withFiles.status === 'invalid' &&
          prior && prior.status === 'ok' &&
          isHttpUrl(fileUrl)
        ) {
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
      })());
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
        entryPromises.push(
          applyFiles(next, prior, recheckFiles, fileFetchCache, args.now, useLocalFiles),
        );
      } else {
        entryPromises.push(Promise.resolve(buildInitialInvalidEntry({
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
        entryPromises.push(Promise.resolve(applyFetchError(prior, errorMessage)));
      } else {
        entryPromises.push(Promise.resolve(buildInitialInvalidEntry({
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
      entryPromises.push(Promise.resolve(prior
        ? applyFetchError(prior, NOT_READ)
        : buildInitialInvalidEntry({
            id, collectionId: args.collectionId, relativePath: found.relativePath,
            fileUrl, errorMessage: NOT_READ, now: args.now,
          })));
    }
  }

  const out = await Promise.all(entryPromises);

  // Anything in `existing` that the scan didn't see → either marked
  // missing (directory collections: file may come back) or dropped
  // (manifest collections: the user explicitly removed the entry).
  const dropVanished = isManifestCollection(args.collectionPath);
  for (const e of args.existing) {
    if (handledPaths.has(e.relativePath)) continue;
    if (dropVanished) continue;
    out.push(applyMissing(e));
  }
  return out;
}

// ---------- chrome.storage.local I/O ----------

const COLLECTIONS_INDEX_KEY = 'collections';
const collectionKey = (id: string) => `collection:${id}`;
const scriptKey = (id: string) => `script:${id}`;

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
  'https://github.com/jshute96/SourceMonkey/tree/main/userscripts',
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

  const all = await chrome.storage.local.get(null);
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
  await chrome.storage.local.set(toSet);
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
  const all = await chrome.storage.local.get(null);
  const out: StoredScript[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith('script:')) out.push(value as StoredScript);
  }
  return out;
}

export async function getCollection(id: string): Promise<StoredCollection | undefined> {
  return await getRaw<StoredCollection>(collectionKey(id));
}

// Result of `addCollection`. Three outcomes:
//   - newCollection: a brand-new collection row was created (a directory /
//     manifest / github-dir collection, or a never-before-seen container
//     auto-created for the first single-file add of its kind). The
//     caller appends a fresh section to the DOM.
//   - existingContainer: the input was a single-file URL/path added
//     into a container that already existed. The caller re-renders
//     that container's section in place.
//   - null: the input was a duplicate (an already-registered collection
//     path, or a script URL/path already present in its container).
//     The caller surfaces the duplicate message and jumps to the
//     existing section.
export type AddCollectionResult =
  | { kind: 'newCollection'; collection: StoredCollection }
  | { kind: 'existingContainer'; collection: StoredCollection; scriptId: string }
  | null;

// Register a new collection from a raw user input. Dispatches by input
// shape:
//   - single-file `.user.js` URL/path → folded into the matching
//     container collection (created on demand if none exists). The script
//     is added to the container's `scriptIds` and its initial fetch
//     runs immediately so the table populates without a manual
//     Refresh.
//   - everything else (directory, manifest, github-dir URL) → mints a
//     UUID, persists an empty collection row, then refreshes to populate
//     the scripts.
//
// `normalizeCollectionInput` runs first so a github.com
// `/blob/.../foo.user.js` (or `/blob/.../script_manifest.json`) URL
// gets rewritten to its raw counterpart before we hit the duplicate
// check. The github blob URL serves HTML, not raw bytes, so storing it
// verbatim would silently load the page chrome instead of the script —
// see [docs/http-collections.md].
export async function addCollection(rawPath: string): Promise<AddCollectionResult> {
  // Two canonicalizations, in order: provider rewriting (github blob →
  // raw), then the one-spelling-per-location rule. The second is what
  // keeps `/x/a.user.js` typed into the collections page and
  // `file:///x/a.user.js` arriving from a captured navigation from
  // becoming two rows for one file — see `canonicalCollectionInput`.
  const path = canonicalCollectionInput(await normalizeCollectionInput(rawPath));

  if (isSingleFileInput(path)) {
    return await addScriptToContainer(path);
  }

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
    const id = crypto.randomUUID();
    const seed: StoredCollection = {
      id,
      path,
      lastRefreshedAt: 0,
      scriptIds: [],
      enabled: true,
      // Seed an inferred displayName at add-time so a viewer opened
      // mid-add (or any other reader) doesn't briefly see a row whose
      // name only materialises on the next backfill pass.
      displayName: inferDisplayName(path),
    };
    const nextIndex = [...collections.map((s) => s.id), id];
    await chrome.storage.local.set({
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
  await chrome.storage.local.set({ [FIRST_RUN_DONE_KEY]: true });
}

// Add a single-file input to the matching container collection. Creates
// the container row if this is the first script of its kind. Returns
// null if the URL/path is already registered as a script under its
// container. The fetch runs as part of `refreshCollection` so the new
// row lands populated.
async function addScriptToContainer(path: string): Promise<AddCollectionResult> {
  const kind = containerKindForSingleFileInput(path);
  const cPath = containerPath(kind);

  // Dedup-check and seed the container + script atomically so a
  // concurrent add (or index mutator) can't lose this scriptIds/index
  // write. The refresh runs OUTSIDE the lock. Returns null on duplicate.
  const seeded = await mutate(async () => {
    const collections = await getCollections();
    const existingContainer = collections.find((s) => s.path === cPath);
    const isNew = !existingContainer;
    if (existingContainer) {
      // Each container script's `relativePath` is the full URL/path the
      // user added; any prior row with the same value is a duplicate.
      const existingScripts = await getMany(existingContainer.scriptIds.map(scriptKey));
      for (const sid of existingContainer.scriptIds) {
        const s = existingScripts[scriptKey(sid)] as StoredScript | undefined;
        if (s === undefined) continue;
        // Canonicalize the STORED value too: rows written before
        // `addCollection` started collapsing `file://` inputs still
        // carry the URL spelling, and comparing raw would offer to
        // install a second copy of a file we already have.
        if (canonicalCollectionInput(s.relativePath) === path) return null;
      }
    }

    const now = Date.now();
    const containerId = existingContainer?.id ?? crypto.randomUUID();
    const scriptId = crypto.randomUUID();
    const priorScriptIds = existingContainer?.scriptIds ?? [];
    const nextContainer: StoredCollection = existingContainer
      ? { ...existingContainer, scriptIds: [...priorScriptIds, scriptId] }
      : {
          id: containerId,
          path: cPath,
          lastRefreshedAt: 0,
          scriptIds: [scriptId],
          enabled: true,
          displayName: inferDisplayName(cPath),
        };
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
    await chrome.storage.local.set(toSet);
    return { isNew, containerId, scriptId, nextContainer };
  });
  if (!seeded) return null;
  const { isNew, containerId, scriptId, nextContainer } = seeded;

  const refreshed = await refreshCollection(containerId);
  if (refreshed) {
    await Promise.all(refreshed.scripts.map(emitInitialLoadLog));
  }
  const finalCollection = refreshed?.collection ?? nextContainer;
  if (isNew) return { kind: 'newCollection', collection: finalCollection };
  return { kind: 'existingContainer', collection: finalCollection, scriptId };
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
  for (const message of localFileLogMessages(undefined, script)) {
    await appendScriptLog(script.id, { level: 'info', source: 'add', message });
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
    await chrome.storage.local.set(toSet);
  }
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
    await chrome.storage.local.set({ [COLLECTIONS_INDEX_KEY]: next });
  });
}

export async function removeCollection(id: string): Promise<void> {
  await mutate(async () => {
    const collection = await getRaw<StoredCollection>(collectionKey(id));
    const ids = await readCollectionIndex();
    const nextIndex = ids.filter((sid) => sid !== id);
    const removeKeys = [collectionKey(id), ...(collection?.scriptIds ?? []).map(scriptKey)];
    await chrome.storage.local.set({ [COLLECTIONS_INDEX_KEY]: nextIndex });
    await chrome.storage.local.remove(removeKeys);
  });
}

// Drop a single script row from storage and remove its ID from the
// parent collection's scriptIds list. Used by the collections-page
// trash-can next to a `missing` row so the user can clear out records
// for files that are gone for good — refreshCollection won't recreate
// the row because it only adds entries the scan currently reports.
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
    if (Object.keys(toSet).length > 0) await chrome.storage.local.set(toSet);
    await chrome.storage.local.remove(scriptKey(id));
  });
  // Drop the per-script Log + max-log-level sentinel along with the
  // row itself — otherwise an orphaned session-storage entry would
  // outlive the script it described and confuse any later renderer
  // that happens to scan log levels.
  try {
    await chrome.storage.session.remove([`log:${id}`, `loglevel:${id}`]);
  } catch { /* best-effort: a missing session row isn't an error */ }
}

// Rescan a collection + refetch all of its scripts. Adds new files,
// keeps known files (status updated based on fetch result), and
// reconciles vanished files per collection kind: directory collections
// mark them `missing` (the file may come back), manifest collections
// delete them (the user explicitly removed the entry). Persists the
// updated collection row plus every script row in one set call.
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
  const prior = await getCollectionWithScripts(id);
  if (!prior) return null;
  const { collection, scripts: existingScripts } = prior;

  let scan: { relativePath: string; size?: number; mtime?: number }[] = [];
  let scanError: string | undefined;
  if (isContainerCollection(collection.path)) {
    // Container collections have no scan step — their child scripts are
    // explicit. Build a synthetic scan from the existing rows so the
    // rest of the pipeline can refetch each URL/path. No size/mtime
    // hints; HTTP entries skip via conditional GET, file:// entries
    // always refetch.
    scan = existingScripts.map((s) => ({ relativePath: s.relativePath }));
  } else {
    try {
      scan = await scanForUserScripts(collection.path);
    } catch (err) {
      scanError = describeError(err);
    }
  }

  const now = Date.now();

  // Scan failure (unreadable manifest, unreadable top-level directory,
  // bad URL shape) is treated as "we don't actually know what's there
  // right now" — keep every existing script row, its content, and its
  // enabled state untouched. The collection row records the scanError so
  // the collections page can surface it. Without this guard, the
  // rebuildCollection path below would mark every script `missing` (or, for
  // manifest collections, drop them entirely) — both of which silently
  // disable the scripts. That's the wrong call when the collection might
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
      await chrome.storage.local.set({ [collectionKey(id)]: nextCollection });
      return { collection: nextCollection, scripts: existingScripts };
    });
  }

  // Fetch every scanned file in parallel except those whose size+mtime
  // are already current.
  const fetchResults = await fetchOrSkipInParallel(
    collection.path,
    scan,
    existingScripts,
  );

  const scripts = await rebuildCollection({
    collectionId: collection.id,
    collectionPath: collection.path,
    existing: existingScripts,
    scan,
    fetchResults,
    now,
    recheckFiles: opts.recheckFiles,
    fileFetchCache: opts.fileFetchCache,
    useLocalFiles: collectionUsesLocalFiles(collection),
  });

  // Re-read the current rows INSIDE the lock and write atomically, so a
  // concurrent enable toggle (setCollectionEnabled / setScriptEnabled)
  // that landed during the fetch isn't reverted by stale values
  // captured before it. Content (and any deliberate refresh-owned
  // `enabled` change, e.g. applyMissing flipping a vanished script to
  // disabled) is kept; we only re-apply the user's toggle when the
  // persisted `enabled` actually changed vs the snapshot this refresh
  // started from — that's the signal a setScriptEnabled landed
  // mid-fetch.
  const priorById = new Map(existingScripts.map((s) => [s.id, s]));
  return await mutate(async () => {
    const curCollection = await getRaw<StoredCollection>(collectionKey(id));
    if (!curCollection) {
      // Collection was removed during the refresh — abandon the write
      // rather than resurrect a deleted collection row.
      return null;
    }
    const curScripts = await getMany(scripts.map((s) => scriptKey(s.id)));
    const finalScripts = scripts.map((s) => preserveConcurrentEdits(
      s,
      priorById.get(s.id),
      curScripts[scriptKey(s.id)] as StoredScript | undefined,
    ));

    const nextCollection: StoredCollection = {
      ...curCollection,
      lastRefreshedAt: now,
      scriptIds: finalScripts.map((s) => s.id),
    };
    // Clear any scanError left by a previous failed refresh — control
    // only reaches here when the scan succeeded (the early-return above
    // handles the failure case).
    delete nextCollection.scanError;

    // Drop rows whose IDs are no longer referenced. Hit by manifest
    // collections whose user removed an entry; also defensive against
    // any future per-script Remove.
    const priorIds = new Set(existingScripts.map((s) => s.id));
    const nextIds = new Set(finalScripts.map((s) => s.id));
    const toRemove = [...priorIds].filter((sid) => !nextIds.has(sid)).map(scriptKey);

    const toSet: Record<string, unknown> = { [collectionKey(id)]: nextCollection };
    for (const s of finalScripts) toSet[scriptKey(s.id)] = s;
    await chrome.storage.local.set(toSet);
    if (toRemove.length > 0) await chrome.storage.local.remove(toRemove);

    return { collection: nextCollection, scripts: finalScripts };
  });
}

// Refetch a single script. Goes through the same per-file pipeline as
// the directory-level Refresh (fetchOrSkipInParallel →
// rebuildCollection) so the two paths can't drift — same skip rules,
// same fsMtime handling, same enabled-preservation, same error shape.
// The single- file path additionally lists the file's parent dir once
// so it has the size+mtime needed by the skip check.
//
// Note: does NOT re-scan the parent dir for VANISHED files, so this
// can't promote a script to `missing` — that's the directory-level
// Refresh's job. (If the file is gone, the fetch will fail and the
// result is `status: 'invalid'`.)
export async function refreshScript(
  scriptId: string,
  opts: RefreshOptions = {},
): Promise<StoredScript | null> {
  const prior = await getScript(scriptId);
  if (!prior) return null;
  const collectionRow = await getRaw<StoredCollection>(collectionKey(prior.collectionId));
  if (!collectionRow) return null;

  // Build a single-entry scan. Only local-directory collections support
  // the targeted size+mtime listing lookup; HTTP, manifest, and
  // container collections rely on the per-entry skip strategy inside
  // fetchOrSkipInParallel (conditional GETs for HTTP entries, always-
  // fetch for file:// entries reached through a manifest or container).
  const scan: { relativePath: string; size?: number; mtime?: number }[] = [
    { relativePath: prior.relativePath },
  ];
  const usesListingStat =
    !isHttpUrl(collectionRow.path) &&
    !isManifestCollection(collectionRow.path) &&
    !isContainerCollection(collectionRow.path);
  if (usesListingStat) {
    const slash = prior.relativePath.lastIndexOf('/');
    const subDir = slash >= 0 ? prior.relativePath.slice(0, slash) : '';
    const fileName = slash >= 0 ? prior.relativePath.slice(slash + 1) : prior.relativePath;
    // The "scan directory" is the collection path plus any subDir
    // prefix from the relativePath. Normalise any file:// URL form back
    // to a raw fs path before doing path arithmetic so
    // parentDir/joinPath behave correctly.
    const fsRoot = locationFsPath(collectionRow.path);
    const dirAbs = subDir ? joinPath(fsRoot, subDir) : fsRoot;
    try {
      const stat = await statFromListing(dirAbs, fileName);
      if (stat) {
        if (stat.size !== undefined) scan[0].size = stat.size;
        if (stat.mtime !== undefined) scan[0].mtime = stat.mtime;
      }
    } catch {
      /* listing failed; scan stays bare → always-fetch */
    }
  }

  const fetchResults = await fetchOrSkipInParallel(collectionRow.path, scan, [prior]);
  const result = await rebuildCollection({
    collectionId: prior.collectionId,
    collectionPath: collectionRow.path,
    existing: [prior],
    scan,
    fetchResults,
    now: Date.now(),
    recheckFiles: opts.recheckFiles,
    fileFetchCache: opts.fileFetchCache,
    useLocalFiles: collectionUsesLocalFiles(collectionRow),
  });
  const next = result[0];
  if (!next) return null;
  // Re-read inside the lock and write atomically so edits that landed
  // during the fetch (an enable toggle, an update probe) aren't
  // reverted by values captured before them.
  return await mutate(async () => {
    const cur = await getRaw<StoredScript>(scriptKey(scriptId));
    const merged = preserveConcurrentEdits(next, prior, cur);
    await chrome.storage.local.set({ [scriptKey(scriptId)]: merged });
    return merged;
  });
}

// Re-apply the parts of a script row that a refresh doesn't own, onto
// the row it just built. Called inside the write lock by both refresh
// entry points, against the row as it stands right now (`cur`) and the
// snapshot the refresh started from (`prior`).
//
//   - `enabled` — only when it actually changed under us, which is the
//     signal that a setScriptEnabled landed mid-fetch. Otherwise a
//     deliberate refresh-owned change (applyMissing flipping a vanished
//     script to disabled) has to win.
//   - `versionProbes` — always, because no refresh path ever produces
//     them. They arrive only from setVersionProbes, so whatever is
//     persisted now is by definition newer than what the refresh
//     started with.
function preserveConcurrentEdits(
  next: StoredScript,
  prior: StoredScript | undefined,
  cur: StoredScript | undefined,
): StoredScript {
  if (!cur) return next;
  const out: StoredScript = { ...next };
  if (prior && cur.enabled !== prior.enabled) out.enabled = cur.enabled;
  if (cur.versionProbes) out.versionProbes = cur.versionProbes;
  else delete out.versionProbes;
  return out;
}

// Fetch each scanned file in parallel.
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
//   - file://: direct fetch. If the scan supplied size+mtime (only
//     local-directory scans do — manifests don't), we apply the
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
  const results = await Promise.all(
    scan.map(async (found): Promise<[string, FetchResult]> => {
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
      // file:// (or any other non-HTTP URL fetchFileUrlText can handle).
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
        const text = await fetchFileUrlText(url);
        return [found.relativePath, { ok: true, text }];
      } catch (err) {
        return [found.relativePath, { ok: false, errorMessage: describeError(err) }];
      }
    }),
  );
  return new Map(results);
}

// Refresh every registered collection in parallel. Returns the new
// state per collection so callers can compute "what changed" without a
// second read. A failed collection-level refresh (e.g. one collection's
// scan throws) doesn't take the rest down — its slot in the result map
// is just absent, and the collection's `scanError` field carries the
// reason.
export async function refreshAllCollections(
  opts: RefreshOptions = {},
): Promise<Map<string, { collection: StoredCollection; scripts: StoredScript[] }>> {
  const collections = await getCollections();
  // One shared file-fetch cache across every collection in this pass so
  // two scripts (across two collections) referencing the same canonical
  // URL share one fetch. Caller can override by passing their own.
  const fileFetchCache = opts.fileFetchCache ?? new Map();
  const entries = await Promise.all(
    collections.map(async (s) => {
      const r = await refreshCollection(s.id, { ...opts, fileFetchCache });
      return [s.id, r] as const;
    }),
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
    await chrome.storage.local.set({ [collectionKey(id)]: next });
    return next;
  });
}

// Per-collection opt-out of local stand-ins. Writing the field only —
// nothing is refetched here, because the flag changes what the NEXT
// refresh resolves to, and the collections page follows this with its
// own Refresh so the user sees the effect immediately.
export async function setCollectionLocalFiles(
  id: string,
  localFiles: boolean,
): Promise<StoredCollection | null> {
  return mutate(async () => {
    const collection = await getRaw<StoredCollection>(collectionKey(id));
    if (!collection) return null;
    const next: StoredCollection = { ...collection, localFiles };
    await chrome.storage.local.set({ [collectionKey(id)]: next });
    return next;
  });
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
    await chrome.storage.local.set({ [scriptKey(id)]: next });
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
    await chrome.storage.local.set({ [scriptKey(id)]: next });
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
    await chrome.storage.local.set(toSet);
  });
}
