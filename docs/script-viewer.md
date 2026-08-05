# Userscript viewer and header parsing

Two related pieces:

- **Header parser** (`src/userscript-header.ts`) — turns the
  `// ==UserScript== … // ==/UserScript==` block into a structured
  form. Used by the [script store](storage.md) for validation and by
  the viewer below for the summary.
- **Viewer page** (`src/userscript.html` + `src/userscript.ts`) —
  renders one script, installed or not. Its two reusable pieces live
  next door: the details `<dl>` in
  [`src/script-details.ts`](../src/script-details.ts), the tabbed code
  view in [`src/code-tabs.ts`](../src/code-tabs.ts) (with the
  linkifier in [`src/code-links.ts`](../src/code-links.ts)).

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
| `userscript.html?script=<scriptId>` | **Installed** | sources page, badge menu, Install / Update |
| `userscript.html?preview=<url>` | **Preview** | [`.user.js` capture](install-capture.md), single-script Add Source |

- **Installed** hydrates from the [script store](storage.md) — it does
  **not** re-fetch from disk on open, so what the user sees matches
  what the sources page table reports.
- **Preview** fetches the URL itself and shows the same heading,
  details panel, and code tabs for a script that isn't in the store.
  Nothing is written until the user says Install.
- The differences are listed per-section below and gathered in
  [Preview mode](#preview-mode).

### Layout

1. **Filename** (`<h1>`) — the script's `relativePath`, decoded for
   reading when it's a URL (also the page `<title>`). See
   [names-and-paths.md](names-and-paths.md).
2. **Controls row** (`#meta-row`) — `Enabled` toggle + **Refresh**
   button → `refreshScript(scriptId)`. Installed mode only; preview
   shows the banner + action row in its place (see
   [Preview mode](#preview-mode)).
3. **Error message** (`<p class="message …">`) — visible when the
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
4. **Details panel** (`#header-summary` → `<dl>`) — built by
   `renderDetails` in [`src/script-details.ts`](../src/script-details.ts).
   Row order is fixed and a row is omitted when its value is absent, so
   the panel doesn't reshuffle between modes:
   - Parsed-header fields (when a metadata block is present):
     - `Name`, `Version`, `Description`, `Author`, `Namespace`
     - `Version at <update|download|update/download> URL` — one row per
       stored update probe, immediately under `Version`. Value is
       `same` / `2.1 (Newer)` / `1.0 (Older)` / the probe's error; the
       probed URL is the row's tooltip; only `(Newer)` is highlighted.
       Installed mode only — a preview hasn't been probed. See
       [updates.md](updates.md).
     - `Homepage` (`@homepage` / `@homepageURL`) — an anchor when the
       value parses as an absolute http(s) URL, plain text otherwise.
   - `Log ID` — short file-derived handle used in every SW log line
     (basename, or `basename#N` for dupes). See
     [logging.md](logging.md). A script added by URL shows its
     decoded filename — see
     [names-and-paths.md](names-and-paths.md). Installed mode only —
     a script that has never run has no log.
   - Parsed-header fields, continued — one row per tag, each pattern
     linkified by the rule in Link rendering below:
     - `Match`, `Include`, `Exclude`
   - What the script is asking for. These are the rows an install
     decision turns on, and they're worth re-reading on an installed
     script too:
     - `Permissions` (`@grant`) and `Network access` (`@connect`),
       rendered monospace — they're API names and hosts, not prose.
     - `Loads libraries` (`@require`)
     - `Loads resources` — the whole `@resource <name> <url>` line;
       the URL is the part that says what gets fetched.
   - Location rows:
     - `Source` — colored type bubble (linking to the source's
       file:// / http(s) URL) + the source's display name (linking
       back to the parent section on the sources page via
       `sources.html#source-<id>`). Same bubble/name combo the sources
       page renders. Installed mode only; row omitted if the parent
       source row has vanished. See
       [`src/source-display.ts`](../src/source-display.ts).
     - `Location` — anchor wrapping the resolved location. Display
       form depends on source kind:
       - `file://` → bare fs path
       - `github` (any flavour) → `github.com/<o>/<r>/blob/<ref>/<path>`
         page URL (raw URL is internal-only)
       - non-github `http(s)://` → URL, percent-decoded for reading
       Anchor href matches the display URL for everything except
       `file://`, where the href is the file:// URL (the bare fs path
       isn't navigable) — and the href always keeps the *encoded* URL,
       with the tooltip showing it. Adjacent square button copies that
       raw location (not the decoded display text) to the clipboard
       via `navigator.clipboard.writeText`; icon swaps to a checkmark
       for ~1.2 s on success. Row omitted if the
       parent source row has vanished. In preview mode this is the
       normalized URL being previewed. Activating the anchor is
       intercepted in both modes — a plain navigation to a `.user.js`
       URL gets captured — see the Link rendering section below.
     - `Size` — `formatScriptSize` output (bytes or `MISSING`); in
       preview, the byte length of the fetched text.
     - `Status` — installed mode only. `OK` / `INVALID` / `MISSING` / `REFRESH FAILED` /
       `OUTDATED` / `WARNING` / `ERROR`
       (see [storage.md → Displayed status](storage.md#displayed-status-ui-level)),
       color-coded; the row's `title` carries the `refreshError` reason
       for a `REFRESH FAILED` row, the newer upstream version for an
       `OUTDATED` one, else `errorMessage` when present.
       Rendered as an `<a href="#Log">` so clicking switches
       to the Log tab via the same hashchange listener as a manual
       tab click. The level promotes live as new log entries arrive
       — the `storage.session.onChanged` listener for
       `loglevel:<scriptId>` repaints just this row.
5. **Tab strip** (`#tabs`) — one tab per source file, plus the Log tab.
   Owned by `CodeTabsView` in [`src/code-tabs.ts`](../src/code-tabs.ts):
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
6. **Code pane / Log pane** — the active tab decides which is shown:
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
     Columns: Time / Level / Source / Message. See
     [script-log.md](script-log.md) for the data model and what gets
     logged. Sticky toolbar with a "Clear log" button.
   - Clicking a tab swaps panes (and re-runs Prism on code tabs).
   - Selected index is preserved across re-renders when the new tab
     list still has an entry at that position.
   - The Log pane subscribes to `chrome.storage.session` changes for
     this script's `log:<id>` key, so events flowing in while the user
     is looking at the tab repaint live.

### Refresh

Clicking Refresh:

1. Disables the button + shows "Refreshing…".
2. Calls `refreshScript(scriptId)` from the store, which refetches
   the file, runs it through the pipeline, and rewrites just that
   one storage row.
3. Re-renders from the returned `StoredScript`.

Failures (file gone, permission denied, etc.) flip status to
`INVALID` (or `MISSING` for a vanished file) with the message exposed
in the message line and the status cell's tooltip. The Log tab also
gains an error-level entry carrying the same message (see
[script-log.md](script-log.md#status-column-promotion)). The prior
content stays visible so the user can still read the last successful
load.

### Live sync (changes from any origin)

An installed viewer stays current with state written elsewhere — the
sources page, a background opportunistic refresh, another tab — not just
its own Refresh. A `chrome.storage.onChanged` listener re-hydrates and
re-renders when:

- a **`script:*`** row changes — this script (status, content, size,
  enabled), or a sibling whose add/remove shifts this script's dedup
  `#N` log ID;
- **this script's parent `source:*`** row changes, but only in a field
  this page shows — `enabled` (greys the Enable toggle), `displayName`
  or `path` (the Source row). The re-hydrate re-reads the source
  alongside the script, so both reach the panel without a reload.
  - Everything else on that row is ignored on purpose. A refresh
    rewrites `lastRefreshedAt` (and `scanError`) whether or not it
    achieved anything, so a source stuck retrying a failing scan would
    otherwise re-render every viewer open on it, on every retry.

If the re-read finds the script gone (its source was removed), the
viewer drops into the not-found state. Session-storage changes
(`loglevel:` / `log:`) drive the Status-row promotion and Log-pane
repaint separately, as described above.

### Not-found

If the URL has neither a `script` nor a `preview` param, or the ID
doesn't resolve in the store, the viewer renders a "not available"
message instead of crashing. The Refresh button is hidden.

### URL fragment navigation

The viewer keeps `location.hash` in sync with the selected tab +
highlight so a URL can be copied or bookmarked and reopened in the
same place. Pure parser / builder live in `src/script-url-hash.ts`.

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
Same heading, details panel, and code tabs as an installed script —
what differs is the controls and where the data comes from.

### Getting the script

- `normalizeSourceInput` runs first, so a `github.com/.../blob/...`
  URL is fetched (and later stored) in its raw form.
- `canonicalSourceInput` then collapses a `file://` URL to its bare
  filesystem path, the same spelling `addSource` stores — so a captured
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

| Situation | Banner | Buttons |
|-----------|--------|---------|
| Not installed | "not installed yet" | **Install**, Cancel, View raw source |
| Already installed | version(s), see below | **Open installed script**, **Update now**, Cancel, View raw source |
| Not installable | the parse / validation error | **Continue to page** / **Continue to file**, Cancel, View raw source |

- **Install** → `addSource(<input>)`, then jumps to the new script's
  viewer. A web install is not a special kind of script: it lands in
  the http / github container source and picks up normal refresh and
  update behavior.
- "Already installed" is matched on the stored `relativePath` equalling
  the normalized URL — that's exactly what `addSource` would store. The
  banner names both versions when `@version` differs.
- **Update now** → `updateScript(id, 'manual')`, then the viewer.
- **Cancel** goes back, or closes the tab (via `chrome.tabs.remove`,
  since Chrome refuses `window.close()` for a tab it didn't open by
  script) when the preview was opened into a fresh one.
- **View raw source** opens the unprocessed file in a **new tab**,
  leaving the preview open behind it. See
  [install-capture.md](install-capture.md#how-the-raw-view-stays-readable).

### When a local file won't read

- Chrome reports "the file-access toggle is off" and "no such file" as
  the **same** opaque fetch failure, so the error text alone can't
  name the cause.
- When a `file://` read fails, the page asks
  `chrome.extension.isAllowedFileSchemeAccess()`. If the toggle really
  is off, `#banner-slot` gets the **"File access is disabled."**
  banner — the same one the sources page shows, from
  [`src/file-access.ts`](../src/file-access.ts) — with a click-through
  to `chrome://extensions/?id=<our id>`.
- Both modes raise it, because both can hit the toggle:
  - **Preview** — the fetch behind `Could not fetch this script: …`.
  - **Installed** — a load error or a failed **Refresh** on a script
    that lives on disk.
- Gated on the URL being `file://`, so an http fetch that failed for
  its own reasons isn't blamed on a toggle that wouldn't have helped.
- Gated on the failure being a **read**, not a verdict on what was
  read. A local script flagged with a parse error was read just fine,
  and the toggle doesn't explain it. Told apart by whether the message
  names the file's own URL — every fetch helper in `directories.ts`
  does, and no parse or validation message does.
- The banner's closing instruction differs by caller, because what
  actually retries the read does:
  - Sources page and preview read on load → *reload this page*.
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
- The source is still rendered. Seeing what actually came back is the
  whole point when a URL returns a login page instead of a script.
- **Continue to page** loads the location itself, with the capture
  stood down: a path ending in `.user.js` and carrying no metadata
  block is usually an ordinary web page. See
  [install-capture.md](install-capture.md#when-the-url-isnt-a-script).
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
  `rebuildSource` treats an http(s) refresh that doesn't parse as a bad
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
- `@resource` entries are a details row only — they're bytes, not code.

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
  (which is what the old prompt's "from `<url>`" link did).
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
  adds still go straight to `addSource`; previewing a listing needs a
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

[`src/prism-userscript.ts`](../src/prism-userscript.ts) extends
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
  useful than plain text.
- `Location` — anchor wrapping the path text. Href is the resolved
  location, except for `file://` scripts where it's `script.fileUrl`
  (the bare fs path isn't navigable). Display text stays that bare fs
  path for `file://` scripts, and is percent-decoded for URLs.
  Chromium typically refuses to navigate to a `file://` link from a
  chrome-extension page; the path is still readable, selectable, and
  copyable via the adjacent button.

### Code box (post-Prism walk)

`linkifyCodeBlock` in `src/userscript.ts` runs after
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
    `fileUrl` via `resolveScriptResource`. A `..`-bearing ref,
    unknown-scheme ref, or `data:` URL falls back to plain text.
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
- `@require` source tabs have no metadata block, so they stay in
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
