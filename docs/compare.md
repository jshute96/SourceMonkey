# Compare page

Two copies of one script, side by side: their header fields in one
table, then a diff of each file they run. `src/compare.html` +
`src/compare.ts`; the diff itself is `src/line-diff.ts`.

## How it is reached

- The versions panel's Compare column ([script-identity.md](script-identity.md)):
  a row's `DIFF` button opens this page in a new tab.
- The URL names the two sides:
  - `compare.html?script=<id>&other=<id>` — two installed copies.
  - `compare.html?preview=<location>&other=<id>` — the download an
    install preview is showing, against an installed copy.
- No other page links here yet; the URL is stable enough to bookmark
  while both copies exist.

## Sides and direction

- The heading is the viewer's: `SourceMonkey | Compare | <favicons>
  <name>`, painted from the **left** side — a swap repaints it from the
  other copy. The names usually agree; the favicons follow each copy's
  own `@match` and `@icon`.
- The diff reads left → right, old to new, and which side is which
  follows from that:
  - From the viewer, the script on screen (the panel's `BASE`) is on
    the left and the `other` row on the right: the diff says what that
    copy changed.
  - From a preview, the download (the panel's `NEW`) is on the right
    and the installed copy on the left: the diff says what installing
    it would change.
- The **swap** button between the two column headings turns the
  comparison around. Everything that depends on direction repaints —
  the table's columns, the `+`/`−` signs, the ADDED / REMOVED chips.
- The table's head is two labelled rows, Collection and Location: the
  collection's type bubble and name (linked to the collections page),
  and the location linked to that copy's own page — the viewer, or the
  install preview. A preview side reads "Not installed" in place of a
  collection. Both rows tint like the fields below when the two sides
  differ — two collections, or two locations.

## The fields table

- Field | left value | ⇄ | right value. The rows are the viewer's
  details-panel rows that come from the header — Name, Description,
  Version, Homepage, Match, Include, Exclude, Network access (`@connect`),
  Require, Resource — plus Size.
- A row appears when either side has something for it; a field only one
  side declares reads `none` on the other.
- A row whose values differ is tinted in the diff's own colours (red
  left, green right). In a list row, the items the other side lacks are
  the ones marked, so a Match row with one new pattern shows which.
- No Status row: Status is a live verdict about one copy rather than a
  difference between two.

## The tabs

- One tab per file that runs: the script itself first, then each
  `@require`, paired across the two sides by the ref the header
  declares it with — or, failing that, by basename, so a copy whose
  libraries moved to another host still lines them up. The base's
  requires come first, in its declaration order, whichever side it is
  on — so the tabs keep their places across a swap.
- Each tab wears a chip: `SAME` (green), `DIFFERENT` (blue — the
  Compare column's colours), or `ADDED` / `REMOVED` (amber) for a
  require only one side declares. ADDED means the right side has it,
  as the diff reads.
- `@resource` files get no tab, as in the Compare column: data, not
  code.

## The diff

- Line-based: a changed character marks its whole line. No intra-line
  highlighting, no syntax colouring — see the follow-ups in `TODO.md`.
- A final newline is not a line, so two copies that differ only in
  whether the file ends with one are `SAME` — the chip and the diff
  agree, both compare lines.
- A summary strip above the lines, right-aligned: `−4 +9 lines`, or
  `No differences`, then Up/Down arrows (the collections page's move
  arrows, by glyph) that jump between change blocks.
  - A block is a run of changed rows between unchanged ones; a jump
    puts its first row at the top of the box. Side by side, the left
    pane is driven and the right follows.
  - Where you are is read off the scroll position, not a counter, so
    scrolling by hand and then clicking goes to the next block from
    what is on screen. Up is off with no block above; Down is off with
    none below, or when the box is scrolled to its end.
- The box fills what is left of the window and the lines scroll inside
  it, like the viewer's code box, so the scroll bars sit at the window's
  edge rather than under a page of code. Under a tall fields table the
  box keeps a floor of lines and the page scrolls instead.
- Two controls above the tabs, remembered in `localStorage` across
  pages:
  - **Unified** (one column, `−`/`+` gutter) or **Side by side** (a
    pane per side, split down the middle, each scrolling sideways on
    its own with vertical scroll kept in step; a changed line beside
    what replaced it, a blank across from a line with no counterpart).
    - The panes hold the same number of rows, so they stay locked;
      the blanks are given a line's height, since a row of empty
      cells would otherwise have none.
    - The scroll one pane is given by the other is not echoed back
      (`linkScroll`), and both always show a sideways scroll bar so
      their scroll ranges match — either alone lets a drag bounce
      between two positions.
  - **Changes only** (hunks with three lines of context, `@@ -a,n
    +b,m @@` seams between them) or **Whole file**.
- A file both sides have and agree on is shown once, in full, whatever
  the view: two identical columns say nothing one does not.
- **Ctrl/Cmd-A** selects the diff, not the page (`select-all.ts`,
  shared with the viewer): the one pane there is, or side by side the
  pane focus is in — the left one when focus is elsewhere. Line
  numbers and signs are not selectable, so what copies is the lines
  (with the `@@` seams, in Changes only).
- A file only one side has is all `+` (or all `−` after a swap).

### The algorithm (`src/line-diff.ts`)

- Myers' O(ND) shortest-edit-script search over lines, the same
  algorithm `diff` and git use, with the common prefix and suffix
  peeled off first.
- Past a few thousand edits the search is abandoned and the pair is
  shown as a whole replacement: the trace the backtrack needs grows as
  the square of the edit count, and a diff that large is not read line
  by line anyway.
- Hunks are a separate pass over the ops, so "changes only" and "whole
  file" draw from one diff.

## Loading the sides

- An installed side is read from the store: its full text
  (`fullSource`), its stored `@require`s, its header.
- A preview side is fetched again — the preview page holds its download
  in memory and stores nothing until Install — through the same steps
  that page takes (`fetchSingleFileText`, `buildScriptFromText`,
  `attachFiles` with the local search roots), so the `@require`s it
  resolves are the ones an install would store.
- A copy that is gone, a preview that is not a valid userscript, or a
  preview whose `@require` will not load, fails the page with one
  message naming which side, rather than a half diff.

## Known limitations

- The page does not follow the store: a refresh of either copy while it
  is open is not reflected until reload.
- Requires are paired by ref, then basename. A basename declared twice
  on either side (`a/util.js`, `b/util.js`) is not paired by name at
  all — only an exact ref match — so those show as ADDED and REMOVED
  rather than a guessed pair.
