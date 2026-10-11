# Userscript viewer and header parsing

Two related pieces:

- **Header parser** (`src/userscript-header.ts`) — turns the
  `// ==UserScript== … // ==/UserScript==` block into a structured
  form. Used by the [script store](storage.md) for validation and by
  the viewer below for the summary.
- **Viewer page** (`src/userscript.html` + `src/extension/userscript.ts`) —
  renders one script, installed or not. Its two reusable pieces live
  next door: the details `<dl>` in
  [`src/extension/script-details.ts`](../src/extension/script-details.ts), the tabbed code
  view in [`src/extension/code-tabs.ts`](../src/extension/code-tabs.ts) (with the
  linkifier in [`src/extension/code-links.ts`](../src/extension/code-links.ts)).

## Header parser

### `splitHeaderBody(source)`

Returns `{leadingText, headerText, bodyText, error?}`:

- `leadingText` — anything in the source file above the
  `// ==UserScript==` line; `''` when the block starts at file top
  (the common case). The viewer prepends this to the rendered tab
  body so a license blurb / shebang / etc. doesn't disappear.
- `headerText` — raw block including both marker lines.
- `bodyText` — everything after the closing marker (a single
  trailing newline is stripped so the body doesn't lead with a blank
  line).
- `error` — `NO_METADATA_BLOCK` or `UNTERMINATED_METADATA_BLOCK`
  (exported from the same module, since the message doubles as the
  discriminant). On error, `leadingText = ''`, `headerText = ''`, and
  `bodyText = source`.
- `headerStartLine` — 1-based line of the `// ==UserScript==` marker,
  when there is one. Set even for the unterminated-block error, which
  is precisely the error whose one useful destination is the line that
  opened the block that never closed.

### `parseHeader(source)`

Returns `ParsedHeader | null` (null when no block is found).
`ParsedHeader` is `{tags: HeaderTag[], startLine?}` and `HeaderTag` is
`{tag, locale?, value, line?}` — flat list of every metadata line in
source order, tag names lowercased.

- `line` and `startLine` are 1-based in the **whole source**, so they
  match the viewer's gutter. They exist so a diagnostic about a tag can
  be clicked through to it — see [diagnostics.md](diagnostics.md).
- Both are optional because `header` is persisted: rows stored before
  the fields existed come back without them, and a refresh re-parses.

Lookup helpers (callers pick the one that matches the tag they want):

- `getValue(header, tag)` — first non-localized value or `undefined`.
- `getValues(header, tag)` — every non-localized value, in order.
- `getLocalized(header, tag)` — `{locale: value}` map (e.g. for
  `@name:de`).
- `hasTag(header, tag)` — boolean (for flag tags like `@noframes`).

The parser is **policy-free**: it doesn't decide which tags can
repeat (`@match`, `@grant`, …) vs which are single-valued (`@name`,
`@version`). That policy lives in the caller. See
`references/header-reference.md` in the `tampermonkey` plugin skill
for the tag catalog.

## Viewer page

### Two modes

One page, one set of panels, two query strings:

