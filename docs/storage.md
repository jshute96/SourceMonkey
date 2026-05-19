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
- `size` — UTF-8 byte length; `null` when `status === 'missing'`.
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
  longer is. `size` becomes `null` AND `enabled` is flipped to
  `false` so a script whose file vanished stops being injected. The
  row stays in storage (viewer keeps working); if the file returns
  on a later refresh the prior `enabled: false` is preserved so the
  user has to explicitly re-enable. Cleanup of long-missing rows is
  tracked in `TODO.md`.

On error or missing we **preserve the prior content** (headerText,
bodyText, parsed header, matching). The viewer keeps working and the
injector can still run the script (assuming it's still enabled).

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
   - `buildScriptFromText` (assemble the `StoredScript`)
4. Reconcile against the prior state in `rebuildSource`:
   - Reuse IDs by `relativePath`.
   - Mint a new UUID for any new file.
   - Tag any prior file not in the scan as `'missing'` (content
     preserved).
5. Persist the source row + every script row in a single
   `chrome.storage.local.set` call.

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
  - Size shows the UTF-8 byte count, or `"MISSING"` when
    `status === 'missing'`.
  - Status shows `"OK"` or `"ERROR"`; the cell's `title` attribute
    carries `errorMessage` for hover detail.

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
what-changed signal. Rows whose state was unchanged (including those
covered by the size+mtime skip) are not highlighted.

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
