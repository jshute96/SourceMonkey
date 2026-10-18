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

- An empty store means the values were left out (TM writes `{}` when
  storage is unchecked), so it is read as none, never as "clear them".
- A script that can't be read (empty, bad base64) is listed as a
  problem; the rest still import.
- Scripts keep the file's order: SM's manifest order, else the
  manager's `position`.

## Imported scripts

A new script with no web address to follow is kept as its text: an
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
  installed at its web address is found again by that address, not its
  uuid.
- An active copy comes first, as the one an update applies to.
- The **Here** column compares the file with that copy:

| Here | Means |
|---|---|
| New | No copy here |
| Same | The same text (content hash) |
| Older here | The file's `@version` is newer |
| Newer here | Ours is newer |
| Changed | The same `@version`, different text |

## The dialog

Choosing a file reads it and shows the preview. Nothing is written until
Import.

- A summary line: the format, the script count, how many are here.
- The scripts that couldn't be read, if any.
- **The table:** a checkbox per script (and one for all), Name (its
  location in a tooltip), Version, Here (the copies here in a tooltip),
  Values (how many), and Result, which follows the choices below.
- **New scripts:**
  - **Into:** a new scripts collection, "Imported from Tampermonkey
    (date)", or an existing scripts collection.
  - **Update from their web addresses** (on): a script with an http(s)
    location is installed at that URL, starting from the file's text,
    and updates from there. Off, or without one, it is kept as an
    imported script. A script edited in TM (`user_modified`) is always
    kept as its text: its address serves something else.
- **Already here:**
  - **Leave them as they are.**
  - **Replace the ones the file has a newer version of** (the default).
  - **Replace them all.**
  - Replacing changes the text only of a copy kept as text (imported or
    scratch). Any other copy loads from its own location, so only its
    values and on/off state change.
- **Include:**
  - **Stored values** (on): they replace an updated script's values
    whole, as TM and VM do.
  - **On/off state** (on): without it, new scripts come in off and
    updated ones keep theirs.
- The button counts what will happen: "Import 3 scripts".
- Afterwards the dialog says what was imported and updated, and what
  failed. Closing it lands the page on the collection new scripts went
  into.

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
- **Updates:** new text is written to the text row and the script
  refreshed; on/off through `setScriptsEnabled`; values replaced whole.
- What failed is reported per script; the rest still apply.

## Testing

- Unit: `tests/unit/import-backup.test.mjs` (each format, including an
  SM export written by the export's own planner) and
  `tests/unit/import-plan.test.mjs`.
- E2E: `tests/e2e/import.spec.ts` drives the dialog: an export restored
  after its collection is gone, a re-import matched by id, a TM backup
  with a bundled `@require` and then a newer version, a script that
  follows its URL, and files that aren't backups.
- Cross-manager: `tests/e2e/backup-interop.spec.ts` uses the TM and VM
  copies `sm-dev --manager tm|vm manager fetch` caches, and is skipped
  without them. Through each manager's own import and export pages:
  - SM → TM → SM: TM keeps SM's ids, on/off state and values, and
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