| URL | Mode | Where it comes from |
|-----|------|---------------------|
| `userscript.html?script=<scriptId>` | **Installed** | collections page, badge menu, Install / Update |
| `userscript.html?preview=<url>` | **Preview** | [`.user.js` capture](install-capture.md), a single-script Add |
| … `&captured=1` | Preview, capture-opened | the capture only — see [install-capture.md](install-capture.md#the-captured1-marker) for who sets, strips, and reads it |

- **Installed** hydrates from the [script store](storage.md) — it does
  **not** re-fetch from disk on open, so what the user sees matches
  what the collections page table reports.
- **Preview** fetches the URL itself and shows the same panels for a
  script that isn't in the store, under an install-flavored heading.
  Nothing is written until the user says Install.
- The differences are listed per-section below and gathered in
  [Preview mode](#preview-mode).

### Heading and page title

Both name the script the same way, pivoted for where they're read.

- **Label** (`scriptLabel`) — the script's `@name`, or its location
  (percent-decoded per [names-and-paths.md](names-and-paths.md)) when it
  declares no usable one.
  - The location is **not** appended to a name that exists: a heading
    carrying both runs the width of the window, and a tab strip shows
    almost none of it. The details panel's `Location` row is where a
    reader goes for the full path.
  - `headerDisplayName` does the `@name` pick, so the viewer and the
    collections page can't disagree about what a script is called.
- **Heading** — `<prefix><favicon> <label>`, prefixed
  `SourceMonkey | ` installed and `SourceMonkey | Install | ` in
  preview.
  - The verb takes its own `|`: it names the page, alongside the
    product's name — it is not a word governing the script's name.
- **Title** — `<label> | SourceMonkey`, with `Install script: ` in
  front in preview.
- The prefix is what tells the two modes apart at a glance; before it
  the pages were indistinguishable from their heading alone.
  - Only the `SourceMonkey | ` run wears `.brand` and takes the header
    bar's brown — the same split every other page's heading makes. The
    preview's `Install | ` reads in the heading's own colour, beside
    the script's name. See
    [architecture.md](architecture.md#the-page-header-bar).
- **The location is announced, not drawn.** When the label came from an
  `@name`, the `<h1>` carries an `aria-label` of
  `<prefix><label>, <location>`.
  - Why: switching copies from the versions panel repaints in place,
    parking focus on the `<h1>` whenever the switch didn't come from
    the table itself (see
    [switching copies](#switching-copies-in-place)) — but two copies of
    one script share an `@name`, so without the location a screen
    reader hears the same heading before and after.
  - An `aria-label`, not a clipped span: the location must stay out of
    `textContent`, which is what a copy/paste of the heading reads.
- **No script to name** (`showMissing`) — `SourceMonkey | Not
  available`, and `Not available | SourceMonkey` in the tab.
  - No favicon slot, no label, no `aria-label`, and the bare prefix in
    both modes: the preview's prefix ends in a verb with nothing here to
    govern, and "Install Not available" is not a page name.
  - The title is set here too. This state is reached by removing the
    script an open viewer is showing, not only by opening a bad URL — a
    stale title would keep advertising a script that is gone.

### Layout

1. **Header bar** (`.page-header`) — the shared bar every extension page
   opens with; the viewer's `<h1>` lives inside it, carrying the product
   prefix, the site favicon, and the script's name. See
   [Heading and page title](#heading-and-page-title) and
   [architecture.md](architecture.md#the-page-header-bar).
   - Its heading is painted before the rest of the page loads — see
     [Naming the bar before the page loads](architecture.md#naming-the-bar-before-the-page-loads).
2. **Other versions panel** (`#other-versions`) — every installed copy
   of this script, when there is more than one to talk about. Built by
   `renderRelatedVersions` in
   [`src/extension/related-versions.ts`](../src/extension/related-versions.ts) over the
   lookup in [`src/extension/script-identity.ts`](../src/extension/script-identity.ts).
   - Two sections: **This URL** (same absolute `fileUrl`) and **Same
     script from a different URL** (same `@namespace` + `@name`).
   - Per row: enable toggle, type bubble + collection name linking to
     the collections page (its named tab, opened beside this one — see
     [architecture.md](architecture.md#cross-page-navigation)), the copy's location as plain text (a link only in
     a preview — see [switching copies](#switching-copies-in-place)),
     status linking to that copy's Log tab, version, a refetch button —
     the circular arrow, called **Refresh**, matching the control the
     page already shows. It is icon-only, so the name lives in its
     tooltip. In a **preview** that button is the word **Update**
     instead: nothing is being fetched there, so it does not wear the
     refresh arrow (see
     [script-identity.md](script-identity.md)). Then a trash can, live
     only for single-file installs.
   - **Every row refreshes** in the installed viewer, both sections:
     the refetch re-reads that copy from its own collection, so a
     different-URL copy is as refreshable as a same-URL one — and a row
     wearing a `modified` chip ([file-changes.md](file-changes.md))
     always has the button that acts on it, wherever the anchor filed
     it. **Refresh all**, in the first table's header, covers the whole
     panel. A preview offers **Update** (and *Update all*) on same-URL
     rows only: the same per-row refetch, but a preview is about the
     URL on screen, and a different-URL row would refetch something
     else ([script-identity.md](script-identity.md)).
   - The Status column carries the same verdict as the `Status` row
     in the details panel — same helper, same wording — for every copy
     rather than only this one.
   - Enabling a copy disables the others, since two enabled copies both
     run; ctrl/cmd-click opts out. Same rule on the controls-row
     toggle, and the whole set flips on screen before the writes land.
   - Headed *Other versions of this script* when installed. A preview
     draws no heading: the banner line the table sits under is the
     heading. Empty — and so hidden — when the only row would be the
     script already on screen, or, in a preview, when nothing is
     installed anywhere.
   - A **triangle in the top-right corner folds the card** down to that
     heading line and back, for when the table is long and beside the
     point. Installed viewer only — the preview has no heading to fold
     into — and the fold lasts for the page only; a panel that newly
     appears is open. See
     [script-identity.md](script-identity.md#folding-it-away).
   - Green card directly under the title, above the controls row:
     *which* copy this page is about comes before anything that acts on
     it. In a preview's already-installed case the banner and the table
     are drawn as one green box (`#status-box.merged`).
   - Full behaviour in [script-identity.md](script-identity.md).
3. **Controls row** (`#meta-row`) — everything that acts on the
   script itself, left to right: the `Enabled` toggle, **Local copy…**,
   the delete trash can (a local copy only), and the **Refresh**
   circular arrow → `refreshScript(scriptId)`. Installed mode only; preview shows the
   banner + action row in its place (see
   [Preview mode](#preview-mode)).
   - The toggle is a radio button, not a plain checkbox: enabling this
     copy disables every other copy that is running, exactly as the
     panel's own rows do. Ctrl/cmd-click opts out. See
     [script-identity.md](script-identity.md#enabling-is-exclusive-disabling-is-not).
4. **Error message** (`<p class="message …">`) — visible when the
   script is flagged. Shows `errorMessage` (red, `.error`) for an
   `invalid` row, or `Refresh failed: <reason>` (amber,
   `.refresh-failed`) for a still-running `refresh-failed` row
   (`status: ok` + `refreshError`). Hidden when neither is set.
   Accompanied by the file-access banner when the toggle explains it
   (see [When a local file won't read](#when-a-local-file-wont-read)).
   - When the row carries an `errorLocation`, the `(in <file>, line N,
     column M)` part is a **link** into the tab it names. See
     [diagnostics.md](diagnostics.md).
   - Painted after `setTabs`, not with the rest of the header fields: a
     location can only become a link once there are tabs to resolve it
     against.
   - `refreshError` never gets one — the fetch failed, so there is no
     new content to point into.
5. **Details panel** (`#header-summary` → `<dl>`) — built by
   `renderDetails` in [`src/extension/script-details.ts`](../src/extension/script-details.ts).
   Row order is fixed and a row is omitted when its value is absent, so
   the panel doesn't reshuffle between modes.
   - **Every label carries a tooltip**, from the one table in
     [`src/extension/details-tooltips.ts`](../src/extension/details-tooltips.ts). Several
     rows report something the label can't convey — what we checked but
     deliberately didn't act on, what a value is *not*, where a name
     shows up outside this page — so the tooltip corrects the likely
     misreading rather than restating the label.
     - One-sentence tooltips take no trailing period; two-sentence ones
       end both and put a newline between, which `title` renders as a
       line break.
     - `Version` is the one that differs by mode: a preview has nothing
       installed, so it describes the file's claim instead.
   - **What earns a row.** The panel is not a mirror of the metadata
     block — that block is already on screen, since the first code tab
     opens on it. A row has to pay for the second reading:
     - identity a reader scans for: `Name`, `Description`, `Version`
     - something resolved or computed that the file doesn't state:
       `Collection`, `Location`, `<Site> page`, `Size`, `Status`, the
       version probes
     - a claim worth acting on: `Homepage`, `Match` / `Include` /
       `Exclude`, `Network access`
   - Tags that pay for none of it stay in the code view: `@author`,
     `@namespace`, `@run-at`, `@icon`, `@noframes`, and the rest.
   - **`@grant` gets no row**, which is a judgement about our GM
     surface rather than a general one:
     - `GM_xmlhttpRequest` is the API that reaches other origins. Past
       the page's own origin, it reaches only the hosts `@connect`
       names, or that the user allowed when asked (see
       [connect-permissions.md](connect-permissions.md)).
       - `Network access` lists both, so it carries that story more
         precisely than a grant name would.
     - Most other grants act within reach the page already has:
       `GM_addStyle`, `GM_addElement`, `GM_registerMenuCommand`,
       `GM_getResourceText`, the value store.
     - `GM_download` and `GM_openInTab` are the exception. Both reach
       outside the page — the user's download directory; any URL, whose
       query string is an exfiltration channel — and neither is
       `@connect`-gated.
       - Surfacing those two specifically is filed in
         [TODO.md](../TODO.md).
   - Parsed-header fields (when a metadata block is present):
     - `Name`, `Description`, `Version`
     - `Version at <update|download> URL` — one row per
       stored update probe, immediately under `Version`. The probed URL
       is the row's tooltip; only `(Newer)` is highlighted.
       - **Only for a probe that has something to say** — the one
         dropped case is a version matching ours whose latest check
         also succeeded.
       - **Any probe carrying an error keeps its row**, whatever its
         version says — that row is the failure's only surface anywhere
         in the UI.
       - **A `@version` on only one side earns a row too.** The `Version`
         row above then reads `<none>`, putting both halves of the
         comparison on screen; the probe row shows the bare number, with
         no `(Newer)`/`(Older)` we can't justify.
       - Installed mode only — a preview hasn't been probed, and a row
         would imply it had.
       - Full rules and the reasoning in [updates.md](updates.md).
   - Location rows:
     - `Collection` — colored type bubble (linking to the collection's
       file:// / http(s) URL) + the collection's display name (linking
       back to the parent section on the collections page via
       `collections.html#collection-<id>`, in that page's named tab —
       see [architecture.md](architecture.md#cross-page-navigation)).
       Same bubble/name combo the collections page renders. Installed mode only; row omitted if the parent
       collection row has vanished. See
       [`src/extension/collection-display.ts`](../src/extension/collection-display.ts).
     - `Location` — anchor wrapping the resolved location. Display form
       depends on collection kind:
       - `file://` → bare fs path
       - `github` (any flavour) → `github.com/<o>/<r>/blob/<ref>/<path>`
         page URL (raw URL is internal-only)
       - non-github `http(s)://` → URL, percent-decoded for reading
       - In preview mode it's the normalized URL being previewed.
       - **href vs display text.** The href matches the display URL for
         everything except `file://`, where it's the `file://` URL (the
         bare fs path isn't navigable). The href always keeps the
         *encoded* form, and the tooltip shows it.
       - **Copy button** (`makeCopyButton` in
         [`src/extension/copy-button.ts`](../src/extension/copy-button.ts), shared with the
         `Local overrides` entries). Copies the raw location, not the
         decoded display text; the icon swaps to a checkmark for ~1.2 s
         on success.
       - Row omitted if the parent collection row has vanished.
       - Activating the anchor is intercepted in both modes — a plain
         navigation to a `.user.js` URL gets captured — see the Link
         rendering section below.
     - `<Site> page` — the human-facing listing page on the site the
       script was published on, derived from the Location URL. Shown in
       both modes, whenever the location matches a known hosting site;
       the sites and their rewrites are tabulated in
       [Hosting-site pages](#hosting-site-pages-srcscript-sitests).
       - Labeled with the site's own name (`Greasy Fork page`) — a
         second row called `Homepage` would collide with the
         `@homepage` row directly beneath it.
       - Omitted when the row would only repeat what's already on
         screen: the script's own `@homepage` / `@homepageURL` names
         the same script, or the Location is itself the page URL.
     - `Homepage` (`@homepage` / `@homepageURL`) — straight after the
       hosting-site row: both name a page about this script, one
       derived from where it lives and one claimed by the file itself,
       so reading them together is what shows when they disagree. An
       anchor when the value parses as an absolute http(s) URL, plain
       text otherwise.
   - `Log ID` — short handle used in every SW log line: the basename
     and the script's number (`foo.user.js#E4`). See
     [logging.md](logging.md). Installed mode only, and always shown.
     - The `#E4` is written nowhere in the file, and it's what a stack
       trace, a `//# sourceURL=` and sm-dev (`E4`) name the script by.
     - The row's tooltip ends with a line naming the number sm-dev uses
       (`E4 is the script's ID in sm-dev.`).
     - A script added by URL shows its decoded filename — see
       [names-and-paths.md](names-and-paths.md).
   - Parsed-header fields, continued — one row per tag, each pattern
     linkified by the rule in Link rendering below:
     - `Match`, `Include`, `Exclude`
     - `Network access` (`@connect`) — directly under the match
       targets, because it's the same question asked outward: those
       rows say which pages the script reads, this one says where it
       may send what it read.
       - Rendered like Match: always bullets, each value with its
         site's icon and a link to it (`connectLinkUrl`, see Link
         rendering).
       - `*` shows as **All sites**, like the prompt answer, with no
         icon.
       - `self` and other values that name no single site stay plain
         text beside the globe. For `self` its tooltip says what it
         covers.
       - Split into two lists, each under a heading shown only when
         its list is non-empty: `Declared in @connect:` for the header
         values, `Undeclared in @connect:` for the prompt answers.
       - The prompt answers (installed scripts only) read
         `<host>: **Allowed**` or `<host>: **Denied**`, with "Allow all sites"
         shown as `**All sites**: **Allowed**`.
       - Each answer's host is linked like a header value. An allowed
         host gets its favicon; a denied one keeps the globe, so
         opening the page never contacts a site the user refused.
       - Each answer has a Reset button that clears it, so the next
         request asks again. The row repaints from the storage change
         (`connectGrants:<id>` in local storage).
       - The row shows whenever there is a value or an answer.
   - `Local overrides` — every `@require` / `@resource` whose body was read
     from a local stand-in instead of the URL it declares, one entry per
     file. Shown in both modes; **absent whenever nothing was
     overridden**, which is the overwhelming majority of scripts, so its
     presence is the whole signal.
     - Each entry: the `@require` / `@resource` tag it stood in for, the
       local path we actually read, and a copy button (the same
       `makeCopyButton` the Location row uses, copying the raw `file://`
       URL rather than the displayed path).
     - The declaration it replaced is the entry's tooltip (`Stands in
       for <url>`) — the same "asked for this, got that" pairing as the
       code tab's, in the same URL display form.
     - Last of the "what does this actually pull in" group: under the
       reach rows, above the byte total those files contribute to. See
       [local-file-overrides.md](local-file-overrides.md#surfacing-it).
   - `Size` — `formatScriptSize` output (bytes, or `—` when the script
     has never loaded); in preview, the byte length of the fetched
     text.
     - Suffixed with what the script loads alongside itself, when it
       loads anything: `12 KB (plus 2 @require files: 125 KB, 1
       @resource file: 4 KB)`. The script's own bytes understate what a
       page pays to run it when the script pulls in a jQuery.
     - Counts entries that **actually loaded and reported a size**, not
       declarations. A `@require` that failed to fetch contributes no
       bytes, so counting it would promise a total the number beside it
       doesn't include; that it was declared at all is the code view's
       story, where it has its own tab.
   - `Status` — installed mode only. `OK` / `INVALID` / `REJECTED` /
     `REFRESH FAILED` / `OUTDATED` / `WARNING` / `ERROR`
     (see [storage.md → Displayed status](storage.md#displayed-status-ui-level)),
     color-coded.
     - The row's `title` carries Chrome's refusal reason for a
       `REJECTED` row, the `refreshError` reason for a `REFRESH FAILED`
       one, the newer upstream version for an `OUTDATED` one, else
       `errorMessage` when present.
     - Rendered as an `<a href="#Log">` so clicking switches to the Log
       tab via the same hashchange listener as a manual tab click.
     - Label and `title` come from `scriptStatusView`
       (`script-display.ts`), shared with the Other-versions panel's
       Status column.
     - The level promotes live as new log entries arrive — the
       `storage.session.onChanged` listener for `loglevel:<scriptId>`
       repaints just this row, and the same listener repaints it (plus
       the message bar) when the injector's `injector-rejections` map
       changes.
6. **Tab strip** (`#tabs`) — one tab per source file, plus the Log tab.
   Owned by `CodeTabsView` in [`src/extension/code-tabs.ts`](../src/extension/code-tabs.ts):
   - Main script first, labeled with the basename of `relativePath`
     (decoded when that path is a URL).
   - Then one tab per `@require` in declaration order, labeled with
     the basename of the require's resolved URL.
   - Trailing **Log** tab, always last so file-tab order is stable as
     `@requires` come and go. Installed mode only.
   - Always rendered, even when there are no `@requires` — the lone
     main-script tab keeps the viewer's shape consistent.
   - The currently selected tab + highlight is mirrored into
     `location.hash` — see "URL fragment navigation" below.
7. **Code pane / Log pane** — the active tab decides which is shown:
   - Code tabs paint a `<pre><code>` highlighted by Prism. Main-script
     tab shows `leadingText + headerText + '\n' + bodyText` (the
     `leadingText` covers anything in the source file above the
     `==UserScript==` line); require tabs show the prefetched `source`.
   - A tab body may be a **thunk** instead of a string — preview mode
     uses that for `@require`s, which aren't fetched until their tab is
     opened. The pane shows "Loading…" meanwhile, caches the result in
     place, and renders the fetch error in the pane if it fails. A
     paint epoch discards a slow load whose tab the user already left.
   - Log tab swaps in a `<table>` view of the script's event log.
     Columns: Time / Status / Source / Message — Status is the badge
     word for a state transition (`REFRESH FAILED`, `OK`) or the level
     for a script-originated entry. See
     [script-log.md](script-log.md) for the data model and what gets
     logged. Sticky toolbar with **Save**, **Copy** and
     **Clear log** — see [script-log.md](script-log.md#export) for the
     exported format.
   - Clicking a tab swaps panes (and re-runs Prism on code tabs).
   - Both panes take the viewport height left under the details panel
     and scroll inside it, but never less than 20 lines of code
     (`--code-box-min` in `userscript.html`, at Prism's line height).
     A details panel tall enough to leave less — dozens of `@match`
     rows — makes the page itself scroll instead, the one case the
     viewer accepts a page-level scroll bar. The body grows with the
     page (`min-height: 100%`, not `height`) so the inset below the
     box survives; the panes have `flex-basis: 0` so their own content
     never sizes the page.
   - Selected index is preserved across re-renders when the new tab
     list still has an entry at that position.
   - The Log pane subscribes to `chrome.storage.session` changes for
     this script's `log:<id>` key, so events flowing in while the user
     is looking at the tab repaint live.
   - **Ctrl/Cmd-A anywhere on the page** selects the visible pane's
     content rather than the whole page (`select-all.ts`, shared with
     the compare page), so Ctrl-A, Ctrl-C copies the script from
     wherever focus is:
     - Code tab: the code element — exactly the file text.
     - Log tab: the table (not its toolbar), or an empty log's
       placeholder line.
     - Text controls and open dialogs keep the browser's own select-all.

### Refresh

Clicking Refresh:

1. Disables the button and spins its glyph in place
   (`setGlyphButtonBusy`, src/extension/glyph.ts). The tooltip becomes
   "Refreshing…"; the button itself neither changes size nor moves
   what sits beside it.
   - Under `prefers-reduced-motion` the glyph doesn't spin — it dims,
     and the disabled state and tooltip carry the rest.
2. Calls `refreshScript(scriptId)` from the store, which refetches
   the file, runs it through the pipeline, and rewrites just that
   one storage row.
3. Re-renders from the returned `StoredScript`.

Failures (file gone, permission denied, etc.) flip status to
`INVALID` with the message exposed
in the message line and the status cell's tooltip. The Log tab also
gains an error-level entry carrying the same message (see
[script-log.md](script-log.md#status-column-promotion)). The prior
content stays visible so the user can still read the last successful
load.

### Moving to another collection

The details panel's **Collection** row carries a **Move…** button to
the right of the collection name, for an installed script whose parent
is an "individual scripts" (container) collection. It sits in a grid
column of its own, right after the name — moving out to the right
margin only when the name is long enough to fill the row, which is also
what keeps a wrapping name from dragging it onto the last wrapped line.

- **Why this row and not the controls row above.** Move… is about where
  the script is *filed*, which is what the Collection row says. The
  controls that act on the script itself — Enabled, Local copy…, the
  delete trash can, the Refresh arrow — are in the row under the
  heading.

- No button at all for a directory or manifest script. Its
  `relativePath` is relative to its collection root, so there is
  nothing to move.

Clicking it opens the **move dialog** (`src/extension/move-dialog.ts`), which
owns the whole action the way the collection dialog owns Create: the
destination dropdown, the refusals, the `moveScript` call, and any
failure in its own error slot.

- **Why a dialog** rather than the dropdown inline in the row: the
  control is a select plus two buttons, more than that row can hold
  beside a collection name without crowding it — and a modal can't be
  swept away by the header repaint a background refresh of any sibling
  script triggers.
- **The list** is the same one the install page uses, with the
  script's own collection marked *(current)*, disabled and
  pre-selected, so Move is greyed until a destination is picked — see
  [script-identity.md](script-identity.md#the-same-dropdown-for-a-move).
  It comes from the last "Other versions" paint, not a fresh store
  read: `readStoreSnapshot` reads every script row in the store,
  which can be a visible pause on a click, and the panel below has
  already paid it. `moveScript` re-checks under the write
  lock, so a stale entry costs a message, never a bad move.
- **A destination that already holds this script** is disabled too,
  marked *(already installed)*. No message goes with either case: the
  labels and the greyed button carry it, where red error text on open
  would read as a failure.
- **New collection…** renames the confirm button to **Create and
  move**, then stacks the collection dialog on top of this one, titled
  *Create new collection and move script*. Cancelling that returns to
  the move dialog with the choice intact, rather than abandoning the
  move.
- After a move the caller re-runs the exclusive-enable sweep — a move
  out of a disabled collection makes this the copy that runs, so the
  others are switched off. A move that *stops* the script enables
  nothing in its place.
- Nothing is repainted by hand: the row's `collectionId` changed, so
  the live-sync listener below rehydrates the header.

### Making a local copy

**Local copy…** sits in the controls row under the heading, between the
**Enabled** box and **Refresh**, and appears for every installed
script. It opens the copy dialog (`src/extension/copy-dialog.ts`), which writes an
editable copy into the *Scripts copied in Downloads* collection under
the browser's Downloads folder.

- The delete trash can (for a script that IS a local copy) sits beside
  it. Neither sizes itself: every button in the extension takes one
  height and one glyph size from `styles.css`, so the row lines up by
  construction rather than by a padding that happens to match.

- The dialog owns the write and its refusals; the caller then runs the
  exclusive-enable sweep for the new row and switches the page to it
  in place, exactly as an install does.
- Everything else — where the copy goes, the header edits, the
  dependency files, the `-local` version suffix — is in
  [local-copy.md](local-copy.md).

### Live sync (changes from any origin)

An installed viewer stays current with state written elsewhere — the
collections page, a background opportunistic refresh, another tab — not just
its own Refresh. A `chrome.storage.onChanged` listener re-hydrates and
re-renders when:

- a **`script:*`** row changes — this script (status, content, size,
  enabled), or a sibling whose add/remove shifts an unnumbered `#N`;
- the **`scriptNumbers`** row changes — a new script gets its number
  just after it is added;
- **this script's parent `collection:*`** row changes, but only in a field
  this page shows — `enabled` (greys the Enable toggle), `displayName`
  or `path` (the Collection row). The re-hydrate re-reads the collection
  alongside the script, so both reach the panel without a reload.
  - Everything else on that row is ignored on purpose. A refresh
    rewrites `lastRefreshedAt` (and `scanError`) whether or not it
    achieved anything, so a collection stuck retrying a failing scan would
    otherwise re-render every viewer open on it, on every retry.

If the re-read finds the script gone (its collection was removed), the
viewer drops into the not-found state — including when another tab
deleted this copy. Only a deletion made *here*, from the versions
panel's trash can, moves the page to another copy instead, and that
path suppresses this listener's not-found paint so the switch stays a
single in-place render; see
[script-identity.md](script-identity.md). Session-storage changes
(`loglevel:` / `log:`) drive the Status-row promotion and Log-pane
repaint separately, as described above.

### Not-found

If the URL has neither a `script` nor a `preview` param, or the ID
doesn't resolve in the store, the viewer renders a "not available"
message instead of crashing. The Refresh button is hidden.

The wording depends on who made the row go (`removedHere`):

- Someone else (another tab, a background refresh): *Script not found
  in storage. Open it from the collections page.*
- One of this page's own trash cans: *This script has been removed*,
  plus anything the removal could not finish.
- This page's Refresh, on a local script whose file had been deleted:
  the check drops such a row itself ([file-changes.md](file-changes.md)),
  and the page moves to the next copy in the versions table, exactly
  as the panel's trash can does. Only when there is no other copy does
  it land on the not-found state, saying *This script has been removed
  because its file was deleted*. Both the wording and the successor
  are decided before the check runs, because the removal's storage
  event reaches the listener first; a check that returns a row clears
  them again.

### Switching copies in place

Selecting another copy from the versions panel swaps the script *below*
the panel without reloading the page. Two ways in:

- a viewer link in the row — its **Location**, or its **Status** (which
  carries `#Log`);
- **anywhere else in the row.** Rows that lead somewhere carry
  `is-navigable` (installed mode, not the current row) for the pointer
  cursor and hover tint. The row's own controls win — the enable
  checkbox and its label, the refetch button, the trash can, a
  dropdown — as does the Collection cell's link to the collections
  page, and so does a click that ends a text selection inside the row.

Because the row already opens the copy, its **Location is plain text**
here rather than a link to the same place — and the row takes over the
two things that link used to provide:

- **`tabindex="0"`**, with Enter / Space activating it. Same number of
  tab stops through the table as the link gave.
  - It also carries `role="link"` and an `aria-label` — a focusable
    thing that acts has to say what it does. The cost is that a
    navigable row stops being a `row` to a screen reader and its cells
    lose their column associations; the current row and every preview
    row keep ordinary table semantics.
  - A repaint rebuilds the rows, so the panel **restores focus** to the
    same copy's row afterwards (`focusedPanelRowId` /
    `restoreRowFocus`) — repaints happen for reasons the user didn't
    ask for, and a keyboard walk shouldn't be dumped back to `<body>`
    mid-stride.
- **Ctrl/Cmd-click and middle-click open the copy in a new tab**
  (`openRowInNewTab`), since there is no `href` for the browser to do it
  with. Shift is not covered: `window.open` cannot promise a window.

A **preview** keeps the link — its rows are not clickable, so the link
is the only way to reach that copy.

- `history.pushState` writes the new `?script=` (plus the link's
  fragment); `popstate` moves back and forward through those entries.
- Everything from the controls row down is re-hydrated by the same
  `loadStored` the initial load runs. Per-script state (log ID, max log
  level, rejection, stack layout) is dropped first, and the tab strip
  re-seeds from the fragment rather than keeping the tab index — tab 3
  of the script being left is nothing in particular in the new one.
- **Only plain left-clicks** swap the script here; see the row's other
  gestures below.
- **Focus follows the user.** The repaint destroys whatever was clicked
  or arrowed to, so something has to claim it.
  - From the table, the **row for the copy now shown** — which is the
    same row, turned into the current row. `pendingRowFocusId` carries
    the intent across to the paint that draws it, since the paint is
    fire-and-forget and finishes after the navigation returns.
    - A row the user has since arrowed to wins over it — that is the
      newer answer — and it is dropped altogether if they reached
      something outside the panel in the gap (`focusIsUnclaimed`): the
      restore is for focus that fell to `<body>` when the old row was
      destroyed, not a licence to take it back off whatever they just
      tabbed to.
  - **The `<h1>` when the row never arrives** (`claimPendingRowFocus`),
    same fallback under two shapes: the repaint failed, or the table
    came back without that row — removed meanwhile, or collapsed to
    nothing worth showing.
  - **The `<h1>` when the panel goes away**, which `showMissing` does
    for itself: the script was removed out from under the page, focus
    may have been standing in the table, and no paint will run to place
    it.
  - From anywhere else (Back / Forward, mostly), the **`<h1>`**
    (`tabindex="-1"`, no focus ring): there is no document load for a
    screen reader to announce the new script from.
- A link to the script already on screen is left alone: that is the
  current row's own Status link, and its `#Log` is an ordinary
  same-document fragment navigation.
- **Deleting the copy on screen** switches the same way, to the next
  row in the table (wrapping to the first) — but with
  `history.replaceState`, since the entry being left names a script
  that no longer exists, and without the fragment, which named a place
  in the file that just went away.
- Preview mode does not do this. It has no installed script to swap,
  and its panel's links are how the user leaves the preview.

#### Walking the table

On the details page every body row is a tab stop, and **Up / Down** move
between rows from anywhere in the panel — so reaching a copy three rows
down doesn't mean counting Tabs through the controls of the two rows in
between. The same shape a listbox has.

- **They land on the row**, wherever they were pressed from — never on
  a control inside it. The columns don't line up as controls: the
  Collection cell holds two links (the type bubble and the name), a
  single-file install's trash can is live where a directory row's is
  not, a disabled collection's checkbox is disabled. "The corresponding one" would be a guess, and a predictable
  rule beats one. Tab still walks the controls within a row.
- **The current row is focusable too** even though activating it does
  nothing: a row that can't take focus would be a hole in the walk, and
  it is where focus lands after a selection. No `role`/`aria-label` with
  it — it goes nowhere, so it stays an ordinary `row`; `aria-current`
  names it. Enter and Space are swallowed there rather than left to
  scroll the page.
- The walk **crosses the two sections**, which are separate tables but
  one list to the user.
- **Only rows that can be stood on take part** (`walkableRows`), which
  in practice means installed mode. A **preview's** rows are not
  focusable — nothing there selects a copy — so a preview has no walk
  and Tab through the controls is what it gets.
  - Landing on each row's first control instead would be the coin toss
    the row rule exists to avoid, and in the install-offer section that
    control is **Install** itself: every arrow would silently re-target
    an install while focus sat on the button that performs it.
- A modified arrow is left alone, as is one aimed at a `<select>`.

#### The panel holds still

The panel's two sections are computed from **one** script — same
`fileUrl` is *This URL*, same `@namespace` + `@name` is *a different
URL* — so re-anchoring it on the newly selected copy would re-file
every row underneath the click that selected it.

- The anchor is the script the page was **opened** with, and it stays
  put for the life of the page (`panelAnchorId` in `userscript.ts`).
  Navigating moves the `is-current` highlight and nothing else — which
  costs nothing, since every row has the same controls whichever
  section it sits in.
- It is an **id**. The location and identity behind it are re-read from
  the store on every paint (`resolveAnchor`), so a Refresh that rewrites
  the anchor's `@name`, or a Move that changes its URL, re-files the
  table around what it is now.
- **Removed anchor** — its trash can is in this very table — re-anchors
  on the copy currently on screen, rather than going on describing
  copies of a row that no longer exists.
- A full page load on another copy anchors on that copy — the
  pre-navigation behaviour, and still what a middle-click or a link
  from elsewhere gives.
- **The anchor files the table and nothing else.** Everything that is
  about the copy on screen — the Move picker's targets, the Enabled
  toggle's sweep and the hint on its tooltip — comes from a second
  lookup keyed on the displayed script (`displayed` in
  `paintRelatedVersions`), which is skipped in the ordinary case where
  the two agree.
- One consequence worth knowing: a Refresh that changes the
  **displayed** script's `@name` can drop it out of a table that is
  still on screen — no highlight, no *(this page)*. Reload to
  re-anchor.

### URL fragment navigation

The viewer keeps `location.hash` in sync with the selected tab +
highlight so a URL can be copied or bookmarked and reopened in the
same place. Pure parser / builder live in `src/extension/script-url-hash.ts`.

Fragment grammar:

- *empty* — main script, no highlight (default landing).
- `#Log` — the Log tab.
- `#<filename>` — code tab whose label matches `filename`.
- `#<filename>:<line>` — that tab, highlight line N.
- `#<filename>:<line>:<col>` — also paints the column-accent bar.

Behaviour:

- Tab clicks, gutter clicks, and stack-ref clicks all update the
  hash via `history.replaceState` (no Back-button entries, no
  re-firing `hashchange`).
- A `hashchange` listener re-applies the URL when the user edits
  it manually or hits Back/Forward.
- Filenames not matching any tab fall back to main, and the hash
  is normalized (an invalid `#foo.user.js` collapses to no
  fragment; the `line` and `col` are dropped because they were
  relative to the missing file).
- Main + no highlight is always written as no fragment — typing
  `#<main-filename>` is silently rewritten to empty.
- Filename matching is by tab label. Two `@require`s whose URLs
  share a basename collide; the URL routes to whichever appears
  first in the tab strip. Uncommon, but flagging it here so a
  reader doesn't go looking for a bug.
- Hash + URL are also re-anchored after a Refresh, an Enabled
  toggle, or an external storage update — the re-render wipes
  the flash overlay, so we re-paint (without scrolling) to keep
  the visible state matching the URL.

## Preview mode

`userscript.html?preview=<url>` renders a script that isn't installed.
Same details panel and code tabs as an installed script, and the same
heading shape under its own install wording — what differs is the
controls and where the data comes from.

### Getting the script

- `normalizeCollectionInput` runs first, so a `github.com/.../blob/...`
  URL is fetched (and later stored) in its raw form.
- `canonicalCollectionInput` then collapses a `file://` URL to its bare
  filesystem path, the same spelling `addCollection` stores — so a captured
  local script and one added by path are the same installed row, not
  two. See
  [install-capture.md](install-capture.md#one-file-one-installed-row).
- The un-normalized input is kept too: it's what a capture bypass is
  keyed on.
- http(s) → `fetchHttpText` (so GitHub auth applies); `file://` →
  `fetchFileUrlText`. Anything else is a hand-edited URL and errors out.
- The page never runs what it fetched — the body is rendered as text
  through Prism, same as installed mode.

### The action row

Banner (`#banner-slot`) states what this file is; the action row
(`#preview-actions`) carries the decision.

| Situation | Banner slot | Buttons |
|-----------|-------------|---------|
| Not installed anywhere | the **install callout**: **Install** *into [collection ▾]* | Cancel, View raw source |
| Any copy exists, here or elsewhere | one line — **This script is already installed.** *Select which instance to update or install.* — with the versions panel under it in the same box | Cancel, View raw source — the panel carries Open / Update per copy, and an **Install another copy of this script** section |
| Not installable | the parse / validation error | **Continue to page** / **Continue to file**, Cancel, View raw source |

- **Install into** — the button leads and the dropdown follows
  (**Install** *into [collection ▾]*), in the callout and in the
  panel's install section alike. The dropdown
  lists every scripts collection, the
  built-in one for this script's scheme first (created on demand if it
  doesn't exist), ending with *New collection…*. Every entry only
  selects; **Install** is what acts, opening the
  [collection dialog](storage.md#the-collection-dialog) first when
  *New collection…* is the choice. Groups, pre-selection, and the
  "(already installed)" / "(disabled)" markings are in
  [script-identity.md](script-identity.md#the-install-into-dropdown).
- **Install** → `installScript(<location>, <target>)`, then jumps to the
  new script's viewer. A web install is not a special kind of script:
  it lands in a scripts collection and picks up normal refresh and
  update behavior. (A location with no single-file spelling — a
  `foo.js`, a manifest URL — gets the callout without a dropdown and
  goes through `addCollection`.)
  - The new copy is left as the **only** running one: installing is an
    enable, so it applies the same exclusive rule as the enable
    checkboxes. See
    [script-identity.md](script-identity.md#enabling-is-exclusive-disabling-is-not).
- Already-installed rows come from `findRelatedVersions`, matched on
  the absolute `fileUrl` — the same lookup the versions panel
  uses, so both apply the same rule for what counts as installed. Each
  reads storage separately, so a write landing between them can leave
  them a moment apart; the next storage change reconciles it. See
  [script-identity.md](script-identity.md).
- **Once any copy exists the table is the only place to act** — the
  header keeps nothing that acts on "the" copy. Rule and wording in
  [script-identity.md](script-identity.md#what-the-header-offers).
- **Cancel** goes back, or closes the tab (via `chrome.tabs.remove`,
  since Chrome refuses `window.close()` for a tab it didn't open by
  script) when the preview was opened into a fresh one.
- **View raw source** navigates a **new tab** to the file itself,
  leaving the preview open behind it. See
  [install-capture.md](install-capture.md#view-raw-source).

### When a local file won't read

- Chrome reports "the file-access toggle is off" and "no such file" as
  the **same** opaque fetch failure, so the error text alone can't
  name the cause.
- When a `file://` read fails, the page asks
  `chrome.extension.isAllowedFileSchemeAccess()`. If the toggle really
  is off, `#banner-slot` gets the **"File access is disabled."**
  banner — the same one the collections page shows, from
  [`src/extension/file-access.ts`](../src/extension/file-access.ts) — with a click-through
  to `chrome://extensions/?id=<our id>`.
- Both modes raise it, because both can hit the toggle:
  - **Preview** — the fetch behind `Could not fetch this script: …`.
  - **Installed** — a load error or a failed **Refresh** on a script
    that lives on disk.
- A refused *navigation* raises it too. With the toggle off Chrome
  won't open a tab on a `file://` URL either, so the paths that do
  (**View raw source** on a local file) report the rejection into the
  message bar and raise the banner beside it, rather than dropping the
  promise — which Chrome files under `chrome://extensions/?errors`.
- Gated on the URL being `file://`, so an http fetch that failed for
  its own reasons isn't blamed on a toggle that wouldn't have helped.
- Gated on the failure being a **read**, not a verdict on what was
  read. A local script flagged with a parse error was read just fine,
  and the toggle doesn't explain it. Told apart by whether the message
  names the file's own URL — every fetch helper in `directories.ts`
  does, and no parse or validation message does.
- The banner's closing instruction differs by caller, because what
  actually retries the read does:
  - Collections page and preview read on load → *reload this page*.
  - Installed mode renders a stored row → *click Refresh*. A reload
    would replay the same cached copy and the same error.
- The toggle is probed **once per page**, not per failure: it lives on
  `chrome://extensions` and flipping it can't reach an already-open
  page, so the answer can't change under us. The probe is fired at
  module scope so first paint doesn't wait on it, and it resolves to
  "allowed" if it ever throws — an explanation is not worth blanking
  the viewer for.
- Not what the capture does. A `file://` navigation with the toggle
  off never reaches this page at all — see
  [install-capture.md](install-capture.md#limitations--future-work).

### When the file can't be installed

- The check is `splitHeaderBody(...).error`, then `validateHeader(...)`
  — the same pair `buildScriptFromText` runs. A preview that offered
  Install for something that would land as an `invalid` row would be
  lying about what installing does.
- Install and Update are both hidden; the banner carries the reason —
  including a link to the line it is about, which for a header problem
  is the `// ==UserScript==` marker and for a file with no block at all
  is the file itself. See [diagnostics.md](diagnostics.md).
- The collection is still rendered. Seeing what actually came back is the
  whole point when a URL returns something other than a script.
- **Continue to page** loads the location itself, with the capture
  stood down: a path ending in `.user.js` and carrying no metadata
  block is usually not a script at all. See
  [install-capture.md](install-capture.md#when-the-url-isnt-a-script).
- A response that is outright **markup** never reaches this state — the
  fetchers reject it before there is a body to render. What happens
  next depends on who asked:
  - **Capture-opened** (`captured=1`): the preview continues to the
    page by itself, no banner and no button. The capture guessed; it
    was wrong; it gets out of the way.
  - **Asked for** (Add field, or a hand-typed `?preview=`): the message
    bar names it, and **Continue to page** is offered exactly as it is
    for a file that isn't a script. There is no body to show alongside
    it, so View raw source is the way to see what came back.
  - See
    [install-capture.md](install-capture.md#when-the-url-turns-out-to-be-a-web-page).
- For a local file the button reads **Continue to file** and targets
  the `file://` form — a bare path would resolve against the
  extension's own origin.

### When the code won't parse

The preview compiles what installing would register — see
[parse-check.md](parse-check.md). Without it, the first report of a
syntax error was an `INVALID` row on the page you land on *after*
clicking Install.

- **Warns, doesn't block.** Install stays live. A missing `@match`
  means the file isn't an installable userscript at all; a syntax error
  is a property of code the user may well intend to install and fix.
- **Says where**, when it can, and the "where" is a **link** into the
  tab it names — a `@require`'s or the script's own. See
  [diagnostics.md](diagnostics.md). Same wording as the `invalid` row's
  message, via `describeDiagnostic`, so the preview and the row can't
  describe one verdict two ways.
- The warning is held as a `PreviewWarning` (message, location,
  trailing sentence), not as rendered text: `replaceBanner` rebuilds
  each warning's DOM, and a location flattened into a string on the way
  in could never come back as a link.
- The warning is appended below the install/installed banner rather
  than replacing it — both facts are true and belong on screen
  together. It renders after `wireInstallButtons` resolves, because
  that path rebuilds the banner slot with `replaceChildren`.
- A file that can't be fetched is reported as **"could not be
  checked"**, not as a prediction about the install. A flaky dependency
  host isn't grounds for telling the user their install will fail — an
  Update over http keeps the working copy running.
- **Update gets the same warning**, since it rebuilds the row just the
  same. The sentence names the button on screen, read off
  `updateBtn.hidden` so the two can't disagree.
- The promised outcome is the real one, which is not one sentence.
  `rebuildCollection` treats an http(s) refresh that doesn't parse as a bad
  *response*, not a bad script — so an Update over http keeps the
  installed body running and flags the refresh, while a first install
  or a `file://` edit really does land `INVALID`.
  - That preservation is gated on the installed row being `ok`, so the
    sentence checks it too. Updating a row that already doesn't parse
    stores the new `INVALID` — there is nothing worth keeping.
- Fails open. `unknown`, an unreachable service worker, or any throw
  leaves the preview silent; the install-time check is still the
  backstop.

### Tabs

- Main tab is the fetched text.
- One tab per `@require` **declared in the header**. The tab bodies are
  thunks, fetched when the tab is opened.
- The bodies arrive up front anyway now. The parse check needs the
  composed program, so it calls `attachFiles` — the store's own loader
  — as soon as the preview renders.
- Previewing a script therefore *does* pull down its dependencies: a
  deliberate reversal of the earlier policy, traded for catching a
  broken library before the install rather than after it.
- **This includes the capture path.** Clicking a `.user.js` link, or
  opening one from disk to read it, lands here — so the fetches happen
  before the user has decided anything. See
  [install-capture.md](install-capture.md).
- Both paths share `previewFetchCache`, so a tab opened after the
  check is a cache hit.
- Each lazy load goes through `fetchRequireForPreview`
  (`external-files.ts`), which routes to the same `loadRequire` an
  install uses — so a require that would be rejected at install time
  (not `.js`, wrong content type, not UTF-8) fails in the tab with the
  identical message.
- Unresolvable refs still get a tab, labeled with the raw ref; opening
  it surfaces the rejection.
- The per-page fetch cache memoizes failures as well as successes, so
  re-opening a tab that failed replays the same message without
  re-hitting the host. Reload the page to retry a transient failure.
- No Log tab, and no stack-ref linkification: nothing has run, so the
  tabs carry no `sourcemonkey://` `sourceUrl`.
- `@resource` entries get no tab — they're bytes, not code. Their bytes
  do reach the `Size` row's `(plus 1 @resource file: 4 KB)` tail, and an
  overridden one gets a `Local overrides` entry. Only the resolved URL
  of a non-overridden resource has no surface here.

**URLs in a not-yet-installed file are clickable.** The old install
prompt rendered `Homepage` and the source URL inert, on the grounds
that the only navigation it offered should be View raw source. The
merged page treats them like any other viewer content:

- The `Homepage` row links only when the value parses as an absolute
  http(s) URL; the code box linkifies header-tag values and bare URLs
  the same way it does for an installed script.
- Every anchor is `target="_blank" rel="noopener noreferrer"`, `data:`
  refs are never linked, and following one is an explicit user action
  that shows a page — the previewed file still never executes.
- The **Location** row is the exception, and is intercepted: navigating
  a `.user.js` URL for real would be captured straight back into a
  second preview, so the click routes to View raw source instead
  (which is what the old prompt's "from `<url>`" link did). The
  `<Site> page` row below it needs no such interception — it points at
  an HTML listing page, not at the script file.
- Installed mode intercepts it too, for the same reason, but stands the
  capture down and opens the real location in a new tab — there is no
  fetched copy to show there, and the row should open what it says.

### Future work

- **Compare against the installed copy.** Today the banner reports both
  `@version` strings when they differ but says nothing about which is
  newer, or whether the bodies differ at all. A version comparison plus
  a two-pane before/after diff per tab is the intended next step. See
  TODO.md.
- **Previewing a whole source.** Directory / manifest / github-dir
  adds still go straight to `addCollection`; previewing a listing needs a
  different UI. See TODO.md.

## Syntax highlighting

The viewer uses **Prism.js**, vendored from `node_modules/prismjs` by
`scripts/build.mjs` into `dist/vendor/prism/`:

- Content is set via `textContent` (never `innerHTML`) so untrusted
  file content can't be interpreted as markup.
- `Prism.highlightElement` walks the text node and replaces it with
  highlighted spans.
- The default Prism theme ships as `prism.css`.
- The **line-numbers** plugin renders a left-side line-number gutter
  inside each code tab. Activated by the `line-numbers` class on the
  `<pre>`; the plugin's `complete` hook fires from each
  `Prism.highlightElement` call, so the gutter repaints on every tab
  switch. Plugin assets vendor alongside Prism as
  `prism-line-numbers.{js,css}` (see `scripts/build.mjs`).
- Gutter line numbers are clickable:
  - A click paints a persistent yellow `.line-flash` overlay on
    that row. Only one row is highlighted at a time — a new click
    replaces the prior overlay; tab switches wipe it via
    `textContent =`.
  - Gutter clicks highlight in place (no scroll) so the viewport
    doesn't jump when the user clicks a row they can already see.
  - Stack-ref clicks from the Log tab reuse the same highlighter
    but with scroll-into-view enabled and an amber column-accent
    bar at the reported column. See [`script-log.md`](script-log.md).

### Userscript-header syntax highlighting extension

[`src/extension/prism-userscript.ts`](../src/extension/prism-userscript.ts) extends
Prism's JavaScript grammar (via
`Prism.languages.insertBefore('javascript', 'comment', …)`) with a
`userscript-header` token that wraps the entire
`// ==UserScript== … // ==/UserScript==` block. Importing the module is
what installs it; `code-tabs.ts` does that, so the grammar travels with
the view that highlights and the linkifier that reads its tokens.

The outer token keeps the `comment` alias so non-tag lines inside
the block still read as comment-grey. Inner tokens use existing
Prism theme classes via `alias`:

- `header-marker` → `bold` — wraps `==UserScript==` and
  `==/UserScript==` (the leading `//` stays plain).
- `header-tag-name` → `constant` — wraps `@tag` (with optional
  `:locale` suffix). Same colour as JS constants in the body.
- `header-tag-value` → `string` — wraps the value text after the
  tag. Same colour as JS string literals.

Inner-pattern order matters: `header-tag-value` must run before
`header-tag-name`, because its lookbehind needs the `@tag` substring
to still be present in unconsumed text.

Because the header block is recognised structurally by Prism (not by
line-shape post-walk), a single-line string literal like
`"// ==UserScript=="` can't spoof header mode — Prism tokenises it
as a string, not as our header block. A multi-line template literal
containing both marker lines can still be picked up (our pattern is
inserted before the string/template tokens), but no real userscript
embeds a fake metadata block that way.

Files with two metadata blocks (see
`tests/bad-examples/two-headers.user.js`) get a tinted band
over each block; SourceMonkey itself only honours the first one and
treats everything past it as body, so the second band is purely a
visual cue that there's a stray block down there.

The `userscript-header` span also gets a tinted band background in
`src/userscript.html` (`display: block` with a negative left/right
margin matched to the code-box's padding) so the metadata block
reads as a visually distinct strip at the top of the file. The
pattern consumes the line-terminating `\n` after `==/UserScript==`
into the span so the block break the browser inserts for `display:
block` doesn't compound with the source `\n` and produce an extra
blank line above the body.

## Link rendering

Both the details panel and the highlighted code box turn eligible
text into open-in-new-tab anchors (`target="_blank"`,
`rel="noopener noreferrer"`). Same per-tag rules apply in both places
so the body header and the details panel agree.

### Details panel

- `Match` / `Exclude` — every pattern is fed through `matchTargetInfo`
  from [`src/match-targets.ts`](../src/match-targets.ts). The
  `linkUrl` rule: keep the literal prefix when `*` is at the end of
  the last segment; otherwise trim back to the last complete
  directory; dewildcard `*.host` to its apex; drop `<all_urls>`,
  host wildcards, and regex literals to plain text. `@exclude`'s
  formal grammar is a free-form glob, but values are almost always
  written as match patterns in practice and a click target is more
  useful than plain text. A pattern that names no site gets a second
  chance via the [same-directory fallback](#same-directory-fallback).
  - Each pattern is led by its site's favicon (`renderPatternIconInto`
    in [site-icons.md](site-icons.md)), linked to the same URL as the
    text. A pattern with no site keeps the globe — linked when the
    same-directory fallback applies, inert otherwise.
  - Always a bulleted list, even for a single pattern, so these rows
    read alike.
- **Long lists fold.** Any details-panel list (the pattern rows,
  `Network access`, `Local overrides`) past `LIST_FOLD_AT` items shows
  the first ones and a final `(N more)` bullet; clicking it shows the
  rest in place and offers `(show fewer)`. `bulletList` in
  `script-details.ts`.
  - Never `(1 more)` — the bullet would take the line it saves, so a
    list one over the limit is shown whole.
  - Every item is rendered up front and merely hidden, so per-item
    work (a favicon fetch) happens once regardless.
- `Location` — anchor wrapping the path text. Href is the resolved
  location, except for `file://` scripts where it's `script.fileUrl`
  (the bare fs path isn't navigable). Display text stays that bare fs
  path for `file://` scripts, and is percent-decoded for URLs.
  Chromium typically refuses to navigate to a `file://` link from a
  chrome-extension page; the path is still readable, selectable, and
  copyable via the adjacent button.

### Same-directory fallback

A script that ships beside the page it acts on often names that page
with patterns that name no site, such as any of these:

```
// @match *://*/gm-menu/gm-menu.html
// @match *://*/*gm-menu/gm-menu.html
// @match file:///*/gm-menu/gm-menu.html
```

`sameDirLinkUrl` (in `src/match-targets.ts`) links each such pattern
to the page sitting next to the script. Given the script's own directory `D`:

- The pattern must name **no host** — `*`, or the empty host of a
  `file://` pattern. A concrete host is `matchTargetInfo`'s job.
- Its scheme must be one a site-less pattern is written with: `*`,
  `http(s)`, `file`, or the `http*://` shorthand `@include` values
  often use. The scheme is then discarded (see the notes below), so
  the check is what keeps `ftp://*/…` from linking.
- Its **last path segment must be a concrete filename** — non-empty,
  no `*`, no `?` or `#`, and carrying an extension.
- The **directory segments after the last wildcard segment** must
  match the tail of `D` exactly.
- Literal text ending that wildcard segment (`gm-menu` in `*gm-menu`)
  must end the directory of `D` just before that run.
- At least one of those two must be present, to anchor on.

The link is then `D` + that filename.

| Pattern (script in `…/examples/gm-menu/`) | Link |
| --- | --- |
| `*://*/gm-menu/gm-menu.html` | `<D>/gm-menu.html` |
| `*://*/*gm-menu/gm-menu.html` | same URL |
| `file:///*/gm-menu/gm-menu.html` | same URL |
| `*://*/examples/gm-menu/gm-menu.html` | same URL (longer overlap) |
| `*://*/gm-menu.html` | *(no link)* — nothing to anchor on |
| `*://*/other/gm-menu.html` | *(no link)* — `other` isn't `D`'s tail |
| `*://*/gm-menu/*` | *(no link)* — not a filename |
| `*://*/gm-menu/page.html?v=1` | *(no link)* — parametrised, not a file next door |

Notes:

- The **scheme and origin come from the script**, not the pattern, so
  `*://` and `file://` patterns for the same page give one URL —
  and the rule works the same for an HTTP-hosted script.
- Requiring at least one matching directory (or directory suffix,
  like `*gm-menu`) is what makes this a deduction: `*://*/page.html`
  says only "a file with this name, somewhere", which is no evidence
  it sits beside the script.
- The result is `D` plus one literal filename, so no pattern can walk
  out of the script's own directory. It's resolved through the URL
  parser, so a filename carrying a space is escaped like the directory
  around it.
- A **github collection's** result is mapped raw → blob, the same
  rewrite the Location row uses: `raw.githubusercontent.com` serves
  HTML as `text/plain`, so the raw neighbour of a script would open as
  a plaintext dump.
- **Segment comparison is exact**, so a pattern that differs in case
  from the script's directory gets no link. Right for http and for
  Linux paths; on a case-insensitive filesystem it costs a link, never
  produces a wrong one.
- **Existence is never checked.** There's no cheap check for the HTTP
  case, and a script should linkify identically whether it was loaded
  from disk or from a server.
- Site-icon discovery does *not* use it — a page beside the script
  isn't a site, and probing it for a favicon would be noise.

### Hosting-site pages (`src/extension/script-sites.ts`)

What we fetch from a userscript-hosting site is its *raw code* URL,
which is not a page a person wants to open. Each supported site
encodes the script's identity in that URL, so the listing page is a
pure rewrite — no network call, no stored field.

| Site | URLs recognised | Page URL | Identity key |
| --- | --- | --- | --- |
| Greasy Fork | `greasyfork.org/[<locale>/]scripts/<id>[-<slug>]/code/…`, `update.greasyfork.org/scripts/<id>/…`, and the page URL itself | `greasyfork.org/[<locale>/]scripts/<id>[-<slug>]` | `greasyfork.org:<id>` |
| Sleazy Fork | the same shapes on `sleazyfork.org` | `sleazyfork.org/[<locale>/]scripts/<id>[-<slug>]` | `sleazyfork.org:<id>` |
| OpenUserJS | `openuserjs.org/install/<user>/<name>.user.js`, `/src/scripts/…`, and the page URL itself | `openuserjs.org/scripts/<user>/<name>` | `openuserjs.org:<user>/<name>` |
| GitHub Gist | `gist.githubusercontent.com/<user>/<id>/raw/…` and the gist page URL | `gist.github.com/<user>/<id>` | `gist.github.com:<id>` |

- The locale segment is preserved so the page opens in the language the
  install link came from; the `-<slug>` tail is kept when the URL
  carried it. Neither is part of the script's identity, hence the key
  column.
- **Compare keys, never URL text**, to ask "same script?". A location
  of `update.greasyfork.org/scripts/12345/x.user.js` and an
  `@homepage` of `greasyfork.org/en/scripts/12345-my-script` are one
  page written two ways, and only the key sees that. This is what the
  row's duplicate suppression runs on.
- Paths are read without decoding, so a percent-encoded or CJK slug
  reaches the `href` in the same form every other URL in the panel is
  printed in.
- GitHub blob URLs are deliberately absent: `raw.githubusercontent.com`
  is already rewritten to the `github.com/<o>/<r>/blob/…` page form
  before the viewer sees it, so the Location row *is* the page link.
  Gists get a table row because that rewrite doesn't cover them.
- Anything else (a plain web server, a local file, an unknown host)
  yields no row.

### Code box (post-Prism walk)

`linkifyCodeBlock` in `src/extension/userscript.ts` runs after
`Prism.highlightElement` in two passes:

1. **Header pass** — finds each `.userscript-header` span left by
   the grammar extension above, walks its `.header-tag-value`
   children, and (for each) walks back to the preceding
   `.header-tag-name` to recover the tag. Eligible tags rewrite the
   value span's contents; others fall through to URL-only mode on
   the value's text.
2. **URL pass** — every text node outside `.header-marker /
   .header-tag-name / .header-tag-value` has its absolute http(s) /
   file:// URLs wrapped via `splitTextByUrls`.

#### Inside the metadata block

- The value span is rewritten as `[prefix-text]<anchor>[suffix-text]`
  so the line round-trips verbatim. Eligible tags:
  - `MATCH_HEADER_TAGS` (`@match`, `@exclude`, `@include`) →
    `matchTargetInfo` linkUrl. The anchor text is the full pattern;
    the href is the trimmed link URL.
  - `RESOLVABLE_HEADER_TAGS` (`@icon`, `@iconURL`, `@defaultIcon`,
    `@icon64`, `@icon64URL`, `@require`, `@updateURL`,
    `@downloadURL`, `@homepage`, `@homepageURL`, `@website`,
    `@source`, `@supportURL`) → resolved against the tab's
    `fileUrl` via `resolveScriptResource`. A ref that escapes a
    *local* script's folder, an unknown-scheme ref, or a `data:`
    URL falls back to plain text.
  - `@resource` carve-out: the value has shape `<name> <url>` (two
    whitespace-separated tokens; the `<name>` token has no internal
    whitespace by Tampermonkey's grammar). The `<name>` plus the
    gap after it stay as plain prefix; only the `<url>` token is
    resolved (like the other single-URL tags) and wrapped.
  - `@connect` carve-out: the value is a host (`example.com`,
    `*.example.com`) or a full URL, not a match pattern.
    `connectLinkUrl` picks the target: bare host gets an `https://`
    prefix; subdomain wildcard collapses to the apex; a full http(s)
    URL is preserved verbatim. `*`, `self`, non-http(s) schemes, and
    anything the URL parser rejects fall back to plain text.
- Anything else falls through to URL-mode for that line.

#### Outside the metadata block

- Absolute `http(s)` / `file://` URLs are extracted via
  `splitTextByUrls` and wrapped. `*` is excluded from the URL
  character class so `https://example.com/foo/*` linkifies as
  `https://example.com/foo/` plus a literal `*`.
- Always-peelable trailing punctuation (`.,;:!?`) comes off the URL
  and back into the literal run.
- Closing brackets (`)`, `]`) only peel when the URL has no matching
  open bracket, so `https://en.wikipedia.org/wiki/Foo_(disambig)`
  keeps its `)`.
- `@require` file tabs have no metadata block, so they stay in
  URL-only mode for the entire body.

#### Anchor styling

- Anchors get `class="code-link"` and inherit Prism's token colour
  (CSS: `color: inherit; text-decoration: none;`); the hover
  underline is the only signal of clickability so the code box keeps
  reading as code.
- Code-box anchors are built with `openInNewTabAnchor(..., slashBreaks=false)`
  so no `<wbr>` markers land in the text. Chrome honors `<wbr>` as a
  break opportunity even under `white-space: pre`, which would soft-
  wrap a long URL like `http://www.w3.org/2000/svg` mid-source-line
  and misalign the line-numbers gutter. The details panel uses the
  default `slashBreaks=true` because its rows DO need to wrap.

Pure helpers (URL tokenizer, tag-line parser, tag-classifier sets)
live in `src/script-links.ts` and are unit-tested without a DOM.
