# Script identity and other versions

How SourceMonkey decides that two installed rows are *the same script*,
and what the UI does with that.

- Lookup: [`src/script-identity.ts`](../src/script-identity.ts)
- Panel: [`src/related-versions.ts`](../src/related-versions.ts)

## Three separate notions, deliberately

- **Record identity** — the stored row's UUID. Ours alone. Minted by
  `crypto.randomUUID()`, kept stable across refreshes by looking the
  row up by `relativePath` (see [storage.md](storage.md)). Nothing in
  this doc changes it.
- **Same URL** — the canonicalized absolute location matches. Literally
  the same bytes.
- **Same identity** — `@namespace` + `@name` match. The userscript
  ecosystem's conventional unique ID.

A script can be all three at once, or only one.

## Same URL

- Key: `canonicalCollectionInput(script.fileUrl)`.
- **`fileUrl`, not `relativePath`.** A script inside a directory,
  manifest, or repo collection stores a path relative to its collection root.
  That shares no text with the full URL the same script carries when
  installed standalone, so comparing `relativePath` can never match a
  collection copy against a single-file copy.
- `fileUrl` is the absolute form the load pipeline already builds for
  every collection kind — `scriptFileUrl` in
  [`src/directories.ts`](../src/directories.ts) resolves manifest
  entries against the manifest URL, joins directory entries onto the
  collection root, and maps GitHub dirs to raw URLs.
- `canonicalCollectionInput` collapses a `file://` URL to its bare path, so
  a directory collection's `file://` URL and a container row's bare path
  land on the same key.

### Display is unaffected

- A collection copy still **shows** its relative path — that is the
  name the user recognizes from the collection's own listing.
- Only the comparison uses the absolute form. The row's tooltip carries
  it, per [names-and-paths.md](names-and-paths.md).

## Same identity

- Key: `@namespace` + `@name`, trimmed, joined by a NUL, spelled `\u0000`.
- This is the convention, not our invention:
  - Greasemonkey documents `@namespace` as the value that, combined
    with the name, forms a unique identifier.
  - Violentmonkey derives an internal `uri` from the pair —
    `<namespace>\n<name>\n` with a custom `-<hex>` escape (not
    percent-encoding), and it appends its own generated id when both
    parts are empty (`getNameURI`, `src/background/utils/script.js`).
  - Tampermonkey mints a UUID per installed entry, but decides
    install-vs-update on the pair. `docs/cross-manager-testing.md`
    relies on exactly this to find existing TM scripts.

### Rules and their reasons

- **No `@name` → no identity match.** With nothing to key on we decline
  rather than fold every nameless script together.
- **A missing `@namespace` is the empty namespace, not a decline.** Two
  scripts that both omit it and share a name are treated as the same
  script. That is the convention's known weak spot; diverging from it
  unilaterally would make our answer differ from the one the user sees
  in Tampermonkey.
- **Exact comparison after trimming.** No case folding, no URL
  normalization of the namespace — for the same reason.
- **The separator is spelled as the escape `'\u0000'`, never as a literal NUL byte.**
  A raw NUL makes `grep` treat the whole source file as binary and
  print nothing for every match in it.

## `findRelatedVersions`

Returns three things.

- **`sameLocation`** — rows at this URL.
- **`sameIdentity`** — rows that are this script but somewhere else.
  **Disjoint** from `sameLocation`: a row matching both is listed once,
  under location, the stronger claim. Its `sameIdentity` flag still
  reports the second relationship.
