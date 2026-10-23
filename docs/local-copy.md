# Local copies of a script

Taking any installed script — one loaded from the web, or one already
on disk — and writing an editable copy into a local directory, where
ordinary file-editing workflows change it and SourceMonkey runs the
result.

- Logic and the write: [`src/extension/local-copy.ts`](../src/extension/local-copy.ts)
- Dialog: [`src/extension/copy-dialog.ts`](../src/extension/copy-dialog.ts)
- Button and what follows a copy: `makeLocalCopyControl` in
  [`src/extension/userscript.ts`](../src/extension/userscript.ts)
- Tests: `tests/e2e/local-copy.spec.ts`, `tests/unit/local-copy.test.mjs`

Related: [local-delete.md](local-delete.md) (taking a copy back off
disk), [script-identity.md](script-identity.md) (which copies count as
the same script, the exclusive-enable rule), [file-access.md](file-access.md)
(why we read via `file://`), [local-file-overrides.md](local-file-overrides.md)
(how a file beside a script stands in for its `@require` URL),
[updates.md](updates.md) (the `@downloadURL` probe that keeps a copy
linked to upstream).

## What it does

- **Local copy…** in the viewer's controls row opens a dialog; **Copy**
  writes the script into `<Downloads>/SourceMonkey/` with no further
  dialog.
- That directory is the **Scripts copied in Downloads** collection,
  created by the first copy. The copy is scanned in like any file in a
  directory collection, so an editor's saves are picked up by Refresh.
- The copy becomes the running version: every other copy of the script
  is switched off, and the viewer moves to the copy in place.
- The copy stays *the same script* as its original — `@name` is
  locked — so the "Other versions" panel lists them together.

## Writing files: why `chrome.downloads`

An extension has a few ways to put bytes on disk, and only one fits.

