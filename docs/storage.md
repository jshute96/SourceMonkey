# Storage and the load/refresh pipeline

The script store (`src/extension/script-store.ts`) is the persistence layer for
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
| `"collections"`         | `string[]`          | Index of collection IDs in display order. |
| `"collection:<cid>"`    | `StoredCollection`  | Per-collection metadata. |
| `"script:<scid>"`      | `StoredScript`      | Per-file header text, parsed header, status, and the hashes of its bodies. No bodies. |
| `"blob:<sha256>"`      | `StoredBlob`        | One stored body (a script body, `@require` or `@resource`), shared by every row whose body has the same bytes (see [Content blobs](#content-blobs)). |
| `"storeFormat"`        | `number`            | Storage format version, `2` once bodies moved to blobs. Absent means format 1 (see [Format 2 migration](#format-2-migration)). |
| `"pathIcon:<pageUrl>"` | `SiteIconEntry`     | Per-page-URL favicon hit (deep-page HTML discovery; see [site-icons.md](site-icons.md)). |
| `"siteIcon:<orig>"`    | `SiteIconEntry`     | Origin-level favicon fallback for an `https://host` (see [site-icons.md](site-icons.md)). |
| `"iconUrl:<url>"`      | `SiteIconEntry`     | Cached `@icon`-declared icon, keyed by header URL (see [site-icons.md](site-icons.md)). |
| `"firstRunComplete"`   | `boolean`           | Set once the SW has seeded the default collections; gates first-run seeding (see [First-run seeding](#first-run-seeding)). |
| `"smLocalFileRoots"`   | `string[]`          | Canonical `file://` directory URLs searched for local stand-ins, in order (see [local-file-overrides.md](local-file-overrides.md)). |
| `"scratch:<url>"`      | `string`            | The text of a scratch or imported script, keyed by its `scratch:///…` or `imported:///…` location (see [Container collections](#container-collections)). |
| `"scratchFiles:<url>"` | `Record<ref, PushedFile>` | The `@require` / `@resource` bodies sm-dev pushed with a scratch script, or a backup held for an imported one, by ref; absent when there were none. |
| `"scratchSource:<url>"` | `ScratchSource` | The file a scratch script was read from (its `file://` URL, and its path as the run was given it), for sm-dev's `script list`; absent from an sm-dev before protocol 1.2. |
| `"importInfo:<url>"` | `ImportInfo` | Where an imported script came from: the manager, when, the file's id for it, and its old location (see [import.md](import.md#imported-scripts)). |
| `"scriptNumbers"`      | `StickyNumbers`     | Each script's number, and the removed scripts' numbers held back from reuse (see [Sticky numbers](#sticky-numbers)). |
| `"connectGrants:<scid>"` | `ConnectGrants` | The hosts the user allowed (or "all sites") or denied a script's `GM_xmlhttpRequest` beyond its `@connect` rules (see [connect-permissions.md](connect-permissions.md)). Removed with the script. |
| `"enablementTimes"`    | `Record<scid, EnablementTimes>` | When each script last became active and went inactive (see [script-enablement.md](script-enablement.md#active-times)). One key, not fields on the rows, so a collection toggle doesn't rewrite every row. |
| `"collectionNumbers"`  | `StickyNumbers`     | Each collection's number, and the removed collections' numbers held back from reuse (see [Sticky numbers](#sticky-numbers)). |
| `"channelKey"`         | `{ key, version }`  | The random key our page-world code's events are named with, made again for each extension version (see [injection.md](injection.md#the-channel-key)). |

Key spaces in `chrome.storage.session` — everything here is dropped on
browser shutdown, which is the point: each row describes the *current*
browsing session, not the user's configuration.

| Key                      | Type                    | Purpose |
|--------------------------|-------------------------|---------|
| `"log:<scid>"`           | `LogEntry[]`            | Per-script event log (see [script-log.md](script-log.md)). |
| `"loglevel:<scid>"`      | `LogLevel`              | Highest level a script-originated entry in that log has carried; drives WARNING / ERROR in the Status column. |
| `"tab:<tabId>"`          | `TabRecord`             | Per-tab expected vs actual injection state behind the toolbar badge (see [matching.md](matching.md)). |
| `"gmtab:<tabId>"`        | `Record<scid, object>`  | Each script's `GM_getTab` object for that tab; removed when the tab closes (see [GM-APIs.md](GM-APIs.md#gm_gettab--gm_savetab--gm_gettabs)). |
| `"popupopen:<tabId>"`    | `Record<scid, boolean>` | Scripts whose menu command list was opened or closed in that tab's popup; removed when the tab closes (see [status-popup.md](status-popup.md#menu-commands)). |
| `"injector-rejections"`  | `Record<string,string>` | `{script id → Chrome's reason for refusing its registration}` — what the UI renders as REJECTED (see [injection.md](injection.md#rejected-registrations)). |
| `"smDevClaims"`          | `Record<tabId, SmDevClaim>` | sm-dev's tab claims: the run that controls each tab, and its lease (see [sm-dev-design.md](sm-dev-design.md#tab-claims)). |
| `"smDevRuns"`            | `Record<runId, number>` | When each sm-dev run's lease runs out, for removing a crashed run's test collection (see [sm-dev-design.md](sm-dev-design.md#test-collections)). |
| `"smDevLastSweep"`       | `number`                | When the test collections were last checked, to tell a gap (the computer slept) from runs gone. |

### Storage format versions

`storeFormat` names the layout of the script rows. Only the rows'
bodies differ between versions; every other key is the same.

| Version | `storeFormat` | Script bodies |
|---------|---------------|---------------|
| 1 | absent | Inline on each `script:` row: `bodyText`, `requires[i].source`, `resources[i].bytesBase64`. Each row carries its own copy. |
| 2 | `2` | In shared `blob:<sha256>` rows (see [Content blobs](#content-blobs)). The row holds `bodyBlobRef`, and each require or resource entry a `blobRef`. |

- **Current**: format 2. All writes produce it, whatever `storeFormat`
  says.
- **Reads accept both**, per body, so a format 1 row left behind (see
  [Format 2 migration](#format-2-migration)) still reads normally.
- **A new version** bumps `STORE_FORMAT` in
  `src/extension/script-blobs.ts`, adds a row here, and gets its own
  migration section.

### Content blobs

Script rows hold no bodies. Each body is a `blob:<sha256>` row, and the
script row points at it by hash.

- **Why**:
  - Most readers (enable checks, URL matching, the popup, page
    repaints) need only the rows. Without bodies, reading all rows is
    small.
  - A write that changes only metadata (the `enabled` flag, a version
    check, a parse verdict, a move) rewrites a small row, not the
    bodies.
  - Change events (`storage.onChanged`) carry the old and new row to
    every open context, so they get small too.
  - Identical bytes are stored once: copies of a script whose headers
    differ (a local copy with its changed `@version`, say), and
    libraries several scripts `@require`.
- **What goes in a blob**: a script's `bodyText`, each `@require`
  body, each `@resource` body.
  - Not the header: `leadingText` and `headerText` stay on the row.
    They're small and rarely identical, so sharing them buys nothing.

#### `StoredBlob` and `BlobRef`

```ts
// The stored body, at `blob:<hash>`.
interface StoredBlob {
  encoding: 'text' | 'base64';
  data: string;
}

// What a row holds to point at one.
interface BlobRef {
  hash: string;   // SHA-256 hex: the blob's key, minus `blob:`
  size: number;   // byte length of the content, not of what's stored
}
```

- **Key**: the SHA-256 hex of the exact bytes the blob decodes to:
  - `text`: the UTF-8 bytes of `data`.
  - `base64`: the bytes `data` decodes to.
  - SHA-256 collisions are treated as impossible; there's no
    collision handling.
- **Form is per blob, not per use.** Readers accept either `encoding`: a
  text reader decodes a `base64` blob as UTF-8, and a resource reader
  encodes a `text` blob to bytes. So a require and a resource with the
  same bytes can share a key, whichever was written first.
  - Writers use `text` for script bodies and requires (no base64
    growth) and `base64` for resources.
- **New `encoding` values** (compression, say) need no migration: readers
  learn the value first, then writers start using it. Old and new
  blobs can coexist.
- **Sizes are on the refs**, so rows know every body's size without
  reading a blob. `BlobRef.size` is the content's size; what a blob
  actually costs in storage (after any compression) comes from
  `getBytesInUse` on its key, which doesn't read the value either.
- **No reference count** in the blob. Cleanup finds unused blobs by
  scanning the rows.

#### Not the `contentHash`

The rows' `contentHash` fields stay change-detection tokens; the
`BlobRef` hashes are separate fields.

- A script's `contentHash` covers the whole file, header included.
  Its blob holds only the body.
- A file entry's `contentHash` is of the fetched bytes. A require is
  stored as decoded text, and `TextDecoder` drops a leading byte-order
  mark, so the stored bytes can differ.

#### Writing and cleanup

- **All writes go through `writeLocal`** in `script-store.ts`, which
  splits each full script into its row plus blobs (`withBlobs`).
- **The blobs and the row go out in one `set`**, which Chrome applies
  as a unit, so no reader sees a row before its blobs.
- **A blob already stored isn't written again**: same key, same bytes.
  `withBlobs` checks the stored keys (`getKeys`, which reads no values).
- **An unchanged body isn't hashed again**: `fromStorage` remembers
  each body's ref by the object it built, so writing that object back
  reuses it.
  - Require and resource entries survive the `{...script}` copies the
    store's writers make, so theirs are reused on most writes.
  - A script's own body often isn't, and is hashed again. That's fast
    next to resources, which would need base64 decoding first.
  - A refresh carries the ref from the copy it started from to the
    script it rebuilt, when the body text is the same (`carryBodyRef`),
    so an unchanged body isn't hashed on every refresh.
- **Unused blobs** (after a remove, or a refresh that replaced a body)
  are deleted by the service worker only (`sweepUnusedBlobs`):
  - A blob goes on the first check that finds no script row using it.
  - A check runs inside the write lock (`sweepUnusedBlobsLocked`), and
    so does every write of a script row: the worker's wrapped `set`
    refuses one made outside it (`checkScriptRowWrite`), apart from the
    migrations, which the check waits for anyway. So no write lands
    between a check reading the rows and deleting: one that found a
    blob already stored, and so didn't write it again, would otherwise
    be left pointing at nothing.
    - The guard sees whether some section of the lock is running, not
      whether the write is in it, so it catches most mistakes, not all.
  - **When it runs**: at once, after a change that leaves a row's blob
    unused by it (`droppedBlobRefs`), so a removal frees its space
    right away. That matters most near the storage quota.
    - Changes that land while a check waits for the lock share it.
    - An alarm set at the same time (half a minute) is the backstop for
      a worker stopped before the check ran; a check that finishes
      clears it.
    - Not in tests: `resetAllState` pauses them, and tests run checks
      through the test surface.
  - A check reads the keys and the small rows (from the row cache when
    it's loaded), never a blob.
  - **Logging**: a removal is always logged (`removed N stored file(s)
    no script uses`); each check's counts only with debug logging on.
- **A row whose blob is missing**, or in an encoding this build
  doesn't know, reads as an `invalid` script (`MISSING_BLOB_MESSAGE`),
  never a crash.
  - The next refresh repairs it because the row is `invalid`, and an
    invalid row is always fetched again.
  - As a backstop, a missing body also drops the row's validators
    (`contentHash`, `fsMtime`, the HTTP ones), and a missing `@require`
    / `@resource` drops that entry, which a refresh fetches like a new
    one.
  - Only readers that load bodies see this (see
    [Reading without the bodies](#reading-without-the-bodies)). The
    registration sync is one: it leaves such a script unregistered,
    saves its row as `invalid` with this message, and writes it to the
    script's Log. The collections page, the popup and the match index
    read only rows, so they see it from then on.

#### Reading without the bodies

- **Two kinds of store read**:
  - `getScript`, `getCollectionWithScripts`, `getAllScripts` return
    full scripts (`StoredScript`), reading their blobs.
  - `getScriptMeta`, `getScriptMetas`, `getCollectionWithScriptMeta`,
    `getAllScriptMetas` return the rows as stored, typed `ScriptMeta`
    (a `StoredScript` without `bodyText`, require `source` or resource
    `bytesBase64`). The type checker flags any use of a body.
- **Writing a row back** with a field changed keeps its blob refs, so
  the write hashes and stores no body. The enable writes, version
  probes, moves and removals work on rows this way.
- **Reading every row** lists the keys and reads only the wanted ones
  (`scanStorageRows`), rather than a `get(null)` that returns every
  blob and GM value too. The collections page does this, and so does
  the worker's row cache when it loads.
- **In the worker**, the store, the registration sync, the match index,
  the log label table and sticky numbers read collection and script
  rows, and the active times, from the row cache, and related copies
  come from its indexes ([worker-writes.md](worker-writes.md#the-row-cache)).
- **Who reads bodies**:
  - The viewer, for the script on screen, and the compare page.
  - Refresh, for the copy it starts from, whose bodies it reuses when
    the file hasn't changed. Its re-read inside the write lock is of
    rows only (see [Only changed rows are written](#only-changed-rows-are-written)).
  - The registration sync, for the scripts it registers only (see
    [The sync is incremental](injection.md#the-sync-is-incremental)).
    It saves a row whose blob it found missing as `invalid`
    (`recordMissingBlobs`), and logs it.
  - The parse check, which records its verdict on the full row it
    hands back for registering (`verifyParseChecks`).
  - Running a manual script, sm-dev's `script print`, and the
    extension-update backfill of `usesUnsafeWindow`.

### Format 2 migration

Format 1 stored bodies inline on the script rows. The migration moves
them to blobs.

- **What moves**, per script row:
  - `bodyText` → a blob; the row gets `bodyBlobRef`.
  - each `requires[i].source` → a blob; the entry gets `blobRef`.
  - each `resources[i].bytesBase64` → a blob; the entry gets `blobRef`.
- **Who runs it**: the service worker, at startup (`migrateToBlobs`,
  via `storeFormatReady` in `script-store.ts`), after the key-rename
  migration below. Then it sets `storeFormat` to `2`.
- **Reads don't wait**: they accept either format, so a format 1 row
  reads as it is.
- **Writes and removes wait** for it. Otherwise a write (an enable
  toggle, say) could be overwritten by the converted copy of the row
  the migration read earlier. Only the worker writes, so they await the
  migration itself.
- **Batches**: rows convert in `set`s of a few dozen. Each `set`
  replaces its rows' inline bodies with blobs, so storage use barely
  moves within a call, and blobs ride in the same call as their rows.
- **Re-running is safe**: converted rows are skipped, so an interrupted
  run finishes on the next worker start.
- **A failed run** (storage full, say) is logged and leaves the rest in
  format 1. Writes go on in format 2 meanwhile.
  - It isn't retried until the next browser session (a flag in session
    storage), so a store too full to convert isn't rescanned on every
    worker wake.
  - A page that gets no answer even the second time logs that, and asks
    again before its next write. The write it was about to make goes
    ahead unguarded.
- **Logging**, in the worker's console:
  - A run that moves anything always logs: how many scripts it's
    moving, then how many it moved, the blobs it wrote, and how long
    it took. A failed run says how far it got.
  - Skipping a retry after a failure this session is always logged.
  - Finding nothing to move (format 2 already in place at a worker
    start, or a new profile) only with debug logging on.
- **Format 1 rows after format 2**: the key-rename migration below
  writes rows as it read them, so it could put back a format 1 row
  after `storeFormat` is `2`. Tests write such rows too. Readers handle
  them, and the next write of the row converts it.
  - The blobs the migration wrote for such a row are then unused, and
    cleanup deletes them.
- **No way back**: an older build can't read format 2.

### Legacy key migration (temporary)

Collections were called "sources" until August 2026. A profile written
before the rename carries the old spelling, and reading it with the new
keys would look like a wiped profile.

- **What moves**: `"sources"` → `"collections"`, every `source:<id>` row
  → `collection:<id>`, and each script's `sourceId` field →
  `collectionId`. Nothing else changes.
- **When**: `ensureCollectionKeysMigrated` (`src/extension/script-store.ts`) runs
  on the first storage read in each JS context, memoized. A cheap
  `get("sources")` probe gates the full `get(null)`, so a migrated
  profile pays one small read per context and no more.
  - Only the worker moves rows. A page whose probe finds the old index
    asks it (`migrateCollectionKeysForPage`) and waits; that re-checks
    once in case the worker's memo predates the rows.
- **Ordering**: new rows are written before the old ones are removed, so
  an interrupted run leaves both spellings and the retry is a no-op over
  what it already moved. A failed run clears the memo instead of wedging
  every read behind it.
- **Who awaits it**: every read path in the store, plus `loadAll` in
  `src/extension/match-index.ts` and `readAll` in `src/extension/injector.ts` — the two
  modules that read the structural rows straight out of
  `chrome.storage.local`.
- **Removal** is scheduled in [TODO.md](../TODO.md) for after
  2026-09-01.

### `StoredCollection`

- `id` — UUID.
- `path` — canonical collection location the user added. One of:
  - absolute filesystem path or `file://` URL pointing at a directory
    of `.user.js` files (recursive scan; see
    [file-access.md](file-access.md)).
  - `http(s)://` URL to a `script_manifest.json` (see
    [http-collections.md](http-collections.md)).
  - `github.com/<o>/<r>/tree/<ref>(/<path>?)` URL for a directory
    collection (blob / file URLs are rewritten to `raw.githubusercontent.com`
    at add time).
  - A **container** identifier — `container:file` / `container:http` /
    `container:github` for the three built-in defaults ("Scripts from
    local disk / web / GitHub"), or `container:<uuid>` for a
    collection the user created — for a collection of individually
    installed scripts. Container collections have no scan step; their
    `scriptIds` list is the source of truth. See
    [Container collections](#container-collections).
- `lastRefreshedAt` — epoch ms of the most recent refresh.
- `scriptIds` — child script IDs in scan order (a directory by path, a
  manifest as listed), or install order for a container. The
  collections page lists them by name instead.
- `scanError?` — set when the directory listing itself failed.
- `manifestSize?` / `manifestMtime?` — a `file://` manifest's own
  listing stat at its last successful scan, for the collections page's
  "refresh pending" chip ([file-changes.md](file-changes.md)). Absent
  for every other kind.
- `enabled` — user-controlled on/off toggle. When `false`, every
  script under this collection is treated as effectively disabled by the
  match index (independent of each script's own `enabled`).
- `localFiles?` — per-collection opt-OUT of local file overrides for
  `@require` / `@resource` / `@icon`. Only an explicit `false` disables
  it, so rows persisted before the field existed read as enabled. See
  [local-file-overrides.md](local-file-overrides.md#per-collection-opt-out).
- `displayName?` — the name shown on the collections page heading, the
  viewer's Collection row, and the install page's dropdown. Seeded from
  `inferDisplayName(path)` at add time (and backfilled on first read
  for older rows — `backfillCollectionDisplayNames`); the collection
  dialog's Name field rewrites it (`setCollectionOptions`). Required for
  a user-created container, which has no path to infer from. The UI
  prefers it over the inferred form whenever it's set (see
  [`src/extension/collection-display.ts`](../src/extension/collection-display.ts)).
  - A name the user chose is unique across collections
    (case-insensitive); an inferred one may collide, since two refs of
    one GitHub tree infer the same short form.
  - The three built-in defaults' names are **reserved**, whether or not
    their rows exist yet — only the default that owns one may carry it
    (`mayUseReservedName`). Otherwise a user collection could take
    "Scripts from web", and the next web install would auto-create
    `container:http` under the same name: two identical entries in the
    install dropdown, in a state that couldn't be re-created afterwards.

### `StoredScript`

- `id` — UUID, **stable across refreshes** (keyed by `relativePath`).
- `collectionId` — back-reference so the viewer can refresh without
  looking up the parent. Written only by the install / move path, so
  both refresh entry points re-apply the persisted value over whatever
  they built (`preserveConcurrentEdits`) rather than reverting a move
  that landed mid-fetch.
- `relativePath`, `fileUrl` — identity + how to refetch.
  - Directory/manifest/github-dir collection: `relativePath` is the path
    relative to the collection root; `fileUrl` is the joined absolute URL.
  - Container collection: `relativePath` is the full URL or absolute path
    the user added, in its canonical spelling (`canonicalCollectionInput`:
    a `file://` URL collapses to its bare path, so one file on disk
    can't land as two rows); `fileUrl` is its URL form.
- `status` — `'ok' | 'invalid'`. A script whose file has vanished is
  not a status — the row is dropped (see
  [Vanished entries](#vanished-entries)).
- `errorMessage?` — set when `status === 'invalid'`.
  - Message *text* is a snapshot of what the wording was when the row
    was parsed. A reworded message therefore reaches an existing row
    only on its next content change; nothing compares these strings,
    so the staleness is cosmetic.
  - Header checks themselves are re-applied, though:
    `backfillHeaderProblems` re-runs all of `validateHeader` on `ok`
    rows on each `onInstalled`, so a script a newer check refuses stops
    running, with its error in the Log.
  - The reverse too: rows refused by a check that's gone are refreshed
    (`retiredHeaderProblemIds`; see
    [manual-scripts.md](manual-scripts.md#header-and-storage)).
  - `startupLogs` (the parse-time warnings, plus a stored `@icon`
    warning carried over from `iconCheck`, which the boot replay
    re-emits verbatim) are different: `backfillStartupLogs` re-derives
    them for all `ok` rows on each `onInstalled`, so a new or reworded
    check reaches installed scripts after an extension update.
- `errorLocation?` — where in the script's own files `errorMessage` is
  about, when it was derived from their content. Absent when the script
  itself couldn't be fetched; a `@require` that wouldn't load still gets
  the header line that declared it. Written
  only via `setScriptError`, which writes the pair — see
  [diagnostics.md](diagnostics.md). The message carries no `(in …)`
  suffix; surfaces pair the two through `describeDiagnostic`.
- `refreshError?` — set when the latest refresh of a previously-good
  script failed but we kept the cached good copy running. Distinct
  from `errorMessage`: a row with `refreshError` keeps `status: 'ok'`
  and stays injectable — only the *update* failed. Cleared on the next
  clean refresh (or a proven-unchanged refetch). See
  [Refresh failures](#refresh-failures-keep-the-good-copy-running).
- `size` — UTF-8 byte length of the cached content. `0` is a valid
  value (an empty file is a real file). `null` only when the entry
  has never successfully loaded — i.e. its first fetch failed and
  there's no cached body to size.
- `contentHash?` — universal "last-change token": a deterministic
  hash of the fetched source bytes on the last successful load. Used
  by `buildScriptFromText` to decide whether a freshly fetched body
  is actually different from the prior — see
  [change detection](#change-detection-the-last-change-token) below.
  Absent only on rows that have never successfully loaded.
- `fsMtime?` — modification time as reported by Chrome's directory
  listing on the last successful scan, or by a direct read's
  `Last-Modified` on a page-load check (the same number: whole
  seconds). Used only for equality. Combined with `size` it lets refresh skip refetching files
  whose listing-reported size+mtime are unchanged. (file:// collections
  only.)
- `httpEtag?`, `httpLastModified?` — HTTP validators captured from
  the last successful fetch. Sent on the next refresh as
  `If-None-Match` / `If-Modified-Since` so the server can answer 304
  instead of resending the body. (http(s):// collections only; see
  [http-collections.md](http-collections.md).)
- `leadingText?`, `headerText` — the file up to the end of its
  metadata block: any text before it, then the block itself.
- `bodyBlobRef?` — `BlobRef` to the body (everything after the metadata
  block): its hash, the key of its [blob](#content-blobs), and its
  size. Joined with the two fields above, the body gives back the exact
  file. Absent only on rows that have never successfully loaded.
- `header` — `ParsedHeader | null` (see [script-viewer.md](script-viewer.md)).
- `matching` — `{matches, excludes, includes}` distilled from the
  header (used eventually by injection).
- `loadedAt` — epoch ms; bumped whenever fresh content lands, including
  a changed `@require` / `@resource`.
- `enabled` — user-controlled per-script toggle. Preserved across
  refreshes; a script's effective enabled state is
  `collection.enabled && script.enabled`.
- `requires?` — prefetched `@require` files, as an array of
  `StoredRequire` entries (`{ref, url, blobRef, size, contentHash,
  loadedAt, httpEtag?, httpLastModified?}`) in declaration order,
  deduped by canonical URL. Each body is a [blob](#content-blobs).
  Absent when the script declares no `@require`. See
  [requires.md](requires.md).
- `resources?` — prefetched `@resource` files, as `StoredResource`
  entries with their bodies in blobs the same way. See
  [resources.md](resources.md#storage-shape).
- `iconCheck?` — what the last check of the script's `@icon` found:
  `{ref, local?, message?}`, with `message` set when the icon can't be
  shown. Kept so a background refresh needn't download the icon again.
  See [site-icons.md](site-icons.md#load-time-check).
- `usesUnsafeWindow?` — the body names `unsafeWindow`, derived from
  `bodyText` alone with no regard to `@grant`. When there is no grant
  line for it, that is what resolves the script to MAIN world and emits
  the binding anyway (TM and VM both expose the name ungranted).
  Persisted rather than recomputed because the world decision sits on
  the per-sync spec-build path. Absent on error rows and on rows written
  before the field existed — `backfillUsesUnsafeWindow` fills those in
  on the next `onInstalled`, since an unchanged script's row is never
  rebuilt. See
  [injection.md](injection.md#unsafewindow-is-the-pages-window).
- `versionProbes?` — what the script's `@updateURL` / `@downloadURL`
  last claimed, as `{kinds, url, version?, error?, checkedAt}` rows.
  Written only by `setVersionProbes`, never by the load pipeline —
  both refresh entry points re-apply the persisted value over whatever
  they built (`preserveConcurrentEdits`). Absent when the script names
  no upstream we don't already fetch from. See
  [updates.md](updates.md).

## Status model

The persisted `status` field has three values; the collections page +
viewer combine it with each script's **highest log level seen** (from
`chrome.storage.session`, see [script-log.md](script-log.md)) and its
update-probe verdict to render the Status column.

### Persisted statuses

- `'ok'` — fetch succeeded, metadata block parsed, required fields
  present (`@name` plus at least one of `@match` / `@include`).
- `'invalid'` — fetch failed, split/parse/validate reported a problem,
  or a `@require` / `@resource` dependency couldn't be loaded. The
  script can't run. `errorMessage` carries the reason — a header
  problem (`NO_METADATA_BLOCK` / `UNTERMINATED_METADATA_BLOCK` from
  `userscript-header.ts`, `NO_NAME` / `NO_MATCH_OR_INCLUDE` from
  `script-store.ts`), a syntax error, a fetch failure, or a dependency
  that wouldn't load. The content-derived ones also carry an
  `errorLocation` — see [diagnostics.md](diagnostics.md).
On invalid we **preserve the prior content** (headerText, bodyBlobRef,
parsed header, matching). The viewer keeps working. The injector runs
the script if and only if `enabled` is true and `status` is `ok` —
`invalid` rows never inject (the current parse result is bad, so the
cached body might mean something different from what the metadata
claims).

### Refresh failures: keep the good copy running

A refresh must never downgrade a *working* script just because the
latest fetch failed or returned junk. When a prior `ok` row's refresh
fails, we keep the last-known-good row exactly as it was — `status`
stays `ok`, so it keeps injecting — and only set `refreshError` to
record the reason. Triggers:

- **Hard fetch failure** (any scheme): network error, 404, unreadable
  file, a disconnected network mount. Covers the case where a read
  throws.
- **Markup response** (any scheme): the fetch succeeded but answered
  with a web page — a login wall, a forge's file-browser page, a
  `file://` directory listing. Rejected at the fetcher
  (`markup-response.ts`), so it arrives here as a hard fetch failure
  and the good copy keeps running. Previously the HTML was stored as
  the script's source and reported as a syntax error in the user's
  script.
- **Soft failure** (http(s) only): the fetch returned 200 but the body
  parsed `invalid` — a login / error page served in place of the
  script (e.g. a logged-out collection). Scoped to http(s): a `file://`
  read returns the file's real bytes, so an `invalid` parse there is a
  genuine local edit and is flagged `invalid` immediately.
- **Dependency failure**: a `@require` / `@resource` fetch failed, so
  the script keeps running on its cached deps. (A `@require` returning
  an HTML login page is caught earlier by the markup gate in
  `external-files.ts` and surfaces as a fetch failure; `@resource`
  bodies are arbitrary bytes and can't be validated this way — see
  [requires.md](requires.md).)

**Recovery** is automatic: the next refresh that lands valid content
(or a conditional-GET 304 / matching size+mtime that proves the cached
content is current again) clears `refreshError`. If the file is later
confirmed *vanished* from its listing, the row goes away — see
[Vanished entries](#vanished-entries).

Both the failure and the recovery are copied into the script's own Log
(warning and info respectively), so the badge is always explainable —
see [script-log.md](script-log.md#every-surfaced-failure-lands-in-the-log).

This mirrors the [scan-failure](#scan-failure-leave-scripts-untouched)
policy one level down: scan failure protects every script in a collection
when the *listing* can't be read; `refreshError` protects a single
script when its own *fetch* fails.

### Displayed status (UI-level)

`src/script-display.ts` exports `effectiveScriptStatus(script,
maxLogLevel, outdated, rejected)` which is what the collections page +
viewer render. Priority order (highest wins):

- `INVALID` — `status === 'invalid'`.
- `REJECTED` — `status === 'ok'`, but Chrome refused the registration,
  so the script never runs. Not stored on the row: it comes from the
  injector's session-storage map (`src/extension/script-rejection.ts`, and
  [injection.md](injection.md#rejected-registrations)). Ranks under
  `INVALID` — both mean "can't run", and the two can't co-occur since
  an invalid script is never offered to Chrome. Rendered in red.
- `REFRESH FAILED` — `status === 'ok'` but `refreshError` is set (the
  script runs from its cached copy; the last update failed). Ranks
  above the log-derived levels — staleness is a distinct, specific
  signal — but below `INVALID`, which means it can't run at all. Rendered in amber, distinct from red `INVALID`.
- `OUTDATED` — an update probe found a newer `@version` at a URL we
  deliberately don't update from. Same rationale (and same amber) as
  `REFRESH FAILED`, and ranks just under it: a collection we can't reach at
  all subsumes "some other copy is ahead". See
  [updates.md](updates.md).
- `ERROR` — `status === 'ok'`, no `refreshError`, but the per-script
  log has a script-originated error entry (max log level = `error`).
- `WARNING` — `status === 'ok'` and the per-script log has a
  script-originated warning entry (max log level = `warning`).
- `OK` — everything else (no logs, or only info-level logs).

Two families, kept apart:

- The states above `ERROR` come from the row (or the rejection map /
  probes) and clear when it recovers — a network mount that comes back
  takes REFRESH FAILED with it.
- `WARNING` / `ERROR` come from the session log's `loglevel:` sentinel,
  which only script-originated entries bump.
  - A refresh failure logged into the script's Log carries a `state`
    and is exempt, so it can't leave a WARNING behind after recovery.
  - A refresh that loads **new content** resets the sentinel: the badge
    then reflects only what the new version does. See
    [script-log.md](script-log.md#a-new-version-starts-the-badge-over).

The Status cell is a link to the script's viewer Log tab in both
pages, and every transition into a non-OK state above appends an entry
carrying the same `state`. Recoveries are logged too (`state: 'ok'`),
so a badge going green has a matching line; see
[script-log.md](script-log.md#every-surfaced-failure-lands-in-the-log).

## Change detection: the last-change token

Every loaded script row carries a `contentHash` — a deterministic hash
of the fetched source bytes on the last successful load. It's the
universal "last-change token" the rest of the system uses to decide
"did anything actually change?", regardless of collection kind or scheme.

### Three layers, same end-state

For every collection/scheme combination the refresh pipeline still asks
the same question — "is there a new version?" — in the cheapest way
each one supports, and then has a universal fallback:

1. **Cheap pre-fetch check** (avoids the body entirely):
   - file:// in a directory collection — compare the listing's
     `size` + `mtime` against the prior row.
   - http(s):// — conditional GET (`If-None-Match` /
     `If-Modified-Since`). A `304` short-circuits with no body.
2. **Fetch** — done when the pre-fetch check didn't fire, can't fire
   (e.g. file:// entry reached through a manifest, where the scan
   carries no per-file stat), or the server doesn't supply validators.
3. **Post-fetch content compare** — `buildScriptFromText` rehashes the
   freshly fetched bytes and compares with the prior `contentHash`.
   Match → `loadedAt` is preserved (the row is logically unchanged,
   so the collections page's "row updated" highlight doesn't fire).
   Mismatch → `loadedAt` is bumped to now.
   - A dependency whose content hash changed bumps it too, even when
     the script's own bytes match (`dependenciesChanged` in
     `applyFiles`).

This makes the **outcome** uniform across every combination of
{directory, single-file, manifest} × {raw path, file://, http(s)}:
unchanged content never registers as a change, even when the
appropriate-for-scheme cheap check couldn't prove it.

### Implementation notes

- The hash is Web Crypto SHA-256 (`crypto.subtle.digest`), hex-encoded.
  Using the standard SubtleCrypto API rather than a hand-rolled hash
  means the same helper works uniformly in service workers, page
  contexts, and Node ≥19. SubtleCrypto is async on the web platform,
  so `buildScriptFromText` and `rebuildCollection` are async.
- Status still reflects the **current** parse outcome even when the
  hash matches, so a parser update between refreshes can promote an
  unchanged file from `error` → `ok` (or vice versa) without bumping
  `loadedAt`.
- HTTP validators (`httpEtag`, `httpLastModified`) on a successful
  fetch are still recorded — they let the next refresh take the cheap
  pre-fetch path even though this one didn't.

## Sticky numbers

Each installed script and each collection has a short number that
stays put as others come and go. The code lives in
`src/extension/sticky-numbers.ts`.

- **Scripts:** sm-dev names one `E12`, and its log ID ends `#E12` (see
  [logging.md](logging.md#log-ids)).
- **Collections:** sm-dev will name one `C3`. Nothing shows these yet.

### Storage

- **One row per kind,** `scriptNumbers` and `collectionNumbers`, each
  with `byId` (script or collection id → number) and `retired` (number
  → when it was last used).
  - Not a field on each script or collection row: those are rewritten
    from many places, and a number one rewrite dropped would be handed
    out again as a new one.
- **One writer:** the service worker, in `assignNumbers`, which
  reconciles both rows in one pass.
  - It runs at startup and at the start of each registration sync, so
    a new script is numbered before it is registered.
  - Serialized, so two installs can't take the same number. Pages only
    read the rows.

### Reconciling

`reconcileNumbers` (pure) applies the same rules to both kinds:

- an item keeps its number; if two share one, the first keeps it;
- a removed item's number is retired from now, unless it already was,
  and is held for 7 days;
- a new item gets the lowest number neither in use nor held.

Holding back a removed item's number means an id someone saw a moment
ago never names a different item, while reuse keeps the numbers small
over a long-lived profile.

### Order and exclusions

- **Scripts:** new numbers go to collections by path, then each
  collection's own script order.
- **Collections:** by path.
- **Not numbered:** sm-dev test collections and their scripts. A run
  names its scripts `1`, `2` itself, and adds and drops both too
  often.

## Container collections

A container collection ("scripts" collection in the UI) is a folder of
individually installed scripts. Two kinds of row, told apart by path:

- **Built-in defaults** — `container:file` ("Scripts from local disk"),
  `container:http` ("Scripts from web"), `container:github` ("Scripts
  from GitHub"). One per scheme, recognised by this fixed path — never
  by name, so a rename doesn't stop it being the default.
- **User-created** — `container:<uuid>`, made by the collection dialog
  with a name of the user's choosing.
- **sm-dev test collections** — `container:sm-dev:<run>`, one per
  `sm-dev` run, holding scripts whose only copy is their
  text in storage. Created by the run's first `writeRunScript` on the
  test surface, named `sm-dev test collection (run <run>)` (see
  [sm-dev-design.md](sm-dev-design.md#test-collections)).
  - Each row's location is a `scratch:///<run>/<path>.user.js` URL,
    its path segments percent-encoded, naming the storage row
    (`scratch:<url>`) that holds the text. The file fetcher reads that
    row back, so every refresh path treats them as ordinary scripts.
  - A write of the same name replaces the text and re-reads the row in
    place.
  - `releaseRun`, or the worker's sweep after a crashed run, removes
    the container, its rows, their GM values and the text rows.
  - No script is moved into or out of one, or installed into one, by
    hand (`SM_DEV_COLLECTION_LOCKED`).
  - Removing a scratch script or the container keeps a text row while
    another script row still reads it.
  - The scheme chip reads `scratch`, and the viewer's Location row is
    plain text, since there is nothing to open.
- **Imported scripts** use the same mechanism in any scripts collection
  the user has ([import.md](import.md#imported-scripts)).
  - Each row's location is `imported:///<tag>/<name>.user.js`, its text
    in the same `scratch:<url>` row and its bundled files in
    `scratchFiles:<url>`.
  - Unlike a scratch script it belongs to no run, so it runs everywhere
    and can be moved like any container script.
  - Removing it drops its text, files and `importInfo:` rows, on the
    same rule as a scratch script's.
  - The scheme chip reads `imported`.

Properties:

- A container may hold scripts from **any scheme** — local, web, and
  GitHub together. The scheme is per script (classified from its
  `relativePath` by `containerKindForSingleFileInput`); the collections
  page shows it as a chip on each row.
- A default is created on demand by the first install that targets it,
  never up-front. Removing it is fine; a later install that picks it
  recreates it with the default name.
- Have no scan step. `scriptIds` is the explicit source of truth; the
  refresh pipeline builds a synthetic scan from those rows and runs
  the per-entry fetch path against each.
- Survive `removeScript` of their last child (the empty container
  stays until the user clicks Remove on the section).
- Duplicate detection is **per container**: `installScript` compares
  the new URL/path against every `relativePath` already in the target
  container and returns null on a match. The same location may live in
  several containers — that is what the viewer's "Other versions" panel
  and its exclusive-enable rule exist for.

Where a single script lands:

- `installScript(location, target)` takes the target explicitly — a
  container by id, or `{schemeDefault: true}` for the built-in default
  of the location's scheme (`https://github.com/*` and
  `raw.githubusercontent.com/*` are `github`, anything else http(s) is
  `http`, raw paths / `file://` are `file`).
- `addCollection(input)` — the Add field's one-string entry point,
  `?add=`, first-run seeding, and the test surface — sends a single-file
  input to the scheme default. Everything else becomes a directory /
  manifest / github-dir collection.
- The install page's dropdown lists every container and lets the user
  pick — see
  [script-identity.md](script-identity.md#the-install-into-dropdown).

## Load / refresh pipeline

Every load path goes through the same pipeline:

1. List the collection:
   - **Container collections** skip `scanForUserScripts` entirely. The
     synthetic scan is built from the existing `scriptIds`, one entry
     per child with `relativePath` set to the child's URL/path. A
     `file://` child gets its folder's listing stat (`size` + `mtime`),
     one listing per folder; an HTTP child carries none and relies on
     the conditional GET in `fetchOrSkipInParallel`.
   - **All other collections** call `scanForUserScripts` (see
     [file-access.md](file-access.md) for local directories and
     [http-collections.md](http-collections.md) for HTTP manifests of any
     scheme). Local-directory scans carry each file's `size` and
     `mtime` from the listing; a manifest scan lists each `file://`
     entry's folder for the same; http(s) entries have no stat.
2. For each scanned file, decide whether to fetch — *per resolved
   entry URL*, not per collection (so a manifest can mix schemes):
   - **file:// skip** (emit `{ unchanged: true }`) if the prior
     stored entry is `status: 'ok'` AND the listing's size+mtime
     match the prior `size` and `fsMtime`. Every local file whose
     folder listed has these; one whose folder wouldn't list fetches.
     A page-load check takes them from a direct read instead (see
     [local-file-overrides.md](local-file-overrides.md#page-load-checks)),
     so a match skips the rebuild rather than the read.
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
4. Reconcile against the prior state in `rebuildCollection`:
   - Reuse IDs by `relativePath`.
   - Mint a new UUID for any new file.
   - Reconcile entries the scan no longer reports — see
     [Vanished entries](#vanished-entries).
5. Persist the collection row + **every script row that actually
   changed** in a single `chrome.storage.local.set` call. See
   [Only changed rows are written](#only-changed-rows-are-written).

### Vanished entries

An entry in the prior state that the scan no longer reports is
**dropped** — the row and its storage key go away, and the collection's
`scriptIds` stops listing it.

- A successful scan is the collection saying what it holds *now*, so a
  renamed or deleted file leaves rather than lingering as a row the
  user has to clear by hand. That includes a scan that found
  **nothing** — an empty directory, or one whose remaining files are
  not `.user.js` — exactly as an empty manifest empties its collection.
- A *failed* scan never gets here at all — see
  [Scan failure](#scan-failure-leave-scripts-untouched).
- **Empty and failed are told apart at the listing.** Chrome's
  `file://` directory listing page has a fixed shape (a `start(…)`
  call, then a row per entry), and an empty directory still has it.
  `listDirectory` refuses a page without it (`isDirectoryListing`) —
  an error page for a directory that moved, a path that is now a file,
  a format change — as a failed read, which becomes a `scanError`.
  Only a real listing with no rows reaches the drop.
- **A drop is not reversible.** The row's UUID goes with it, so a file
  that disappears and comes back (a branch switch, an editor that saves
  by unlink+rename) returns as a fresh row: `enabled: true`, an empty
  Log, and none of its `gmval:` values, which stay orphaned. That's the
  price of not accumulating stale `MISSING` rows; preserving identity
  across a bounce is filed in `TODO.md`.

- **The per-script refresh drops too.** `refreshScript` lists the
  file's parent directory anyway (for the size+mtime skip), so a local
  directory script whose file that listing no longer shows — and whose
  read then fails — is dropped there as well, same outcome whichever
  refresh noticed. The read is required because this path runs on
  every navigation and can catch an unlink-and-rename save mid-way; a
  file that reads is not gone. A listing that failed leaves the row
  alone; a manifest or single-file
  collection has no listing to consult, so a vanished file there fails
  its fetch and keeps running from the cached body with a
  `refreshError`.
- **Before any refresh runs**, every page that names a local file
  probes the disk and marks a deleted one with a chip — see
  [file-changes.md](file-changes.md).
- **Container collections** never observe a vanished entry: the
  synthetic scan is built from the existing scripts. Per-script removal
  goes through `removeScript` instead.

### Only changed rows are written

Every refresh rebuilds a full row per script, including the ones that
took a pre-fetch skip and came back byte-identical.

Writing all of them would mean a refresh of N scripts persists N rows to
answer a question about one. So both refresh paths compare first, and
write only the difference:

- **`refreshCollection`** filters its rows through `changedScriptRows`.
  `refreshAllCollections` and `addCollection` delegate to it, so they
  are covered too.
- **`refreshScript`** — the opportunistic per-navigation path, where
  this matters most — runs its single merged row through the same
  helper.
  - First, outside the lock, it compares against the row as stored now
    (from the row cache), and when nothing would change it takes
    neither the lock nor a storage call (`unchangedAsStored`). Not
    writing is safe without the lock: a write by someone else meanwhile
    stands either way.
  - Not when the copy it started from found a body missing: that case
    goes through the lock, which writes the missing blob back.

Why it's shaped this way:

- **The comparison that decides a write uses the rows read inside the
  write lock**, never the pre-fetch snapshot. Comparing against a stale read would skip a write
  that a concurrent edit had made necessary.
- **The collection row is always written.** `lastRefreshedAt` moved, and
  that timestamp is the record of the check having happened at all.
  Scripts have no equivalent field, and nothing looks for one.
- **Rows are compared in stored form, without bodies.** The rebuilt
  script becomes its small row plus blobs (`storedForm`), and the row
  is compared with the stored row, read without its bodies.
  - An unchanged body has the same hash, so the comparison reads no
    blob. Only the copy the refresh started from loads bodies, to reuse
    them when the file hasn't changed.
  - A changed row is written as that small row, with only the blobs not
    yet stored, so the body isn't hashed twice.
  - A row that compares equal but points at a blob that isn't stored is
    written too, with that blob: a refresh is how a missing body comes
    back.
  - A format 1 row never compares equal, so it's rewritten in format 2.
- **Rows are compared with `sameStoredValue`** — structural equality
  over the JSON shapes storage round-trips.
  - Key order is not significant. A rebuilt row's order comes from the
    spread-and-delete that built it, a stored row's from its last
    serialization, so a `JSON.stringify` comparison would call every row
    changed and quietly do nothing.
  - `undefined`-valued keys count as absent, matching what the
    round-trip does to them.
- **No listener sees a difference.** Chrome already declines to fire
  `storage.onChanged` for a `set` whose value matches what's stored —
  the behavior the rejection retry is built around (see
  [injection.md](injection.md#rejected-registrations)).
  - What this drops is the serialize-and-store cost paid before Chrome
    gets far enough to compare.
- **What a refresh *reports* is unnarrowed.** Both paths still return
  every row, so the outcome summary, the Log entries, the update probes,
  and the collections page's changed-row highlights all see the full
  set.

### Fan-out is bounded

Steps 2–4 run concurrently across entries, but with a cap
(`src/extension/concurrency.ts`).

- **Why**: an unbounded `Promise.all` over the scan starts one fetch per
  scanned file. On a collection with thousands of scripts, that puts every
  decoded body — plus each entry's prefetched `@require` / `@resource`
  payloads — live at the same instant.
- **What that cost**: enough peak memory to abort the extension process.
  Chrome reports that only as "this extension crashed"; no JavaScript
  error is raised, and nothing reaches the Log or the Errors panel.
- **The limits nest, so read them as a product**:
  - `FETCH_SCRIPTS_PER_COLLECTION_CONCURRENCY` — scripts in flight
    within one collection.
  - `FETCH_COLLECTIONS_CONCURRENCY` — collections in flight during
    `refreshAllCollections`. Each slot expands into a whole collection's
    worth of fetches, so the worst case is the two multiplied.
- **The inner limit carries the balance**, and is the larger of the two.
  Most profiles have one or a few collections, and a per-collection
  Refresh button never engages the outer limit at all — so the inner one
  is what the common cases actually hit. A larger outer limit would only
  speed up a many-collection profile, at the cost of capping the
  single-collection case everyone hits.
- **Ordering**: `mapWithConcurrency` returns results in input order, so
  rebuilt rows still come back in scan order.
- **Rejection**: the first failure rejects the call right away, and every
  remaining entry still runs (its result is just discarded). A failure
  never skips the entries behind it, not even when every entry fails.
- **Scans use it too**, under their own pair
  (`SCAN_DIRS_CONCURRENCY`, `SCAN_GITHUB_DIRS_CONCURRENCY`). Sibling
  directories are listed together rather than one after another —
  serialized, the scan cost a round trip per directory regardless of how
  shallow the tree was. The GitHub half is bounded tighter: those round
  trips are `api.github.com` requests, which are throttled in bursts on
  top of an hourly quota. Parallelising changes the concurrency, never
  the request count, which is what the quota meters.
- **Same helper elsewhere**: the update probes (`probeVersions`,
  `runVersionProbes`) use it too, under their own pair — a separate pair
  because the scripts in one probe pass can span every collection, so
  neither refresh limit describes the shape. See
  [updates.md](updates.md#when-it-runs); only the scripts-at-once half
  of that pair can actually bind.
- **Bounds the working set, not the total.** Every result is still
  retained until the write, so a large enough collection is still a
  large enough peak. A hard per-collection entry cap is still open — see
  TODO.md.

### Write failure: report, don't lose it

The write in step 5 is the last thing that can fail, and the one failure
`chrome.storage.local` cannot record.

- **Trigger**: `chrome.storage.local.set` rejects. In practice an
  exhausted quota — 10 MB for the whole extension, since the manifest
  does not take `unlimitedStorage`.
- **Outcome**: nothing is written, so every script keeps its prior
  content and keeps running. The reason goes to the session-storage map
  in `src/extension/refresh-error.ts`, keyed by collection.
- **Why not the collection row**: writing the error there needs the
  bucket that just rejected. `chrome.storage.session` is a separate
  quota, so it still has room in exactly the situation being reported.
- **Why session lifetime**: "your last refresh didn't save" describes
  this session's attempt, not a property of the collection. A new
  browser session refreshes from scratch.
- **Cleared** on the next refresh of that collection that does save, and
  pruned when the collection is removed.
- **Surfaced** on the collections page as a per-section message plus a
  page banner naming storage usage — see
  [diagnostics.md](diagnostics.md#refreshes-that-could-not-be-saved).
- **Usage is also shown at all times** at the bottom of the Options
  page, so a profile nearing the quota is visible before a write fails.
  See [Storage usage table](#storage-usage-table).
- **One collection failing doesn't stop the others.**
  `refreshAllCollections` records each failure and keeps going rather
  than rejecting at the first, because an exhausted quota fails *every*
  collection — a first-failure abort would be the normal case.
- **Chrome's wording is replaced.** Every `chrome.storage.local.set` in
  `script-store.ts` goes through `writeLocal`, which turns Chrome's
  `... quota exceeded` rejection into `storageFullMessage()` — the
  cause and the fix, in one string, wherever the reason lands (Log
  entry, install callout, collection section). Other rejections pass
  through as worded.

### Storage usage table

The Options page's read-only breakdown of `chrome.storage.local`
(`src/extension/storage-usage.ts`).

- **Rows by kind**: scripts, `@require` and `@resource` files, GM
  values, icons, imported scripts kept only here, scripts run by
  sm-dev, collections, other.
- **Session storage isn't shown**: it holds only this session's logs
  and tab state, with its own quota, and is nowhere near filling.
- **Blobs by kind**: each `blob:` row counts once, under the kind of
  the first row found pointing at it (a script body, a `@require`, a
  `@resource`).
  - The count says `(N unique)` when sharing stores fewer bodies than
    there are files: `12 files (9 unique)`.
  - Files not stored as blobs (never loaded, or not yet migrated) count
    as unique, so they can't make the count look like sharing. Each
    kind counts its own distinct blobs, even one shared with another
    kind.
  - A blob nothing points at (left by a remove or a replaced body,
    until cleanup deletes it) counts under **Stored files no script
    uses**.
  - A format 1 row not yet migrated carries its `@require` /
    `@resource` bodies inline, so their JSON is subtracted from the row
    and counted under their own kind.
- **Sizes** are key + JSON value in UTF-8 bytes, which is how Chrome
  charges. The total comes from `getBytesInUse`, and **Other** takes
  the difference so the rows always add up.
- **Rows in whole KB**, rounded by largest remainder so they sum
  exactly to the total in KB. Rows that round to 0 are left out.
- **Total in MB**, on both sides of "of" (`9.9 MB of 10 MB`): mixed
  units read as over the limit at a glance. Rounded down, so it never
  reads as full while there is room. The collections page's
  storage-full banner uses the same wording (`formatStorageUsage`).
- **Repaint** on any storage change, at most once a second, since each
  paint reads every row.

#### Later: without reading every blob

The table still reads the whole store. Each `BlobRef` carries its hash
and size, so a later version could skip the blobs:

- **Per kind**, from the refs on the rows: files and size as if
  nothing were shared, and the unique count and size.
- **Stored bodies**: the real cost of all `blob:` rows, from `getKeys`
  and `getBytesInUse` on those keys, which read no values.

### Storage debug page

`/debug/storage.html` (`src/debug/storage.html` +
`src/extension/debug/storage.ts`) shows where the storage goes, in more
detail than the Options table. Linked from under that table. The
breakdown is built by `src/extension/storage-breakdown.ts`, which sizes
rows the same way as `storage-usage.ts`.

- **Views**, picked at the top and kept in the URL fragment (`#file`,
  `#values`):
  - **By script**: a total per script, with its parts under it.
  - **By file**: each stored file once, with the scripts that use it.
    Mostly `blob:` rows, but a body stored elsewhere (sm-dev's rows, a
    format 1 row's inline body) is listed as a file of its own.
  - **Stored values**: GM values per script, only for scripts that
    have some.
- **A script's parts**:
  - `script`: its body. `@require` and `@resource`: each file.
  - `metadata`: the `script:<id>` row without any body.
  - For a script sm-dev pushed: sm-dev's copy of its text (with the
    `scratchSource:` row) and each file it pushed from disk.
  - A format 1 body still inline in the row counts as its own file,
    taken out of the metadata.
- **Shared copies**: how many uses there are of the same stored file
  (`blob:` row), across all scripts and kinds. Blank when only one.
  - By script counts a shared file in full under each script, so its
    totals add up to more than is stored. By file counts it once.
- **By file headings** name what every use agrees on:
  - The kind, when all uses are the same kind. Then the `@resource`
    name and the location, each where all uses agree on it.
  - Otherwise "multiple locations", with each use's line giving what
    the heading leaves out.
  - Mixed kinds: "Multiple locations", with kind and location per line.
- **Not used by any script**, listed last in By file: blobs no script
  points at, and sm-dev rows whose script is gone.
- **Missing from storage**: a blob a script points at that isn't
  there is marked so, sized from the script's ref, and left out of
  the stored total.
- **Sorting**: clicking a heading sorts by collection, script, size,
  shared copies or value count; again reverses it.
  - Numbers start largest first, names A to Z. Ties go to collection
    name, then script name. The default is size, largest first.
  - A group sorts as a unit. A script's parts are listed largest first.
  - By file sorts only by size or shared copies, since a file has no
    one collection or script. Ties go to the other of the two, then
    the first use's collection and script.
- **Sizes** in whole KB, `< 1 KB` for a size that rounds to 0; the
  tooltip gives the exact bytes.
- **Repaint** on any storage change, at most once a second, like the
  Options table.

### Write failure during an install: take the seed back out

`installScript` commits a placeholder row (`Not loaded yet`, no
content, no header) before the refresh that loads it — see
[Container collections](#container-collections).

- **If that refresh throws**, the placeholder is removed again:
  the row, its slot in the container's `scriptIds`, and — when this
  install created the container — the container and its index entry.
  The install then fails with the refresh's reason.
- **Why**: a placeholder that never loaded matches nothing and runs
  nothing; left in place it is a broken row the user has to notice and
  refresh by hand. Nothing else about the install has happened yet, so
  there is nothing to preserve.
- **A fetch that fails is different**: the refresh then *writes* the
  row with its error, and that row is the honest record of an install
  that landed. Only a refresh that could not save at all is rolled back.
- **Into an existing container**, the siblings and the container stay;
  only the seed goes. The container keeps the refresh-error record its
  refresh left (its siblings were re-read and not saved either), so its
  section shows the message and a Refresh button as after any failed
  refresh.
- **Races across contexts are accepted**: the refresh runs outside the
  lock, so another tab can dedup-reject its own install against a seed
  that then vanishes, or move the seed (leaving a stale id in the
  destination's `scriptIds`, which reads filter out). Both need a real
  quota failure and a same-moment action elsewhere.
- **Unlike `addCollection`**, whose seeded collection row stays with a
  refresh-error message and a Refresh button (above): an empty
  collection is a valid state, a content-less script row is not.
- **Works on a full quota**: every write in the rollback shrinks
  storage, which Chrome accepts. The `set` (the only refusable step)
  goes first, so a refused rollback changes nothing.

### Scan failure: leave scripts untouched

- **Triggers**: unreadable directory listing, unreadable manifest,
  malformed manifest JSON, bad URL shape.
- **Outcome**: collection row records the error in `scanError`; every
  existing script is left untouched — content, status, and `enabled`
  state all preserved.
- **Why**: we can't tell whether a collection that won't list is actually
  empty or just temporarily unreachable (remote mount with stale
  creds, flaky network, …). The user's scripts keep running until we
  see definitive evidence they're gone.
- **Recovery**: a later successful refresh runs the normal
  reconciliation and clears `scanError`.
- **Logging**: because no script row is touched, the per-script
  outcome pass would report "no change" for rows that were never
  checked (see [script-log.md](script-log.md#how-a-check-frames-itself)). Instead the reason is fanned out to every script's Log at
  info level (the badge for a collection-level problem stays on the collection
  row), plus one entry when it clears — see
  [script-log.md](script-log.md#collection-level-failures).

### Entry points

- `addCollection(path)` — dispatches by input shape:
  - **single-file `.user.js`** input (URL or path) → `installScript`
    into the built-in default container for its scheme (created if
    absent); the new script row is seeded and refreshed. Returns
    `{kind: 'newCollection' | 'existingContainer', collection, scriptId?}` to
    tell the caller whether to render a new section or replace an
    existing one. Returns `null` if the URL/path is already a script
    in that container.
  - **everything else** (directory / manifest / github-dir) →
    create an empty collection row, then run `refreshCollection`. Returns
    `{kind: 'newCollection', collection}`. Returns `null` if the collection path
    is already registered.
- `createCollection(spec)` — what the collection dialog calls.
  `{kind: 'scripts', name, localFiles?}` writes an empty
  `container:<uuid>` row; `{kind: 'location', path, name?, localFiles?}`
  is the directory / manifest / github-dir half of `addCollection` plus
  the dialog's name and local-overrides choice. Throws when a chosen
  name is already in use.
- `installScript(location, target)` — install one `.user.js` into
  `{collectionId}` or the `{schemeDefault: true}` container. Same
  return shape as `addCollection`; null when that container already
  holds the location; throws `COLLECTION_GONE` when the id no longer
  exists.
- `importScripts(request)` — apply an import the page planned:
  - restore the backup's collections that aren't here;
  - add scripts to directory, manifest and GitHub collections here;
  - install new scripts into the scripts collections the backup names,
    or into one chosen (made when asked for);
  - update scripts already here.

  See [import.md](import.md#applying-it).
- `moveScript(scriptId, target)` — move one already-installed script
  from its container collection into `{collectionId}` or the
  `{schemeDefault: true}` container. Same target shape as
  `installScript`, so both dropdowns share one builder.
  - The stored row keeps its `id`. Its Chrome registration
    (`chrome.userScripts` ids are the row id), its `gmval:<scriptId>:*`
    rows, and its `log:<scriptId>` entries all follow it untouched.
    Only `collectionId` and the two collections' `scriptIds` change,
    written in one `storage.local.set`.
  - `fileUrl` is unaffected: a container script's `scriptFileUrl` is its
    own `relativePath`, so the body and content hash stay valid and
    nothing is refetched.
  - **Unless `localFiles` differs** between the two collections. That
    toggle is what the `@require` / `@resource` bodies were resolved
    under, so a move across it ends with a `refreshScript`.
  - **Whether the script runs can change**: registration requires the
    parent collection to be enabled too, so a move into a disabled
    collection stops it and a move out of one starts it. The row's own
    `enabled` flag is left alone either way.
  - The viewer then applies the exclusive-enable sweep, as an install
    does — but only in the one direction:
    - the move made this copy start running → every other running copy
      of the same script is switched off, since two would both run;
    - the move made it stop → nothing else is touched. No other copy is
      auto-enabled to take its place.
  - Returns null when the destination already holds that location, or
    is the collection the script is already in. Throws
    `NOT_A_MOVABLE_SCRIPT` for either end that isn't a container — a
    directory or manifest script's `relativePath` is relative to its
    collection root, so it has no absolute spelling to carry over.
- `probeCollectionLocation(path)` — the dialog's pre-create check: the
  same listing / manifest fetch / GitHub lookup a refresh runs, with
  nothing written. Throws with the reason when the location can't be
  read; returns the script count otherwise (so the dialog can warn
  about an empty directory without refusing it).
- `setCollectionOptions(id, {displayName?, localFiles?})` — the dialog's
  Save. A blank name on a location collection goes back to the
  inferred one; a chosen name is held unique. `setCollectionLocalFiles`
  remains as a thin wrapper for the test surface.
- `refreshCollection(id)` — full rescan + reload of one collection
  (with the unchanged-file skip described above).
- `refreshAllCollections()` — runs `refreshCollection` for every registered
  collection, a bounded few at a time. Used by the collections page's "Refresh All"
  button and by the `?refresh` URL trigger.
- `removeCollection(id)` — drop the collection row + every child script row +
  rewrite the index.
- `moveCollection(id, 'up' | 'down')` — swap the collection one position in
  the `"collections"` index. No-op at the boundary. Only the index row
  is rewritten; per-collection rows untouched.
- `removeScript(id)` — drop a single script row and remove its ID
  from the parent collection's `scriptIds`. Used by the collections page's
  trash-can button (container collections), the delete-local-file
  dialog, and `refreshScript` when the directory
  no longer lists the file. A collection refresh drops vanished rows
  the same way — every path also clears the script's session-storage
  Log rows.
- `refreshScript(scriptId)` — one-file fast path used by the viewer.
  Goes through the same `fetchOrSkipInParallel` + `rebuildCollection`
  pipeline as the collection-level Refresh (so the two paths can't
  drift on skip rules, fsMtime handling, enabled preservation, error
  shape — they share the per-file logic), but with a single-element
  scan. For any `file://` script it does a targeted directory-listing
  lookup to populate the scan's size+mtime; for http(s):// entries it relies on the conditional GET
  inside `fetchOrSkipInParallel` instead. In a directory collection,
  when that listing is read and no longer shows the file, and the
  fetch fails too, the row is dropped right there (see
  [Vanished entries](#vanished-entries)); other files that went are
  the collection-level Refresh's to notice. A manifest entry is never
  dropped by this path — the manifest decides what it lists.
- `writeEnablement({ collection?, scripts?, started? })` — the one enable
  write. Flips a collection's flag and scripts' flags in a **single**
  `chrome.storage.local.set`, and stamps the active times (the
  `enablementTimes` key) of every copy whose active state changed. Only
  rows whose own flag changed are rewritten. See [script-enablement.md](script-enablement.md#active-times).
  The match index picks up the change via `storage.onChanged`.
- `setCollectionEnabled(id, enabled)` / `setScriptEnabled(id, enabled)` /
  `setScriptsEnabled(updates)` — thin wrappers over it, touching
  nothing else. The UI's toggles go through `script-enablement.ts`
  instead, which keeps one copy of each script running.
  - The bulk form exists so 15 flips fire one `storage.onChanged`
    event (and therefore one background re-sync) instead of one per
    script.

### Write serialization (`mutate`)

`chrome.storage.local` has no compare-and-swap, so two operations that
each *read* a row, derive a new value, and *write* it back can drop one
another's change. The classic symptom: a user toggles a script's
`enabled` flag while an opportunistic `refreshCollection` is mid-fetch; the
refresh captured the old flag before the toggle and writes it back,
silently reverting the user's choice.

- All structural read-modify-writes run inside a single non-reentrant
  mutex (`mutate()` in `script-store.ts`): the enable setters, the
  index mutators (`addCollection`/`addScriptToContainer` seed, `moveCollection`,
  `removeCollection`, `removeScript`), and the write halves of
  `refreshCollection` / `refreshScript`.
- The mutex guards only the **short** critical sections. Slow fetches
  stay *outside* it: a refresh fetches first, then re-reads the current
  rows and writes **inside** the lock, taking the user-owned `enabled`
  (and the collection's `displayName`) from the freshly re-read row and
  keeping the refresh-owned content. So an enable toggle that landed
  during the fetch is preserved, and I/O isn't serialized.
- Enable writes decide which copies to change inside the lock
  (`writeEnablementFrom`), from rows re-read there. See
  [script-enablement.md](script-enablement.md#decided-at-write-time).
- Non-reentrant: a `mutate()` block must not call another mutator. The
  orchestrators honor this — `addCollection` runs its dedup+seed write in
  the lock, then calls `refreshCollection` (which takes the lock for its own
  write) *outside* it; `refreshAllCollections` fans out `refreshCollection`
  calls that each lock independently.
- **Membership moves under a refresh.** The rebuilt child set comes
  from a snapshot taken before the fetch (for a container, that
  snapshot *is* the synthetic scan), so it can describe a membership
  that is minutes stale. The write reconciles against the freshly
  re-read rows instead of overwriting with it.
  - **Joined** — an `addScriptToContainer` or `moveScript` INTO this
    collection. Its id isn't in the rebuilt list, so it is appended
    from the re-read collection row.
  - **Left** — a `removeScript`, or a `moveScript` OUT. The rebuilt row
    still claims it, so it is dropped from both the list and the row
    write: the script row is the authority on which collection it
    belongs to.
  - `droppedIds` covers only ids the snapshot had and that didn't
    depart — this refresh has no evidence about a row it never looked
    at, and a departed row is either already deleted or now owned by
    somewhere else.

#### One lock, in the worker

`mutateChain` is module state, so the lock covers one JS context. Only
the service worker writes ([worker-writes.md](worker-writes.md)): the
pages ask it, and `writeLocal` throws in a page. So the structural
read-modify-writes all run under the same lock, with the exceptions
under "Still unguarded" below.

- Re-reading inside the lock and merging still matters: a refresh
  fetches outside the lock, so the `preserveConcurrentEdits` fields and
  the joined/departed reconcile in `writeRefreshedCollection` are what
  keep a change made during the fetch.
- Keep sections short: every write in the worker waits on them.

Still unguarded:

- A copy installed between an enable's pre-lock read and its lock is
  not among the copies it considers (`writeEnablementFrom`).
- The legacy-key migration a page requests mid-session
  (`migrateCollectionKeysForPage`) runs outside the lock. It writes
  script rows as its scan read them, so a `removeScript` landing in
  between gets its row written back.
  - Rare: it needs old rows restored into a running profile.
  - Not moved under the lock: reads inside the lock await the
    migration, so it would deadlock.

### Membership disagreements

The two directions of membership are written together by every mutator,
so a disagreement between them is a bug state, not a shape the store
means to represent. Two kinds:

- **Unlisted** — a row names a collection whose `scriptIds` omits it.
  Half-visible: the injector and the viewer key off `collectionId`, so
  the script still runs and still opens; the collections page and
  refresh key off `scriptIds`, so it is absent there and never updated
  again.
- **Cross-listed** — a collection lists a row that names a different
  one, so the script renders under a collection it doesn't belong to.

`reconcileScriptMembership()` repairs both, taking the script row's own
`collectionId` as the authority: append where missing, drop where stale.

- Finding a row nothing points at needs every row, so it has no
  schedule of its own. The collections page asks the worker for it on
  every full render, without waiting, so it repairs the profile on the
  page where an unlisted row is missing. The worker reads the rows from
  its row cache ([worker-writes.md](worker-writes.md#the-row-cache)).
- A row whose collection is **gone** is reported, not repaired:
  `removeCollection` drops both together, so it shouldn't arise, and
  there is nowhere to put such a row back. (`script-identity.md` calls
  that shape an orphan too — same word, different failure.)

## First-run seeding

So a freshly-installed extension isn't empty, SourceMonkey seeds the
`DEFAULT_COLLECTIONS` (`script-store.ts`) on the very first run. Seeding is
**driven by the collections page**, not the SW, so the user watches the
normal Add flow (each section appears, populated) instead of scripts
materialising silently.

- **Open trigger.** On `chrome.runtime.onInstalled` with reason
  `install`, and only while `"firstRunComplete"` is unset, the SW opens
  `collections.html?first_run=1`. The flag check matters because unpacked
  reloads re-fire `onInstalled('install')`.
- **Seed trigger.** `seedDefaultCollectionsViaUi()` (`collections.ts`) runs only
  when the page loads with `?first_run` AND the flag is unset — so an
  ordinary collections-page visit never seeds. It adds each default via
  `seedCollection()`, which calls `addCollection` directly; that fetches
  the collection's scripts as part of the add, so no follow-up Refresh
  is needed.
  - **Deliberately not the Add field's path.** Typing a location opens
    the [collection dialog](#the-collection-dialog), which is right for
    a user naming a collection and wrong for seeding: a fresh install
    would put up a modal per default and wait. `seedCollection` is the
    plain route — no dialog, no preview hand-off, no scroll.
- **Run-once.** The page asks the worker to set `"firstRunComplete"` after seeding;
  once set, neither the SW open nor the page seed fires again —
  including after the user deletes the seeded collections.
- **Reset behavior.** The test-surface `resetAllState()` sets
  `"firstRunComplete"` after clearing storage, so the network seed never
  runs during tests.
  - The e2e launch fixture also sets the flag in a throwaway browser
    before the real one starts (`tests/fixtures/sourcemonkey-launch.ts`).
    Setting it after launch would race `onInstalled`, and a lost race
    leaves a stray collections tab open for the rest of the worker's
    life: the first-run page scrubs `?first_run` from its URL, so what
    remains looks like an ordinary collections tab to the named-tab
    tests.

## Updater

`src/extension/script-updater.ts` is the single entry point every refresh path
goes through, so concurrency and rate-limiting live in one place.

- **`updateScript(id, mode)`**, **`updateCollection(id, mode)`**,
  **`updateAllCollections(mode)`** — thin gates over the corresponding
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

- `rebuildCollection` — orchestrator that takes prior scripts + scan
  results + per-file fetch results and returns the new script list.
- `buildScriptFromText`, `applyFetchError`, `buildInitialErrorEntry` —
  per-script state transitions.
- `validateHeader`, `distillMatching` — header-shape checks.

Covered by `tests/unit/script-store.test.mjs`.

## Collections-page render

The collections page reads from the store and renders **one section per
collection**:

- **Enable** toggle (checkbox) for the collection as a whole, placed to
  the left of the name.
- Heading: the type bubble (`file-dir`, `github-dir`, `file-manifest`,
  `http-manifest`, `github-manifest`, `scripts`, or `sm-dev` for an
  sm-dev test collection — see
  [`src/extension/collection-display.ts`](../src/extension/collection-display.ts)), then
  the display name. For a location collection the tooltip carries the
  path.
  - An `sm-dev` collection has no gear (rename and options), since its
    run names it.
- **Up / Down** arrow buttons → `moveCollection`. Swap this collection's
  position in the `"collections"` index. Up is disabled on the first
  section; Down is disabled on the last. The DOM moves the two
  sibling sections directly instead of re-rendering, so per-section
  state (highlights, scroll) is preserved.
- **Remove** trash can → `removeCollection`. If the collection owns ≥ 1 script,
  a `confirm()` dialog prompts "Remove collection with N scripts?" first;
  cancel aborts the remove. An empty collection removes silently.
  - The plain `record` glyph of `src/extension/delete-icon.ts`, the same one the
    script rows carry: a collection's removal drops SourceMonkey's rows,
    never the files behind them.
- **Options** gear → the [collection dialog](#the-collection-dialog) in
  edit mode: rename, or change the local-overrides option (which
  refreshes the collection on save).
  - A gear rather than a pencil: the dialog is mostly options, and a
    pencil would promise editing the scripts themselves.
- **Refresh** circular arrow → `refreshCollection`. Rightmost in the
  row, matching Refresh All at the top of the page.
  - Icon-only, so the tooltip *Refresh this collection* is its whole
    label. While it runs, the arrow spins in place instead of a label
    changing to "Refreshing…" (`setGlyphButtonBusy`, src/extension/glyph.ts) —
    nothing beside it moves.
  - Under `prefers-reduced-motion` the arrow dims rather than spins, so
    the in-flight cue there is the dimming plus the disabled state. The
    tooltip still says it, but only on hover — a real loss against the
    old visible "Refreshing…", and the reason Refresh All keeps words.
- Table with columns **(bulk toggle) | Name | Size | Status** — plus,
  in a scripts collection, a small scheme chip (`file` / `http` /
  `github` / `scratch`) after the name, since one such collection can
  mix them, and a trailing per-row remove button.
  - Header's first cell is a small `+` / `−` bulk-toggle button:
    turns the collection's scripts on (one copy per script, see
    [script-enablement.md](script-enablement.md#enable-all)) or every
    one off (once every script has a copy on). Greyed when the
    collection itself is off.
  - Every toggle on the page is exclusive, with a Ctrl/Cmd-click
    opt-out ([script-enablement.md](script-enablement.md)).
  - First column of each row is a per-script enable toggle. When the
    collection is disabled, the script toggles are visually greyed and
    the checkbox itself is `disabled` (the underlying value is
    preserved so flipping the collection back on restores each script's
    prior state).
  - Name shows the script's `@name`, falling back to its location when
    it declares none — see
    [names-and-paths.md](names-and-paths.md#the-collections-page-shows-name).
    It links to the viewer at `userscript.html?script=<scriptId>`.
  - The name's tooltip is the whole location (never the shortened
    form the column may fall back to), a blank line, then the
    `@description` (or `No description`).
  - Rows are sorted by the name the column shows (case-insensitive,
    numbers in numeric order), then by location for duplicate names.
    Stored order (scan or install order) isn't visible, so it isn't
    used.
  - Size shows the UTF-8 byte count of the cached content — including
    a `"0 B"` for an empty file, and the prior size for `invalid` rows
    that retain their last-read body. Only rows that have
    never successfully loaded (`size == null`) render as `"—"`.
    Right-aligned, in whole KB below 1 MB (`formatBytes`).
  - Status shows one of `OK | INVALID | WARNING | ERROR`
    (see [Displayed status](#displayed-status-ui-level) for the
    priority rules). The label is a link to the script viewer's Log
    tab; the cell's `title` carries `errorMessage` for hover detail.

### The Add field

Routes by what was typed (trimmed):

- **Ends in `.user.js`** (URL, `file://`, or absolute path) → the
  install page, `userscript.html?preview=…`, which asks where to put
  it. Nothing is written until Install.
  - **In a new tab**, with the Add field cleared: the collections page
    the user was adding from is still there behind the install
    question. See
    [architecture.md](architecture.md#cross-page-navigation).
- **Any other URL, or anything starting with `/`** → the collection
  dialog, prefilled with the location. The dialog classifies it (see
  [what a location turns out to be](#what-a-location-turns-out-to-be)),
  the name is left blank (blank means the inferred short form), and
  anything it can't build a collection from — a bad shape, a path that
  isn't there, an unsupported file — is reported inside the dialog.
- **Blank** → the dialog, empty.
- **Anything else** → the dialog, with the text as the name of a new
  scripts collection.

Creating from a location loads it immediately — no need to click
Refresh after adding.

### The collection dialog

`src/extension/collection-dialog.ts`, one `<dialog>` per page, shared by the
collections page (Add, Edit) and the install page ("New collection…").

- **Fields**:
  - Name: its placeholder says whether it is required (no location) or
    optional, meaning "the name inferred from the location".
  - The location, labelled *Directory or manifest* in Add and
    *Directory* or *Manifest*, whichever it is, in Edit, where it's
    read-only. Absent where none can be given.
    - A copy button beside it copies it: a local one as a plain path
      (a `file://` URL decoded), anything else as given.
    - An open button opens it in a new tab: an http(s) or `file://`
      URL as given, an absolute path as `file://`. Disabled for
      anything else.
  - Type: **reported, never chosen** (see below).
  - **Allow local file overrides** (see
    [local-file-overrides.md](local-file-overrides.md#per-collection-opt-out)).
- **The Type row** shows the collection bubble the form would produce,
  in the same colours (and with a tooltip each) the collections page
  uses:
  - a name and no location → `scripts`;
  - a location we could classify → `file-dir`, `github-manifest`, …;
  - `checking` while the location's verdict is being fetched;
  - anything else → `invalid`, with the reason in the error slot.
  - Neither a name nor a location is the one `invalid` with nothing
    wrong yet, only unfinished: the error slot stays empty and the row
    reads *Enter a name or path* — or *Enter a name* where no location
    can be given.
- **Live validation** on every keystroke, in the dialog's own error
  slot, with Create/Save disabled while anything holds: a missing name
  where nothing can be inferred; a chosen name already in use
  (case-insensitive) or reserved; a location already registered; and
  every `invalid` verdict below.
- **Create, with a location**: runs `probeCollectionLocation` first. A
  location that can't be read stays in the dialog with the reason and
  **nothing is written** — previously it landed as a collection whose
  only content was a scan error. An empty directory warns once; the
  next Create adds it anyway.
- **Create, no location**: `createCollection({kind: 'scripts'})`.
- **Edit**: Type and Location are fixed (changing them would be a
  different collection); a scripts collection shows no location field at
  all, since one can't be added. Save → `setCollectionOptions`; a
  changed overrides option refreshes the collection, because the flag
  only affects the next refresh.
- **No location on offer** when a script is what will land in the new
  collection — the install page's "New collection…", and the viewer's
  move dialog. A script can only go into a scripts collection.
- **The title and confirm button say what the caller will do with the
  collection** the moment it exists, since a plain *Create* gives no
  hint that a script lands too:
  - plain → *New collection* / **Create**;
  - install → *Create new collection and install script* / **Create and
    install**;
  - move → *Create new collection and move script* / **Create and
    move**.

#### What a location turns out to be

`classifyLocation` (`src/extension/directories.ts`) decides, debounced ~250ms
after typing stops. It reads rather than guesses, so a path that isn't
there says so instead of being filed as a directory and failing later
in a scan.

- **Shape first** — not a URL or an absolute path, or a path that
  resolves to the filesystem root (`/`, `//`, `/..`) → invalid.
- **Local paths and `file://` URLs** are probed:
  - the directory listing answers → `directory`;
  - else a plain read answers → a file, classified by name: `.user.js` →
    `script`, `script_manifest.json` → `manifest`, anything else →
    invalid, *unsupported file type*;
  - neither answers → invalid, *could not read* — naming which of the
    two causes it is, since a `file://` read fails identically for "not
    there" and "not allowed" and `isFileSchemeAccessAllowed()` can tell
    them apart.
- **http(s) URLs** are classified by shape alone — there is no remote
  listing, and a keystroke-rate classifier must not fire reads at
  arbitrary origins. `.user.js` → `script`, `script_manifest.json` →
  `manifest`, a GitHub tree / repo-root URL → `directory`, anything else
  → invalid. GitHub is the only folder here: a plain web directory has
  nothing to list. Readability is checked at Create.

A `script` verdict is not a refusal so much as a wrong door — local
path or URL alike: the error slot says *This is a single script, not a
collection* and offers an **Install script** button that hands the
location to the viewer's install preview.

Verdicts are cached per dialog session, but **refusals are forgotten on
every edit** — a location that couldn't be read may become readable
while the dialog is open, so retyping it is the retry.

Each rendered collection section gets a stable DOM id
(`collection-<collectionId>`) so it can be scrolled to via the URL fragment
or via `jumpToCollection(id)`. After a successful add the page scrolls
to the new section and writes `#collection-<id>` into the URL.

A page-level **Refresh All** button at the top of the collections page
runs `refreshAllCollections()` and re-renders every section in place. The
same flow is auto-triggered when the collections page is opened with
`?refresh` in the query string — i.e. an external tool can poke the
extension with:

```
google-chrome chrome-extension://<extension-id>/collections.html?refresh
```

after writing new userscripts to disk. Combined with the unchanged-file
skip and the [changed-rows-only write](#only-changed-rows-are-written),
this is cheap when most files are untouched.

#### Narrower refresh triggers

`?refresh` re-reads every http(s) and GitHub collection too, which is
wasted work when what changed was a file on disk. Two narrower triggers
cover that case (selection rules in `src/extension/refresh-targets.ts`):

- **`?refresh_local`** — every local collection: scanned directories,
  local `script_manifest.json` collections, and the local-files
  container. No http(s) or GitHub collection is touched. (A *local*
  manifest listing http(s) entries still refetches them — "local" is
  about where the collection lives, not every file it names.)
- **`?refresh_file=<path>`** — one file or directory path, as a raw
  absolute path or a POSIX `file://` URL. Selects:
  - each scanned local collection whose directory **overlaps** the path
    — in either direction, so naming a file finds the directory that
    scans it, and naming a tree finds the collections inside it;
  - each scanned local collection that already holds a row pointing at
    the path (a manifest may list files outside its own directory);
  - individual rows of the local-files container that point at the path
    — that collection has no directory to re-scan.

Notes:

- Overlapping collections refresh **whole**, not just the named file.
  That re-scan is what notices files added, renamed, or deleted
  alongside the edit.
- Disabled collections refresh too, matching Refresh All.
- Each target refreshes on its own — no shared file-fetch cache and one
  update-probe pass per collection, unlike `refreshAllCollections`.
- A collection that fails doesn't stop its siblings, also matching
  Refresh All; the reason lands where the repaint shows it.

**Slashes need no escaping** — write the path as it appears on disk.
The value is read with `URLSearchParams`, which applies form decoding,
so only a filename containing `+` (arrives as a space), `%`, `&`, or
`#` (cuts the value short) has to be percent-encoded.

Rejected up front, with `Refresh failed: <reason>` on the page's error
line:

- A relative path or an http(s) URL.
- A `file://` URL carrying a host or a Windows drive letter —
  `locationFsPath` would drop the host and compare against a different
  place than the one named.
- Anything resolving to bare `/`, which would sweep every local
  collection. The Add field refuses `/` for the same reason.

Paths are compared as written: the page can't resolve symlinks. So a
path through a symlink matches nothing when the collection was added
under the symlink's target (or the reverse).

```
google-chrome chrome-extension://<extension-id>/collections.html?refresh_local
google-chrome 'chrome-extension://<extension-id>/collections.html?refresh_file=/home/me/scripts/a.user.js'
```

#### `?add=<path-or-url>`

- Runs the same flow as typing the value into the Add field and
  clicking Add (validation, dedup, scroll-to-section).
- A single `.user.js` value (URL or path) opens the viewer's preview in
  a new tab rather than being added outright — see
  [script-viewer.md](script-viewer.md#preview-mode). Every other value
  opens the collection dialog prefilled, so a deep-linked directory
  gets a name and a readability check before it exists.
- Scrubs the param from the URL once it was consumed; a cancelled
  dialog leaves it in place so the user can edit and retry.
- `?refresh` / `?refresh_local` are also scrubbed once consumed, so a
  reload after the bootstrap actions doesn't re-fire them.
- `?refresh_file=` follows the `?add` rule instead: scrubbed only when
  it was acted on, so a path that was rejected or matched nothing stays
  in the URL alongside its message.
- `?add` runs first, so a collection the same URL adds is included in
  the refresh — and a `?refresh_file=` rejection is the message left
  standing on the page's single error line.
- Is the entry point used by `docs/redirect-page.md` (see
  [`deep-link.md`](deep-link.md)).

### Row highlights after refresh

After any refresh (single-directory or all), each row the refresh
touched is tagged. Two independent signals, because they answer two
different questions:

- **What happened to it** — the wash and a chip beside the status:
  - **green** + `New` (`row-added`) — a script this refresh saw for the
    first time.
  - **blue** + `Updated` (`row-updated`) — re-read, or a status change
    without a re-read, or a `refreshError` that cleared.
    - The recovery case flashes even when the body is unchanged (HTTP
      304 / size+mtime skip, which preserve `loadedAt`) — otherwise the
      red highlight would silently vanish with no "it came back"
      feedback.
- **How it came out** — **red** (`row-failed`), which overrides the wash
  and is applied to:
  - any of the above whose row isn't `'ok'`. A script that *arrived*
    broken is still new, so it keeps its `New` chip and only loses the
    green.
  - a row whose refresh just failed (`refreshError` newly set, the
    cached body still running, `status` still `'ok'`). No chip: nothing
    was re-read, so there is no update to announce.

Rows whose state was unchanged are not tagged — this covers all three
"no change" paths uniformly: the cheap pre-fetch skips (size+mtime,
HTTP 304) and the post-fetch content-hash compare (servers without
validators). See
[change detection](#change-detection-the-last-change-token).

The tags stay until the next refresh **of that collection**, which
clears the previous ones before applying its own — a single-collection
Refresh leaves every other section's tags alone. So the user can leave
the page and come back without losing the what-changed signal.

The New / Updated chips are `::after` pseudo-elements keyed off the
row's class, not DOM nodes: the Status cell is rebuilt from stored state
on every repaint, which would discard a chip element, while the class
lives on the `<tr>` a repaint preserves. (A tombstone's `Removed` chip
is a real element — see below.)

### Tombstones: rows a refresh dropped

A [vanished entry](#vanished-entries) is deleted outright — row,
storage key, Log, `gmval:` values — and the deletion can't be undone.
Nothing else on the page would say so, so the refresh leaves a
**tombstone** where the script used to be: the name, size and last
enabled state, struck through and greyed, with a `Removed` chip where
the status would be — the same chip the New / Updated rows wear, since
a dropped row has no status of its own any more. Its favicon is painted
too, from the snapshot, so the row is still recognizable at a glance.

- **Nothing to act on.** No working link (the favicon keeps its image
  and loses its href), a disabled checkbox, no trash can, and
  `aria-disabled` on the `<tr>`. Deliberately NOT `inert`: an inert
  subtree isn't hit-tested and isn't in the accessibility tree, which
  would take away the row's own hover explanation and hide from a
  screen-reader user the one row that reports an irreversible delete.
- **Its `Removed` chip is a real element**, unlike the New / Updated
  pseudo-elements. Nothing repaints a tombstone (no `data-script-id`),
  and here the chip is the whole status — it has to be selectable and
  announced.
- **DOM-only.** The next refresh clears it along with the other tags,
  and a reload never rebuilds it. Unrelated repaints keep it.
- **Only for a refresh the page ran** — Refresh All, a collection's own
  Refresh, a `?refresh_local` / `?refresh_file` trigger. A background
  opportunistic refresh drops a row without a ghost, the same way it
  changes one without a highlight.
- **Marked `data-tombstone`, never `data-script-id`.** That is what
  keeps every walker on the page — status repaints, log-suffix updates,
  bulk-toggle counting, row reconciliation — away from a row with no
  stored script behind it. The reconciler re-seats ghosts against the
  surviving row each was recorded below (`data-tombstone-after`) after
  it re-orders the live rows. (It also drops a ghost whose script id is
  live again. That can't happen — a returning file gets a fresh UUID —
  but the table must never show one id twice.)
- **Where it doesn't reach.** A collection that loses its *last* script
  shows the "no scripts" message, which has no table to hang ghosts off,
  so the case that empties a whole table is the case with no explanation
  on screen — filed in `TODO.md`.

### In-place updates (no full re-render)

The collections page does **not** re-render the whole `#collections` list
on every interaction. Each user action mutates only the affected DOM:

- Per-collection toggle → flips `.disabled` on the section, retitles each
  per-script toggle, and re-evaluates the bulk-toggle's symbol.
- Per-script toggle → flips `.disabled` on that row + recomputes the
  bulk-toggle symbol.
- Bulk +/− → one `setAllScriptsEnabled` write (one
  `storage.onChanged`, one background re-sync), then repaints every
  row's box from storage, since "Enable all" may leave a copy off.
- Every enable toggle also updates each row its write changed elsewhere
  on the page (the copies it turned off or brought back), from the
  write's result. They change together with the clicked one, rather
  than one repaint later.
- Add directory, Remove, Refresh, Refresh All → write, then repaint
  from storage (see [Live repaint](#live-repaint-changes-from-any-origin)).
  The section list, the empty placeholder, and each row follow from what
  was stored rather than from a hand-rendered result.

While the async work is in flight the triggering control shows a small
spinner, and the rest of the page — banners, other directories, scroll
position — is undisturbed.

- A toggle label gets a `.busy-spinner` child, absolutely positioned
  over its own checkbox. It must not take up layout space: the script
  table's toggle cell sizes to its content, so an in-flow spinner
  widened the column and shifted every row in the collection sideways
  for as long as the write ran.
- The bulk-toggle's glyph is painted transparent under an overlaid
  spinner via `.bulk-toggle.busy`. The glyph stays in the button:
  emptying it moved the inline-flex button's baseline, resizing the
  header row by a pixel and jiggling the collections below it.

### Live repaint (changes from any origin)

The in-place mutators above cover the page's **own** actions.
A `chrome.storage.local.onChanged` listener covers everything else:

- a Refresh from the viewer, or a background opportunistic refresh;
- an Install captured in another tab, or a second Collections tab.

The page therefore always shows the current stored state without a
manual reload.

#### The event is only a hint

The values the event carries are ignored. It sets a dirty flag and adds
its keys to the set the next pass covers; the repaint then re-reads
storage and makes the DOM match it.

- **Idempotent by construction.** Running it twice changes nothing, and
  running it after a burst lands on the final state.
- **Nothing to go stale.** A change event carries a snapshot of one key;
  acting on that snapshot later paints a state that has since moved on.
- **Nothing to keep in step.** There is no per-key handler that has to
  be taught about a new field, and no second opinion about which fields
  matter — `repaintFromStorage` reads the same rows `render()` does.

Passes are serialized on a promise chain, and a burst collapses: the
first link to run clears the flag and does the work, and the rest find
nothing to do.

Awaiting `repaintPage()` is therefore enough for a caller to know the
DOM matches storage as of its own call — which is how the flow handlers
below sequence their own work.

#### Only the rows that changed

When every changed key is a `script:` row, the pass re-reads just those
rows and their collections, and updates those rows in place
(`repaintScriptRows`). An enable toggle then reads two or three rows,
not every one.

It falls back to the full repaint, having changed nothing, when:

- a collection row or the collection list changed;
- a changed script isn't on the page, is gone, or names another
  collection than the section showing it;
- a row's shown name would change, which can move it in the section's
  name order. Its other Name cell inputs (icon, tooltip, the file's
  size and mtime) are redrawn in place.

A caller that awaits `repaintPage()` without keys gets the full one.

#### What a repaint touches

A repaint runs on any structural write from anywhere, so it has to be
safe while the user is mid-interaction. Nothing is rebuilt that doesn't
have to be.

- **Sections** are matched to the stored collection list: gone ones are
  removed, new ones built, the rest updated in place. The section
  element is never replaced, so the Refresh button's busy state and
  every row's spinner survive.
- **Rows** are matched to the collection's scripts the same way: a `<tr>`
  that is still wanted is updated in place rather than recreated, so
  refresh highlights and in-flight toggles survive.
- **A row this page wrote since the repaint read storage** keeps its
  checkbox state (and a collection its toggle). The read can take
  hundreds of ms on a large store, and drawing it would undo a click
  that landed meanwhile.
  - The click's handler has already drawn the row from the write's
    result, so nothing is left wrong.
  - A later repaint, which reads after the write, draws it again.
  - The exception is a collection crossing between "has scripts" and "has
    none", since a table and the empty message are different elements.
    That swap discards the block wholesale.
- **Re-seating** into name order happens only when the order actually
  differs — moving an attached node detaches it first, and Chrome blurs
  anything focused inside it.
- **The Name and Status cells** are rebuilt only when one of their
  inputs moved, tracked per row by `nameCellKeys` / `statusCellKeys`.
  Both discard and recreate their contents, which would drop focus off
  a link the user had tabbed to; the Name cell would also re-run the
  favicon fetch and flash the globe placeholder.
- **Reads are proportionate.** A full pass reads the collection index
  and each collection's script rows once, without their bodies
  (`getScriptMetas`), and paints from those rows. A pass for a few
  script rows reads only those (see above). A
  `storage.local.get(null)` per pass would also return every body,
  every GM value and the base64 favicon cache.
- **`data-script-*` datasets** are written by `applyScriptRowDatasets`,
  shared with the initial render so the two cannot disagree — notably
  about the `(in <file>, line N)` the hover text depends on. Fields that
  no longer apply are **deleted**: a stale `data-script-refresh-error`
  used to pin the recompute to REFRESH FAILED forever, which is the
  issue-#10 bug.

#### Coordination with the page's own handlers

The worker does the writes for a page's Add / Remove / Refresh, and
`chrome.storage` fires in every other context, so each one echoes back
to the page as a repaint. That echo is harmless: a repaint only ever
converges the DOM onto storage.

The handlers therefore don't defend against it — they use the repaint
themselves rather than hand-rendering their result:

- **Add / Remove**, both per-collection and per-script, write and then
  `await repaintPage()`. Sections, rows, and the empty placeholder come
  and go as a consequence of what is stored.
- **Refresh** writes, awaits the repaint, and then paints its
  change-highlights onto the live rows. Because rows are updated in
  place, the highlight lands on the same `<tr>` the user was already
  looking at. `applyChangeHighlights` clears the previous refresh's
  colors first, which a section rebuild used to do implicitly.

#### Busy affordances win over the echo

A control the page is still awaiting shows the value the user just
chose; a repaint must not overwrite it, or the operation appears to undo
itself mid-flight.

- **Per-script and per-collection toggle checkboxes** — left alone while
  their label carries a `.busy-spinner`. The handler's `finally` writes
  the settled state.
  - The label's `toggle-disabled` class and tooltip are updated anyway.
    They say what the parent collection is, not what the user clicked, and
    `setToggleBusy`'s restore reads the class back to settle the
    checkbox — skip it and a collection disabled mid-click leaves an
    enabled checkbox with nothing left to repaint it.
- **The bulk `+`/`−` button** — its `disabled` is left alone while
  `.busy` is set.
- **The Up / Down arrows** — `refreshMoveButtons()` no-ops while a move
  is in flight, since a repaint ends in one.

### Background-SW sync coalescing

`onCacheChanged` (in `match-index.ts`) fires for every
`storage.onChanged` batch that touches a `collection:*` or `script:*`
row, naming the rows that moved.

- The background SW's handler accumulates those ids and debounces by
  50 ms before calling `syncRegistrations(scope)` +
  `refreshAllOpenTabs`, so several rapid changes collapse into one
  re-sync over the union of their rows.
- The sync is scoped to those rows, so coalescing now saves a rebuild
  per row rather than a whole-library re-registration per row — still
  worth having, and no longer the difference it was. See
  [injection.md](injection.md#the-sync-is-incremental).

The debounce is about *cost*, not correctness — it can't stop the
startup sync, a refresh's targeted retry, or an extension page from
asking at the same moment. Ordering those is the injector's own lock;
see [injection.md](injection.md#one-registration-operation-at-a-time).
