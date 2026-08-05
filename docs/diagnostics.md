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
| "the … metadata block is never closed" | the `// ==UserScript==` line that opened it |
| "no `// ==UserScript==` metadata block" | the file, with no line — there is nothing to point at |
| "no `@name`" / "no `@match` or `@include`" | the `// ==UserScript==` marker |
| unknown `@grant` (a warning) | the first offending `@grant` line |
| `@require` / `@resource` that won't load | the header line that declared it |

The header messages are exported constants rather than inline literals,
so a rewording can't quietly stop matching what compares against them:

| Constant | Module |
|----------|--------|
| `UNTERMINATED_METADATA_BLOCK`, `NO_METADATA_BLOCK` | `userscript-header.ts` |
| `NO_NAME`, `NO_MATCH_OR_INCLUDE` | `script-store.ts` |

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

## Rejected registrations

Chrome refusing `chrome.userScripts.register` is the one verdict about
a script that **we don't author and can't locate**. It belongs here as
the exception that shapes the rules above.

- **Not a load failure.** The row is `status: 'ok'` — the file was
  read, the header parsed, the code compiled. It just never runs. That
  is its own display status, `rejected` / REJECTED, ranked directly
  under `invalid` in `effectiveScriptStatus`.
- **Not a diagnostic.** It carries no `DiagnosticLocation`: Chrome
  names the offending value in its own coordinates (`matches[1]: Empty
  path`), and we have no mapping from that back to a header line.
- **Chrome's wording is passed through verbatim.** It names the tag and
  the index, which is what the reader has to fix. Rewriting it in our
  own voice would lose that and risk drifting from what Chrome
  actually objected to. Only the framing around it is ours, and it
  lives in one place — `describeRejection` in `script-rejection.ts`,
  listed under [One string, one place](#one-string-one-place).

Why the gap exists at all: `validateHeader` checks that a script *has*
a `@match`/`@include`, not that Chrome's stricter match-pattern grammar
accepts it — see [file-index](file-index.md) for `src/script-rejection.ts`,
which holds the state, and [injection.md](injection.md#rejected-registrations)
for the registration path that produces it.

## Wording

One message per problem, phrased to survive every place it lands.

- **Lowercase, no trailing period, subject included.** The same string
  appears alone in the message bar and the Log tab, *and* after the
  preview's `This file cannot be installed: ` prefix. A capitalized
  sentence breaks the second; a bare fragment (`missing @name`) reads
  badly in all three.
  - A period would also land in the wrong place: surfaces render
    `<message> (in <where>)`, so it would sit before the parenthetical.
  - For the same reason, a message carrying a location shouldn't end
    with an instruction — `… — add a // ==/UserScript== line (in f, line
    1)` reads as *where to add it*, which is not what line 1 is.
- **No prefix the location already carries.** The parse check says
  `syntax error: …`, not `script source has a syntax error: …` — the
  location names the file, which is routinely a `@require`.
- **Name the thing that failed.** `@require` names its ref; `@resource`
  names both its name and its ref, because the name alone doesn't say
  what wouldn't load.
- **Friendly is not vague.** Dropping our vocabulary can't also drop the
  facts. Name the *step* that failed, not just the subsystem it was in —
  `failed reading this script's stored GM values during setup` leaves
  somewhere to start; `could not load your settings` doesn't.
- **Don't guess between causes.** Where the pipeline genuinely can't
  tell (`FETCH_FAILED`), the message states the possibilities and
  TODO.md tracks the plumbing that would narrow it. Where it can, it
  says which.
- **Say when it's ours.** A failure the user can't act on is prefixed
  `internal error:` rather than phrased as an accusation.

Two consequences worth stating outright:

- **The install preview holds no wording of its own.** It wraps the
  store's string. It used to keep parallel sentences for the two
  metadata-block failures, which meant one problem had two texts and
  only one of them ever improved.
- **The version-probe rows are the deliberate exception.**
  `version-probe-fetch.ts` keeps its own terse set (`could not fetch`,
  `no @version`, `no metadata block`) because they render as a value in
  a definition-list cell, where a full message doesn't fit. Listed in
  TODO.md so the exception stays a decision rather than a leftover.

### Beyond diagnostics

The same rules govern every string a user can read, not just the
verdicts about a script's content:

- **Log rows about our own machinery** (`script-updater.ts`,
  `background.ts`, `injector.ts`) — `could not check for updates`, not
  `update check threw`; `this script was removed while it was being
  refreshed`, not `row vanished`.
- **Source-level failures** — `this source did not load`, not `scan
  failed`. "Scan" is the pipeline stage's name; the sources page never
  shows it.
  - Phrased so it doesn't echo what follows it. `scanError` values
    usually open with their own `could not read <url>: …`, so a
    `could not …:` wrapper would say "could not" twice running.
- **Errors GM APIs throw back into script code** — the audience is the
  script's author, so `GM_openInTab: url required` stays as it is. Only
  *our* internals get rewritten, and a failure in our plumbing gets the
  `internal error:` prefix so it doesn't read as the script's fault.

Two capitalization conventions coexist, and both are correct:

- **Diagnostics and Log rows are lowercase fragments** — they get
  wrapped by prefixes and `(in <where>)` suffixes.
- **The viewer's `setMessage` copy is a standalone sentence**
  (`Install failed: …`, `This script is already installed.`) — nothing
  wraps it, and it sits alone in the message bar.

### One string, one place

Where a message reaches more than one surface it lives in one
constant, so the copies can't drift:

| Helper | Covers |
|--------|--------|
| `gmXhrError` (`gm-connect.ts`) | every failure `GM_xmlhttpRequest` hands back to a script |
| `connectBlockedMessage` (`gm-connect.ts`) | the pre-flight and post-redirect `@connect` denials |
| `NO_ORIGINATOR_TAB` (`background.ts`) | the GM handlers that reply when the calling tab can't be identified |
| `NOTIFICATIONS_UNAVAILABLE` (`gm-notification.ts`) | both guards on `chrome.notifications` |
| `LOCATION_SHAPES` (`directories.ts`) | the add-source and preview validators' description of a valid location |
| `gmValuesFailure` (`gm-bindings.ts`) | the injected console line and the `sm:error` payload |
| `describeRejection` (`script-rejection.ts`) | the refused-registration sentence, in the Log row and the viewer's message bar |

The last one is the cautionary case: it was two literals, and the Log
copy had already lost the "reload the page to retry" half — the only
part the reader could act on.

### Blame the right thing

Sharper wording makes a wrong attribution worse, so a message that
names a culprit has to be reachable only when that culprit is real:

- `isUrlConnectAllowed` returns `denied` alongside `reason`. A URL that
  wouldn't parse fails the check without the header having refused
  anything, so only `denied: true` goes through
  `connectBlockedMessage` — otherwise a script with `@connect *` would
  be told its own rules blocked a relative URL.
- `loadConnectPolicy` splits "this script is gone" (a race the user
  fixes by reloading) from "its header is missing" (ours). The first
  must not carry the `internal error:` prefix.

## Testing

- `tests/unit/diagnostic-location.test.mjs` — the label and the
  validator, especially what they do with a partial location.
- `tests/e2e/rejected-registration.spec.ts` — the REJECTED state end to
  end, driven by a `@match` with an empty path (valid to us, invalid to
  Chrome).
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
