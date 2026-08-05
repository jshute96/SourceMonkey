# Diagnostics and their locations

Everything SourceMonkey concludes about a script *from its content* —
not from whether a file could be fetched — is a diagnostic, and every
diagnostic is about a specific place in a specific file. This doc
covers the shared shape those verdicts carry and how a surface turns
one into a click.

The parse check itself (how a syntax error is found, and how its line
is recovered from V8) is [parse-check.md](parse-check.md). This is the layer above
it, shared with the header diagnostics.

## The shape

`DiagnosticLocation` (`src/diagnostic-location.ts`):

| Field | Meaning |
|-------|---------|
| `file` | The script's `relativePath`, or a `@require`'s resolved URL |
| `line` | 1-based, in the whole file — optional |
| `column` | 1-based — optional, and only ever present with a line |

- `file` is the identity the **source map** uses (`MappedSegment.url`),
  not a display string. The viewer matches it against its tabs, so
  prettifying it would break the link.
- The two coordinates are independently optional because the producers
  genuinely differ in how much they know. Inventing a column for a
  header problem would be made-up precision.

## Who produces one

| Diagnostic | Where it points |
|------------|-----------------|
| syntax error (parse check) | the offending token, in the file it was written in |
| `unterminated metadata block` | the `// ==UserScript==` line that opened it |
| `no metadata block` | the file, with no line — there is nothing to point at |
| `missing @name`, `missing @match or @include` | the `// ==UserScript==` marker |
| unknown `@grant` (a warning) | the first offending `@grant` line |
| `@require` / `@resource` that won't load | the header line that declared it |

Rules that run through that table:

- **A tag that isn't there has no line of its own.** Those point at the
  marker, because that is the block the missing tag belongs in and
  where the reader has to add it.
- **A file that never loaded has no content to point into.** So the
  location is the *declaration* — the only place the reader can act.
  This is the one case where "we couldn't read a file" still yields a
  location, and it works because the declaration is in a file we *did*
  read.

A failure to fetch the **script itself** produces no location at all.

## Line numbers in the header

`parseHeader` records a 1-based `line` on every `HeaderTag`, and
`startLine` on the block, both counted from the top of the whole
source — which is what the viewer's gutter shows.

- Counting and splitting share one line-terminator rule
  (`LINE_BREAK` in `src/userscript-header.ts`). If they diverged, every
  header diagnostic in a DOS or classic-Mac file would be off by the
  number of lines above it.
- That rule deliberately excludes U+2028/U+2029, unlike `countLines` in
  `composed-source.ts`, which includes them because V8 does. They
  cannot appear in a metadata line anyway.
- Both fields are **optional**: `header` is persisted, so rows stored
  before they existed come back without them. A missing line means "no
  location", never line 0. A refresh re-parses and fills them in.

## Carrying it

Optional fields, each written beside the message it belongs to:

- `StoredScript.errorLocation` — pairs with `errorMessage`.
- `StartupLog.location` — pairs with a parse-time warning.
- `LogEntry.location` — what the Log tab renders.

`errorMessage` no longer carries a `(in …)` suffix. Anything showing it
as plain text has to pair it with `errorLocation` through
`describeDiagnostic`, which is the single phrasing every surface uses.

### Never on its own

`setScriptError(entry, message, location)` writes the pair. They are
one fact in two fields, and a location left behind by a previous
failure would point the reader at a line that has nothing to do with
what the row now says.

- `applyFetchError` and `applyMissing` route through it too, so a
  content-derived location can't survive into a message about a file
  that wouldn't load.
- `validLocation` checks the shape on the way in, at the store and at
  the log. These rows are persisted and later become click targets; a
  malformed line number is not something to discover at render time.

## Rendering it

`appendDiagnostic` (`src/userscript.ts`) paints
`<message> (in <where>)` with the "where" a link.

- It resolves `location.file` to a tab: `@require`s match a tab's
  `fileUrl` directly, and the main script matches `mainDiagFile` — the
  script's `relativePath` when installed, the previewed location
  otherwise. (The main tab's `fileUrl` is its *fetchable* URL, which is
  not what the source map calls it.)
- No tab for that file → plain text, exactly what `describeDiagnostic`
  produces. Real case, not a defensive one: a `@require` whose fetch
  failed never gets a tab, and naming the declaration still helps.
- The anchor gets a real `#file:line:col` fragment so it is copyable
  and shows where it goes, *and* a click handler — because clicking a
  link whose hash already matches the URL fires no `hashchange`, so a
  second click after scrolling away would do nothing.
- A location with no line selects the tab and clears any highlight,
  rather than leaving a previous jump's line looking like this
  navigation's answer.

### Where it shows up

- **Viewer, installed** — the message bar, for an `invalid` row.
  Painted after `setTabs`, since a location can only become a link once
  there are tabs to resolve it against.
- **Viewer, preview** — the banner. Warnings are held structurally
  (`PreviewWarning`), not as rendered text, because `replaceBanner`
  rebuilds their DOM and a flattened location could never come back as
  a link.
- **Log tab** — entries carrying a `location`. Distinct from the
  `sourcemonkey://…:L:C` refs inside a runtime stack trace: those are
  text the script produced and are found by scanning, whereas this is
  structure we derived.
- **Sources page** — hover text only. The dataset is a string channel,
  so the message is flattened there; the row's link opens the viewer,
  which has the clickable form.

## Testing

- `tests/unit/diagnostic-location.test.mjs` — the label and the
  validator, especially what they do with a partial location.
- `tests/unit/userscript-header.test.mjs` — header line numbers across
  leading text, all three line-ending shapes, and a BOM.
- `tests/e2e/diagnostic-links.spec.ts` — clicking through, in both
  viewer modes, for a `@require` error, a header problem, a file-only
  location, a failed `@require`, and a Log-tab warning. The URL hash is
  the assertion of record: it is the viewer's own source of truth for
  view state, so it can't pass while the pane shows something else.
- `tests/bad-examples/` — installable by hand. `unknown-grant.user.js`
  is the only one that isn't invalid; it demonstrates that a *warning*
  gets a location too.
  - The expected locations live in `tests/fixtures/bad-script-cases.mjs`
    and are pinned twice: by `bad-scripts.spec.ts` against the stored
    `errorLocation` in Chromium, and by
    `tests/unit/validate-userscripts.test.mjs` against the offline CLI's
    report under Node. Both go through `locationPattern`, so the two
    engines' answers stay checked against each other.
  - Lines are read off each example's `>>> the error` marker rather than
    written down, except for the header failures — those are about a tag
    that isn't there, so there is no line to mark and the case states it.
