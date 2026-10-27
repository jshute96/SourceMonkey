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

The collections page's header ⋯ menu (`more-menu.ts`): **Import
scripts…**, beside the Export item.

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
- How the backup's copy compares with that one (`HereState`). The
  "newer" choice and the Existing table's Version and Content columns
  go by it:

| State | Means |
|---|---|
| Same | The same code (content hash) |
| Backup is newer | The backup's `@version` is newer |
| Installed is newer | Ours is newer |
| Same version, different code | The same `@version`, different code |

## Restoring collections

From an SM export, its directory, manifest and GitHub collections can
be made again with their scripts (`planCollections`, then `restores` in
the request). Its scripts collections aren't restored as such: their
scripts import as new or existing scripts, and new ones go back into
their collections ([below](#scripts-collections)).

- Each is matched to a collection here, in this order:
  1. The same id.
  2. A directory, manifest or GitHub collection at the same location.
  3. A built-in scripts collection for the same scheme.
  4. A user's scripts collection with the same name, ignoring case.
- **Only one that isn't here is restored** (`restorable`). One that is
  shows as Already exists ([below](#collections-here)).
- A restored collection takes its name, kind, location and local-files
  flag from the backup. Its enabled flag too, with the Directory
  collections section's Enabled state on; otherwise it is on.
- **All its scripts go into it,** whatever they match here, from the
  backup's text, each at its `relativePath`: the path the collection's
  scan names it by.
- Their values and enabled state are restored too, per the Directory
  collections section's options. So even a local directory's scripts
  get their values back.
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

### Collections here

A directory, manifest or GitHub collection that is already here isn't
made again (`updatable`, then `additions` in the request).

- **The scripts it doesn't have are added to it** (`addingScripts`):
  those with no copy here, each at its path, from the backup's text, as
  a restore adds them. Its next refresh then loads what the location
  has, or drops one whose file is gone.
- The ones it has are listed as existing scripts.
- It keeps its own enabled state, whatever the backup's.
- An import never removes a collection's scripts.
- The scripts it can add aren't listed in the New section, whether or
  not it is checked.
- A collection here that the backup can't place scripts in (Can't
  restore, below) has its scripts imported one by one.

### Scripts collections

- A new script from one of the backup's scripts collections goes into
  that collection (`backupScriptsCollection`, then `named` in the
  request):
  - The one here it matches (rules 1, 3 and 4 above), or
  - One made like the backup's: its name, built-in scheme, local-files
    flag, and its enabled flag with the New section's Enabled state on.
- This is offered only when every new script has such a collection.
  Otherwise, as from TM or VM, they all go into one picked collection.
- Existing scripts stay where they are installed.

## The dialog

Choosing a file reads it and shows the preview. Nothing is written until
Import.

- A section per kind of script: Collections, New, Existing with
  changes, Existing with no changes, and Invalid.
  - Each is headed with its count ("New scripts (3)") and shows only
    when the file has such scripts.
  - Each has its own options, then a table of just what they apply
    to.
  - A line above each section and below the last sets them apart.
- **Values and enabled state are options per section.** Scripts that
  arrive fresh (restored or new) take the backup's by default. For an
  existing script they'd overwrite what it has now, so they start off.
- **Directory collections**, first, for an SM export with collections
  to restore or add to ([above](#restoring-collections)): Collection
  (its name), Type (the type bubble the collections page shows, such
  as `file-dir`, `file-manifest` or `github-dir`), Location (linked),
  Enabled, Status (New, Already exists, or Can't restore), and Scripts.
  Scripts collections aren't listed.
  - A new one is checked to be restored, and one here is checked when
    it has scripts to add. The others can't be checked; for one that
    can't be restored, the Status tooltip says why.
  - Scripts: a new one's count; for one here, its count, or
    `1 → 2` when scripts are added.
  - Enabled: `✓` or `☐`, the state it will have: for a new one, the
    backup's with its option on, else on; for one here, its own. Blank
    for one that can't be restored.
  - A count that grows has a light yellow cell, as a change in the
    Existing table has.
  - The heading's checkbox checks or clears all that can be checked.
  - The scripts a new collection takes aren't listed in the New or
    Existing sections. Unchecked, it is skipped with all its scripts.
  - Its options, on one line, both on: **Use from the backup:
    Enabled state, Stored values.** Enabled state is for restored
    collections and the scripts added to collections; off, they load
    enabled.
- The New and Existing tables have a checkbox per script (and one for
  all), a **Type** column and a **Values** column:
  - Type is the scheme chip the collections page shows (`http`,
    `github`, `file`, `imported`, `scratch`), linked to the location
    when it is a URL or a file. For a new script it is where the import
    will put it (`arrivingLocation`): its location, else `imported`.
    For an existing one, the installed copy's, and an arrow to where
    replacing its text moves it (below).
  - In New, Values has a check when the file has stored values for the
    script. Existing shows a comparison (below).
  - Each column heading's tooltip says what the column shows, in these
    tables and the Directory collections and Invalid ones.
- **New scripts:** Name, Version, Enabled, Type, Values.
  - Enabled: `✓` or `☐`, the state each will have: the backup's with
    the Enabled state option on, else on.
  - When each has a scripts collection in the backup
    ([above](#scripts-collections)), two choices:
    - **Add to collections named in the backup** (the default). The
      table gains a Collection column first: the collection here, or
      the name one made for it will get (numbered if taken), with
      "(New)".
    - **Add to one collection** and the picker below. The Collection
      column is greyed. Clicking or changing the picker picks this.
  - Otherwise only the picker shows.
  - **Add to one collection:** a new scripts collection, "(New) Imported
    from Tampermonkey (date)", or an existing scripts collection.
    - When a collection already has that name, the choice shows the
      numbered name the import will give it ("… (2)"), worked out as
      the worker does (`freeCollectionName`).
  - **Use from the backup: Enabled state, Stored values**, both on.
    Without the enabled state, they load enabled, as any install does.
  - A script with a location (an http(s) URL or a file) is installed
    at it, starting from the file's text, and gets updates from there.
    Without one, it is kept as an imported script.
    - A script edited in TM (`user_modified`) is kept as its text: its
      location serves something else.
    - A file is linked only if it can be read at import time, since a
      refresh drops a scripts-collection row whose file is gone. One
      that can't be read uses the backup's copy instead, and the result
      lists those scripts.
- **Existing scripts with changes:** Collection (the installed
  copy's), Name (a link to the installed copy an update goes to, in the
  viewer), Version, Content, Enabled, Type, Values.
  - Rows are grouped by collection, in the page's order.
  - Each attribute column shows the installed copy's value, or
    `installed → backup` where the backup's differs: all the import
    could change, whatever the choices. `∅` means nothing.
    - **Version:** `1.0`, or `1.0 → 2.0 (Newer)` / `(Older)`.
    - **Content:** Same, or a `DIFF` button that opens the compare
      page ([compare.md](compare.md)): the installed copy on the left,
      the backup's on the right ("Import from *file*"), with its
      bundled `@require` files. Same's tooltip lists the copies here.
      Disabled while importing.
    - **Enabled:** `✓` or `☐`, marks rather than checkboxes so they
      don't look clickable, or two with an arrow.
    - **Type:** in a scripts collection, where a new install of the
      backup's copy would load from (`locationChange`): `imported →
      http` for one the backup has an address for, `http → imported`
      for one it has none for (or edited in TM). In other collections
      the collection says where, so it doesn't change.
    - **Values:** blank for none, `✓` when only the installed copy has
      them (the backup has none, so they stay), `∅ → ✓` added,
      `✓ → ∅` removed (the backup's are empty), `✓ (Same)`, or
      `✓ → ✓ (Different)`. The installed values come from the worker
      (`readScriptValues`).
  - The Enabled and Values columns are greyed while their Replace
    option is off. A difference the current choices will apply has a
    light yellow cell: Version, Content and Type when the text is
    replaced, Enabled and Values when their option is on.
  - A row the current choices do nothing to is greyed, with its
    checkbox disabled; it keeps its check for when the choices change.
    Its tooltip says why.
    An unchecked row is greyed too.
  - Which texts to replace:
    - **Keep existing version.**
    - **Replace when the imported version is newer** (the default),
      with how many that is. Greyed out at zero, and Keep chosen
      instead; the default comes back if restoring fewer
      collections raises the count, unless a choice was made.
    - **Replace with imported version always**, even when the text is
      the same, which also brings the backup's dependency files. (A
      script with no changes at all is in the next section and never
      imports.)
    - These replace any script's text. One that loads from a URL or
      file runs the backup's text until its next refresh loads what its
      location has then, as it would after a first import.
  - **Replace from the backup: Enabled state, Stored values**, both
    off. Values are replaced whole, as TM and VM do.
  - Values and enabled state apply to each checked row, whatever the
    text choice.
- **Existing scripts with no changes:** those the same in every column
  (code, type, enabled state, values), which never import.
  - A line, "N existing scripts are exactly the same and will not be
    imported.", and a Show button for their table, hidden by default.
  - The table has the Existing columns, without checkboxes. Values
    shows `✓` without "(Same)", since every row is the same.
- **Invalid scripts:** "These scripts cannot be imported", and a table
  of each one's name (its file, in a zip) and the reason.
- The button counts what will happen: "Import 3 scripts", restored
  and added scripts included. With nothing to do it's greyed, and its
  tooltip says "This import would update zero scripts".
- Afterwards the dialog shows only the results: a line each for the
  collections restored ("Added 1 collection with 2 scripts."), scripts
  added to collections here, and scripts imported and updated
  ("Updated 4 scripts."). After a blank line, the scripts kept as text
  because their files couldn't be read, and what failed.
  - The choices are gone, since there's nothing left to do there. To
    import more, or retry after a failure, open the dialog again.
  - Close or Esc closes it. The page stays where it was.

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
- **Additions** add scripts to a collection here through the same
  path, at their paths (a URL or path it already holds is refused).
- **Updates:** new text rebuilds the script as an install builds it
  (`replaceImportedText`), keeping its id, collection and enabled
  state:
  - One kept as text has its text row rewritten, in the same write as
    its row, so a build that fails leaves the old text.
  - One that loads from a URL or file runs the backup's text. The
    rebuilt row has no modified time or HTTP validators, so its next
    refresh reads the location again rather than skipping it.
  - The last update check's results (`versionProbes`) are dropped, as
    the new text may name other update URLs.
  - `relink` moves one in a scripts collection to the backup's
    location or to an imported location. A file that can't be read now
    leaves it where it loads from (kept as text, for one kept as
    text). A location the collection already holds is refused. Once
    the row is written, the old location's text rows are removed.
  - A check of the script that was fetching while the import moved it
    doesn't write its result, which is for the old location.
  - Enabled state goes through `setScriptsEnabled`; values are
    replaced whole.
- What failed is reported per script; the rest still apply.

## Testing

- Unit: `tests/unit/import-backup.test.mjs` (each format, including an
  SM export written by the export's own planner) and
  `tests/unit/import-plan.test.mjs`.
- E2E: `tests/e2e/import.spec.ts` drives the dialog: an export
  imported after its collection is gone (linked to a file still there,
  kept as text for one that isn't), its collection restored with its
  values and then refreshed, then re-imported to add back a lost
  script, a re-import matched by id, a TM backup
  with a bundled `@require` and then a newer version, a script linked
  to its URL, then its text replaced and moved to an imported
  location, scripts that can't be read, and files that aren't backups.
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
