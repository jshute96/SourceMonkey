# Files deleted behind SourceMonkey's back

What happens when a local file SourceMonkey holds a row for — a script,
or a stand-in for a `@require` / `@resource` — is deleted on disk, and
how each surface says so before and after a refresh notices.

- Paint-time probe and chip: [`src/missing-files.ts`](../src/missing-files.ts)
- Listing-shape check: `isDirectoryListing` in
  [`src/directories.ts`](../src/directories.ts)
- Dropping on refresh: `rebuildCollection` and `refreshScript` in
  [`src/script-store.ts`](../src/script-store.ts)
- Tests: `tests/e2e/missing-files.spec.ts`, the vanished-entry tests in
  `tests/e2e/collections.spec.ts`, `tests/unit/script-store.test.mjs`

Related: [storage.md](storage.md#vanished-entries) (the drop rule),
[local-delete.md](local-delete.md) (deleting a copy from inside
SourceMonkey), [local-file-overrides.md](local-file-overrides.md)
(stand-ins).

## One outcome per kind of file

| File | Between refreshes | On refresh |
| --- | --- | --- |
| Script in a directory collection | `deleted` chip | Row dropped — by the collection refresh or the per-script one |
| Script added on its own, or a manifest entry | `deleted` chip | `REFRESH FAILED`; keeps running from its last copy |
| Local stand-in for a `@require` / `@resource` | `deleted` chip on the Local overrides row | Remote copy loaded; an `info` Log line says so |
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
- The viewer's own Refresh button says what happened when it was the
  one to drop the row: *This script has been removed because its file
  was deleted*, in place of the generic not-found wording.

## The `deleted` chip

Every surface that shows a local path paints from storage, which only
learns a file is gone when a refresh lists its directory. Until then
the page would describe a file that isn't there, so it checks.

- **Where**: the viewer's Location row and each Local overrides entry;
  the location cell of the versions table; the name link on the
  collections page.
- **How**: the element carrying the path is tagged (`tagLocalFile`:
  the absolute path and a tooltip), and `markMissingFiles` runs over
  the page after each paint. It lists each distinct parent directory
  once (`missingFiles`) and puts the chip after every tagged element
  whose name is not in its listing.
- **Conservative by construction.** A file is reported gone only when
  its directory listed and the name was absent. A listing that fails —
  the directory itself gone, file access off, a read error — marks
  nothing. A chip on a file that is there would be worse than none.
- **Cheap.** One small listing per folder on the page, however many
  rows it settles; no file bodies are read. It runs after the
  synchronous paint and is never awaited by it.
  - The collections page repaints on every storage write — an enable
    toggle included — so it passes a `maxAgeMs` and a listing read in
    the last few seconds is reused rather than re-read. The viewer
    and versions table read fresh on each render.
- **Re-run on every repaint**, removing an earlier chip first, so a
  file put back loses it and a file the refresh drops takes its chip
  with it.

### What the tooltip says

The chip says the file is gone; the tooltip says what follows, which
differs by surface (`scriptFileMissingHint`, `STAND_IN_MISSING_HINT`):

- Script in a directory collection: *This file has been deleted. The
  next refresh will remove this script.*
- Manifest entry: *This file has been deleted. The script keeps
  running from its last copy until the entry is removed from the
  manifest.*
- Script added on its own: *This file has been deleted. The last copy
  of the script keeps running until you remove it.*
- Stand-in: *This file has been deleted. The next refresh will reload
  the remote version.*

## The delete dialog uses the same probe

Deleting a copy from inside SourceMonkey
([local-delete.md](local-delete.md)) needs the same answer — which of
the files it lists are still on disk — and polls `missingFiles` while
it is open, so a file deleted by hand while the dialog is up moves to
its **Files already deleted** list.
