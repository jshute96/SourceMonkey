# Deleting a local copy

Deleting a [local copy](local-copy.md) from disk: the script file, and
the dependency files beside it that nothing else is using.

- Logic and the deletion: [`src/local-delete.ts`](../src/local-delete.ts)
- Dialog: [`src/delete-dialog.ts`](../src/delete-dialog.ts)
- Trash cans: `makeDeleteCopyControl` and the panel's `remove` action in
  [`src/userscript.ts`](../src/userscript.ts), `makeDeleteCopyButton` in
  [`src/collections.ts`](../src/collections.ts), `removeCell` in
  [`src/related-versions.ts`](../src/related-versions.ts)
- Tests: `tests/e2e/local-delete.spec.ts`, `tests/unit/local-delete.test.mjs`

Related: [local-copy.md](local-copy.md) (how the files got there),
[local-file-overrides.md](local-file-overrides.md) (why a dependency
file beside a script is used at all).

## What it does

- A 🗑 appears on a script whose file is in the copies directory — on
  the viewer's Collection row beside **Local copy…**, on its row in the
  "Other versions" panel, and on its row on the collections page. All
  three open the one dialog.
  - The panel's button is normally dead for a script that came in with
    a directory collection, because the collection's next scan would
    bring the row straight back. Deleting the file is what stops it, so
    a copy's row gets a live button and a tooltip that says what it
    does.
- **Delete local script file** names the file, its full path, and every
  dependency file the copy is loading from the collection's directory,
  under a heading per outcome.
- **Delete** removes the files from disk, then removes the script's
  record, the way every other trash can in the UI does.

## Only files the browser downloaded

An extension cannot delete an arbitrary file. `chrome.downloads.removeFile`
deletes one the browser itself saved, named by its absolute path in the
download history — so the copies directory, and nothing else, is
deletable.

- `chrome.downloads.search({ filename, state, exists })` is an exact
  match on the absolute path. The record persists until the user clears
  browsing data, so it is not limited to copies made this session.
- **`exists: true` is part of the query, not a detail.** Chrome refuses
  `removeFile` with *Download file already deleted* for a record it has
  marked gone, and that mark is sticky — Chrome's own existence checks
  set it, so a copy saved by an editor that writes to a temp file and
  renames can carry it while the file is sitting right there. Filtering
  on it means the dialog's lists and the deletion agree.
- **Erasing is best effort.** A record that survives its file leaves a
  downloads-list row pointing at nothing. Logged, not reported: the
  deletion the user asked for has happened.
- **A record is never erased unless the file went.** The record is the
  only handle there is on that file; erasing one we failed to delete
  with would leave the file on disk and take away the only way of ever
  removing it.
- `removeFile` deletes the bytes; `erase` then drops the history row,
  which would otherwise sit in the downloads list pointing at a file
  that is gone.
- One path can carry several records — every Replace adds one. The
  newest is tried first, the rest are erased; only when every record
  refuses is the deletion reported as failed.
- **No download record → nothing we can do.** The user cleared their
  downloads, or the file arrived some other way.

### Asked before Delete, not after

`trackedFiles` runs with the dialog's other open-time reads, so which
files are deletable is on screen before anything is pressed.

- **The script's own file has no usable record** → Delete is off, and
  the blocking message takes the slot the warning would use: *Script
  file is no longer in Chrome download history, so SourceMonkey cannot
  delete it.* It names no path — the file and its full path are two
  rows above it. The dependency lists still say what would have
  happened.
- **A dependency has no record** → it lands under the third heading and
  is left alone. Its being unreachable is no reason to refuse the
  deletion the user asked for.
- The answer can still go stale between the read and the click. That
  failure is reported in the error slot and nothing else is touched.

### Not (yet) the overwrite trick

A file with no download record could be *replaced* — download a
one-line "this script was deleted by SourceMonkey" file over it with
`conflictAction: 'overwrite'`, then delete the download we just made.

Deliberately not done yet:

- It destroys the file's content before it can fail, and the failure
  mode leaves an unusable script on disk where a real one was.
- Chrome's *Ask where to save each file* setting turns it into a Save As
  box per file, pointed at a path we are trying to erase.
- It writes to a path we believe is the file's — if Chrome's Downloads
  location has moved since the copy was made, that belief is wrong.

Tracked in TODO.md. A one-line comment, rather than zero bytes, is the
form it should take: an empty `.user.js` reads as a broken script, where
a comment says who removed it.

## Which scripts offer it

Two things have to be true (`deletableCopyPath`), and the second is
what the rest of this feature rests on:

- The file sits under `<Downloads>/SourceMonkey/`, so Chrome downloaded
  it and `removeFile` can be asked about it.
