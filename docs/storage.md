# Storage and the load/refresh pipeline

The script store (`src/script-store.ts`) is the persistence layer for
every userscript SourceMonkey knows about. It backs onto
`chrome.storage.local` with **one row per record** — no monolithic
blob.

Related modules:

- [file-access.md](file-access.md) — directory scanning + file fetch
  primitives used by the pipeline.
- [script-viewer.md](script-viewer.md) — the per-script viewer page that hydrates
  from this store.

## Schema

Key spaces in `chrome.storage.local`:

| Key                    | Type                | Purpose |
|------------------------|---------------------|---------|
| `"sources"`            | `string[]`          | Index of source IDs in display order. |
| `"source:<sid>"`       | `StoredSource`      | Per-directory metadata. |
| `"script:<scid>"`      | `StoredScript`      | Per-file content, parsed header, status. |
| `"pathIcon:<pageUrl>"` | `SiteIconEntry`     | Per-page-URL favicon hit (deep-page HTML discovery; see [site-icons.md](site-icons.md)). |
| `"siteIcon:<orig>"`    | `SiteIconEntry`     | Origin-level favicon fallback for an `https://host` (see [site-icons.md](site-icons.md)). |
| `"iconUrl:<url>"`      | `SiteIconEntry`     | Cached `@icon`-declared icon, keyed by header URL (see [site-icons.md](site-icons.md)). |
| `"firstRunComplete"`   | `boolean`           | Set once the SW has seeded the default sources; gates first-run seeding (see [First-run seeding](#first-run-seeding)). |

### `StoredSource`

- `id` — UUID.
- `path` — canonical source location the user added. One of:
  - absolute filesystem path or `file://` URL pointing at a directory
    of `.user.js` files (recursive scan; see
    [file-access.md](file-access.md)).
  - `http(s)://` URL to a `script_manifest.json` (see
    [http-sources.md](http-sources.md)).
  - `github.com/<o>/<r>/tree/<ref>(/<path>?)` URL for a directory
    source (blob / file URLs are rewritten to `raw.githubusercontent.com`
    at add time).
  - One of three **container** identifiers — `container:file`,
    `container:http`, `container:github` — used by the synthetic
    "Scripts from local disk / web / GitHub" sources that aggregate
    individually added `.user.js` URLs and paths. Container sources
    have no scan step; their `scriptIds` list is the source of truth.
- `lastRefreshedAt` — epoch ms of the most recent refresh.
- `scriptIds` — child script IDs in display order.
- `scanError?` — set when the directory listing itself failed.
- `enabled` — user-controlled on/off toggle. When `false`, every
  script under this source is treated as effectively disabled by the
  match index (independent of each script's own `enabled`).
- `displayName?` — short, human-readable label shown on the sources
  page heading and the viewer's Source row. Backfilled from
  `inferDisplayName(path)` on first read after upgrade
  (`backfillSourceDisplayNames`). Future user-rename UI would write
  this field; the UI prefers it over the inferred form whenever it's
  set (see [`src/source-display.ts`](../src/source-display.ts)).

### `StoredScript`

- `id` — UUID, **stable across refreshes** (keyed by `relativePath`).
- `sourceId` — back-reference so the viewer can refresh without
  looking up the parent.
- `relativePath`, `fileUrl` — identity + how to refetch.
  - Directory/manifest/github-dir source: `relativePath` is the path
    relative to the source root; `fileUrl` is the joined absolute URL.
  - Container source: `relativePath` is the full URL or absolute path
    the user added, in its canonical spelling (`canonicalSourceInput`:
    a `file://` URL collapses to its bare path, so one file on disk
    can't land as two rows); `fileUrl` is its URL form.
- `status` — `'ok' | 'invalid' | 'missing'`.
- `errorMessage?` — set when `status === 'invalid'`. Cleared on the
  transition to `missing` (the row's body is preserved, but the prior
  error reason is dropped — the file is simply gone).
- `refreshError?` — set when the latest refresh of a previously-good
  script failed but we kept the cached good copy running. Distinct
  from `errorMessage`: a row with `refreshError` keeps `status: 'ok'`
  and stays injectable — only the *update* failed. Cleared on the next
  clean refresh (or a proven-unchanged refetch). See
  [Refresh failures](#refresh-failures-keep-the-good-copy-running).
- `size` — UTF-8 byte length of the cached content. `0` is a valid
  value (an empty file is a real file). `null` only when the entry
  has never successfully loaded — i.e. its first fetch failed and
  there's no cached body to size. `'missing'` rows keep their last
  known size so the UI can still show how big the cached body is.
- `contentHash?` — universal "last-change token": a deterministic
  hash of the fetched source bytes on the last successful load. Used
  by `buildScriptFromText` to decide whether a freshly fetched body
  is actually different from the prior — see
  [change detection](#change-detection-the-last-change-token) below.
  Absent only on rows that have never successfully loaded.
- `fsMtime?` — modification time as reported by Chrome's directory
  listing on the last successful scan. Opaque integer used only for
  equality. Combined with `size` it lets refresh skip refetching files
  whose listing-reported size+mtime are unchanged. (file:// sources
  only.)
- `httpEtag?`, `httpLastModified?` — HTTP validators captured from
  the last successful fetch. Sent on the next refresh as
  `If-None-Match` / `If-Modified-Since` so the server can answer 304
  instead of resending the body. (http(s):// sources only; see
  [http-sources.md](http-sources.md).)
- `headerText`, `bodyText` — raw split of the file.
- `header` — `ParsedHeader | null` (see [script-viewer.md](script-viewer.md)).
- `matching` — `{matches, excludes, includes}` distilled from the
  header (used eventually by injection).
- `loadedAt` — epoch ms; bumped whenever fresh content lands.
- `enabled` — user-controlled per-script toggle. Preserved across
  refreshes; a script's effective enabled state is
  `source.enabled && script.enabled`.
- `requires?` — prefetched `@require` bodies, inline as an array of
  `StoredRequire` rows (`{ref, url, source, size, contentHash,
  loadedAt, httpEtag?, httpLastModified?}`) in declaration order,
  deduped by canonical URL. Absent when the script declares no
  `@require`. See [requires.md](requires.md).
- `versionProbes?` — what the script's `@updateURL` / `@downloadURL`
  last claimed, as `{kinds, url, version?, error?, checkedAt}` rows.
  Written only by `setVersionProbes`, never by the load pipeline —
  both refresh entry points re-apply the persisted value over whatever
  they built (`preserveConcurrentEdits`). Absent when the script names
  no upstream we don't already fetch from. See
  [updates.md](updates.md).

## Status model

The persisted `status` field has three values; the sources page +
viewer combine it with each script's **highest log level seen** (from
`chrome.storage.session`, see [script-log.md](script-log.md)) and its
update-probe verdict to render the Status column.

### Persisted statuses

- `'ok'` — fetch succeeded, metadata block parsed, required fields
  present (`@name` plus at least one of `@match` / `@include`).
- `'invalid'` — fetch failed, split/parse/validate reported a problem,
  or a `@require` / `@resource` dependency couldn't be loaded. The
  script can't run. `errorMessage` carries the reason:
  `'no metadata block'`, `'unterminated metadata block'`,
  `'missing @name'`, `'missing @match or @include'`, a
  fetch-failure message, or the offending dep URL.
- `'missing'` — file was in the scan listing previously but no
  longer is. Behavior:
  - On the **ok → missing** transition (and only then), `enabled`
    flips to `false` so the script stops being injected by default.
  - The row stays in storage with content + last known `size`
    preserved so the viewer keeps working.
  - If the file returns on a later refresh, the prior `enabled` is
    preserved so the user's choice survives.
  - The sources page surfaces a trash-can button on missing rows
    (`removeScript`) for clearing records the user doesn't expect back.
  - **Re-enabling** a missing row makes it run again from the cached
    body — match-index and injector both treat enabled `missing` rows
    as injectable, mirroring `ok`. Subsequent refreshes while the file
    is still gone leave `enabled` alone, so the user's opt-in survives.

On invalid or missing we **preserve the prior content** (headerText,
bodyText, parsed header, matching). The viewer keeps working. The
injector runs the script if and only if `enabled` is true and `status`
is `ok` or `missing` — `invalid` rows never inject (the current parse
result is bad, so the cached body might mean something different from
what the metadata claims).

### Refresh failures: keep the good copy running

A refresh must never downgrade a *working* script just because the
latest fetch failed or returned junk. When a prior `ok` row's refresh
fails, we keep the last-known-good row exactly as it was — `status`
stays `ok`, so it keeps injecting — and only set `refreshError` to
record the reason. Triggers:

- **Hard fetch failure** (any scheme): network error, 404, unreadable
  file, a disconnected network mount. Covers the case where a read
  throws.
- **Soft failure** (http(s) only): the fetch returned 200 but the body
  parsed `invalid` — a login / error page served in place of the
  script (e.g. a logged-out source). Scoped to http(s): a `file://`
  read returns the file's real bytes, so an `invalid` parse there is a
  genuine local edit and is flagged `invalid` immediately.
- **Dependency failure**: a `@require` / `@resource` fetch failed, so
  the script keeps running on its cached deps. (A `@require` returning
  an HTML login page is caught earlier by the Content-Type gate in
  `external-files.ts` and surfaces as a fetch failure; `@resource`
  bodies are arbitrary bytes and can't be validated this way — see
  [requires.md](requires.md).)

**Recovery** is automatic: the next refresh that lands valid content
(or a conditional-GET 304 / matching size+mtime that proves the cached
content is current again) clears `refreshError`. If the file is later
confirmed *vanished* from its listing, the row transitions to
`missing` and the `refreshError` annotation is dropped.

Both the failure and the recovery are copied into the script's own Log
(warning and info respectively), so the badge is always explainable —
see [script-log.md](script-log.md#every-surfaced-failure-lands-in-the-log).

This mirrors the [scan-failure](#scan-failure-leave-scripts-untouched)
policy one level down: scan failure protects every script in a source
when the *listing* can't be read; `refreshError` protects a single
script when its own *fetch* fails.

### Displayed status (UI-level)

`src/script-display.ts` exports `effectiveScriptStatus(script,
maxLogLevel, outdated)` which is what the sources page + viewer render.
Priority order (highest wins):

- `INVALID` — `status === 'invalid'`.
- `MISSING` — `status === 'missing'`.
- `REFRESH FAILED` — `status === 'ok'` but `refreshError` is set (the
  script runs from its cached copy; the last update failed). Ranks
  above the log-derived levels — staleness is a distinct, specific
  signal — but below `INVALID`/`MISSING`, which mean it can't run at
  all. Rendered in amber, distinct from red `INVALID`.
- `OUTDATED` — an update probe found a newer `@version` at a URL we
  deliberately don't update from. Same rationale (and same amber) as
  `REFRESH FAILED`, and ranks just under it: a source we can't reach at
  all subsumes "some other copy is ahead". See
  [updates.md](updates.md).
- `ERROR` — `status === 'ok'`, no `refreshError`, but the per-script
  log has an error entry (max log level = `error`).
- `WARNING` — `status === 'ok'` and the per-script log has a warning
  entry (max log level = `warning`).
- `OK` — everything else (no logs, or only info-level logs).

The Status cell is a link to the script's viewer Log tab in both
pages, and every non-OK state above (except OUTDATED, which the probe
logs separately) has a matching entry in that Log — INVALID / MISSING
at error level, REFRESH FAILED at warning. Repeats are suppressed and
recoveries are logged; see
[script-log.md](script-log.md#every-surfaced-failure-lands-in-the-log).

## Change detection: the last-change token

Every loaded script row carries a `contentHash` — a deterministic hash
of the fetched source bytes on the last successful load. It's the
universal "last-change token" the rest of the system uses to decide
"did anything actually change?", regardless of source kind or scheme.

### Three layers, same end-state

For every source/scheme combination the refresh pipeline still asks
the same question — "is there a new version?" — in the cheapest way
each one supports, and then has a universal fallback:

1. **Cheap pre-fetch check** (avoids the body entirely):
   - file:// in a directory source — compare the listing's
     `size` + `mtime` against the prior row.
   - http(s):// — conditional GET (`If-None-Match` /
     `If-Modified-Since`). A `304` short-circuits with no body.
2. **Fetch** — done when the pre-fetch check didn't fire, can't fire
   (e.g. file:// entry reached through a manifest, where the scan
   carries no per-file stat), or the server doesn't supply validators.
3. **Post-fetch content compare** — `buildScriptFromText` rehashes the
   freshly fetched bytes and compares with the prior `contentHash`.
   Match → `loadedAt` is preserved (the row is logically unchanged,
   so the sources page's "row updated" highlight doesn't fire).
   Mismatch → `loadedAt` is bumped to now.

This makes the **outcome** uniform across every combination of
{directory, single-file, manifest} × {raw path, file://, http(s)}:
unchanged content never registers as a change, even when the
appropriate-for-scheme cheap check couldn't prove it.

### Implementation notes

- The hash is Web Crypto SHA-256 (`crypto.subtle.digest`), hex-encoded.
  Using the standard SubtleCrypto API rather than a hand-rolled hash
  means the same helper works uniformly in service workers, page
  contexts, and Node ≥19. SubtleCrypto is async on the web platform,
  so `buildScriptFromText` and `rebuildSource` are async.
- Status still reflects the **current** parse outcome even when the
  hash matches, so a parser update between refreshes can promote an
  unchanged file from `error` → `ok` (or vice versa) without bumping
  `loadedAt`.
- HTTP validators (`httpEtag`, `httpLastModified`) on a successful
  fetch are still recorded — they let the next refresh take the cheap
  pre-fetch path even though this one didn't.

## Container sources

Container sources aggregate individually-added scripts of one kind:

- `container:file` — "Scripts from local disk"
- `container:http` — "Scripts from web"
- `container:github` — "Scripts from GitHub"

Properties:

- Auto-created the first time the user adds a single-file URL/path of
  the matching kind. Never created up-front.
- Reused on subsequent single-file adds of the same kind.
- Have no scan step. `scriptIds` is the explicit source of truth; the
  refresh pipeline builds a synthetic scan from those rows and runs
  the per-entry fetch path against each.
- Survive `removeScript` of their last child (the empty container
  stays until the user clicks Remove on the section).
- Per-script duplicate detection compares the new URL/path against
  every `relativePath` already in the container — adding the same URL
  twice returns null from `addSource`.

The dispatch rule sits in `addSource`:

- input passes `isSingleFileInput` → folded into container by kind
  (`containerKindForSingleFileInput` classifies `https://github.com/*`
  and `raw.githubusercontent.com/*` as `github`, anything else
  http(s) as `http`, raw paths / `file://` as `file`).
- otherwise → directory / manifest / github-dir source (existing
  behavior).

## Load / refresh pipeline

Every load path goes through the same pipeline:

1. List the source:
   - **Container sources** skip `scanForUserScripts` entirely. The
     synthetic scan is built from the existing `scriptIds`, one entry
     per child with `relativePath` set to the child's URL/path. No
     size/mtime hints are carried, so the per-entry skip strategy in
     `fetchOrSkipInParallel` (conditional GET for HTTP, always-fetch
     for file://) is what decides whether to re-download each child.
   - **All other sources** call `scanForUserScripts` (see
     [file-access.md](file-access.md) for local directories and
     [http-sources.md](http-sources.md) for HTTP manifests of any
     scheme). Local-directory scans carry each file's `size` and
     `mtime`; URL-style scans (manifest entries) don't have a
     pre-fetch stat step.
2. For each scanned file, decide whether to fetch — *per resolved
   entry URL*, not per source (so a manifest can mix schemes):
   - **file:// skip** (emit `{ unchanged: true }`) if the prior
     stored entry is `status: 'ok'` AND the listing's size+mtime
     match the prior `size` and `fsMtime`. Only local-directory
     scans supply these; file:// entries reached via a manifest
     always fetch.
   - **http skip** (also `{ unchanged: true }`) when the server
     answers `304` to a conditional GET driven by the prior row's
     `httpEtag` / `httpLastModified`.
   - **Fetch** otherwise. Successful HTTP fetches carry the new
     validators back through `FetchResult.ok` so they get persisted
     on the rebuilt row. Errors carry `errorMessage`.
3. For each fetched file run, in order:
   - `splitHeaderBody` (see [script-viewer.md](script-viewer.md))
   - `parseHeader`
   - `validateHeader` (`@name` + match/include present)
   - `distillMatching` (extract `@match`/`@exclude`/`@include`)
   - `buildScriptFromText` (assemble the `StoredScript`). If the
     freshly fetched bytes hash to the prior row's `contentHash`,
     `loadedAt` is preserved — the post-fetch fallback in the
     [change-detection model](#change-detection-the-last-change-token)
     so unchanged content never registers as an update even when the
     cheap pre-fetch skips couldn't fire.
4. Reconcile against the prior state in `rebuildSource`:
   - Reuse IDs by `relativePath`.
   - Mint a new UUID for any new file.
   - Vanished-entry handling depends on the source kind:
     - **Directory sources** — tag the prior file `'missing'`
       (content preserved). A vanished file may come back; the
       row stays so the viewer keeps working.
     - **Manifest sources** — drop the row entirely. The manifest
       is the user's source of truth; removing an entry is an
       explicit removal, not a "maybe gone" signal.
     - **Container sources** — vanished is never observed, because
       the synthetic scan is built from the existing scripts. Per-
       script removal goes through `removeScript` instead.
5. Persist the source row + every script row in a single
   `chrome.storage.local.set` call.

### Scan failure: leave scripts untouched

- **Triggers**: unreadable directory listing, unreadable manifest,
  malformed manifest JSON, bad URL shape.
- **Outcome**: source row records the error in `scanError`; every
  existing script is left untouched — content, status, and `enabled`
  state all preserved.
- **Why**: we can't tell whether a source that won't list is actually
  empty or just temporarily unreachable (remote mount with stale
  creds, flaky network, …). The user's scripts keep running until we
  see definitive evidence they're gone.
- **Recovery**: a later successful refresh runs the normal
  reconciliation and clears `scanError`.
- **Logging**: because no script row is touched, the per-script
  outcome pass would report "no change" for rows that were never
  checked. Instead the reason is fanned out to every script's Log at
  info level (the badge for a source-level problem stays on the source
  row), plus one entry when it clears — see
  [script-log.md](script-log.md#source-level-failures).

### Entry points

- `addSource(path)` — dispatches by input shape:
  - **single-file `.user.js`** input (URL or path) → folded into the
    matching container source (created if absent); the new script row
    is seeded and refreshed. Returns
    `{kind: 'newSource' | 'existingContainer', source, scriptId?}` to
    tell the caller whether to render a new section or replace an
    existing one. Returns `null` if the URL/path is already a script
    in that container.
  - **everything else** (directory / manifest / github-dir) →
    create an empty source row, then run `refreshSource`. Returns
    `{kind: 'newSource', source}`. Returns `null` if the source path
    is already registered.
- `refreshSource(id)` — full rescan + reload of one source
  (with the unchanged-file skip described above).
- `refreshAllSources()` — runs `refreshSource` for every registered
  source in parallel. Used by the sources page's "Refresh All"
  button and by the `?refresh` URL trigger.
- `removeSource(id)` — drop the source row + every child script row +
  rewrite the index.
- `moveSource(id, 'up' | 'down')` — swap the source one position in
  the `"sources"` index. No-op at the boundary. Only the index row
  is rewritten; per-source rows untouched.
- `removeScript(id)` — drop a single script row and remove its ID
  from the parent source's `scriptIds`. Used by the sources page's
  trash-can button on `'missing'` rows and (in container sources) on
  every row.
- `refreshScript(scriptId)` — one-file fast path used by the viewer.
  Goes through the same `fetchOrSkipInParallel` + `rebuildSource`
  pipeline as the source-level Refresh (so the two paths can't
  drift on skip rules, fsMtime handling, enabled preservation, error
  shape — they share the per-file logic), but with a single-element
  scan. For file:// sources it does a targeted directory-listing
  lookup to populate the scan's size+mtime; for http(s):// and
  manifest sources it skips that step and relies on the conditional
  GET inside `fetchOrSkipInParallel` instead. Doesn't enumerate the
  whole parent dir, so it can't transition a script into `'missing'`
  — that's the source-level Refresh's job.
- `setSourceEnabled(id, enabled)` / `setScriptEnabled(id, enabled)` —
  flip the per-source / per-script `enabled` flag with a single-row
  write. The match index picks up the change via `storage.onChanged`.
- `setScriptsEnabled(updates)` — bulk variant: flips many scripts'
  enabled flags in a **single** `chrome.storage.local.set` call.
  Used by the sources page's bulk +/− toggle so 15 flips fire one
  `storage.onChanged` event (and therefore one background re-sync)
  instead of one per script.

### Write serialization (`mutate`)

`chrome.storage.local` has no compare-and-swap, so two operations that
each *read* a row, derive a new value, and *write* it back can drop one
another's change. The classic symptom: a user toggles a script's
`enabled` flag while an opportunistic `refreshSource` is mid-fetch; the
refresh captured the old flag before the toggle and writes it back,
silently reverting the user's choice.

- All structural read-modify-writes run inside a single non-reentrant
  mutex (`mutate()` in `script-store.ts`): the enable setters, the
  index mutators (`addSource`/`addScriptToContainer` seed, `moveSource`,
  `removeSource`, `removeScript`), and the write halves of
  `refreshSource` / `refreshScript`.
- The mutex guards only the **short** critical sections. Slow fetches
  stay *outside* it: a refresh fetches first, then re-reads the current
  rows and writes **inside** the lock, taking the user-owned `enabled`
  (and the source's `displayName`) from the freshly re-read row and
  keeping the refresh-owned content. So an enable toggle that landed
  during the fetch is preserved, and I/O isn't serialized.
- Non-reentrant: a `mutate()` block must not call another mutator. The
  orchestrators honor this — `addSource` runs its dedup+seed write in
  the lock, then calls `refreshSource` (which takes the lock for its own
  write) *outside* it; `refreshAllSources` fans out `refreshSource`
  calls that each lock independently.
- **Residual** (narrow, pre-existing): adding a child to a container
  (`addScriptToContainer`) concurrently with a `refreshSource` on that
  same container can still drop the new child from `scriptIds`, because
  the refresh computes its child set from a snapshot taken before the
  add. The byte-level writes are now atomic, but this logical
  interleaving isn't reconciled. Both are user-driven from one page, so
  it's rare in practice.

## First-run seeding

So a freshly-installed extension isn't empty, SourceMonkey seeds the
`DEFAULT_SOURCES` (`script-store.ts`) on the very first run. Seeding is
**driven by the sources page**, not the SW, so the user watches the
normal Add flow (each section appears, populated) instead of scripts
materialising silently.

- **Open trigger.** On `chrome.runtime.onInstalled` with reason
  `install`, and only while `"firstRunComplete"` is unset, the SW opens
  `sources.html?first_run=1`. The flag check matters because unpacked
  reloads re-fire `onInstalled('install')`.
- **Seed trigger.** `seedDefaultSourcesViaUi()` (`sources.ts`) runs only
  when the page loads with `?first_run` AND the flag is unset — so an
  ordinary sources-page visit never seeds. It adds each default via the
  same `onAddDirectory` the Add button uses; `addSource` fetches the
  source's scripts as part of the add, so no follow-up Refresh is needed.
- **Run-once.** The page writes `"firstRunComplete"` after seeding;
  once set, neither the SW open nor the page seed fires again —
  including after the user deletes the seeded sources.
- **Reset behavior.** The test-surface `resetAllState()` sets
  `"firstRunComplete"` after clearing storage, and the e2e launch
  fixture pre-sets it at startup, so the network seed never runs during
  tests.

## Updater

`src/script-updater.ts` is the single entry point every refresh path
goes through, so concurrency and rate-limiting live in one place.

- **`updateScript(id, mode)`**, **`updateSource(id, mode)`**,
  **`updateAllSources(mode)`** — thin gates over the corresponding
  `script-store` `refresh*` functions.
- **`mode: 'manual'`** — Refresh buttons. Always runs. Awaited by the
  caller so the UI can show a spinner and re-render.
- **`mode: 'opportunistic'`** — the background SW calls this for each
  script that matches a page the user just navigated to. Fire-and-
  forget. No sooner than `UPDATE_MIN_INTERVAL_MS` (10s) after the prior
  completion for that resource; otherwise the call returns
  immediately with no work done.
- **Coalescing.** Any caller that arrives while a refresh is already in
  flight for a resource awaits the same promise instead of starting a
  second fetch — even across modes (e.g. a manual click during a
  background check).

The actual stale-tab signal isn't driven from here. The updater just
calls `script-store`, which writes to `chrome.storage.local`; the
background SW's stale-script listener picks up any content change from
the storage event itself (see
[matching.md](matching.md#stale-tab-notification)).

### Opportunistic check on navigation

When `chrome.webNavigation` reports a navigation, the SW computes the
match set as usual, then hands the matched script IDs to
`requestOpportunisticScriptChecks`. Per-script behavior:

- If a check is already in flight for this script, this caller drops
  on the floor (the in-flight one will produce a fresh storage row).
- Else if a previous check completed less than 10s ago, drop on the
  floor.
- Else `refreshScript(id)` runs in the background. The directory
  listing supplies the file's `size` + `mtime`; if both still match the
  stored row, no fetch happens (see `fetchOrSkipInParallel`). When they
  don't, the new content is fetched, parsed, and written.

Any write that lands a new `loadedAt` triggers the stale-script
listener on the SW side and flips affected tabs to PURPLE/RELOAD.

## Pure helpers (testable in isolation)

`script-store.ts` exports its core logic as pure functions so the
unit tests don't need a `chrome.storage` stub:

- `rebuildSource` — orchestrator that takes prior scripts + scan
  results + per-file fetch results and returns the new script list.
- `buildScriptFromText`, `applyFetchError`, `applyMissing`,
  `buildInitialErrorEntry` — per-script state transitions.
- `validateHeader`, `distillMatching` — header-shape checks.

Covered by `tests/unit/script-store.test.mjs`.

## Sources-page render

The sources page reads from the store and renders **one section per
source**:

- **Enable** toggle (checkbox) for the source as a whole, placed to
  the left of the directory path.
- Heading with the directory path.
- **Up / Down** arrow buttons → `moveSource`. Swap this source's
  position in the `"sources"` index. Up is disabled on the first
  section; Down is disabled on the last. The DOM moves the two
  sibling sections directly instead of re-rendering, so per-section
  state (highlights, scroll) is preserved.
- **Refresh** button → `refreshSource`.
- **Remove** button → `removeSource`. If the source owns ≥ 1 script,
  a `confirm()` dialog prompts "Remove source with N scripts?" first;
  cancel aborts the remove. An empty source removes silently.
- Table with columns **(bulk toggle) | Filename | Size | Status**.
  - Header's first cell is a small `+` / `−` bulk-toggle button:
    flips every script under this source on (when not all are on) or
    off (when all are on). Greyed when the source itself is off.
  - First column of each row is a per-script enable toggle. When the
    source is disabled, the script toggles are visually greyed and
    the checkbox itself is `disabled` (the underlying value is
    preserved so flipping the source back on restores each script's
    prior state).
  - Filename links to the viewer at
    `userscript.html?script=<scriptId>`.
  - Size shows the UTF-8 byte count of the cached content — including
    a `"0 B"` for an empty file, and the prior size for `missing` /
    `invalid` rows that retain their last-read body. Only rows that have
    never successfully loaded (`size == null`) render as `"—"`.
  - Status shows one of `OK | INVALID | MISSING | WARNING | ERROR`
    (see [Displayed status](#displayed-status-ui-level) for the
    priority rules). The label is a link to the script viewer's Log
    tab; the cell's `title` carries `errorMessage` for hover detail.
  - Missing rows get a small trash-can button next to the Status
    label. It calls `removeScript` to drop the row from storage (and
    from the parent source's `scriptIds`) — useful because a refresh
    won't re-add a row whose file the scan no longer reports.

Adding a directory triggers a full load immediately — no need to
click Refresh after adding. The input is validated client-side:
- accepted: `http(s)://…`, `file://…`, or an absolute POSIX path.
- anything else surfaces an inline error and the add is rejected
  before it touches the store.

Each rendered source section gets a stable DOM id
(`source-<sourceId>`) so it can be scrolled to via the URL fragment
or via `jumpToSource(id)`. After a successful add the page scrolls
to the new section and writes `#source-<id>` into the URL.

A page-level **Refresh All** button at the top of the sources page
runs `refreshAllSources()` and re-renders every section in place. The
same flow is auto-triggered when the sources page is opened with
`?refresh` in the query string — i.e. an external tool can poke the
extension with:

```
google-chrome chrome-extension://<extension-id>/sources.html?refresh
```

after writing new userscripts to disk. Combined with the unchanged-
file skip, this is cheap when most files are untouched.

Similarly, `?add_source=<path-or-url>`:

- Runs the same flow as typing the value into Add Source and
  clicking Add (validation, dedup, scroll-to-section).
- A single `.user.js` value (URL or path) hands off to the viewer's
  preview rather than being added outright — see
  [script-viewer.md](script-viewer.md#preview-mode). Directory /
  manifest / github-dir values still add directly.
- Scrubs the param from the URL only on success/duplicate; an
  invalid value stays in the URL so the user can edit and retry.
- `?refresh` is also scrubbed once it's been consumed, so a reload
  after the bootstrap actions doesn't re-fire them.
- Is the entry point used by `docs/redirect-page.md` (see
  [`deep-link.md`](deep-link.md)).

### Row highlights after refresh

After any refresh (single-directory or all), each row that changed
gets a persistent background color:

- **light green** (`row-updated`) — script newly added OR re-read
  and now `'ok'`.
- **light red** (`row-failed`) — script newly added with an error,
  re-read with an error, transitioned to `'missing'`, or whose refresh
  just failed (`refreshError` newly set, even though the cached body
  keeps running and `status` stays `'ok'`).
  - A refresh-failed row that **recovers** (`refreshError` cleared)
    flashes green even when the body is unchanged — otherwise the red
    highlight would silently vanish with no "it came back" feedback.

The color stays until the next refresh re-renders the section, so the
user can leave the page and come back without losing the
what-changed signal. Rows whose state was unchanged are not
highlighted — this covers all three "no change" paths uniformly:
the cheap pre-fetch skips (size+mtime, HTTP 304) and the post-fetch
content-hash compare (manifest entries, servers without validators).
See [change detection](#change-detection-the-last-change-token).

### In-place updates (no full re-render)

The sources page does **not** re-render the whole `#directories` list
on every interaction. Each user action mutates only the affected DOM:

- Per-source toggle → flips `.disabled` on the section, retitles each
  per-script toggle, and re-evaluates the bulk-toggle's symbol.
- Per-script toggle → flips `.disabled` on that row + recomputes the
  bulk-toggle symbol.
- Bulk +/− → one `setScriptsEnabled(updates)` write (one
  `storage.onChanged`, one background re-sync), then flips every row.
- Add directory → appends one new section.
- Remove → removes that section (and re-shows the placeholder if it
  was the last one).
- Refresh → rebuilds just that one section in place.
- Refresh All → rebuilds every section in place (one at a time, after
  one parallel `refreshAllSources()`).

While the async work is in flight the triggering control shows a small
inline spinner (toggle labels get a `.busy-spinner` sibling; the
bulk-toggle's glyph is replaced via `.bulk-toggle.busy`). The rest of
the page — banners, other directories, scroll position — is
undisturbed.

### Background-SW sync coalescing

`onCacheChanged` (in `match-index.ts`) fires for every
`storage.onChanged` batch that touches a `source:*` or `script:*` row.
The background SW's handler debounces by 50 ms before calling
`syncRegistrations` + `refreshAllOpenTabs`, so several rapid changes
collapse into one re-sync. `syncRegistrations` is O(total scripts) and
issues an `unregister`-all/`register`-all against `chrome.userScripts`,
so coalescing matters.
