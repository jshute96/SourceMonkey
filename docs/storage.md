# Storage and the load/refresh pipeline

The script store (`src/script-store.ts`) is the persistence layer for
every userscript VibeMonkey knows about. It backs onto
`chrome.storage.local` with **one row per record** — no monolithic
blob.

Related modules:

- [file-access.md](file-access.md) — directory scanning + file fetch
  primitives used by the pipeline.
- [script-viewer.md](script-viewer.md) — the per-script viewer page that hydrates
  from this store.

## Schema

Three key spaces in `chrome.storage.local`:

| Key                  | Type                | Purpose |
|----------------------|---------------------|---------|
| `"sources"`          | `string[]`          | Index of source IDs in display order. |
| `"source:<sid>"`     | `StoredSource`      | Per-directory metadata. |
| `"script:<scid>"`    | `StoredScript`      | Per-file content, parsed header, status. |
| `"siteIcon:<orig>"`  | `SiteIconEntry`     | Cached favicon for an `https://host` origin (see [site-icons.md](site-icons.md)). |

### `StoredSource`

- `id` — UUID.
- `path` — absolute filesystem path the user typed in. Either a
  directory (the usual case — scanned recursively for `*.user.js`)
  or a single `.user.js` file (treated as a one-script source; see
  [file-access.md](file-access.md#single-file-paths)).
- `lastRefreshedAt` — epoch ms of the most recent refresh.
- `scriptIds` — child script IDs in display order.
- `scanError?` — set when the directory listing itself failed.
- `enabled` — user-controlled on/off toggle. When `false`, every
  script under this source is treated as effectively disabled by the
  match index (independent of each script's own `enabled`).

### `StoredScript`

- `id` — UUID, **stable across refreshes** (keyed by `relativePath`).
- `sourceId` — back-reference so the viewer can refresh without
  looking up the parent.
- `relativePath`, `fileUrl` — identity + how to refetch.
- `status` — `'ok' | 'error' | 'missing'`.
- `errorMessage?` — set when `status === 'error'`.
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

## Status model

- `'ok'` — fetch succeeded, metadata block parsed, required fields
  present (`@name` plus at least one of `@match` / `@include`).
- `'error'` — fetch failed, or split/parse/validate reported a
  problem. `errorMessage` carries the reason:
  `'no metadata block'`, `'unterminated metadata block'`,
  `'missing @name'`, `'missing @match or @include'`, or a
  fetch-failure message.
- `'missing'` — file was in the scan listing previously but no
  longer is. `enabled` flips to `false` so the script stops being
  injected, but the row stays in storage (with content + last known
  `size` preserved) so the viewer keeps working. If the file returns
  on a later refresh the prior `enabled: false` is preserved so the
  user has to explicitly re-enable. The options page surfaces a
  trash-can button on missing rows (`removeScript`) for users who
  want to clear records for files they don't expect back.

On error or missing we **preserve the prior content** (headerText,
bodyText, parsed header, matching). The viewer keeps working and the
injector can still run the script (assuming it's still enabled).

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
   so the options page's "row updated" highlight doesn't fire).
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

## Load / refresh pipeline

Every load path goes through the same pipeline:

1. List the source via `scanForUserScripts`
   (see [file-access.md](file-access.md) for local directories /
   single files, and [http-sources.md](http-sources.md) for HTTP
   single-files and manifests of any scheme). Local-directory scans
   carry each file's `size` and `mtime`; URL-style scans (HTTP
   single-file, manifest entries) don't have a pre-fetch stat step.
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

### Entry points

- `addSource(path)` — create an empty source row, then run
  `refreshSource`. Returns `null` if the path is already registered.
- `refreshSource(id)` — full rescan + reload of one source
  (with the unchanged-file skip described above).
- `refreshAllSources()` — runs `refreshSource` for every registered
  source in parallel. Used by the options page's "Refresh All"
  button and by the `?refresh` URL trigger.
- `removeSource(id)` — drop the source row + every child script row +
  rewrite the index.
- `removeScript(id)` — drop a single script row and remove its ID
  from the parent source's `scriptIds`. Used by the options page's
  trash-can button on `'missing'` rows.
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
  Used by the options page's bulk +/− toggle so 15 flips fire one
  `storage.onChanged` event (and therefore one background re-sync)
  instead of one per script.

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

## Options-page render

The options page reads from the store and renders **one section per
source**:

- **Enable** toggle (checkbox) for the source as a whole, placed to
  the left of the directory path.
- Heading with the directory path.
- **Refresh** button → `refreshSource`.
- **Remove** button → `removeSource`.
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
    `error` rows that retain their last-read body. Only rows that have
    never successfully loaded (`size == null`) render as `"—"`.
  - Status shows `"OK"`, `"ERROR"`, or `"MISSING"`; the cell's `title`
    attribute carries `errorMessage` for hover detail.
  - Missing rows get a small trash-can button next to the Status
    label. It calls `removeScript` to drop the row from storage (and
    from the parent source's `scriptIds`) — useful because a refresh
    won't re-add a row whose file the scan no longer reports.

Adding a directory triggers a full load immediately — no need to
click Refresh after adding.

A page-level **Refresh All** button at the top of the options page
runs `refreshAllSources()` and re-renders every section in place. The
same flow is auto-triggered when the options page is opened with
`?refresh` in the query string — i.e. an external tool can poke the
extension with:

```
google-chrome chrome-extension://<extension-id>/options.html?refresh
```

after writing new userscripts to disk. Combined with the unchanged-
file skip, this is cheap when most files are untouched.

### Row highlights after refresh

After any refresh (single-directory or all), each row that changed
gets a persistent background color:

- **light green** (`row-updated`) — script newly added OR re-read
  and now `'ok'`.
- **light red** (`row-failed`) — script newly added with an error,
  re-read with an error, or transitioned to `'missing'`.

The color stays until the next refresh re-renders the section, so the
user can leave the page and come back without losing the
what-changed signal. Rows whose state was unchanged are not
highlighted — this covers all three "no change" paths uniformly:
the cheap pre-fetch skips (size+mtime, HTTP 304) and the post-fetch
content-hash compare (manifest entries, servers without validators).
See [change detection](#change-detection-the-last-change-token).

### In-place updates (no full re-render)

The options page does **not** re-render the whole `#directories` list
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