- **The row's collection IS the directory collection at that
  directory.** Compared by path, so it doesn't matter whether that
  collection was created by the first copy or adopted from one the user
  had already added there.

Why the second: a file in a directory collection is shared only within
that collection, so its scripts are the whole set that could be reading
it — which is what lets `copyDeletePlan` answer *does anything else
need this?* from one collection's rows.

- **A row filed anywhere else is refused**, even when its file is in
  that directory — an individual script the user added by hand at that
  path, say. Its collection's scripts are the wrong set to ask, so a
  library another copy is loading could be classified as this script's
  alone and deleted. Individual-file rows, overlapping directory
  collections and manifests all break the assumption the same way; none
  is worth the mess (TODO.md).
- The check is re-run when the dialog opens, not trusted from the
  button that opened it: the row can move or go missing in between.
- A `missing` row is refused — its file has already gone, and the
  ordinary trash can that clears the record is what that row wants.
  - Deleting every copy in the directory by hand is how a row gets
    there: an empty scan can't be told apart from an unreadable
    directory, so `rebuildCollection` keeps the rows and marks them
    missing.
  - The collections page repaints rows in place, so its action cell is
    reconciled on every sync (`syncScriptRow`). Left alone, a row that
    had just gone missing kept its file-delete button beside the
    record-delete one the status cell had grown.
- **POSIX paths only.** `locationFsPath` mangles a Windows `file:///C:/…`
  URL, so the path comparison never matches and no row offers a
  deletion — the same assumption the rest of `directories.ts` makes,
  failing in the safe direction.
- The setting is read once per page render and consulted synchronously
  while rows are drawn. Before the first copy ever there is no setting,
  and no row offers a deletion.
- **The answer is not checked against the download history up front.**
  One `chrome.downloads.search` per painted row, for an answer that can
  go stale anyway; the deletion itself is where it is settled.

## Dependency files

The files listed are the ones the script is **loading now** — each
`@require` / `@resource` entry's `localUrl`, which is what the load
pipeline actually read, filtered to paths under the copies directory.
Not a re-derivation of what the copy once wrote, so a file the user
renamed or removed by hand isn't offered.

### Headings, not a checkbox

What happens to a dependency follows from two facts the dialog can
state, so there is nothing to put to the user:

- **Files used by this script only** — deleted with it. Nothing else is
  reading them.
- **Not deleting files also used by other scripts** — a dependency can
  be shared: two copies that `@require` the same URL write, and then
  read, one file. Deleting it would break a script the user wasn't
  asked about.
- **Not deleting files no longer in Chrome download history** — the
  browser can't be asked to remove them (below). Left on disk and said
  so, rather than blocking the deletion that was asked for.

Each heading is hidden when nothing is filed under it, and the whole
row with it.

### Details

- **The scripts keeping a shared file alive are not named.** A
  userscript `@name` is long and there can be several; the heading says
  the fact that matters.
- Only the collection's own scripts are consulted, which is exactly the
  set that can be reading these files: a stand-in is searched for under
  the script's own folder and its collection root, so a file in the
  copies directory is invisible to a script outside that collection —
  and a row outside it can't reach this dialog at all (above).
- **Empty directories are left behind.** `removeFile` deletes files;
  nothing in the extension removes a directory. Deleting
  `cdn.example.com/lib/util.js` leaves the folders it sat in.

## Order and failure

1. The **script file first** — it is what the user asked for. A failure
   here stops everything: the dependencies stay, and the dialog stays
   open with the reason in its error slot.
2. Then each dependency under the first heading. A failure here is reported but does not
   undo anything: the script is gone, which is what was asked, and a
   leftover library file is a smaller problem than a half-deleted state.
   The caller shows those messages beside "This script has been removed".
3. Then `removeScript`, which takes the row and its logs.

### Why not a refresh

A refresh would be the tidier story — the scan no longer finds the file,
which is exactly what `rebuildCollection` handles for a file deleted in
a file manager. It is wrong here for one case: a directory the deletion
leaves **empty** hits the empty-scan guard, which marks its rows
`missing` rather than dropping them, so an unreadable directory can't
wipe a collection. Deleting your only copy would leave a MISSING row
behind. We know why this file went, so the record goes with it.

## What's next

- The overwrite trick above, for a copy with no download record.
- **Deleting a shared file once nothing needs it.** The split is made
  per script, so a file two copies share stays while either of them
  does — and the one deleted last takes it, since by then no sibling
  claims it. Cleaning up between those two points needs a sweep of the
  collection, not a per-script plan.
- Removing directories left empty by a deletion, if the extension ever
  gains a write path that can.
