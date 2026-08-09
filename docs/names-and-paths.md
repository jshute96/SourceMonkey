# Names and Paths on Screen

How a stored location becomes the text a user reads. Helpers live in
[`src/script-display.ts`](../src/script-display.ts).

## The problem

- A script installed from the web stores its URL as `relativePath`.
- Script hosts put the script's human name *in the path*, so the
  stored value is a wall of escapes:
  `…/34613/YouTube%E2%84%A2%20Ultimate%20Downloader%20v13.2%20%F0%9F%9A%80….user.js`
- That's what the browser requests, but it isn't what Chrome shows for
  the same URL, and it isn't readable in a heading, a tab label, or a
  console line.

## The rule

- **Display decodes. Everything functional stays encoded.**
- Decoded: headings, page titles, the viewer's `Location` row (and its
  `Log ID` row, on the scripts that get one), the `Local overrides`
  paths, code-tab labels, install-prompt text, badge/menu labels, SW
  console log IDs, and stack refs in the viewer's Log tab.
- Not decoded: `href`s, the Location row's copy button, fetch URLs,
  stored `relativePath`, `@match` patterns, anything compared for
  identity (e.g. the preview's already-installed check).
- A row's tooltip carries the raw href, so the encoded form is always
  one hover away.
- **`Local overrides` is the one row whose copy button gives you the
  displayed string.** Its value is a bare filesystem path, not a URL, so
  there is no encoded form to preserve — decoding already happened in
  `sourceFsPath`.

## Helpers

| Function | Use |
|----------|-----|
| `decodeForDisplay(s)` | percent-decode; returns `s` unchanged if it doesn't decode |
| `leafName(p)` | last `/`-separated segment, no decoding |
| `displayLocation(s)` | readable form of a whole URL or path |
| `scriptBasename(s)` | short name: URL filename (decoded, no query) or path leaf |
| `scriptDisplayName(script)` | `@name`, else `displayLocation(relativePath)` |
| `appendWithSlashBreaks(el, s)` | append text with a `<wbr>` after each `/` so long values wrap at slashes |

### Only URLs get decoded

- `displayLocation` and `scriptBasename` decode only when the string
  starts with a scheme.
- A `relativePath` from a local directory source is a literal on-disk
  name: a file really called `a%20b.user.js` must keep its `%20`, or
  the name on screen won't be the name on disk.

### Stack refs decode by scheme, not by shape

- The one place the decode is gated on the URL's **scheme** rather than
  on "is it a URL at all".
- A Log-tab stack ref may name our synthetic `sourcemonkey://…` URL,
  which embeds the percent-encoded log label (`main%232`), or a real
  `http(s)`/`file` URL from a `@require` or from page code.
- Only our own URLs decode — and not because decoding the others is
  unsafe. `displayLocation` decodes any absolute URL and accepts the
  same `%2F`-reads-as-`/` ambiguity (see **Known limitations**).
- The line is **coordinate vs name**. A stack ref is compared against
  devtools, pasted into a Sources-panel search, or matched to a
  `@require` line, so it wants the bytes that were really in the URL.
  Our synthetic URLs are the exception because their encoding is an
  artifact we introduced, not part of an address anyone can look up.
- Matched against the whole `sourcemonkey://SourceMonkey` prefix, not
  the scheme: the scheme is unregistered, and a script can put
  `sourcemonkey://elsewhere/…` in its own log message.
- `displayRefText` in `src/stack-link.ts`; `setRefText` / `refNode` in
  `src/userscript.ts` paint it. The raw URL still does the tab lookup
  and the click target; only the painted text changes.
- Devtools' Sources tree indexes the file under the **encoded** folder
  name, so the tooltip carrying the raw form is how a user finds the
  same file there.

### Decoding never throws

- A lone `%` (a filename like `100% free.user.js`) makes
  `decodeURIComponent` raise `URIError`.
- `decodeForDisplay` returns the input in that case — one undecoded
  escape beats losing the whole string.

## Long names wrap, they never widen the page

- Names are attacker-length: an on-disk file or a web-installed script
  can carry a whole marketing title, emoji and all.
- Any element showing one must wrap. A `white-space: nowrap` name cell
  pushes its table wider than the card around it and the trailing
  columns render outside the border.
- The wrap recipe, used by the sources page's `td.name-cell`, the
  source heading (`.source-display-name`), the viewer's `h1` and its
  Location row (`.filename-text`):
  - CSS `overflow-wrap: anywhere; word-break: normal;`
  - text appended via `appendWithSlashBreaks`.
- Break order that gives: spaces first, then `/`, then mid-word only
  when nothing else fits.
- `anywhere` (not `break-word`) is load-bearing: only `anywhere` lowers
  the element's min-content width, which is what lets the sources
  table's name column actually shrink.
- Where a fixed-width favicon slot precedes the text, add a hanging
  indent (`padding-left` past the icon + a matching negative
  `text-indent`) so continuation lines align with the text, not the
  icon. The `td` version also absorbs the cell's own padding, so the
  two constants differ — don't copy one to the other.
- `<wbr>` adds no characters, so `textContent` reads, copy/paste, and
  test assertions still see the original string.
- Exception: the viewer's code box passes `slashBreaks=false` — see
  [script-viewer.md](script-viewer.md#anchor-styling).

## Log IDs and `sourcemonkey://` URLs

- Log IDs are display strings, so they carry decoded names — see
  [logging.md](logging.md).
- That means spaces, parens, `#`, and non-ASCII can reach
  [`script-source-url.ts`](../src/script-source-url.ts), which builds
  the `//# sourceURL=` values.
- It re-encodes everything outside `[A-Za-z0-9._~-]`, because:
  - a bare `#` (the `#N` dedup suffix) would start a URL fragment;
  - a space or paren ends the ref run `stack-link.ts` matches, so a
    stack frame would stop linkifying to its viewer tab.
- Round-trip is stable for the common case: `My%20Script` decodes to
  `My Script` and re-encodes to `My%20Script`, so devtools' Sources
  tree looks exactly as it did.
- It is *not* stable when the stored URL has a query string (now
  dropped from the label) or non-canonical escapes (`%e2` → `%E2`).
  Stack refs in log entries written before this change render as
  plain text instead of anchors for those scripts, until the log
  rotates.

## Known limitations

- **Reserved characters decode too.** `displayLocation` decodes the
  whole string, so `%2F` reads as `/`, `%23` as `#`, `%26` as `&` —
  a URL that looks structurally different from the one that gets
  requested. Display-only (the tooltip and copy button carry the raw
  form), and `scriptBasename` re-takes the leaf so a decoded `/`
  can't smuggle a path separator into a log ID.
- **`&` in a context-menu title** is a mnemonic marker to Chrome, so
  a decoded `%26` in a script's name renders as an underline in the
  action menu. Already true for any `@name` containing `&`.
- **A literal `#N` at the end of a name collides with the dedup
  suffix.** `foo%231.user.js` and the first of two `foo.user.js`
  dupes both fold to the same `sourcemonkey://` folder. Cosmetic,
  devtools-only, and exotic enough not to design around.
