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
- Decoded: headings, page titles, the viewer's `Log ID` and `Location`
  rows, code-tab labels, install-prompt text, badge/menu labels, SW
  console log IDs.
- Not decoded: `href`s, the Location row's copy button, fetch URLs,
  stored `relativePath`, `@match` patterns, anything compared for
  identity (e.g. the preview's already-installed check).
- A row's tooltip carries the raw href, so the encoded form is always
  one hover away.

## Helpers

| Function | Use |
|----------|-----|
| `decodeForDisplay(s)` | percent-decode; returns `s` unchanged if it doesn't decode |
| `leafName(p)` | last `/`-separated segment, no decoding |
| `displayLocation(s)` | readable form of a whole URL or path |
| `scriptBasename(s)` | short name: URL filename (decoded, no query) or path leaf |
| `scriptDisplayName(script)` | `@name`, else `displayLocation(relativePath)` |

### Only URLs get decoded

- `displayLocation` and `scriptBasename` decode only when the string
  starts with a scheme.
- A `relativePath` from a local directory source is a literal on-disk
  name: a file really called `a%20b.user.js` must keep its `%20`, or
  the name on screen won't be the name on disk.

### Decoding never throws

- A lone `%` (a filename like `100% free.user.js`) makes
  `decodeURIComponent` raise `URIError`.
- `decodeForDisplay` returns the input in that case — one undecoded
  escape beats losing the whole string.

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
