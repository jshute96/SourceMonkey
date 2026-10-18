# Importing scripts

Design in progress for bringing scripts into SourceMonkey from a backup
file. The file formats themselves are in
[export-format.md](export-format.md); this doc covers the feature: where
it starts, the dialog, and what happens to each script.

- **Sources:**
  - Another manager's backup: Tampermonkey, Violentmonkey, or others
    with a compatible format.
  - SourceMonkey's own export
    ([export-format.md](export-format.md#sourcemonkey)), used as a
    backup or to move a setup to another machine. It restores what the
    other formats can't carry: collections, each script's location, and
    its own on/off flag.
- **Reading zips:** with fflate, already vendored for the export
  ([export.md](export.md#the-zip-writer)).
- **Not in scope:** driving another manager's pages or reading its
  storage. Chrome gives an extension no way to reach another
  extension's state, so the user carries a file across.

## Entry points

- A **⋯ menu** in the collections page's header, next to Refresh All:
  Import, and Export all collections.
- A **⋯ menu** in each collection's button bar: Export this collection,
  and Import into this collection.
- Both use the popup's ⋯ menu (`more-menu.ts`). The Export items exist
  ([export.md](export.md)); Import is to come.
- Importing into a collection presets the dialog's destination; it is
  otherwise the same dialog.

## Imported scripts

A script whose only copy is its text in storage, with no file or URL to
load it from.

- It is the scratch-script mechanism with a second owner:
  - Scratch scripts belong to an sm-dev run and run only in that run's
    tabs.
  - Imported scripts belong to no run and run everywhere.
- The row records where it came from: the manager, the import time, and
  the manager's own id for the script.
- It never refreshes; there is nothing to refresh from.
- Its scheme chip reads `imported`, with a tooltip saying it has no
  external location.

Open:

- Can the user edit an imported script in place?
- Can it be saved to disk as a local copy, becoming a normal file
  script?
- Can a URL be attached later, so it starts updating from there?

## The preview dialog

Choosing a file parses it and opens a preview. Nothing is written until
the user confirms.

### The script table

One row per script in the file.

| Column | Shows |
|---|---|
| Checkbox | Whether to import this script |
| Name | The script's `@name` |
| Version | The file's `@version` |
| Source | Where it would load from: web, file, or none. The URL in a tooltip |
| Here | What we already have: New, Same version, Older here, Newer here, Edited here, or multiple copies |
| Values | How many stored values the file has for it |
| Result | What will happen to it, updated live from the options below |

- "Here" uses the existing copy rules: the same location, or the same
  `@namespace` + `@name` ([script-identity.md](script-identity.md)).
- Multiple copies get a tooltip listing them and their collections.

### New scripts section

For scripts with no copy here.

- **Action:** Import, or Skip.
- **Into:** a new collection (named for the source and date), or an
  existing scripts collection. Preset when started from a collection's
  menu.
- **Follow the script's URL** when it has one, so it installs and
  updates like a downloaded script; otherwise it lands as an imported
  script.
- **Keep the on/off state** from the file, or import everything off.
- **Bring stored values.**

### Existing scripts section

For scripts that already have a copy here.

- **Leave as they are.**
- **Update the existing copy**, with options:
  - Replace stored values.
  - Take the file's on/off state.
- **Install another copy**, using the New scripts options.

What "update" can change depends on the existing copy's kind:

- **Imported or scratch copy:** its stored text can be replaced.
- **File-backed copy:** we can't write the file, so only values and
  on/off state change.
- **URL-backed copy:** a new body would be overwritten at the next
  refresh. The choice is to refresh it from its URL, or to turn it
  into an imported copy.

The Result column says which case applies to each row.

## After the import

- The collections page lands on the destination.
- A summary stays on the page: imported, updated, skipped, failed.
- Each script's Log starts with its import.

## Open questions

- **Matching:** should identical content count as "already have it"
  when the name or namespace changed?
- **Same version:** compare `@version` alone, or also the content
  hash? Same version with different content needs its own state.
- **Multiple copies:** update the active copy, the preferred copy
  ([script-enablement.md](script-enablement.md)), or all of them?
- **Default checkboxes** by state: for example, New and Older here
  checked, Same version unchecked.
- **Per-row overrides:** is the checkbox enough, or does each row need
  its own action? Start with checkboxes plus the sections.
- **Destination with Follow the URL:** do scripts with a URL go to the
  built-in web collection, or does everything land together?
- **Exclusive enabling:** an imported copy that is on turns our other
  copies off. Say so in the dialog, or offer "import off"?
- **Values on update:** all-or-nothing, or merge key by key with the
  file winning?
- **Re-import:** show rows matched through an earlier import's ids as
  "Imported before"?
- **Undo:** a "Remove this import" that also removes the values it
  brought?
- **Dependencies:** refetch `@require` / `@resource`, or use the copies
  in the file so a dead URL doesn't break the script?
- **Settings the file has that we don't model,** such as per-script
  match overrides: ignore, warn, or support some?

## Current implementation

What the branch builds today, before the design above: TM's JSON
format only, into a new collection, with no options. Parsing is in
`src/extension/tampermonkey-import.ts`; writing is `importCollection`
in `script-store.ts`.

### The flow

- An **Import** button right of Add opens a dialog that links to TM's
  Utilities page and says to use **File → Export** there.
- The dialog's file picker takes the `.txt`. Parse errors show inline,
  with the file still selected.
  - A single `.user.js` is refused with a pointer to Add, so one file
    doesn't get two install paths.
- The page parses the file and hands the scripts to the worker's
  `importCollection` operation, which writes the rows and the GM values
  ([worker-writes.md](worker-writes.md)).
- Success lands on the new collection, as Add does.

### One collection per import

- Each import creates a collection at `import:<uuid>`, named
  `Imported from Tampermonkey (<date>)`.
- Re-importing duplicates the scripts; `importedFrom` keeps TM's uuid
  for a later merge.
- It wears its own `imported` bubble.
- No scan: `scriptIds` is the source of truth, and `refreshCollection`
  returns it untouched, so Refresh All can't overwrite imported bodies.
- Its scripts can be removed one at a time, as in a scripts collection
  (`isSyntheticCollection`).

### Per-script location

Each row's `fileUrl` is one of:

- **Located:** TM's `file_url`, else the script's `@downloadURL`. The
  row refreshes and links out like any web script.
  - `@updateURL` is not used: it may point at a `.meta.js` holding only
    the header, which would replace the script on the first refresh.
- **Pinned:** a synthetic `sourcemonkey://imported/<scriptId>/<name>`.
  - Synthetic rather than empty, so a relative `@require` fails cleanly
    in `file-loader.ts` instead of throwing.
  - Neither `isHttpUrl` nor `isFileUrl`, so local-file overrides skip it.
  - Update probes skip it (`probeOneScript`), or both `@updateURL` and
    `@downloadURL` would read as live targets.
  - The viewer's Location row reads "Imported from Tampermonkey, with
    no external location"; Refresh is disabled with that reason.
- A script TM marked as edited (`options.user_modified`) is pinned even
  when it has a URL, so a refresh can't overwrite the edit.

### What carries over

| From the file | Into SourceMonkey |
|---|---|
| `source` | Built with `buildScriptFromText`, so it is parsed and checked like a fetched script |
| `name` | A filename (`My Script.user.js`), with `-2` suffixes for duplicates |
| `enabled` | The row's on/off |
| `position` | The order of `scriptIds` (the page lists rows by name) |
| `storage.data` | GM values, through the worker's value store. The values' type prefixes are not decoded yet ([export-format.md](export-format.md#gm-value-encoding)) |
| `uuid` | `importedFrom.uuid` |
| `requires` / `resources` | Not used; refetched from their URLs |
