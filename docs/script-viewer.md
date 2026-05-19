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

Returns `{headerText, bodyText, error?}`:

- `headerText` — raw block including both marker lines.
- `bodyText` — everything after the closing marker (a single
  trailing newline is stripped so the body doesn't lead with a blank
  line).
- `error` — `'no metadata block'` or `'unterminated metadata
  block'`. On error, `headerText = ''` and `bodyText = source`.

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
open, so what the user sees matches what the options page table
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
     - `Filename` — absolute path (source directory +
       `relativePath`), shown next to a square icon button that
       copies it to the clipboard via `navigator.clipboard.writeText`.
       The icon swaps to a checkmark for ~1.2 s on success. Row
       omitted if the parent source row has vanished.
     - `Size` — `formatScriptSize` output (bytes or `MISSING`).
     - `Status` — `OK` / `ERROR` / `MISSING`, color-coded; the
       row's `title` carries `errorMessage` when present.
5. **Code box** (`<pre><code>`) — `headerText + '\n' + bodyText`
   highlighted by Prism.

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
