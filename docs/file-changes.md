# Files changed behind SourceMonkey's back

What happens when a local file SourceMonkey holds a row for — a script,
or a stand-in for a `@require` / `@resource` — is deleted or edited on
disk, or a new script file appears in a directory collection, and how
each surface says so before and after a refresh notices.

- Paint-time probe and chip: [`src/extension/file-changes.ts`](../src/extension/file-changes.ts)
- Listing-shape check: `isDirectoryListing` in
  [`src/extension/directories.ts`](../src/extension/directories.ts)
- Dropping on refresh: `rebuildCollection` and `refreshScript` in
  [`src/extension/script-store.ts`](../src/extension/script-store.ts)
- Tests: `tests/e2e/file-changes.spec.ts`, the vanished-entry tests in
  `tests/e2e/collections.spec.ts`, `tests/unit/script-store.test.mjs`

Related: [storage.md](storage.md#vanished-entries) (the drop rule),
[local-delete.md](local-delete.md) (deleting a copy from inside
SourceMonkey), [local-file-overrides.md](local-file-overrides.md)
(stand-ins).

## One outcome per kind of file

| File | Between refreshes | On refresh |
| --- | --- | --- |
| Script in a directory collection | `deleted` / `modified` chip | Deleted: row dropped, by the collection refresh or the per-script one. Modified: re-read |
| Script added on its own, or a manifest entry | `deleted` / `modified` chip | Deleted: `REFRESH FAILED`, keeps running from its last copy. Modified: re-read |
| Local stand-in for a `@require` / `@resource` | `deleted` / `modified` chip on the Local overrides row | Deleted: remote copy loaded. Modified: re-read. An `info` Log line says so either way |
| http(s) script or dependency | nothing | `REFRESH FAILED` (a 404 is not proof the file is gone) |

- A directory collection **mirrors its directory**: a file it no
  longer lists is gone from SourceMonkey too, however many went — an
  empty directory, or one with no `.user.js` files left, empties the
  collection like an empty manifest does.
- What must never be mistaken for that is a directory that could not be
  read. Chrome's listing page has a fixed shape, and `listDirectory`
  refuses anything else as a failed read, which the refresh turns into
  a `scanError` that leaves every row alone
  ([storage.md](storage.md#vanished-entries)).
- The per-script refresh (a navigation, a tab focus, the viewer's
  Refresh) lists the parent directory anyway, so it drops the row
  itself rather than reporting a failed read for a file it can see is
  not there.
  - Only when the read that follows fails too. A file the listing
    lacked but the read found is mid-save (an editor that writes by
    unlink and rename), and this path runs often enough to land in
    that gap.
- The viewer's Refresh — its own button, or the versions panel's
  button on the row for the copy on screen, Refresh all included —
  when it is the one to drop the row, moves the page to the next copy
  in the versions table (as the panel's trash can does); with no other
  copy it says *This script has been removed because its file was
  deleted*, in place of the generic not-found wording
  (`refreshShownScript` in `userscript.ts`).

## The `deleted` and `modified` chips

Every surface that shows a local path paints from storage, which only
learns about the disk when a refresh lists a directory. Until then the
page would describe the file as it was last read, so it checks.

- **Where**: the viewer's Location row and each Local overrides entry;
  the location cell of the versions table; the name link on the
  collections page.
- **How**: the element carrying the path is tagged (`tagLocalFile`:
  the absolute path, the size and listing mtime the row was read at,
  and the tooltips), and `markFileChanges` runs over the page after
  each paint. It lists each distinct parent directory once
  (`probeFiles`) and puts a chip after every tagged element whose file
  is not in its listing (`deleted`) or whose listed size or mtime
  differ from the row's (`modified`).
- **`modified` is the refresh's own test.** The comparison is the one
  `canSkip` makes before re-reading a file, so the chip predicts
  exactly what a refresh will re-read — and shares its blind spot: a
  same-size edit within the listing's one-second mtime granularity.
  - Every local file SourceMonkey holds has the stat for it: a
    directory collection's rows, a manifest's `file://` entries, and a
    single file added on its own all record `size` + `fsMtime` on every
    refresh (the manifest and container refreshes list each file's
    folder once for it — which also lets the refresh skip an unchanged
    file rather than always re-reading it).
  - A stand-in records its listing mtime beside `localUrl` when it is
    read (`fsMtime` on the entry), so the Local overrides row reports
    edits the same way — until the next refresh, the row is still
    claiming to load the bytes it holds.
- **Conservative by construction.** A file is reported gone only when
  its directory listed and the name was absent, and modified only when
  the listing supplied a size and mtime that differ. A listing that
  fails — the directory itself gone, file access off, a read error —
  marks nothing. A chip on a file that is fine would be worse than
  none.
- **Cheap.** One small listing per folder on the page, however many
  rows it settles; no file bodies are read. It runs after the
  synchronous paint and is never awaited by it.
  - The collections page repaints on every storage write — an enable
    toggle included — so it passes a `maxAgeMs` and a listing read in
    the last few seconds is reused rather than re-read. The viewer
    and versions table read fresh on each render.
- **Re-run on every repaint**, removing an earlier chip first, so a
  file put back loses it and a file the refresh drops or re-reads
  takes its chip with it. (The collections page's name cell is only
  rebuilt when its inputs move, so the row's size and mtime are part
  of that key — otherwise the tag would keep the pre-refresh stat.)

### The collection's `refresh pending` chip

A directory collection on the collections page whose directory differs
from its rows wears a `refresh pending` chip after its name, in the
same colour as `modified`. Its tooltip carries the counts
(`refreshPendingHint`): *1 file modified, 1 file deleted, 2 new files
on disk. Refresh to load.* Only the kinds with a count appear, and the
chip is absent when nothing differs.

- **New** files are `.user.js` names in the listing that no row
  accounts for (`newScriptFiles`). It looks in the collection root and
  in every folder a known script sits in — where new files land in
  practice. A new subdirectory with nothing known in it is not seen
  until a refresh scans it.
- A `file://` manifest collection gets the chip too: for its entries
  (modified / deleted, from their listing stats), and for the manifest
  file itself, whose listing size + mtime the scan records on the
  collection row (`manifestSize` / `manifestMtime`) — *The manifest
  changed on disk. Refresh to load.* No "new" count: what a manifest
  lists is what it has.
- The Refresh button beside the header is the action; the chip only
  says why.
- Not for http(s) collections or manifests: telling whether those
  changed means fetching them, which is a refresh, not a listing.

### What the tooltips say

The chip says what the disk holds; the tooltip says what follows,
which differs by surface (`scriptFileMissingHint`,
`SCRIPT_FILE_MODIFIED_HINT`, `STAND_IN_MISSING_HINT`):

- Any script file or stand-in that changed: *This file has changed on
  disk. The next refresh will load the new version.*
- Script in a directory collection: *This file has been deleted. The
  next refresh will remove this script.*
- Manifest entry: *This file has been deleted. The last copy of the
  script keeps running until the entry is removed from the manifest.*
- Script added on its own: *This file has been deleted. The last copy
  of the script keeps running until you remove it.*
- Stand-in: *This file has been deleted. The next refresh will reload
  the remote version.*

## The delete dialog uses the same probe

Deleting a copy from inside SourceMonkey
([local-delete.md](local-delete.md)) needs the same answer — which of
the files it lists are still on disk — and polls `missingFiles` (a
convenience over `probeFiles`) while it is open, so a file deleted by hand while the dialog is up moves to
its **Files already deleted** list.