| Mechanism | Writes anywhere? | Do we learn the absolute path? | Dialogs for N files |
|---|---|---|---|
| `chrome.downloads.download`, relative `filename` | Only under the browser's Downloads folder (subdirectories are created; `..` / absolute refused) | **Yes** — `DownloadItem.filename` is absolute on completion | none |
| `chrome.downloads.download`, `saveAs: true` | Anywhere the user navigates | Yes, same way | **N** — one Save As per file |
| FSA `showSaveFilePicker` (what the Log tab's Save uses) | Anywhere | **No** — a handle exposes only its leaf name | N |
| FSA `showDirectoryPicker` → directory handle | Anywhere | No | 1 — every file through the one handle |
| Native-messaging helper binary | Anywhere | Yes | none |

- **We must learn the absolute path**: the copy is registered as a
  script and re-read over `file://` from then on. The File System
  Access API (FSA) never tells us; `chrome.downloads` does.
- **Chrome's own "Webpage, Complete"** (the `foo_files/` layout) is
  browser-internal; no web or extension API triggers it.
  `chrome.pageCapture.saveAsMHTML` yields one MHTML blob. Multi-file
  copies are assembled by us, one download per file.
- So: every file is one `chrome.downloads.download` of a `blob:` URL,
  with `filename` relative to Downloads. Waited on by polling
  `chrome.downloads.search` — `filename` is empty until `complete`.

### Verified against Chrome (headless, in the e2e harness)

- A `.user.js` download is **not** flagged as a dangerous file type;
  `danger` is `safe`. (`acceptDanger` is still called if it ever isn't.)
- `conflictAction: 'overwrite'` replaces in place; the default
  `uniquify` writes `name (1).user.js`.
- **`saveAs: false` does not override Chrome's "Ask where to save each
  file" setting.** With it on, the user sees a Save As box already
  pointed at `Downloads/SourceMonkey/<name>`.
  - Wherever they send the file is what Chrome reports back. A file
    that didn't land under `Downloads/SourceMonkey` is left where it is
    and reported: *The copy was saved to …, outside
    Downloads/SourceMonkey, so it was not added as a script*.
  - Cancelling the box reports *Saving the copy was cancelled*.
- **A copy that fails part-way takes back what it wrote.** The files
  already on disk are removed (`chrome.downloads.removeFile`, plus the
  history entry) before the failure is reported.
  - Not tidiness: an abandoned `.user.js` in the copies directory is
    scanned in as a new script by the next refresh, and a new row lands
    **enabled** — so it would start running a script the user never
    agreed to install.
  - Best effort. A file that can't be removed is logged, not reported:
    the caller already has a failure to show.
- `chrome.downloads` refuses a `filename` with characters illegal on
  any platform (`\ : * ? " < > |`), whatever the OS — see
  [Dependencies](#dependencies-opt-in) for where that bites.

### Where Downloads is

- Chrome exposes no API for it. The first completed copy tells us:
  the absolute path reported, minus the relative name we asked for.
- Stored in **two places with two roles**:
  - the collection's `path` — an ordinary directory collection, scanned
    and refreshed like any other;
  - the `smDownloadsCopies` setting — `{ downloadsDir, collectionId }`,
    the browser's Downloads folder itself plus which collection is
    ours. Shown and editable on the Options page.
- **Only the first copy ever runs write → learn → create.** After that
  the collection is found from the setting; the copy is written and
  the collection refreshed.
- **Every completed copy re-confirms the setting.** A saved path that
  no longer starts with the recorded directory means Chrome's Downloads
  location moved: the setting is updated and a collection at the new
  directory is created (or adopted); the old one stays as an ordinary
  directory collection.
- Never guessed (`~/Downloads`): the discovered path is the only honest
  source, and the first copy gets it for free.

### Identity of the default collection

- The scheme defaults (`container:file` …) are recognized by a fixed
  `path`, never by name. This one can't be: its `path` must be the real
  directory, or the scan has nothing to read.
- So it is found by the **id in the setting**. `displayName` is seeded
  with *Scripts copied in Downloads* and is the user's to edit; a
  rename changes nothing about how it is found.
- **Id no longer resolves** (the user removed the collection) → the
  next copy creates it again at `<downloadsDir>/SourceMonkey` and
  records the new id.
  - `createCollection` dedupes by canonical path, so a collection the
    user added by hand at that directory is **adopted** — its id is
    recorded — rather than doubled.
  - The seeded name is skipped if another collection already wears it
    (the one at a previous Downloads location, say); the path-derived
    name serves. Nothing looks the collection up by name.
- Not a `role` field on the row: the setting already has to exist for
  the path, and one place to look is enough.

## The dialog

Opened by **Local copy…**, in the controls row under the heading,
between **Enabled** and **Refresh**.

- It appears for every installed script, whether or not its collection
  row can be read — the copy is written into the Downloads collection,
  which does not depend on where the script came from. (Move… is on the
  Collection row instead, and only for container scripts, because it is
  about where the script is filed.)
- Disabled only for an `invalid` row, which has no usable header to edit
  and would land invalid in its turn.
- A `missing` row keeps its button: the row still holds the last content
  that loaded, and rescuing that onto disk is a reason to be here. Modelled on the move dialog: it owns the
write, the refusals, and its own error slot; the caller hears only of
a copy that landed.

```
Make a local copy of this script
  Target collection  Scripts copied in Downloads  (/home/me/Downloads/SourceMonkey)
  Filename         [ youtube-downloader.user.js         ]
  (with subdir)
  Dependencies     [ ] Also copy 3 dependency files (212 KB)
                       Local filenames in download collection
                       lib/util.js (already exists)
  Updated headers in downloaded script
  Name             YouTube Downloader                      (read-only)
  Version          13.2 → [ 13.2-local                   ]
  Description      [ …                                    ]  (grows to 4 lines)
  ⚠ Target script file already exists and will be replaced
                                            [Cancel] [Replace]
```

- Every row's label and its control carry the same tooltip, so
  pointing at either answers "what is this?". Two parts say something
  their row doesn't and carry their own: the dependencies checkbox
  (whether anything is written, where the row is about the paths) and
  the Version row's left half (which of the two versions it is, where
  the row names both).
- **Target collection** is a static line: one destination today. Before the
  first copy it reads *(a SourceMonkey directory under Chrome's
  Downloads directory)*; afterwards the collection's current name and
  its actual path.
- **Filename** — labelled *(with subdir)*, since it takes a path — is
  relative to the collection, defaulting to the source's decoded
  basename (made a `.user.js` if it isn't one).
  - Refused, with the reason in the error slot: empty, not `.user.js`,
    absolute or `..`, characters `chrome.downloads` rejects, or deeper
    than `MAX_SCAN_DEPTH` folders — the scan would never find it.
  - **A copy of a copy** defaults to the same name, which is the file
    it is loaded from. That is refused — *The copy source and
    destination are the same. Choose another filename.* — rather than
    silently renamed; the user picks the fork's name.
- The header fields sit under their own heading, **Updated headers in
  downloaded script** — above it is where the copy goes, below it is
  what will differ from the script it came from.
- **Version** is prefilled with the source version plus `-local`
  (`localEditVersion`), and reads `<original> →` beside the box so the
  edit is read against what it replaces. `<none>` on the left when the
  script declares no version — the arrow needs a left-hand side.
- **Description** is prefilled with the source's, in a box that grows
  with its value to four lines and then scrolls: a description is often
  a sentence, and a one-line field hides most of it.
  - It still holds one line of *value*. Enter submits rather than
    inserting a line, and a pasted newline becomes a space — a metadata
    line can hold nothing else.
- **A blank value removes the tag** rather than writing an empty one.
- **`@name` is shown but locked.** It is half of the identity key, so
  changing it would drop the copy out of the "Other versions" panel.
- The open-time reads (the setting, the collections, the file-access
  probe) run after the dialog is on screen; the confirm is off until
  they land. With file access off, the banner from
  [file-access.md](file-access.md) sits above the form and Copy stays
  off — a copy that can be written but never read back would register
  as a broken script.
- Esc is refused while a write is in flight: closing would resolve the
  caller `null` while files are still landing, and the enable sweep and
  navigation would be skipped.

### Existing files at the target

- Checked through the directory listing a refresh uses
  (`statFromListing`), for the script and every dependency, debounced
  behind typing. A listing that can't be read (the folder doesn't
  exist yet) counts as empty — the write creates it.
- An existing file → the confirm reads **Replace**, which passes
  `conflictAction: 'overwrite'`, and the warning line says what kind:
  *Target script file already exists and will be replaced*, *Target
  dependency files already exist and will be replaced*, or both in one
  line.
  - It names no files. A dependency that is there is marked
    *(already exists)* in the list under the checkbox, which already
    names every file — in the warning colour the bottom line uses, not
    the error one: replacing is a choice, not a fault.
- The list shows each dependency's collection-relative path, so a file
  name with a subdirectory in it moves them on screen the way it moves
  them on disk.
- The list and its *Local filenames in download collection* heading are
  dimmed while the box is unticked — what would happen, not what will.
- **An installed script's file is replaceable like any other.** The
  file is what its row is built from, so the refresh that follows the
  write rebuilds that row from the new bytes, keeping its id — the user
  is updating that script in place, and the page lands on it.
- The dependencies are checked whether or not the box is ticked, so
  the marks are always right; only files that will actually be written
  count toward the warning and the Replace button.
- **The last completed check is what is drawn**, never a half-known
  state. Editing the file name leaves the marks, the warning and the
  button's wording exactly as they are, and only disables the confirm
  until the new answer lands — which is often the same answer.
  - Clearing them per keystroke made the whole panel blink.
  - Paths and marks move together for the same reason: a live path
    beside the old answer would claim a file exists somewhere it
    doesn't.
- Never `uniquify` on purpose: a silently renamed file would register
  as a second script the user did not name.
  - Chrome can still uniquify — a file that appeared between the check
    and the write. That is reported as what it is, separately from a
    file the user redirected somewhere else: *Chrome saved the copy as
    `hello (1).user.js` instead of `hello.user.js`, so it was not added
    as a script. Delete that file, or copy again to replace it.*

## What happens on Copy

1. The header is rewritten (below) and the file set built.
2. Each file is downloaded in turn and waited on.
3. The Downloads folder is confirmed from the first saved path; every
   later file must have landed under it too.
4. The page hands over to the service worker, which writes all storage
   ([worker-writes.md](worker-writes.md)): `registerLocalCopy` runs
   steps 4 and 5 there. The page keeps the downloads, which need a blob
   URL the worker lacks. The collection is created, adopted, or found;
   then refreshed, which scans the copy in.
5. The copy's row is **enabled** if it isn't already. Replacing a file
   inherits the row it replaced, and `rebuildCollection` preserves a
   prior `enabled: false` across a refresh — so replacing a copy the
   user had switched off would otherwise land them on a page with
   nothing running and no explanation.
6. **Exclusive enable** (`soloRunningCopy`): the new row is enabled and
   every other running copy is switched off through
   `turnOffOtherCopies`: the "installing counts as enabling" rule in
   [script-identity.md](script-identity.md).
   Only when the new row landed `ok` and its collection is enabled.
7. The viewer moves to the copy **in place** (`swapToScript`); the
   "Other versions" panel re-files with the new row highlighted.

## Header rewriting

- `rewriteHeaderTags` works on the raw metadata block from
  `splitHeaderBody`, line by line: the tag's value is replaced on its
  existing line, keeping the spacing between tag and value; a missing
  tag is inserted after `@name` and aligned to it; an empty value
  removes the line.
  - The block's line endings are kept, CRLF included, so a diff against
    the original shows only the edit. A file using lone `\r` endings —
    classic Mac, which nothing writes today — is normalised to `\n`.
  - Only the first line of a given tag is edited. A header with two
    `@version` lines is malformed; the second would survive.
- Plain `@version` / `@description` only; a localized `@description:de`
  is a different tag and is left alone.
- Everything else is byte for byte — including `@downloadURL` /
  `@updateURL`, deliberately: the version probe uses them, so the copy
  keeps reporting where it stands against the published version.

### The `-local` suffix

- The prefilled version is the source's plus `-local`, so the copy says
  what it is without claiming a release that doesn't exist.
- **Ordering caveat:** `compareVersions` follows the prerelease rule,
  so `13.2-local` sorts *below* `13.2`. Left alone, the upstream probe
  would report the copy as OUTDATED against the very version it was
  copied from.
- `versionRelation` therefore has an **`edited`** verdict: the other
  side has no prerelease tail, the main segments match, and ours is a
  `-local` tail (`isLocalEditVersion`). The details row reads
  `13.2 (Base of this local edit)`; upstream moving to 13.3 still reads
  as `newer`.
- Deliberately narrow — only a `-local` tail qualifies — so a genuine
  `1.0-beta` whose upstream has since shipped `1.0` still reads as
  outdated.
- Always a plain append, with no idempotence check: the fork of a fork
  reads `1.2-local-local`. Ugly, but honest about its distance from the
  release, and the `edited` verdict still holds (`isLocalEditVersion`
  matches any segment ending in `-local`). The field is editable.
- `1.0-beta` becomes `1.0-beta-local`:
  `splitVersion` keys on the first `-` only, so the tail is the single
  segment `beta-local`, which sorts above `beta` and below the `1.0`
  release. That copy reads as *newer* than its source — the ordinary
  "local edit running ahead" case.

## Dependencies (opt-in)

Off by default: a self-contained copy that keeps pointing at the web is
what most edits want. Ticking **Also copy N dependency files** writes
the script's `@require` and `@resource` files beside it.

### Layout: beside the script

- **A relative ref** (`@require lib/util.js`) is written at that same
  path under the copy's folder, which is what it resolves to against
  the copy. One that climbs out of the script's folder (`../x.js`,
  allowed in a script served over http(s)) can't be, and is skipped.
- **An absolute URL** goes to `<script's folder>/<host>/<path>` of
  the declared URL — the *longest* candidate the local-overrides
  suffix rule tries (`localFileCandidates`, with the script's own
  folder as the implicit first root). Built through that same
  function, so the two can't drift.
- So **no `@require` line is rewritten.** Relative refs need nothing
  more, and the copy keeps its published absolute URLs, stays
  portable, and picks up the local files through the existing
  stand-in mechanism; the refreshed row shows `localUrl` on each
  overridden entry.
- Shared libraries dedupe naturally: two scripts in one collection that
  both require the same CDN URL write the same file.
- **Unwritable names fall back to the next-longest suffix.** A
  `host:port` directory carries a `:` Chrome refuses, so a dev-server
  `http://localhost:8080/lib/util.js` is written as `lib/util.js` —
  which the lookup finds too, one candidate down. A basename that
  itself can't be written is skipped.
- A `_files/`-style folder per script (Chrome's layout) would be tidier
  but is invisible to the suffix search; it would need a new
  search-root rule.
- The checkbox is disabled, and says why, when the collection's local
  files option is off or the script declares nothing to copy.

### What gets written

- The bytes the row already holds: `requires[]` (text) and
  `resources[]` (base64) on the `StoredScript`. No refetch — the copy is
  what is running now.
- A dependency already served by a local stand-in is written from that
  stand-in's bytes, which is what the row holds.
- Of the absolute URLs, only http(s) ones: a `data:` one has no file
  to write. `@icon` is not copied.
- Existing-file checks and Replace apply per file, as for the script.

## The link to the original

- `@namespace` + `@name` identity is what the panel and the enable
  sweep key on, and `@downloadURL` keeps the upstream probe working.
- Provenance — which script, at what version and location, the copy
  came from — is not recorded. Directory rows are rebuilt from scan on
  every refresh and only `enabled` survives from the prior row
  (`rebuildCollection`), so a `copiedFrom` field would need an explicit
  carry, and nothing reads it yet.

## Testing

- `tests/e2e/local-copy.spec.ts` runs under `testWithBrowserDownloads`
  (see [testing.md](testing.md#fixtures)): Playwright's default
  download interception renames every download to a GUID in its own
  artifacts directory, which hides exactly the path this feature reads
  back. The variant hands download handling back to Chrome over CDP and
  points it at a temp directory through the `download.*` Preferences.
- `tests/unit/local-copy.test.mjs` covers the pure parts: name
  validation and defaults, header rewriting, the mirror layout, the
  file plan, the setting, and finding the collection.

## What's next

- **Other destinations.** The dialog's static *Target collection* line
  becomes the Install / Move dropdown with directory collections added.
  - Silent when the destination is under Downloads; otherwise one
    `showDirectoryPicker`, with every file written through the handle.
  - FSA's missing path is recoverable by reading each expected path
    back over `file://` and comparing hashes — we always know where the
    files are *supposed* to go.
  - Individual-file collections with a typed absolute path, and *New
    collection…* with `createPurpose: 'copy'`, come with it.
- **Remembering a directory handle** per collection in IndexedDB, so
  later copies need at most a small allow prompt. Whether Chrome's
  persistent FSA permissions apply to extension origins is unverified;
  [file-access.md](file-access.md) recorded that grants did not persist.
- **Provenance** (`copiedFrom: { fileUrl, version, contentHash }`),
  once a diff feature wants "the original as it was when I copied it".
- **Copying `@icon`** beside the script.
- **Copy from the install preview**, before installing at all.
- **Diffing copies**; pushing an edited copy back to its source.
