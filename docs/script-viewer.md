# Userscript viewer and header parsing

Two related pieces:

- **Header parser** (`src/userscript-header.ts`) — turns the
  `// ==UserScript== … // ==/UserScript==` block into a structured
  form. Used by the [script store](storage.md) for validation and by
  the viewer below for the summary.
- **Viewer page** (`src/userscript.html` + `src/userscript.ts`) —
  renders one stored script.

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
- `error` — `'no metadata block'` or `'unterminated metadata
  block'`. On error, `leadingText = ''`, `headerText = ''`, and
  `bodyText = source`.

### `parseHeader(source)`

Returns `ParsedHeader | null` (null when no block is found).
`ParsedHeader` is `{tags: HeaderTag[]}` and `HeaderTag` is
`{tag, locale?, value}` — flat list of every metadata line in source
order, tag names lowercased.

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

Loaded as `userscript.html?script=<scriptId>`. Hydrates from the
[script store](storage.md) — it does **not** re-fetch from disk on
open, so what the user sees matches what the sources page table
reports.

### Layout

1. **Filename** (`<h1>`) — the script's `relativePath`.
2. **Controls row** (`#meta-row`) — `Enabled` toggle + **Refresh**
   button → `refreshScript(scriptId)`.
3. **Error message** (`<p class="message error">`) — visible only when
   `errorMessage` is set.
4. **Details panel** (`#header-summary` → `<dl>`) — labeled rows in
   order:
   - Parsed-header fields (when a metadata block is present):
     - `Name`
     - `Description`
   - `Log ID` — short file-derived handle used in every SW log line
     (basename, or `basename#N` for dupes). See
     [logging.md](logging.md).
   - Parsed-header fields, continued:
     - `Match`
     - `Exclude`
   - Always present (per script):
     - `Source` — colored type bubble (linking to the source's
       file:// / http(s) URL) + the source's display name (linking
       back to the parent section on the sources page via
       `sources.html#source-<id>`). Same bubble/name combo the sources
       page renders. Row omitted if the parent source row has
       vanished. See [`src/source-display.ts`](../src/source-display.ts).
     - `Location` — anchor wrapping the resolved location
       (file:// → bare fs path, http(s):// → URL). Anchor href is the
       canonical `fileUrl`. Adjacent square button copies the
       displayed text to the clipboard via
       `navigator.clipboard.writeText`; icon swaps to a checkmark for
       ~1.2 s on success. Row omitted if the parent source row has
       vanished. See the Link rendering section below for the linkify
       rules.
     - `Size` — `formatScriptSize` output (bytes or `MISSING`).
     - `Status` — `OK` / `ERROR` / `MISSING`, color-coded; the
       row's `title` carries `errorMessage` when present.
5. **Tab strip** (`#tabs`) — one tab per source file, plus the Log tab:
   - Main script first, labeled with the basename of `relativePath`.
   - Then one tab per `@require` in declaration order, labeled with
     the basename of the require's resolved URL.
   - Trailing **Log** tab, always last so file-tab order is stable as
     `@requires` come and go.
   - Always rendered, even when there are no `@requires` — the lone
     main-script tab plus the Log tab keep the viewer's shape
     consistent.
6. **Code pane / Log pane** — the active tab decides which is shown:
   - Code tabs paint a `<pre><code>` highlighted by Prism. Main-script
     tab shows `leadingText + headerText + '\n' + bodyText` (the
     `leadingText` covers anything in the source file above the
     `==UserScript==` line); require tabs show the prefetched `source`.
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

Failures (file gone, permission denied, etc.) flip status to ERROR
with the message exposed in the message line and the status cell's
tooltip. The prior content stays visible so the user can still read
the last successful load.

### Not-found

If the URL has no `script` param, or the ID doesn't resolve in the
store, the viewer renders a "not available" message instead of
crashing. The Refresh button is hidden.

## Syntax highlighting

The viewer uses **Prism.js**, vendored from `node_modules/prismjs` by
`scripts/build.mjs` into `dist/vendor/prism/`:

- Content is set via `textContent` (never `innerHTML`) so untrusted
  file content can't be interpreted as markup.
- `Prism.highlightElement` walks the text node and replaces it with
  highlighted spans.
- The default Prism theme ships as `prism.css`.

### Userscript-header syntax highlighting extension

`src/userscript.ts` extends Prism's JavaScript grammar (via
`Prism.languages.insertBefore('javascript', 'comment', …)`) with a
`userscript-header` token that wraps the entire
`// ==UserScript== … // ==/UserScript==` block.

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
- `Location` — anchor wrapping the path text. Href is
  `script.fileUrl` (http(s) or file://). Display text stays the bare
  fs path for file:// scripts. Chromium typically refuses to navigate
  to a `file://` link from a chrome-extension page; the path is still
  readable, selectable, and copyable via the adjacent button.

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

Pure helpers (URL tokenizer, tag-line parser, tag-classifier sets)
live in `src/script-links.ts` and are unit-tested without a DOM.
