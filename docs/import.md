# Importing scripts

Bringing scripts into SourceMonkey from a backup file: another
manager's, or SourceMonkey's own export. The file formats are in
[export-format.md](export-format.md); exporting is [export.md](export.md).

- **Sources:**
  - Tampermonkey (TM): its zip, and its JSON `.txt` backup.
  - Violentmonkey (VM): its zip.
  - SourceMonkey (SM): its export ([export-format.md](export-format.md#sourcemonkey)),
    as a backup or to move a setup to another machine.
  - Any other zip of `.user.js` files, at any folder depth.
- **Not in scope:** reading another manager's storage directly. Chrome
  gives an extension no way to reach another extension's state, so the
  user carries a file across.
- Code:
  - `src/extension/import-backup.ts`: reads any of those files into one
    `ParsedBackup`.
  - `src/extension/import-plan.ts`: matches its scripts to what's
    installed, and turns the dialog's choices into a request.
  - `src/extension/import-dialog.ts`: the dialog.
  - `importScripts` in `src/extension/script-store.ts`: the worker's
    write ([worker-writes.md](worker-writes.md)).

## Entry points

The collections page's ⋯ menus (`more-menu.ts`), beside the Export
items:

- In the header: **Import scripts…**
- In a scripts collection's button bar: **Import scripts into this
  collection…**, which presets where new scripts go.

## Reading the file

`readBackup` tells the format from the bytes, not the file name:

- A zip (`PK` at the start) is unzipped with fflate, then:
  - `script_manifest.json` with `format: "sourcemonkey-export"`: SM.
  - A `violentmonkey` entry: VM.
  - Any `.options.json` or `.global.json`: TM.
  - Otherwise a plain zip of userscripts.
- Anything else is read as TM's JSON backup.
  - A userscript is refused, pointing at the Add field.
  - JSON without a `scripts` list is refused as not a backup.

Each script becomes a `BackupScript`:

| Field | From |
|---|---|
| `text` | The `.user.js` entry, or TM JSON's base64 `source` |
| `name`, `namespace`, `version` | Its header |
| `enabled` | SM: the script's own flag. TM: `settings.enabled`. VM: `config.enabled` |
| `location` | SM: its `location` (`null` for a script kept as text). TM: `file_url`. VM: `downloadURL`, else `lastInstallURL`. Otherwise its `@downloadURL` |
| `foreignId` | SM: its uuid. TM: its uuid, which is SM's for a script SM exported |
| `values` | `.storage.json` or TM JSON's `storage`, else VM's `values` by namespace + name; decoded from the type letters ([export-format.md](export-format.md#gm-value-encoding)) |
| `files` | Dependency bodies, by the ref the header declares: TM's `<name>.user.js-<md5>-<basename>` entries, TM JSON's `requires` / `resources`, or SM's files at their local-copy paths |
| `userModified` | TM's `options.user_modified` |
| `collection`, `relativePath` | SM: its collection's uuid, and its path in a directory, manifest or GitHub collection (`relative_path`) |

- SM's collections are read too, as `BackupCollection`s: name, kind,
  location, built-in scheme, enabled and local-files flags. One of a
  kind this importer doesn't know is left out.

- An empty store means the values were left out (TM writes `{}` when
  storage is unchecked), so it is read as none, never as "clear them".
- A script that can't be read (empty, bad base64) becomes a problem:
  its zip entry (its name, in TM's JSON) and the reason. The rest still
  import.
  - Except an empty script SM's manifest lists: it was a row there,
    which a restore brings back. Outside a restore, the dialog lists it
    under Invalid scripts.
- Scripts keep the file's order: SM's manifest order, else the
  manager's `position`.

## Imported scripts

A new script that isn't linked to a location is kept as its text: an
**imported script**.

- The scratch mechanism with a second owner
  ([storage.md](storage.md#container-collections)):
  - Its location is `imported:///<tag>/<name>.user.js`. `<tag>` is
    random, so two imports of one name don't share a text row.
  - The text is in the `scratch:<url>` row, which the fetcher reads
    back, so every refresh path treats it as an ordinary script.
  - Its dependency bodies from the file are pushed files, in
    `scratchFiles:<url>`, used instead of fetching. A dependency the
    file lacks is fetched from its URL as usual.
  - An `importInfo:<url>` row records where it came from: the source,
    the time, the file's id for it, and its old location.
- Unlike a scratch script it belongs to no sm-dev run, so it runs
  everywhere, and it sits in an ordinary scripts collection.
- Its scheme chip reads `imported`.
- A relative `@require` or `@resource` works only when the file
  included it; otherwise it fails with its own message.

## Matching what's here

`planImport` finds each script's copies here, in this order:

1. **Id:** a row whose id is the file's id (an SM export, or a script
   SM exported through TM), or whose import record has it (a TM script
   imported before).
2. **Location:** the same canonical location (`locationKey`).
3. **Identity:** the same `@namespace` + `@name`
   ([script-identity.md](script-identity.md)).

- Rows in sm-dev test collections are never matched.
- Only a script kept as text has an import record, so a TM script
  linked to its web address is found again by that address, not its
  uuid.
- An active copy comes first, as the one an update applies to.
- How the backup's copy compares with that one (the Existing scripts
  table's **Compared** column):

| Compared | Means |
|---|---|
| Same | The same text (content hash) |
| Backup is newer | The backup's `@version` is newer |
| Installed is newer | Ours is newer |
| Same version, different text | The same `@version`, different text |

## Restoring collections

From an SM export, its collections can be made again with their
scripts (`planCollections`, then `restores` in the request).

- Each is matched to a collection here, in this order:
  1. The same id.
  2. A directory, manifest or GitHub collection at the same location.
  3. A built-in scripts collection for the same scheme.
  4. A user's scripts collection with the same name, ignoring case.
- **Only one that isn't here is restored.** One that is shows as
  Already here, and its scripts import one by one, as from any backup.
- A restored collection takes its name, kind, location and local-files
  flag from the backup. Its enabled flag too, with Enabled state on;
  otherwise it is on.
- **All its scripts go into it,** whatever they match here, from the
  backup's text:
  - In a directory, manifest or GitHub collection, each at its
    `relativePath`: the path the collection's scan names it by.
  - In a scripts collection, placed as a new script would be: linked
    to its location, or kept as an imported script.
- Their values and enabled state are restored too, per the Include
  options. So even a local directory's scripts get their values back.
- **The next refresh loads what the location has now.** It matches
  rows by path, so each script keeps its id and values, takes the
  file's current version, or is dropped when its file is gone.
- A script's path in its collection:
  - Read from the manifest's `relative_path`.
  - For an export from before that field, worked out from its location
    for a local or GitHub directory.
  - A manifest collection from such an export has no path for its
    scripts. It is listed as Can't restore, and its scripts import one
    by one.

## The dialog

Choosing a file reads it and shows the preview. Nothing is written until
Import.

- A section per kind of script: New, Existing and Invalid. Each is
  headed with its count ("New scripts (3)"), shows only when the file
  has such scripts, and has its own controls and a table of just the
  scripts they apply to.
- **Collections**, first, for an SM export with collections to restore
  ([above](#restoring-collections)): Name, Kind (Directory, GitHub,
  Manifest, Scripts, or Scripts (built-in)), Location (linked), Scripts, and Status (New,
  Already here, or Can't restore).
  - A new one is checked to be restored. The others are unchecked and
    can't be checked; the Status tooltip says why.
  - The scripts a checked collection takes aren't listed in the New or
    Existing sections. Unchecking it moves them there.
- The New and Existing tables have a checkbox per script (and one for
  all), a **Type** column and a **Values** column:
  - Type is the scheme chip the collections page shows (`http`,
    `github`, `file`, `imported`, `scratch`), linked to the location
    when it is a URL or a file. For a new script it is where the backup
    says it loaded from; for an existing one, the installed copy's.
  - Values has a check when the file has stored values for the script.
- **New scripts:** Name, Version, Type, Values.
  - **Into:** a new scripts collection, "Imported from Tampermonkey
    (date)", or an existing scripts collection.
- **Existing scripts:** Name (a link to the installed copy an update
  goes to, in the viewer), Backup version, Installed version, Compared
  (the copies here in its tooltip), Type, Values.
  - A row the current choice leaves alone is greyed.
  - **Leave them as they are.**
  - **Replace the ones the backup has a newer version of** (the default),
    with how many that is. Greyed out at zero, and Leave chosen instead;
    the default comes back if restoring fewer collections raises the
    count, unless a choice was made.
  - **Replace them all.**
  - Replacing changes the text only of a copy kept as text (imported or
    scratch). Any other copy loads from its own location, so only its
    values and enabled state change.
- **Invalid scripts:** "These scripts cannot be imported", and a table
  of each one's file in the zip and the reason.
- **Include:**
  - **Link scripts to their location from the import** (on): a new
    script, or one restored into a scripts collection, with a location
    (an http(s) URL or a file) is installed at it, starting from the
    file's text, and can get updates from there. Off, or without one,
    it is kept as an imported script.
    - A script edited in TM (`user_modified`) is always kept as its
      text: its location serves something else.
    - A file is linked only if it can be read at import time, since a
      refresh drops a scripts-collection row whose file is gone. One
      that can't be read uses the backup's copy instead, and the result
      lists those scripts.
  - **Stored values** (on): they replace an updated script's values
    whole, as TM and VM do.
  - **Enabled state** (on): use enabled states from the backup.
    Otherwise, new scripts and restored collections load enabled, as
    any install does, and existing ones keep theirs.
- The button counts what will happen: "Import 3 scripts", restored
  collections' scripts included.
- Afterwards the dialog says what was restored, imported and updated,
  and what failed. Closing it lands the page on the collection new
  scripts went into, else the first one restored.

## Applying it

`buildImportRequest` sends the worker the kept rows' actions;
`importScripts` applies them.

- **New scripts** are built from the file's text with
  `buildScriptFromText` + `applyFiles`, as a refresh builds them, and
  written in one step under the store's lock with their collection.
  - A URL the collection already holds is refused for that script.
  - New copies settle as a refresh's do (`settleNewCopies`).
  - Values go through the value store; each script's Log starts with
    its install.
- **Restores** go first, each as a new collection through the same
  path, given its row:
  - Its path is its canonical location, or a built-in or new scripts
    collection's.
  - A location or built-in collection that turns out to be here
    already is refused, and its scripts are listed as failed.
  - A name already taken gets a number, unless it is the one inferred
    from the location (which may repeat, as when adding a collection)
    or a built-in collection's own name.
- **Updates:** new text is written to the text row and the script
  refreshed; enabled state through `setScriptsEnabled`; values replaced whole.
- What failed is reported per script; the rest still apply.

## Testing

- Unit: `tests/unit/import-backup.test.mjs` (each format, including an
  SM export written by the export's own planner) and
  `tests/unit/import-plan.test.mjs`.
- E2E: `tests/e2e/import.spec.ts` drives the dialog: an export
  imported after its collection is gone (linked to a file still there,
  kept as text for one that isn't), its collection restored with its
  values and then refreshed, a re-import matched by id, a TM backup with
  a bundled `@require` and then a newer version, a script linked to its
  URL, scripts that can't be read, and files that aren't backups.
- Round trip: `tests/e2e/backup-roundtrip.spec.ts` exports one
  collection of each kind, with scripts of each kind (linked to a file
  or URL, kept as text, disabled, invalid, empty, with dependencies and
  values), restores it into an empty SM, and compares what's there.
  Then a refresh of each keeps every script's row. GitHub and web
  scripts come from routes on made-up hosts.
- Cross-manager: `tests/e2e/backup-interop.spec.ts` uses the TM and VM
  copies `sm-dev --manager tm|vm manager fetch` caches, and is skipped
  without them. Through each manager's own import and export pages:
  - SM → TM → SM: TM keeps SM's ids, enabled state and values, and
    re-importing updates rather than duplicates. Back in SM, the scripts
    match by id.
  - TM's own scripts, from its JSON and zip backups, with values a
    script stored and a bundled `@require`.
  - SM → VM → SM, plus a script of VM's own: VM keeps no ids, so SM
    matches by namespace and name.
  - Headless Chrome can't answer a permission prompt or show Save As,
    so TM's browser is launched with `downloads` granted, and its
    downloads are made without Save As.

See [TODO.md](../TODO.md) for follow-ups.
