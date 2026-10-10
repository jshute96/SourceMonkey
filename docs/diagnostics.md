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
| "The … metadata block is never closed" | the `// ==UserScript==` line that opened it |
| "No `// ==UserScript==` metadata block" | the file, with no line — there is nothing to point at |
| "No `@name`" / "No `@match` or `@include`" | the `// ==UserScript==` marker |
| unknown `@grant` (a warning) | the first offending `@grant` line |
| a `@match` Chrome's grammar refuses (a warning) | the `@match` line that declared it |
| "`@match <pattern>` has no path, so this script would never run…" | the first offending `@match` line, when no pattern is usable |
| `@require` / `@resource` that won't load | the header line that declared it |

The header messages are exported constants rather than inline literals,
so a rewording can't quietly stop matching what compares against them:

| Constant | Module |
|----------|--------|
| `UNTERMINATED_METADATA_BLOCK`, `NO_METADATA_BLOCK` | `userscript-header.ts` |
| `NO_NAME`, `NO_MATCH_OR_INCLUDE`, `SYNTAX_ERROR_PREFIX` | `script-build.ts` |
| `ignoredMatchMessage`, `unusableMatchMessage` | `url-match.ts` |

The same rule covers anything that *recognizes* a message rather than
prints it. The corpus validator (`validate-corpus.mjs`) groups its
survey by message, and used to do it with regexes over the wording —
which went stale silently the first time these were recased, mislabelling whole
buckets without failing. It now imports `SYNTAX_ERROR_PREFIX`, and calls
`isFetchFailureMessage` (`external-files.ts`) and
`unusableMatchGroupKey` (`url-match.ts`) — each derived from the
function that writes the message, and pinned by a unit test.

Rules that run through that table:

- **A tag that isn't there has no line of its own.** Those point at the
  marker, because that is the block the missing tag belongs in and
  where the reader has to add it.
  - The unusable-`@match` failure is the near miss that proves the
    rule: it reads like the missing-pattern one, but the offending
    text *is* in the file, so it gets that line rather than the
    marker.
- **A file that never loaded has no content to point into.** So the
  location is the *declaration* — the only place the reader can act.
  This is the one case where "we couldn't read a file" still yields a
  location, and it works because the declaration is in a file we *did*
  read.

A failure to fetch the **script itself** produces no location at all.

## Line numbers in the header

`parseHeader` records a 1-based `line` on every `HeaderTag`, and
`startLine` on the block, both counted from the top of the whole
source file — which is what the viewer's gutter shows.

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

- `applyFetchError` routes through it too, so a content-derived
  location can't survive into a message about a file that wouldn't
  load.
- `validLocation` checks the shape on the way in, at the store and at
  the log. These rows are persisted and later become click targets; a
  malformed line number is not something to discover at render time.

## Rendering it

`appendDiagnostic` (`src/extension/userscript.ts`) paints
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
- **Collections page** — hover text only. The dataset is a string channel,
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
  names the offending value in its own coordinates (`matches[1]:
  Invalid port`), and we have no mapping from that back to a header
  line.
