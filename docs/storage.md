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
- `path` — absolute filesystem path the user typed in.
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
  longer is. `size` becomes `null`.

On error or missing we **preserve the prior content** (headerText,
bodyText, parsed header, matching). The viewer keeps working and the
(future) injector can still run the script.

## Load / refresh pipeline

Every load path goes through the same pipeline:

1. List the directory via `scanForUserScripts`
   (see [file-access.md](file-access.md)).
2. Fetch each scanned file in parallel via XHR.
3. For each file run, in order:
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
- `refreshSource(id)` — full rescan + reload of one directory.
- `removeSource(id)` — drop the source row + every child script row +
  rewrite the index.
- `refreshScript(scriptId)` — one-file fast path used by the viewer.
  Doesn't re-scan the parent dir, so it can't transition a script
  into `'missing'` — that's the directory-level Refresh's job.
- `setSourceEnabled(id, enabled)` / `setScriptEnabled(id, enabled)` —
  flip the per-source / per-script `enabled` flag with a single-row
  write. The match index picks up the change via `storage.onChanged`.

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

- Heading with the directory path.
- **Enable** toggle (checkbox) for the source as a whole.
- **Refresh** button → `refreshSource`.
- **Remove** button → `removeSource`.
- Table with columns **(toggle) | Filename | Size | Status**.
  - First column is a per-script enable toggle. When the source is
    disabled, the script toggles are visually greyed and the
    checkbox itself is `disabled` (the underlying value is preserved
    so flipping the source back on restores each script's prior
    state).
  - Filename links to the viewer at
    `userscript.html?script=<scriptId>`.
  - Size shows the UTF-8 byte count, or `"MISSING"` when
    `status === 'missing'`.
  - Status shows `"OK"` or `"ERROR"`; the cell's `title` attribute
    carries `errorMessage` for hover detail.

Adding a directory triggers a full load immediately — no need to
click Refresh after adding.