- **`installOptions`** — the entries of the install page's dropdown,
  present only when the location is a single-file input:
  - the built-in default for the location's scheme first, then every
    other container in page order — see
    [The "Install into" dropdown](#the-install-into-dropdown);
  - each marked `installed` when a `sameLocation` row already sits in
    it;
  - `collection: null` on the default means it does not exist yet.

Both lists sort by collection display name, then location, so the panel is
stable across renders.

## The panel

One table shape, both pages. What differs is only which actions each
row offers, which the caller supplies as callbacks.

| | Details page | Preview |
|---|---|---|
| Heading | Other versions of this script | none — the banner line above the table is the heading |
| Current row | highlighted, **(this page)**, not a link | — |
| Nothing installed anywhere | can't happen — its own row is always there | no panel at all |

Sections: **This URL**, then **Same script from a different URL** with
a normal-weight gloss naming the match.

The panel sits at the top of the page, under the title and above the
controls row — which copy you are looking at comes before anything that
acts on it. Green card rather than the grey of the details panel
further down: this is the one carrying live controls, so it has to read
as a different kind of thing at a glance. On a preview whose script is
already installed, the panel and the "already installed" banner are
drawn as one box.

On the details page, clicking a row anywhere that isn't a control opens
that copy **in place**: new history entry, same table. The row is the
control — `role="link"` and `tabindex="0"` with Enter / Space, and
Ctrl/Cmd- or middle-click for a new tab. The panel is
anchored to the script the page was opened with, so selecting a copy
moves only the highlight and never re-files the rows; the controls-row
toggle keeps sweeping from the copy on **screen**. See
[script-viewer.md](script-viewer.md#switching-copies-in-place).

### Enabling is exclusive; disabling is not

The rule applies to **every** enable checkbox the viewer shows: each
panel row, on the details page and the preview alike, and the
controls-row toggle at the top of the details page. `enableChanges` +
`otherRunningCopies` are shared by all of them, so they cannot drift.
The controls-row toggle has no table around it to read the copies from,
so it runs its own lookup; if that read fails it still writes the copy
the user clicked rather than blocking on something it needs only for
the *other* rows.

- **Clicking an unchecked box enables that copy and disables every
  other copy that is running** — across both sections, since the point
  is that one copy of this script runs, not one per section. Two
  enabled copies at one URL both register and both run, which is almost
  never wanted.
- **Clicking a checked box just disables it.** That leaves none running,
  which is an ordinary thing to want, and there is no other copy that
  should be promoted in its place.
- **Installing counts as enabling.** A fresh install lands enabled, so
  it sweeps the other running copies off on its way to the new script's
  page.
  - Both Install controls do it — the preview's header button and the
    panel's offer row.
  - And so does the collections page's **Add** field, which previews any
    single-file location the user types rather than adding it directly.
    (First-run seeding bypasses the preview, so it never sweeps.)
  - **Single-file installs only.** The preview keeps an Install button
    for other shapes too, and those add a whole collection — no one
    script for the rule to be about.
  - **Only when the new copy will actually run.** It must have landed
    `ok` — a row stored `invalid` can't run — and its container
    collection must be enabled. Switching a working copy off in favour
    of one that can't run would leave nothing running at all.
  - **A duplicate Install doesn't sweep.** Nothing new landed, so
    nothing was enabled; the message says the script is already
    installed and the panel in the same box is where to choose between
    copies.
  - **Fails open, and never blocks the navigation.** A sweep that
    can't run — or whose write fails — is not reported: the install
    itself succeeded, and the panel on the page it lands on shows the
    real enable state.
  - No ctrl/cmd opt-out here: the modifier belongs to the checkboxes,
    where the sweep is the whole effect of the click. Two copies that
    really are meant to run together are one checkbox away on the page
    Install lands on.
- **A copy under a disabled collection is spared.** It isn't running, so it
  isn't competing — and its own checkbox is rendered disabled, so a
  flip made here could not be undone from this panel at all. Turning it
  off would silently destroy the user's stored intent for whenever they
  re-enable that collection.
- **Ctrl/Cmd-click opts out** and toggles only that box, for the rare
  case where two copies really are meant to run together (say, two
  `@match`-disjoint edits of one script). Read from the `click` event,
  not `change`, which carries no modifier state; keyboard activation
  fires a click too, with the modifier simply false.
- The action takes the whole list of changes at once, so the caller
  applies them as one batch and one rejection reverts the clicked box.
- **The panel repaints after the write, on success as well as failure.**
  Each row's handler closes over the row list as it was drawn, so
  without it the *second* click would compute "the others" from
  pre-first-click data and sweep nothing — two enabled copies, the
  exact state the rule exists to prevent. Leaving it to
  `storage.onChanged` is not enough: a preview has no such listener,
  and a batch that turns out to be a no-op writes nothing and fires no
  event.
- **The whole batch is one write.** `setScriptsEnabled`, not a loop of
  `setScriptEnabled`: the bulk call lands as a single
  `chrome.storage.local.set` and fires one `storage.onChanged`. A loop
  fired one per copy, and each one rehydrated the viewer from a
  half-applied state — the Enabled checkbox visibly flipped back and
  forth as the batch went through. It also spares the background worker
  a registration sync per copy.
- **The whole batch paints before the write.** The browser flips the
  box that was clicked; `paintEnabledOptimistically` catches up the
  rest — the other rows and the page's own toggle — in the same task.
  A radio-button pair that flips one box now and its partner after a
  round trip through storage reads as a bug. Purely cosmetic: nothing
  reads it back, and the repaint that follows draws from stored state,
  so a failed write corrects itself.
- **One tooltip, both surfaces**: *Enable this script*, the same pair
  the collections page uses (with *Collection is disabled* when the
  parent is off). Both are single constants — `ENABLE_TITLE` in
  `src/script-display.ts` and `COLLECTION_OFF_TITLE` in
  `src/collection-display.ts` — so no surface can drift. It does not
  name the copy — the Collection and Location cells are an inch to the
  right — and it does not swap to "Disable" when checked, which would
  make one control read two ways for no gain.
  - *(Ctrl-click for multi-enable)* is appended only where the sweep
    can actually fire. It matters most on the controls-row toggle,
    whose effect on other copies is otherwise invisible from where it
    sits, so `paintRelatedVersions` adds it once the lookup it needs
    has run.
  - **The app names one key, the one this machine has** — *Cmd* on a
    Mac, where ctrl-click opens the context menu and the handler takes
    `metaKey` instead. These docs write "Ctrl/Cmd" because they
    describe every platform at once; a message on screen would be
    telling half its readers about a key their keyboard doesn't have.
  - **The accessible name carries what the tooltip drops.** A panel
    row's checkbox is the only content of its cell, so it has no name
    from markup at all, and rows all announcing "Enable this script"
    would be indistinguishable — where a sighted user simply reads
    across to the Collection cell.

### Which actions each section gets

- **A refetch button on every `sameLocation` row** — they all load from
  the same place, so it means the same thing on all of them, the
  current script's own row included. That duplicates the control at the
  top of the page, which is fine: a table where one row lacks the
  control its neighbours have reads as though that row could not be
  refreshed.
- **The label follows the page**, because the call is the same one the
  page's own control makes (`updateScript(id, 'manual', 'force')`):
  **Refresh** / **Refresh all** in the viewer, **Update** / **Update
  all** in a preview. A third name would read as a third operation.
- **The …all button** sits in the header row's actions column, and
  appears only when more than one row is refreshable. Same call as a
  single row's, with every id.
- **No refetch on a `sameIdentity` row.** It would pull that row's own,
  different upstream — a reasonable thing to want, but not "bring this
  up to date with what you are looking at", and offering it here would
  read as though it were.
- **Install**, only on the offer row — with the dropdown that picks
  where — and only when the caller passes an `install` action. Two
  callers decline:
  - the **installed page**, where an Install would add a second row for
    a file already installed, and two enabled rows at one URL inject
    the script twice;
  - an **invalid preview**, which has already said the file cannot be
    installed and hidden its own Install button.
- **A trash can on every row**, in its own column right of the refetch
  button — same glyph and behaviour as the collections page's per-script
  remove.
  - **Live only for scripts in a container collection** (a scripts
    collection — the built-in *Scripts from …* defaults or one the user
    made), which the user installed one at a time.
  - **Disabled elsewhere**, with the tooltip *Script from **directory**
    collection can only be removed by removing the collection* — or
    ***manifest** collection*, per `collectionHasManifest`.
    - These docs call the whole family "collection collections", but that
      phrase appears nowhere a user can see it, and this message is the
      first that needed a name for them. *Directory* and *manifest* are
      the words the collections page already uses for how a collection was
      added, so they are the ones a user can act on. A GitHub repo or
      `/tree/` collection is a directory of scripts too, and reads that way.
    - Shown-but-disabled rather than hidden: a ragged column would give
      no clue why some rows can be removed and others can't. Removing
      such a copy wouldn't stick anyway — the collection's next refresh
      scans it straight back in.
  - **A row whose collection dangles gets the live button.** An orphan is
    the thing a user would most want to clear out, and nothing will
    scan it back in.
  - **Removing the row you are looking at is allowed.** Refusing only
    where the user happens to be standing would be arbitrary. The viewer
    then reports "This script has been removed" rather than its generic
    not-found message, and clears the panel along with the rest of the
    page — its heading has nothing left to be *other than*.
    - The removed state is driven from the action, not left to the
      storage listener: `removeScript` writes nothing when the row was
      already gone, so there may be no event to wait for.
    - The flag behind that wording is cleared by `render`, not on read.
      The path can run twice for one removal (our call, then the
      event), and the second pass must not downgrade the message; once
      a script is on screen again, a later disappearance is someone
      else's doing.

### Keeping the page around the panel in step

- **The installed viewer needs nothing.** Its `storage.onChanged`
  listener rehydrates the whole page after any panel action.
- **A preview has no such listener** — it returns early without a
  `scriptId` — so its banner and buttons would keep whatever the
  load-time wiring left them with. After every panel action that
  changed storage, the preview re-runs `wireInstallButtons`.
  - Without it, removing the copy a preview offers to update leaves the
    banner claiming it is still installed, Open and Update pointed at
    an id that no longer exists, and Install still hidden — precisely
    when Install is what the user now wants.
  - `wireInstallButtons` therefore resets every button it owns before
    deciding, rather than only ever revealing them.
  - **Not on an invalid preview**, which has deliberately hidden those
    buttons; re-running the wiring would put them back on a file the
    page has said cannot be installed.

### A repaint waits for an open dropdown

The panel rebuilds by `replaceChildren`, and the offer row's "Install
into" control is a native `<select>` whose popup is drawn by the browser
and dies with the element.

- **The hazard**: a `storage.session` write — the injector's rejection
  map, or any drawn copy's log level — repaints the panel. If that
  lands while the popup is open, the popup closes and the mouseup that
  was going to pick an entry falls on whatever the rebuild put there.
  It reads as the dropdown choosing something by itself.
- **The rule**: an *echo-driven* repaint is held (`panelPaintDeferred`)
  while a `<select>` inside the panel has focus. Focus is the only
  signal the platform offers — there is no "is the popup showing" API —
  so it errs wide: a select merely tabbed to also defers.
- **Flushed on `change` or `focusout`.** Both, because picking an entry
  closes the popup but leaves the select focused, so a `focusout`-only
  flush could sit pending until the user happened to click elsewhere. A
  `change` proves the popup closed, so it flushes without re-checking
  focus.
- **The flush repaints from `lastRelatedPaint`**, not from args captured
  when it deferred — otherwise a paint that landed in between could be
  overwritten with older state.
- **A panel action still repaints immediately.** The user asked for it,
  and by then the click that opened the popup has been spent on the
  button that ran the action.
- Same principle as the collections page's busy affordances: a repaint
  nobody asked for waits for the control being used.

### Failures

- The panel reports its own action failures **inside itself**, not in
  the page's `#message` bar. That bar is rewritten from the current
  script's stored state on every `storage.onChanged` repaint, and a
  refresh is exactly what triggers one — a message about another copy
  would be painted and wiped in the same breath.
- A multi-copy refresh keeps going past a failure and names every copy
  that failed. Aborting on the first would silently leave the rest
  untouched after the user asked for all of them.
- **An exclusive toggle is a batch, and reports the same way.** A
  half-applied one leaves two copies enabled, so the message names
  which write failed and in which direction. The panel repaints from
  stored state before rejecting — a better answer than the renderer's
  own revert of the single box that was clicked.

### Accessibility

- Each row's checkbox is the only content of its cell, so it carries an
  `aria-label` naming the copy — five rows of "Enable this script"
  would be indistinguishable. See the tooltip note above for the split
  between what the tooltip says and what the accessible name adds.
- A row whose **collection** is disabled greys out and says so, matching
  the viewer's own toggle. The box still shows the script's own stored
  flag; the collection override is carried by the disabled state and label.
- The current row gets `aria-current`, because the `(this page)` marker
  is in the Location cell, which reads as decoration rather than state.

### Suppression

A panel whose only row is the script already on screen says nothing the
rest of the page doesn't, so it renders empty and the `:empty` rule
hides it.

### Row layout

- Columns: enable toggle, collection, location, status, version,
  actions, remove.
- **Collection cell leads with the type bubble**, then the name — the same
  order as the details panel's Collection row and the collections page's
  headings. The bubble is fixed-width and the name is the variable
  part, so leading with it also keeps rows aligned down the left edge.
- **Location** shows the row's own stored `relativePath` (relative for a
  collection copy), decoded for reading.
  - **Plain text on the details page** — the row already opens the copy,
    so a link inside it would offer the same destination twice. A
    preview keeps the link: its rows are not clickable.
  - **Tooltip: the full resolved location** — the collection root
    spliced back on, a github row's `blob` page URL, or the literal
    percent-encoded URL behind a decoded display. Omitted when that is
    the string already in the cell.
- **Status** is the same verdict the collections list and the viewer's
  own Status row show. `scriptStatusView` in `script-display.ts`
  computes label and hover text for all three.
  - Titled only where the verdict has more to say, so a cell can't
    carry an explanation the identical verdict in the details panel
    lacks.
  - **Links to that copy's Log tab**, which makes the panel a route to
    each copy's diagnostics rather than only a report on them.
  - **Every row links, OK ones included.** "Why is it OK" is the same
    pane as "why is it ERROR", and a column where only broken rows
    respond teaches the user to stop clicking.
  - **No `target="_blank"`**, unlike the collections page's status
    cell. That page is a list you come back to; this panel is already
    inside the viewer, a tab away from the Log.
  - **Coloured**, unlike the controls row's status link, which inherits
    its colour to read as one line of text. Down a column the colour is
    what finds the broken copy among five.
  - **Live for every row it draws**, on the preview as well as the
    viewer — that listener branch runs before the installed-script
    gate. A sibling that starts erroring while you sit here says so.
    - Repaints on a `loglevel:` write for a **drawn** id, or on any
      write to the shared rejection map. A dozen unrelated scripts
      failing on some page must not rebuild this table a dozen times.
  - **The offer row has no status**, and nor does a row whose lookup
    failed: both show an em dash. Absent is not the same claim as OK.
    - A failed lookup empties the whole column, including the row for
      the script whose own Status row still reads normally —
      that row's verdict comes from a separate read. The alternative,
      one column reading from two sources, is worse.

### Layout

- Two `<table>`s, not one, but a shared `<colgroup>` plus
  `table-layout: fixed` pins their columns to the same widths — without
  it each table sizes its own and the panel reads as two unrelated
  grids.
- **Status does not shed** either: it says whether a copy works, and
  its link is the only route from here to that copy's log.
- **Status, Version, and the actions column are measured, not
  guessed.** `fitColumns` sizes each to its own widest cell across both
  tables and writes the result to the panel as custom properties;
  Location absorbs everything left over.
  - Under `table-layout: fixed` a column cannot shrink to its content,
    so a fixed width has to cover the worst case (`REFRESH FAILED`, a
    date-shaped `2026.08.19`) — which left a short `1.2.0` stranded a
    column's breadth from the button beside it.
  - Measured by switching the tables to `auto` layout at `max-content`
    width, with the `<col>` widths taken off (under `auto` they are
    still honoured, so leaving them on measures the guess). Restored in
    the same task, so no frame paints mid-measurement.
  - Custom properties rather than inline `<col>` widths, which would
    beat the narrow-window rule that zeroes Version.
  - The stylesheet's widths remain as fallbacks, for the first paint
    and for a panel measured while hidden (which reports zero).
- Narrow windows shed **Version** below 640px rather than wrapping
  every cell to a ribbon. It is the least load-bearing: nothing acts on
  it, and the copies it distinguishes are still told apart by collection
  and location. Zeroing the `<col>` width alongside `display: none` on
  the cells is what reclaims the space — under `table-layout: fixed`
  the colgroup, not the cells, sets column width.
- **Location does not shed**, though it used to below 460px. It is what
  tells two copies apart, and on a preview it carries the only link to
  another copy's page — that preview having dropped its header Open
  button in favour of this table when there are several targets.
  Wrapping a long path is the lesser cost.

## The "Install into" dropdown

Where a single-file install lands is the user's choice, made in one
dropdown that appears in two places: the install callout (nothing
installed yet) and the panel's offer row (some copy exists). Built by
`buildInstallSelect` in `src/related-versions.ts` from `installOptions`.

- **Three groups**, separated by rules:
  1. the **built-in default** for the script's scheme — `Scripts from
     web` / `…GitHub` / `…local disk` — matched by its stored path
     (`container:http` etc.), never by name. Listed as-is if it
     exists, as *… (new)* if not; the install creates it;
  2. every other scripts collection, in page order (including the
     other two defaults, if they exist);
  3. **New collection…**, which is an ordinary entry: picking it only
     selects it. The collection dialog opens when **Install** is
     clicked, with no location on offer (only a scripts collection
     can take an individually installed script), titled *Create new
     collection and install script* with a **Create and install**
     button — so the dialog's confirm doesn't quietly install too.
     Cancelling it installs nothing and leaves the page as it was.
     - Why not on selection: Chrome fires `change` on every arrow key
       over a *closed* select, so a keyboard user cursoring past the
       entry would get a modal without asking for one.
- **Already holds this script** → the entry is disabled and marked
  *(already installed)*.
- **Switched off** → marked *(disabled)*, but still selectable: a
  script installed there won't run, and the user may be about to turn
  the collection back on. At most one suffix per entry, in the order
  *(already installed)* → *(new)* → *(disabled)* — a move's list adds
  *(current)* ahead of all three, see below.
- **The first entry is pre-selected** for an install (a move opens on
  its *(current)* entry instead), even when disabled;
  Install is then disabled until the user picks another entry, and the
  offer row's Location cell says why. Installing a second copy is never
  the one-click path.
- On a fresh profile the list is just *Scripts from web (new)* and
  *New collection…*. No default is created up-front — only by an
  install that targets it.
- Directory / manifest collections never appear: a script can't be put
  into one.

### The opening click never picks

Both dropdowns (and the move dialog's) run through
`guardSelectOpeningClick` in `src/select-open-guard.ts`, which opens the
list on the mouse *release* instead of the press.

- **The hazard**: the popup is drawn by Chrome, and when the list
  doesn't fit below the closed control — bottom of the screen, short
  window, long list — Chrome shifts it up over the control. That puts
  an entry under the pointer that just pressed, and Chrome's
  press-drag-release gesture makes the release of that same click
  commit it. The dropdown appears to open, pick at random, and close,
  with the list never seen.
- **Why the page has to handle it**: the popup is a browser widget, not
  DOM. Nothing tells us it opened, we can't place it, and the gesture
  has no opt-out.
- **The rule**: `mousedown` is cancelled — which is what stops Chrome
  opening the popup, and takes the focus it would have given, so focus
  is set by hand — and the `click` that press produces calls
  `showPicker()`. Same list, opened with the mouse already up, so
  nothing is committed until the user presses on an entry deliberately.
- **Only that click opens it**, tracked by a flag rather than judged
  from the click itself. Clicks arrive with no cancelled press behind
  them — Enter or Space on a focused select, the install page's `for=`
  label, a programmatic `click()` — and each would otherwise open a
  list nobody asked for, or fight one Chrome had opened already.
- **What it costs**: press-drag-release no longer picks. That is the
  gesture the bug rides on; press, release, click the entry still
  works, and keyboard use never touches this code.
- **Not undo-after-the-fact.** Letting the stray pick land and
  reverting it was tried first: the list is torn down and re-opened
  under the cursor, which reads as a flash over the whole popup on
  every click.
- If `showPicker` is missing (Chrome 120, one below where it landed)
  or ever refuses, the takeover switches itself off and the browser's
  press-to-open stands — bug and all, but a control that opens beats
  one that can't. A refusal costs the click that discovered it, whose
  press was already cancelled; the next one opens natively.

### The same dropdown, for a move

The viewer's move dialog (see
[script-viewer.md](script-viewer.md#moving-to-another-collection))
builds the same list through `installOptionsFor`, with one addition:
`current` marks the collection the script is in now.

- **The current collection is listed, not hidden** — marked
  *(current)*, disabled, and pre-selected. Two things follow: every
  script's list has the same shape and ordering regardless of where it
  lives, and the dialog opens on somewhere the script already is, so
  nothing moves without a deliberate pick. Move is greyed until one is
  made.
- Entries that already hold this location stay listed and disabled,
  marked *(already installed)*, exactly as for an install.
- Suffix order is *(current)* → *(already installed)* → *(new)* →
  *(disabled)*, at most one per entry.
- **New collection…** works the same way, and for the same reason
  (`change` fires on arrow keys over a closed select): picking it only
  selects. Selecting it renames the dialog's confirm button to
  **Create and move**, since that entry creates before it moves; the
  collection dialog then opens on click, titled *Create new collection
  and move script*.

## What the header offers

Every decision comes from `sameLocation` / `sameIdentity` /
`installOptions`; the header is passed too, but only the banner reads
what it adds.

| What exists | Banner | Header | Table |
|---|---|---|---|
| Nothing, anywhere | none | the **install callout**: *Install into [dropdown]* + Install | none |
| Any copy, here or from a mirror | one line: ***This script is already installed.*** *Select which instance to update or install.* | Cancel, View raw source | every copy, plus the offer row with the same dropdown |
| A location with no single-file spelling (a `foo.js`, a manifest URL), nothing at this location | as above when a same-`@name` copy exists | the callout without a dropdown — `addCollection` judges the shape | copies, no offer row |

- **"Not installed" means nowhere**, not merely not here: a same-`@name`
  copy from a mirror is still this script, installed.
- **Once any copy exists the table is the only place to act.** Every
  action exists per row: Open (the location link) and Update on each
  copy, Install on the offer row. Header buttons acting on "the" copy
  would leave the user guessing which row they meant.
- The banner and the panel are one green box, not two stacked cards:
  the banner is about which of the copies the table lists, so its single
  line reads as the table's heading. Which versions exist is the Version
  column's job, where several rows can't be confused for one.
- `syntaxErrorOutcome` asks `previewInstalledStatus` — the row at this
  location, recorded before the header is wired — for whether a copy
  exists here.
- **A script inside a directory or repo collection is recognized** when
  the same URL is opened directly, and installing by URL then makes a
  deliberate second copy of the user's own — the offer stays live
  because no *container* holds it.

## Known limitations

- **Two different scripts that share a name and both omit
  `@namespace`** are treated as one. Inherited from the convention; see
  above.
- **Neither match compares content.** Two rows at the same URL can hold
  different bytes if one has not been refreshed. The Version column is
  the only hint the panel gives.
- **A row's version is not necessarily the newest published one.** The
  `@updateURL` / `@downloadURL` upstream is tracked separately by
  `versionProbes` ([updates.md](updates.md)). The …all button refetches
  each row from its own source, which is not the same as bringing every
  copy to the newest version that exists anywhere.