- **Not every refusal Chrome gives.** `Duplicate script ID '<id>'` is
  a fact about our own ordering — the id is already placed — so the
  registration replaces it rather than filing it against the script.
  See [injection.md](injection.md#one-registration-operation-at-a-time).
- **Chrome's wording is passed through verbatim.** It names the tag and
  the index, which is what the reader has to fix. Rewriting it in our
  own voice would lose that and risk drifting from what Chrome
  actually objected to. Only the framing around it is ours, and it
  lives in one place — `describeRejection` in `script-rejection.ts`,
  listed under [One string, one place](#one-string-one-place).

Why the gap still exists: `matchPatternProblem` reproduces the shapes
of Chrome's match-pattern grammar we are sure about — those become
located warnings or an INVALID row before anything is registered (see
[matching.md](matching.md#patterns-chrome-refuses)) — but not the whole
parser, because a false positive would drop a pattern that works. What
reaches REJECTED is the remainder: a malformed port, a host Chrome's
canonicalizer rejects, or whatever it tightens next. See
[file-index](file-index.md) for `src/extension/script-rejection.ts`, which holds
the state, and [injection.md](injection.md#rejected-registrations) for
the registration path that produces it.

## Refreshes that could not be saved

A refresh that read everything successfully and then failed to store it.
Sibling to [rejected registrations](#rejected-registrations): another
verdict about a script's *fate* rather than its content.

- **Not a script-level fact at all.** It belongs to the collection, not
  to any row under it — every script failed together, for a reason that
  has nothing to do with any of them. So it carries no
  `DiagnosticLocation` and never touches `errorMessage`.
- **Not `scanError` either.** That one means the listing failed and
  nothing was fetched. This means the listing and every fetch worked and
  the *write* failed. Both can be present at once, from different
  attempts, so a section shows both lines.
- **The scripts are fine and still running.** Nothing was written, so
  every row keeps the content it had. The message says so — what the
  reader needs to know is that what they see on the page is not what is
  on disk, not that something is broken.
- **One string, one place**: `describeRefreshError` in
  `src/extension/refresh-error.ts`, listed under
  [One string, one place](#one-string-one-place).
- **The reason is ours, not Chrome's.** An out-of-quota write rejects
  with `Resource::kQuotaBytes quota exceeded` (the exact text varies by
  Chrome version), which is internal vocabulary.
  - `writeLocal` in `script-store.ts` replaces it with
    `storageFullMessage()` before it reaches any surface — see
    [storage.md](storage.md#write-failure-report-dont-lose-it).
  - Its heading matches the page banner's, so the two read as one
    condition rather than two.

Where it shows up:

- **Per collection**, as a message line in that section, next to a
  `scanError` line if there is one.
- **Page banner** on the collections page, which adds the one thing the
  per-collection message can't: how full storage actually is. That turns
  "the write failed" into "you are out of space, remove something",
  which is the only version the reader can act on.
- **Not on the toolbar badge.** The badge is per-tab — its count is the
  scripts expected ∪ actual for *that document* — so a global condition
  rendered there would claim something about every unrelated page. See
  [matching.md](matching.md).

## Wording

One message per problem, phrased to survive every place it lands.

- **Capitalized, no trailing period, subject included.** The same
  string appears alone in the message bar and the Log tab, *and* after
  the preview's `This file cannot be installed: ` prefix. A capital
  after that colon is fine — what isn't is a bare fragment (`Missing
  @name`), which reads badly in all three.
  - A period would land in the wrong place: surfaces render
    `<message> (in <where>)`, so it would sit before the parenthetical.
  - For the same reason, a message carrying a location shouldn't end
    with an instruction — `… — add a // ==/UserScript== line (in f, line
    1)` reads as *where to add it*, which is not what line 1 is.
  - **Anything after a `: ` is a message too, so give it a subject.**
    `describeFetchFailure` / `describeResolveFailure` used to return
    predicates (`is empty`, `is not a valid URL`) that only parsed as
    English once `@require lib.js` was glued on the front. They now
    return sentences — `The file is empty`, `The reference is not a
    valid URL` — so the capital is grammatical rather than a capital
    dropped onto a verb.
    - Dropping the old `could not be fetched: ` half also removed a
      second colon from a string that already lands after one.
  - **A multi-sentence banner is the one exception**, because the rule's
    reasons don't reach it: it lands in exactly one place, takes no
    prefix, and carries no `(in <where>)`. Ordinary punctuation wins
    over a rule about strings that get spliced — see the viewer's
    *This script is already installed. Select which instance to update or install.*
    Anything that can be spliced still takes no period.
- **No prefix the location already carries.** The parse check says
  `Syntax error: …`, not `Script source has a syntax error: …` — the
  location names the file, which is routinely a `@require`.
- **Name the thing that failed.** `@require` names its ref; `@resource`
  names both its name and its ref, because the name alone doesn't say
  what wouldn't load.
- **Friendly is not vague.** Dropping our vocabulary can't also drop the
  facts. Name the *step* that failed, not just the subsystem it was in —
  `Failed reading this script's stored GM values during setup` leaves
  somewhere to start; `Could not load your settings` doesn't.
- **Don't guess between causes.** Say which. Where a helper knows the
  cause but its return type doesn't carry it, widen the return type
  rather than writing a message that lists possibilities — that is
  what `FetchFailReason` and `ResolveFailReason` (`file-loader.ts`)
  exist for, and `describeFetchFailure` / `describeResolveFailure`
  (`external-files.ts`) are the only place they become words.
  - Genuinely indistinguishable causes stay merged, and say so — but
    only where they really are. A `file://` read has no HTTP layer, so
    "the file isn't there" and "the file can't be read" arrive
    identically and share one message. A timeout does *not* qualify:
    our own abort sets `signal.aborted`, so it gets its own reason.
- **Say when it's ours.** A failure the user can't act on is prefixed
  `Internal error:` rather than phrased as an accusation. The GM-API
  errors below are the exception: they keep the lowercase prefix,
  because they are spliced into a `[SourceMonkey] GM_*: ` line.

Two consequences worth stating outright:

- **The install preview holds no wording of its own.** It wraps the
  store's string. It used to keep parallel sentences for the two
  metadata-block failures, which meant one problem had two texts and
  only one of them ever improved.
- **The version-probe rows are the deliberate exception.**
  `version-probe-fetch.ts` keeps its own terse set (`could not fetch`,
  `no @version`, `no metadata block`) because they render as a value in
  a definition-list cell, where a full message doesn't fit. Lowercase
  for the same reason: they sit in a table cell beside `same` and
  `unknown`, as values rather than sentences. Listed in TODO.md so the
  exception stays a decision rather than a leftover.

### Beyond diagnostics

The same rules govern every string a user can read, not just the
verdicts about a script's content:

- **Log rows about our own machinery** (`script-updater.ts`,
  `background.ts`, `injector.ts`) — `Could not check for updates`, not
  `update check threw`.
- **Collection-level failures** — `This collection did not load`, not `scan
  failed`. "Scan" is the pipeline stage's name; the collections page never
  shows it.
  - Phrased so it doesn't echo what follows it. `scanError` values
    usually open with their own `Could not read <url>: …`, so a
    `could not …:` wrapper would say "could not" twice running.
- **Errors GM APIs throw back into script code** — the audience is the
  script's author, so `GM_openInTab: url required` stays as it is. Only
  *our* internals get rewritten, and a failure in our plumbing gets the
  `internal error:` prefix so it doesn't read as the script's fault.

One capitalization convention, with carve-outs:

- **Every message a user reads starts with a capital and ends without
  a period** — diagnostics, Log rows, banners, and the viewer's
  `setMessage` copy alike (`Install failed: …`, `This script is already
  installed`, `Checked for updates and found no change`).
  - "No period" is about a *single-sentence* message. Copy that is
    genuinely two sentences punctuates all of them, last one included —
    `Syntax error: … (in a.user.js, line 12). Installing it will store
    it as INVALID.`
  - **A statement plus a fix is two sentences**, not one joined by a
    dash: `This location is a manifest. Choose Manifest as the type.`
    Same for `Script not found in storage. Open it from the
    collections page.`
  - The subject-plus-shapes messages (`Location must be a URL or
    absolute file path`) stay one sentence with no period.
  - **No em-dashes in any user-visible text** (messages, Log rows,
    tooltips, UI copy, console diagnostics). Use a colon, comma,
    parentheses, or two sentences instead.
  - Wrapping doesn't change that. `This file cannot be installed: No
    @name in the metadata block` is the intended reading: the prefix is
    its own clause, and the message keeps its capital wherever it lands.
- **The carve-out is mid-*sentence* splices, not post-colon tails.**
  `LOCATION_SHAPES` stays lowercase because it completes a sentence we
  wrote — `Location must be a URL or absolute file path`. A capital
  there would land inside the sentence. A tail after `: ` is not that
  case: it starts its own clause, so it gets a capital, and if it can't
  take one grammatically it wants rewriting rather than exempting.
- **Some surfaces stay lowercase for reasons of their own**, each
  documented where it lives: the service-worker console lines
  ([logging.md](logging.md#message-catalog)), the version-probe table
  values above, and the errors GM APIs hand back to script code. None
  of them is a message a user reads in our UI.
- **Static page copy is not a message.** Headings and empty-state prose
  (`No collections yet. Add one above.`, `File access is disabled.`) are
  layout text, not a report of an outcome, and punctuate as ordinary
  writing. The line is whether the string tells the user what just
  happened: a banner does and follows the message rule, a heading that
  is always on screen does not.

### One string, one place

Where a message reaches more than one surface it lives in one
constant, so the copies can't drift:

| Helper | Covers |
|--------|--------|
| `gmXhrError` (`gm-connect.ts`) | every failure `GM_xmlhttpRequest` hands back to a script |
| `connectBlockedMessage`, `connectDeniedMessage`, `connectCancelledMessage`, `connectUnansweredMessage`, `connectPromptFailedMessage` (`gm-connect.ts`) | the pre-flight and post-redirect `@connect` refusals |
| `NO_ORIGINATOR_TAB` (`background.ts`) | the GM handlers that reply when the calling tab can't be identified |
| `NOTIFICATIONS_UNAVAILABLE` (`gm-notification.ts`) | both guards on `chrome.notifications` |
| `LOCATION_SHAPES` (`file-locations.ts`) | the Add-field and preview validators' description of a valid location |
| `gmValuesFailure` (`gm-bindings.ts`) | the injected console line and the `sm:error` payload |
| `describeRejection` (`script-rejection.ts`) | the refused-registration sentence, in the Log row and the viewer's message bar |
| `describeRefreshError` (`refresh-error.ts`) | the could-not-be-saved sentence, in the collection's section message |
| `storageFullMessage` (`script-store.ts`) | the out-of-storage reason, wherever a refused `chrome.storage.local` write is reported |
| `HTTP_STATUS_PREFIX` (`external-files.ts`, private) | shared by `describeFetchFailure` and `isFetchFailureMessage`, so printing and recognizing can't disagree |
| `markupResponseMessage` (`markup-response.ts`) | "we got a web page, not JavaScript", from the script fetchers and the `@require` gate alike |

The last one is the cautionary case: it was two literals, and the Log
copy had already lost the "reload the page to retry" half — the only
part the reader could act on.

### Blame the right thing

Sharper wording makes a wrong attribution worse, so a message that
names a culprit has to be reachable only when that culprit is real:

- `decideConnect` answers `invalid` for a URL that wouldn't parse,
  apart from `deny`. The header refused nothing there, so only `deny`
  goes through `connectBlockedMessage`. Otherwise a script with
  `@connect *` would be told its own rules blocked a malformed URL.
- A host the user denied says so (`connectDeniedMessage`), not that
  the rules blocked it: the rules asked, and the user answered.
- `loadConnectPolicy` splits "this script is gone" (a race the user
  fixes by reloading) from "its header is missing" (ours). The first
  must not carry the `internal error:` prefix.
- `markupResponseMessage` names the server or the local file, never
  both: blaming a server for bytes that came off local disk is a flatly
  wrong diagnosis, and the usual way to hit the local case is a
  *directory* whose name matches the ref, which Chrome answers with a
  generated HTML listing.
  - It quotes the `Content-Type` only when the header is what proved
    it. Body-sniffed markup leaves it out — quoting `text/plain` next
    to a claim that the response is HTML reads as a contradiction.

## Measuring where a refresh's time goes

A diagnostic for "the refresh felt slow", which nothing else answers —
the Log tab records what a refresh *decided*, never what it cost.

Turn on **Options → Debug logging**, then click Refresh. Each phase
group emits one line via `src/phase-timing.ts`.

### Where to look

The refresh pipeline runs in the **collections page**, not the service
worker — `collections.ts` imports `script-updater` directly. So the
lines land in two consoles, and you need both:

| Console | Lines |
|---------|-------|
| Collections page (F12) | `collection check`, `collection refresh` |
| Service worker (`chrome://extensions` → *service worker*) | `registration sync` |

### Reading it

```
timing: collection refresh: total 34ms (read 3.9, scan 8.7, fetch 0.4,
  rebuild 0.7, write 21); /path/to/scripts, 5 scripts, 5 unchanged,
  rows written: 0
```

- **read** — loading the collection and its existing script rows.
- **scan** — the directory listing. Sibling directories are listed
  together, so it grows with tree DEPTH (each level waits on the one
  above) rather than with directory count or script count.
- **fetch** — reading changed files. Near zero when the size+mtime skip
  catches everything; `N unchanged` says how often it did.
- **rebuild** — everything downstream of having the bytes: `@require` /
  `@resource` fetches, hashing, the parse check.
- **write** — the storage write, plus the in-lock re-read. Never zero
  even at `rows written: 0`, because the collection row always goes
  (see [storage.md](storage.md#only-changed-rows-are-written)).

The other two lines cover work the refresh triggers rather than does:

- `collection check` wraps the refresh with the update probes and the
  rejected-registration retry, so it separates "the refresh is slow"
  from "the annotation pass is slow". Its `N of M scripts have a probe
  target` matters — a `0ms` probe leg means nothing to check, not
  everything already fresh.
- `registration sync` is work no one clicked: it runs on a debounce
  *after* the write, so it lands just past the button release and is
  easy to mistake for refresh time. The note says which kind it was —
  `incremental` (only the rows that moved) or `full` (every spec
  rebuilt and reconciled against Chrome's list, which is the startup
  case). A `full` line for anything other than a worker start means
  something dropped the injector's record of the registration set.
- `all-collections check` is the Refresh All wrapper — the prior
  snapshot, plus the probe and rejected-registration passes that run
  once over every script rather than per collection.

### Inside `rebuild`

`rebuild` is a fan-out — every script in the collection is processed
concurrently — so no single sequence describes it. A second line breaks
it down by cumulative time per stage:

```
collection check cumulative (concurrent, sums past wall clock):
  deps 1626ms/46, dep-fetch 761ms/13, parse-check 64ms/46, local-standin 4.5ms/76
```

- `ms/n` is total time and call count. The totals **sum past the wall
  clock** they happened in, because the work overlapped — they answer
  "which stage dominates", which is a ratio, not "how long did it take".
- `deps` is the whole dependency stage per script; `dep-fetch` is the
  network leg inside it, counted once per *unique URL* thanks to the
  cross-script cache. `deps` far exceeding `dep-fetch` is expected and
  not a finding: it is N scripts waiting on the same shared fetches.
- **The count is the number that matters for `dep-fetch`.** Measured on
  a real 46-script collection, its 76 declarations resolved to 13
  fetches at ~58ms each — so `rebuild` tracks unique-dependency count
  times latency, and neither hashing nor the parse check
  (~1.4ms/script) nor local stand-in probing (~0.06ms/probe) is
  material.

### What a healthy run looks like

`registration sync` should appear **once or twice** per Refresh All, not
once per collection and never once per script. A long run of them is the
symptom that led to `onlyAnnotationsChanged` (see
[injection.md](injection.md#lifecycle)): probe results are written one
row at a time, and each write used to schedule its own re-registration.
If they come back, that suppression is the first place to look.

## Measuring an enable click

With **Options → Debug logging** on, each enable or disable prints one
line in the service worker's console, which saves them all
([worker-writes.md](worker-writes.md)). The `registration sync` line
follows. The viewer's versions table prints its own line in the page
too.

| Line | Printed by |
|------|------------|
| `enable script` / `disable script` | a script checkbox (collections page, viewer, popup, sm-dev), and an enable in the viewer's versions table |
| `enable collection` / `disable collection` | a collection checkbox |
| `enable all` / `disable all` | the collections page's bulk toggle |
| `versions table enable` | a checkbox in the viewer's versions table, in the page: the round trip to the worker (`write`), then the redraw |
| `turn off other copies` | an install or move that displaces other copies |
| `enablement write` | any other enable write (only the write's own steps) |

The shape of a line (numbers illustrative):

```
timing: enable script: total 24ms (find copies 0.3 [3 script(s)],
  lock wait 0.1, re-read 0.5 [4 keys, 9 KB], plan 0.4, read rows 0.3
  [3 keys, 9 KB], read collections 0.1 [1 key, 0.4 KB], write 9.8
  [3 keys, 9 KB]); 2 change(s)
```

- **find copies**: which copies are related to the ones being changed
  (the same location, or `@namespace` + `@name`). From the worker's
  index over its row cache ([worker-writes.md](worker-writes.md#the-row-cache));
  where there is none, a read of every row.
- **read collection** (collection toggles and Enable all): the
  collection and its scripts' rows.
- **plan**: working out which copies to change.
- **lock wait**: waiting behind other storage writes in the worker.
- **re-read**: the related copies, their collections and the active
  times, read inside the lock to plan from. From the worker's row
  cache, so it stays small even while a sync is reading storage.
- **read rows / read collections**: the rows the write changes,
  re-read inside the lock. `read collection` is the toggled collection.
- **write**: the one storage write. Every changed script row is
  written whole; its bodies stay in their blobs.
- **repaint** (`versions table enable`, in the page): the table redraw
  the checkbox stays grey for.
- Sizes are JSON lengths, roughly what Chrome stores and copies.
  Computing them is left out of the step times.

After any storage write, the collections page redraws and prints a
`collections page repaint` line. Its note says which kind of pass ran.

- **`N row(s)`**: only script rows changed, so only those are redrawn.
  - **read scripts**: those rows.
  - **read collections**: their collections' rows.
  - **icons / paint**: cached favicons for them, then updating those
    rows and the "could not save" banner.
- **`all rows`**: anything else, or a change those rows can't take in
  place (see `repaintScriptRows`).
  - **read collections / banner**: the collection rows, and the "could
    not save" banner's check.
  - **read scripts**: every collection's script rows in one read,
    without their bodies.
  - **size**: asking Chrome how big those rows are.
  - **icons / paint**: cached favicons, then updating the rows.
  - A pass that started as a rows-only one and found it couldn't shows
    its own `read scripts`, and maybe `read collections`, first.

The `registration sync` line that follows has these steps:

- **read / labels / read bodies / build-specs**: the changed rows
  (and, as `read collections`, any collection rows the sync hadn't
  seen); the log labels, and any rows a label change moved; the bodies
  of those that will be registered; and what Chrome is given to
  register.
  - Rows come from the worker's row cache once it's loaded; bodies
    still come from storage.
  - The labels use the script numbers the worker assigned just before
    the sync.
  - A full sync reads rows and bodies under `read`. Its note says how
    many specs Chrome already held exactly (no call), how many more went
    without their code, and how many registrations it dropped.
  - An incremental sync's note says how many specs it rebuilt the same
    as it last placed them (`in place`, no call).
- **list** (full syncs only): asking Chrome which registrations it
  holds.
- **compare** (full syncs only): which of them Chrome already holds
  exactly, or with the same code.
- **unregister / register**: the `chrome.userScripts` calls, removals
  first.
- **unregister after** (only when needed): removals Chrome may not hold,
  and scripts it just refused that it already held.
- **read rejections / write rejections**: the list of scripts Chrome
  refused, which shows them as REJECTED. It is read alongside the
  calls above, so `read rejections` is only the wait left after them.

Around the steps:

- A worker's first sync is incremental when it took the last worker's
  record ([injection.md](injection.md#startup-the-record-or-a-full-reconcile)):
  its scope is the rows that changed while no worker ran. A
  `registration record` line before it says whether the record was
  taken, and if not, why.
- The console line after a sync names what is in place with
  `chrome.userScripts`; after a full sync, how many registrations were
  sent and how many Chrome already held. An incremental sync that
  rebuilt some the same says how many it sent and how many it left; one
  that sent nothing and dropped nothing prints no line.

## Measuring a missed reload swap

The [reload fast-path](injection.md#reload-fast-path) races a refresh
against a 500 ms window measured from reload commit. When it loses, the
page keeps the old body and the badge goes purple — so the question is
always *which* part of the budget ran out. Everything lands in the
**service worker** console.

### The outcome line (no debug logging needed)

```
reload fast-path: <name> update not detected within 500ms
  (asked at 140ms, waited 360ms); running prior version
reload swap: <name> loadedAt A -> B (asked at 120ms, decided at 260ms of 500)
```

- **asked at** — commit → the wrapper's `sm:check-pending`. Chrome's
  injection plus our setup; nothing the refresh can do about it.
- **waited / decided at** — how much of the rest the refresh used.

Which number is large tells you where to look, and they have different
fixes: a large *asked at* is worker wake-up and match-index load, a
large *waited* is the per-script check below.

### With debug logging on

| Line | What it covers |
|------|----------------|
| `reload fast-path setup` | `ensure-loaded` (the match index — a full read on a cold worker) then `start-checks` |
| `script check` | one per script, the same phase names as `collection refresh` |
| `reload fast-path cumulative` | one for the batch, breaking `rebuild` into its concurrent stages |

```
timing: script check: total 731ms (read-script 38, read-collection 169,
  stat 17, fetch 23, rebuild 450, write 34)
  — garmin/upload.user.js, 46 KB row, refetched
timing: reload fast-path cumulative: parse-check 448ms/3, build 2.8ms/1, deps 0.3ms/3
```

- **read-script / read-collection** — two point reads, in series because
  the collection key comes out of the script row. Marked separately
  because the split was the diagnosis: `read-collection` *used to* run
  3–4× `read-script` despite reading a far smaller row. The cause was
  an unrelated full-namespace scan on the same thread — see
  [the case study](#read-collection-is-still-slow).
  - **`gets: script Xms, collection Yms`** is what settled that, and
    what to check first if either phase looks wrong again. Printed by
    whichever check performed the read; sharers print `collection row
    shared with batch` instead.
  - The phase spans from the caller's own script read to the row
    arriving, so it includes time the worker spent elsewhere;
    `gets` is the read alone.
  - **A small `gets` under a large phase means the row is fine and
    something else held the thread.** Look for a storage scan next.
- **stat** — the `file://` directory listing that supplies the
  size+mtime the skip check needs.
  - **`read directly`**: a page-load check read the file itself instead,
    which gives the same size+mtime and the body with it (see
    [local-file-overrides.md](local-file-overrides.md#page-load-checks)).
    `stat` then covers that read, and `fetch` costs nothing.
- **`local-standin` / `dep-fetch`** in the cumulative line — the
  stand-in lookups, and the file reads inside them. A script's lookups
  run at once, so their sum can pass `deps`; on a page-load check the
  known stand-ins' reads start with the script read, overlapping `stat`
  too.
- **`collection row shared with batch` / `listing shared with batch`** —
  the navigation-triggered checks for one page share both (see
  [injection.md](injection.md#shared-work-across-the-batch)), so only
  the first of a batch pays. The phases are still marked on the
  sharers: what they measure there is the wait for the batch's single
  read, which on one thread still queues behind the siblings' own work.
- **read-bodies** — waiting for the script's stored code (its blobs),
  whose read starts with the check and runs alongside `stat`. Usually
  0; the read's own time is the `bodies` note. `read-script` itself is
  the row from the worker's row cache, so usually no storage call.
- **fetch** — `unchanged` means the size+mtime skip hit and no body was
  read; `refetched` means it missed.
- **`nothing to write`** — the rebuilt row matched the stored one, so
  `write` took neither the store's lock nor a storage call.
- **rebuild** — header parse, hashing, the parse check, and the
  `@require` / `@resource` pass. The cumulative line says which:
  measured on a real 3-script page, `parse-check` was 448 of 450 ms and
  `deps` was 0.3 ms.
- The parse check runs only for content that changed, and compiles in a
  sandboxed iframe inside an offscreen document. Creating that document
  is the expensive part, so the first check after an extension update —
  which invalidates every cached verdict, since `parseCheckKey` includes
  the version — is the worst case by an order of magnitude. Observed:
  2306 ms, then 336, then 48.

Two things that are **not** on the critical path but land in these
numbers anyway, both because the worker is single-threaded:

- `registration sync`, on a 50 ms debounce after the write the fast
  path just made. It reads only the rows that moved, so this is far
  smaller than it was — a `full` line here means it read everything.
- The other checks in the same batch. Every await one of them makes
  costs its siblings' measured time as well as its own — which is why
  no phase drops to zero even now that the duplicate work is shared.
- Any **storage scan** that overlaps the window (below).

### Storage scans

```
timing: storage scan (registration sync): 183ms, 266 keys, 4.1 MB
```

The size comes from Chrome (`getBytesInUse`), not from serializing the
rows, so measuring it costs this thread nothing.

- A `chrome.storage.local.get(null)` returns **every row the extension
  owns** — script bodies, `@require` / `@resource` payloads, favicons,
  `gmval:` rows — however narrow the caller's interest is.
- The read is one cost; deserializing the result into JS objects is the
  other, and that runs on the *calling context's* single thread. While
  it does, unrelated pending callbacks in that context wait. So a scan
  inflates phases that have nothing to do with it.
- The line names the caller, because that is the part a reader needs:
  `all scripts`, `key migration`, `blob migration`, `gm value wipe`.
- The same line also reports the narrow reads of every script row
  (`scanStorageRows`). These list the keys and read only the rows, so
  they skip the bodies and GM values:
  - `row cache`: the worker's, which the match index, log labels,
    numbers, registration sync, registration record and membership
    repair read once loaded.
  - Those readers' own scans, when the cache isn't loaded: `match
    index`, `log id table`, `registration sync`, `registration record`,
    `membership reconcile`.
  - `new copies`, and `all script rows` (pages, and the worker before
    its cache is on).
  - The extension-update backfills: `startup log backfill`, `header
    check backfill`, `retired header check`.
- Measured on a 266-row profile, a scan costs **129–193 ms** whoever
  asks. That is the unit to price any new one against.

#### `gm snapshot (narrow)`

The same line for a read that is deliberately *not* a scan.

- The check-pending handler starts a GM value read in parallel with the
  swap decision whenever the wrapper set `needsValues` — i.e. for any
  storage-granting script on the page — so it lands **inside** the
  500 ms window.
- It used to scan the whole namespace for one script's `gmval:` rows,
  at a measured 155 ms of that budget. It now lists keys and reads only
  the matching rows: 36–41 ms on the same profile.
- A plain **`gm snapshot`** line means the browser had no `getKeys()`
  and it fell back to the scan.

### Case study: what made `read-collection` slow {#read-collection-is-still-slow}

Worth reading before optimising anything else here, because the first
two diagnoses were both wrong and the log said so each time. Measured on
one 192-script profile, same page, three scripts:

| | `read-script` | `read-collection` |
|---|---|---|
| One read + one listing per script | 28–53ms | 103–169ms |
| Shared across the batch | 30–33ms | 129–149ms |
| Shared, and the `gm snapshot` scan narrowed | 39–44ms | 12–44ms |

- **First guess: payload.** Wrong — the collection row is a few fields
  and the script row carries 63 KB of source, yet the small one read
  4× slower.
- **Second guess: duplicate work.** Also wrong on its own. Sharing the
  row and the listing across the batch is real (the annotations prove
  one read and one listing happened) and it did **not** move the
  number.
- **Actual cause: something else owned the thread.** The check-pending
  handler's GM snapshot was a full-namespace scan, running from
  `asked at 72ms` for 155 ms — straight across the collection reads.
  Deserializing it blocked the worker, so the read's callback simply
  could not run. Narrowing that read (see above) took ~100 ms off a
  phase that never had anything to do with collections.
- **Both effects were real; the big one hid the small one.** With the
  thread free, the batch's sharing is finally visible in the numbers:
  joiners pay 12–14 ms against the owner's 44 ms.
- `gets: collection 43ms` under `read-collection 44` is what "no hidden
  wait remains" looks like. That agreement is the check to repeat
  before believing any future number from this phase.

The lesson worth keeping:

- **A phase in a single-threaded context measures its own work plus
  whoever else is holding the thread.** Nothing in its name says which
  you are looking at.
- So pair a phase with a measurement of the operation *inside* it
  before concluding anything about that operation.

## Testing

- `tests/unit/diagnostic-location.test.mjs` — the label and the
  validator, especially what they do with a partial location.
- `tests/e2e/rejected-registration.spec.ts` — the REJECTED state end to
  end, driven by a `@match` with a malformed port (valid to us, invalid
  to Chrome — the empty-path case it used to use is now caught before
  registration).
- `tests/unit/url-match.test.mjs` — the `@match` grammar check, and the
  invariant that everything it flags is a pattern `matchPattern` could
  never match anyway.
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
    `tests/unit/harness/validate.test.mjs` against `sm-dev validate`'s
    output under Node. Both go through `locationPattern`, so the two
    engines' answers stay checked against each other.
  - Lines are read off each example's `>>> the error` marker rather than
    written down, except for the header failures — those are about a tag
    that isn't there, so there is no line to mark and the case states it.
