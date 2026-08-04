# File access

How SourceMonkey reads userscripts off the local filesystem. Owned by
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

- Enable **"Allow access to file URLs"** for SourceMonkey on
  `chrome://extensions` (one-time, persistent).
- (Already handled in the manifest) `"file:///*"` is in
  `host_permissions`.

## Telling the user the toggle is off

[`src/file-access.ts`](../src/file-access.ts) owns both halves: the
`chrome.extension.isAllowedFileSchemeAccess()` probe, and the
**"File access is disabled."** banner every page renders from it.

- **Sources page** — up front, on every load. Without the toggle,
  every fetch the page could make will fail.
- **Script viewer / install preview** — only after a `file://` read
  actually failed, since an unrelated page has no reason to nag. Covers
  the preview fetch, a load error, and a failed **Refresh**, but not a
  parse verdict on a file we read successfully. See
  [script-viewer.md](script-viewer.md#when-a-local-file-wont-read).

Why it takes a probe rather than error text: a blocked read and a
missing file both surface as the XHR `onerror` below, with no status
or message to tell them apart.

The toggle also gates the `file://` half of the `.user.js` install
capture — see
[install-capture.md → Local files](install-capture.md#local-files).
Nothing surfaces a banner there: with the toggle off the navigation
event never fires, so there's no moment to hang one on.

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

A path that points directly at a `*.user.js` file (rather than at a
directory) is **not** registered as its own source. `addSource`
routes single-file inputs into the matching container source instead
— see [storage.md](storage.md#container-sources). The script's
`relativePath` carries the full path/URL the user added, and
`scriptFileUrl` URL-coerces it back to the `file://` form for the
fetcher.

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
- `isSingleFileInput(path)` — true iff the path ends in `.user.js`.
  Used at add-source time to route the input into the matching
  container source rather than minting a single-file source row.
- `scriptFileUrl(sourcePath, relativePath)` — composes the file URL
  for a found script, dispatching on source kind (directory /
  manifest / github-dir / container).
- `fetchFileUrlText(url)` — XHR a `file://` URL → text.
- `parseListing(html)` — Chrome listing → `{name, isDir}[]`.
- `scanForUserScripts(absolutePath, depth?, prefix?)` — recursive
  `*.user.js` walk for directory / manifest / github-dir sources.
  Container sources are never scanned through this entry point —
  `refreshSource` builds a synthetic scan from their explicit
  `scriptIds` instead.
- `MAX_SCAN_DEPTH` — recursion cap (currently 2).
