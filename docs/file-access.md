# File access

How VibeMonkey reads userscripts off the local filesystem. Owned by
`src/directories.ts`; consumed by the
[script store](storage.md) and the [viewer](script-viewer.md). For
the `http(s)://` story (single-file URLs + JSON manifests + ETag /
Last-Modified conditional GETs) see
[http-sources.md](http-sources.md).

## Why paths + `file://` instead of FSA

The File System Access API gives clean enumeration and writable
handles, but Chrome **does not persist permission grants across
browser sessions** — the user must click "Grant access" each time
the browser restarts, and there is no API to remember it.

The `chrome://extensions` → **"Allow access to file URLs"** toggle,
by contrast, is persistent. Once enabled, the extension can read any
`file://` URL with no further prompts, for the life of the install.
Tampermonkey's `@require file://…` feature uses this same mechanism.

So the user types an **absolute path** instead of using a picker, and
we read content via `file://` URLs.

## Requirements

For any reading to work the user must:

- Enable **"Allow access to file URLs"** for VibeMonkey on
  `chrome://extensions` (one-time, persistent).
- (Already handled in the manifest) `"file:///*"` is in
  `host_permissions`.

When the toggle is off, `chrome.extension.isAllowedFileSchemeAccess()`
returns false and the options page renders a banner with the
extension's settings URL and instructions.

## Reading a file

`fetchFileUrlText(url)` uses **`XMLHttpRequest`**, not `fetch`:

- `fetch` treats `chrome-extension:// → file://` as cross-origin and
  returns an opaque response (status 0, unreadable body).
- XHR doesn't apply that restriction.
- For `file://` XHRs, `status` is `0` even on success (there's no
  HTTP layer), so we treat any non-empty `responseText` as success
  and an empty body as failure.

## Directory enumeration

Chrome renders `file://` directory URLs as an HTML listing page that
contains a sequence of script calls like:

```
addRow("name", "url", isdir, size, "size_str", date, "date_str")
```

`parseListing(html)` extracts those calls with a tolerant regex:

- Pulls the first arg (display name) and the third positional arg
  (the `isdir` flag).
- Tolerates both `0/1` (older Chrome) and `true/false` for `isdir`.
- Decodes JS string escapes in the name via `JSON.parse('"' + … + '"')`.
- Skips `.` and `..`.

`scanForUserScripts(absolutePath)` walks recursively up to
`MAX_SCAN_DEPTH` levels and returns every `*.user.js` it finds, sorted
by relative path.

### Single-file paths

A source path may also point directly at a `*.user.js` file rather
than at a directory. `isSingleFilePath(path)` (true for any path
ending in `.user.js`) flags this case and the rest of the pipeline
treats the source as if it were a directory holding exactly one
script:

- `scanForUserScripts` lists the file's **parent** directory and
  picks out just that entry (so it can carry size+mtime for the
  unchanged-file skip). If the file isn't in the listing the scan
  returns `[]`, which the refresh pipeline reads as "vanished" and
  flags the prior entry as `missing`.
- `scriptFileUrl` returns the source path's `file://` URL verbatim
  (a directory-style join would double the basename).
- `parentDir(path)` and `baseName(path)` are the small POSIX helpers
  used to split the file path.

## Listing-format caveat

Chrome's directory-listing HTML is an **undocumented format**:

- We match the `addRow(...)` shape we currently observe.
- If Chrome's format changes, the unit tests in
  `tests/unit/directories.test.mjs` break loudly rather than the
  scanner failing silently.
- Working around a format change would mean updating the regex (or
  switching to a different enumeration strategy entirely; FSA is the
  obvious fallback at the cost of per-session re-grants).

## Module surface

`src/directories.ts` exports only I/O helpers — no persistence:

- `pathToFileUrl(absolutePath)` — percent-encode + add `file://`.
- `joinPath(base, child)` — POSIX path join.
- `parentDir(path)` / `baseName(path)` — split an absolute path.
- `isSingleFilePath(path)` — true iff the path ends in `.user.js`.
- `scriptFileUrl(sourcePath, relativePath)` — composes the file URL
  for a found script, handling both directory and single-file
  sources.
- `fetchFileUrlText(url)` — XHR a `file://` URL → text.
- `parseListing(html)` — Chrome listing → `{name, isDir}[]`.
- `scanForUserScripts(absolutePath, depth?, prefix?)` — recursive
  `*.user.js` walk; falls back to a single-entry stat for paths that
  point at a `.user.js` file.
- `MAX_SCAN_DEPTH` — recursion cap (currently 2).
