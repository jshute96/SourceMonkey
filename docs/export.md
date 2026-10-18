# Exporting collections

Saving collections and their scripts to a zip file: a backup, a way to
move a setup to another machine, or a way to hand scripts to
Tampermonkey or Violentmonkey. The file's format is in
[export-format.md](export-format.md#sourcemonkey); importing is
[import.md](import.md).

- Code: `src/extension/export-backup.ts` (what goes in the file),
  `src/extension/export-dialog.ts` (the dialog),
  `src/extension/zip-writer.ts` (the zip itself, through fflate).

## Entry points

The collections page has two ⋯ menus (`src/extension/more-menu.ts`,
shared with the toolbar popup):

- In the header, right of Refresh All: **Export all collections…**
- In each collection's button bar, at the right: **Export this
  collection…**
  - Not on an sm-dev test collection: those are never exported.

## The dialog

- **Include:**
  - **Stored values** (on by default): each script's GM values, as its
    `.storage.json`.
  - **Dependency files** (off by default): the `@require`, `@resource`
    and `@icon` files each script uses.
- **Export…** builds the zip and opens Chrome's Save As, with
  `sourcemonkey-backup-<iso>.zip` filled in.
- On success the dialog stays open to say how many scripts went in and
  where the file was saved, with a button that copies the path.
  **Close** dismisses it.
- Cancelling the Save As returns to the dialog with nothing said.
- Esc is refused while the file is being saved.

## Where the data comes from

The export runs on the collections page, which only reads:

- Collection and script rows, with their bodies, from storage.
- GM values from the worker (the `readScriptValues` operation), since
  its value store can hold writes not yet saved
  ([worker-writes.md](worker-writes.md)).
- Icons through the page's icon cache (`ensureIconForUrl`), fetched when
  not cached.
- Dependency bodies from the script rows: what is running now,
  including a local stand-in's bytes.

## The zip writer

`zip-writer.ts` writes the archive with **fflate**, the zip library
Violentmonkey uses too.

- Vendored like Prism: the build copies `node_modules/fflate/esm/browser.js`
  to `dist/vendor/fflate.js`, with its license as
  `dist/vendor/fflate.LICENSE`, and `src/vendor/fflate.d.ts` gives it
  types.
- It deflates each entry and marks non-ASCII names as UTF-8, which
  Tampermonkey's and Violentmonkey's readers both honor.

## Testing

- Unit: `tests/unit/zip-writer.test.mjs`, and
  `tests/unit/export-backup.test.mjs` for the planner. Both read zips
  back with `tests/fixtures/zip-read.mjs`, which is independent of the
  writer.
- E2E: `tests/e2e/export.spec.ts` drives the menus and dialog and
  reads the saved file.
  - Headless Chrome can't show a Save As and reports it as cancelled.
    The test sets `smExportSkipSaveAs` on the page, which saves straight
    to the Downloads folder. Nothing in the extension sets it.
- Not yet tested: importing the file into real Tampermonkey and
  Violentmonkey.
