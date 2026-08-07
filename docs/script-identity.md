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

- Key: `canonicalSourceInput(script.fileUrl)`.
- **`fileUrl`, not `relativePath`.** A script inside a directory,
  manifest, or repo source stores a path relative to its source root.
  That shares no text with the full URL the same script carries when
  installed standalone, so comparing `relativePath` can never match a
  collection copy against a single-file copy.
- `fileUrl` is the absolute form the load pipeline already builds for
  every source kind — `scriptFileUrl` in
  [`src/directories.ts`](../src/directories.ts) resolves manifest
  entries against the manifest URL, joins directory entries onto the
  source root, and maps GitHub dirs to raw URLs.
- `canonicalSourceInput` collapses a `file://` URL to its bare path, so
  a directory source's `file://` URL and a container row's bare path
  land on the same key.

### Display is unaffected

- A collection copy still **shows** its relative path — that is the
  name the user recognizes from the source's own listing.
- Only the comparison uses the absolute form. The row's tooltip carries
  it, per [names-and-paths.md](names-and-paths.md).

## Same identity

- Key: `@namespace` + `@name`, trimmed, joined by a NUL, spelled `\u0000`.
- This is the convention, not our invention:
  - Greasemonkey documents `@namespace` as the value that, combined
    with the name, forms a unique identifier.
  - Violentmonkey derives an internal `uri` from the pair.
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
- **`installTarget`** — where a standalone install would land, present
  only when it would actually add something:
  - the location is a single-file input, **and**
  - no `sameLocation` row already sits in that container.
  - `source: null` means the container does not exist yet.

Both lists sort by source display name, then location, so the panel is
stable across renders.

## The panel

One table shape, both pages. What differs is only which actions each
row offers, which the caller supplies as callbacks.

| | Details page | Preview |
|---|---|---|
| Heading | Other versions of this script | Existing versions |
| Current row | highlighted, **(this page)**, not a link | — |

Sections: **This URL**, then **Same script from a different URL** with
a normal-weight gloss naming the match.

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
- **Install**, only on the `installTarget` row — and only when the
  caller passes an `install` action. Two callers decline:
  - the **installed page**, where an Install would add a second row for
    a file already installed, and two enabled rows at one URL inject
    the script twice;
  - an **invalid preview**, which has already said the file cannot be
    installed and hidden its own Install button.

### Failures

- The panel reports its own action failures **inside itself**, not in
  the page's `#message` bar. That bar is rewritten from the current
  script's stored state on every `storage.onChanged` repaint, and a
  refresh is exactly what triggers one — a message about another copy
  would be painted and wiped in the same breath.
- A multi-copy refresh keeps going past a failure and names every copy
  that failed. Aborting on the first would silently leave the rest
  untouched after the user asked for all of them.

### Accessibility

- Each row's checkbox is the only content of its cell, so it carries an
  `aria-label` naming the copy — five rows of "Enable this copy" would
  be indistinguishable.
- A row whose **source** is disabled greys out and says so, matching
  the viewer's own toggle. The box still shows the script's own stored
  flag; the source override is carried by the disabled state and label.
- The current row gets `aria-current`, because the `(this page)` marker
  lives in the Location cell, which the narrow layout hides.

### Suppression

A panel whose only row is the script already on screen says nothing the
page above it doesn't, so it renders empty and the `:empty` rule hides
it.

### Row layout

- Columns: enable toggle, source, location, version, actions.
- **Source cell leads with the type bubble**, then the name — the same
  order as the details panel's Source row and the sources page's
  headings. The bubble is fixed-width and the name is the variable
  part, so leading with it also keeps rows aligned down the left edge.
- Location shows the row's own stored `relativePath` (relative for a
  collection copy), with the absolute form on the tooltip.

### Layout

- Two `<table>`s, not one, but a shared `<colgroup>` plus
  `table-layout: fixed` pins their columns to the same widths — without
  it each table sizes its own and the panel reads as two unrelated
  grids.
- Narrow windows shed columns rather than wrapping every cell to a
  ribbon: **Version** below 640px, **Location** below 460px. Zeroing
  the `<col>` width alongside `display: none` on the cells is what
  reclaims the space — under `table-layout: fixed` the colgroup, not
  the cells, sets column width.
- Dropping Location takes the per-row link to that copy's page with it.
  The source name still links to the sources page, so the row is not a
  dead end.

## What this changed

- **Install and Open/Update are no longer exclusive.** A script can be
  installed inside a collection source while the user still has no copy
  of their own. `installTarget` — "would a standalone install add
  anything?" — is what decides whether Install shows.
- **The preview's already-installed check now uses this lookup**, so
  the buttons and the panel apply the same rule for what counts as
  installed. Each reads storage separately, so they can sit a moment
  apart; sharing a cached snapshot would be worse, handing the buttons
  a stale answer right after an install. It passes no header:
  the buttons care only about this URL. Letting an identity match
  suppress Install would strand the user with no way to add the script,
  since installing one location over another is not a thing we can do.
- **A script inside a directory or repo source is now recognized** when
  the same URL is opened directly — previously it wasn't, and installing
  by URL made a second copy.
- **Install shows when installing would add something**: an
  `installTarget`, *or* nothing installed at this location at all. The
  second clause matters because a preview accepts any http(s)/file
  location while `installTarget` only speaks for `.user.js` ones —
  without it a `foo.js` or manifest URL would lose its Install button
  with nothing said about why. `addSource` remains what judges those.

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
