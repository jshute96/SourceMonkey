# GreasyFork corpus

Tools and data for testing SourceMonkey against real-world userscripts: the
2000 most-installed scripts on [GreasyFork](https://greasyfork.org), downloaded
with their dependencies, plus a record of what testing each one found.

This README covers the tools and data. For how to test scripts on their
live sites and record results (also for agents), see the `corpus-testing`
skill in [`.claude/skills/corpus-testing/`](../../.claude/skills/corpus-testing/SKILL.md).

## Overview

### State files

| File | In git | Contents | Written by | Read by |
|------|:------:|----------|------------|---------|
| `greasyfork-dump/` | no | GreasyFork listing pages, saved by hand from a browser | you ([how](#why-the-pages-are-saved-by-hand)) | `fetch-top-scripts.mjs` |
| `corpus.json` | yes | One record per script: its GreasyFork `listing` stats, plus test findings | `fetch-top-scripts.mjs` (listings), `record-results.mjs` (findings) | every tool |
| `files/` | no | Downloaded scripts and their `@require` / `@resource` files (~270 MB) | `download-scripts.mjs` | `build-db.mjs`, `record-results.mjs` |
| `download-report.json` | no | Last download run's counts and failures | `download-scripts.mjs` | you |
| `corpus.db` | no | SQLite database of listings, parsed headers, dependencies and findings; rebuilt from scratch each run | `build-db.mjs` | `render-analysis.mjs`, ad hoc SQL |
| `analysis.sql` | yes | The queries behind `analysis.html` | you | `render-analysis.mjs` |
| `analysis.html` | yes | Corpus statistics report | `render-analysis.mjs` | you |
| `results.html` | yes | Static page that reads `corpus.json` and shows a sortable, filterable table of every script's validity, test status, tags and notes | you (hand-written) | you, in a browser |

`corpus.json` is the source of truth. Everything not in git can be rebuilt
from it, except `greasyfork-dump/`, which is only needed to refresh the
listing.

### Scripts

| Script | Reads | Writes | Does |
|--------|-------|--------|------|
| `fetch-top-scripts.mjs` | `greasyfork-dump/` | `corpus.json` listings | [Extracts](#extracting) the top scripts from the saved pages |
| `download-scripts.mjs` | `corpus.json` | `files/`, `download-report.json` | [Downloads](#downloading-the-scripts-themselves) each script, then its dependencies |
| `record-results.mjs` | `corpus.json`, `files/` | `corpus.json` findings | **Records individual facts about one script at a time** (a test result, tag or note) as you learn them. [More](#test-results). Its `validate` subcommand is the one bulk step |
| `build-db.mjs` | `corpus.json`, `files/` | `corpus.db` | [Loads everything into SQLite](#analysis-database) |
| `validate-corpus.mjs` | `files/` | stdout, `--json` file | [Validates](#validating-the-corpus) every downloaded script offline; `record-results.mjs validate` runs it |
| `render-analysis.mjs` | `corpus.db`, `analysis.sql` | `analysis.html` | Renders the statistics report |
| `serve-results.mjs` | `results.html`, `corpus.json` | | [Serves the results page](#viewing-results) on localhost |
| `corpus.mjs` | | | Shared helpers: locked `corpus.json` updates, URL to `files/` path mapping |

Each script takes `--help`, which prints its usage.

The tools that parse headers import the extension's compiled code from
`dist/` (or `lib/`), so run `pnpm run build` first.

### Rebuilding from a fresh checkout

```sh
pnpm run build
node tests/greasyfork-examples/download-scripts.mjs  # corpus.json → files/ (~20 min)
node tests/greasyfork-examples/build-db.mjs          # → corpus.db
node tests/greasyfork-examples/render-analysis.mjs   # → analysis.html
```

## Why the pages are saved by hand

GreasyFork is behind a Cloudflare bot check. `curl` gets a 403 "Just a
moment..." page, and both headless and headed Playwright get stuck on the
interstitial, so there is no scripted download path. Save the listing pages
from a normal browser session instead:

1. Open `https://greasyfork.org/en/scripts?sort=total_installs&page=1`.
2. Save into `tests/greasyfork-examples/greasyfork-dump/` as `gfpage1.html`
   (Ctrl+S → "Webpage, HTML Only").
3. Repeat for `page=2`, `page=3`, … — 100 scripts per page, so 20 pages is the
   top 2000.

## Extracting

```sh
node tests/greasyfork-examples/fetch-top-scripts.mjs
```

Defaults to every `greasyfork-dump/gfpage<N>.html`, in page order, updating
the `listing` block of each record in `corpus.json`.

- Findings (everything outside `listing`) are left alone.
- After a full run, a script missing from the listing keeps its record and
  findings, with `listing.rank` set to `null`. The other tools still include
  it, after the ranked ones.
- A partial run (`--count`, or pages named on the command line) updates only
  the scripts it saw, and leaves every other rank alone.

Options:

- `--dir PATH` — where to look for the `gfpage*.html` set (default `greasyfork-dump/`)
- `--count N` — stop after N scripts
- `--corpus PATH` — corpus file to update
- positional file paths — parse exactly these files instead of the default set

## Listing fields

Each record is keyed by GreasyFork's integer script ID (`data-script-id`). Its
`listing` block holds:

| Field | Source in the listing markup |
|-------|------------------------------|
| `rank` | position in the saved pages, from 1; `null` once a script drops out |
| `name` | `data-script-name` |
| `info_page` | the `a.script-link` href, made absolute |
| `script_url` | `data-code-url` (the `update.greasyfork.org` `.user.js` URL) |
| `total_installs` | `data-script-total-installs` |
| `daily_installs` | `data-script-daily-installs` |
| `ratings_good` / `ratings_ok` / `ratings_bad` | the `good`/`ok`/`bad-rating-count` spans |
| `created_date` | `data-script-created-date` |
| `updated_date` | `data-script-updated-date` |

Notes:

- Counts are JSON numbers (the visible page renders them with commas), or
  `null` when the page showed none.
- Rows keep the page's sort order. Expect a handful of off-by-one inversions in
  `total_installs` across page boundaries — counts tick up while you're saving
  pages, not a parse error.
- Scripts repeated across pages (same cause) are dropped after the first sighting.
- The default listing shows English-language results only. To include the rest,
  save pages with `&filter_locale=0` in the URL.

## Downloading the scripts themselves

The raw `.user.js` URLs are *not* behind the bot check, so these fetch normally:

```sh
node tests/greasyfork-examples/download-scripts.mjs [--count N]
```

Three phases: every `script_url` from `corpus.json`, then every unique `@require` URL
and `@resource` URL found in the metadata blocks of what it just downloaded.

Options: `--corpus`, `--root`, `--count`, `--delay MS` (default 200),
`--concurrency N` (default 1), `--force`, `--scripts-only`, `--requires-only`,
`--resources-only`, `--max-broken-hosts N` (default 5).

Requires a build (`pnpm run build`) — the `@require` scan reuses the extension's
own metadata-block parser from `dist/userscript-header.js`.

**Re-run `pnpm run build` after any change to `src/userscript-header.ts`.** The
tools import the compiled copy, and a stale `dist/` mis-parses silently: it once
cost 26 scripts whose metadata blocks start with a UTF-8 BOM, which showed up
only as an oddly long "no metadata block" list.

### On-disk layout

Files land under `tests/greasyfork-examples/files/<host>/<url-path>`, with the
URL's percent-encoding kept verbatim in the filename:

```
https://update.greasyfork.org/scripts/25253/ZOOM%20HACK%20for%20Blobleio%21.user.js
→ files/update.greasyfork.org/scripts/25253/ZOOM%20HACK%20for%20Blobleio%21.user.js
```

- **Query strings** are appended to the filename, since some `@require` URLs
  differ only there.
- **Over-long names** get truncated with `~<hash>` spliced in before the
  extension (`AC-baidu-%E9%87%8D…%E5%BA%94~efdc1ce2.user.js`). Percent-encoded
  CJK costs 9 bytes per character, which can overrun the filesystem's
  per-name limit: 255 bytes normally, but only 143 on an eCryptfs-encrypted
  home. Names are cut at 143 bytes on every machine, so a script's path
  depends only on its URL, and corpus.json can store it.

### The greasyfork.org mirror

`@require` URLs pointing at `greasyfork.org` itself hit the same bot check as
the listing pages and always 403. `update.greasyfork.org` serves the same bytes
unprotected, so those fetch from the mirror:

- `/scripts/<id>-<slug>/code/<File>.js` → `update…/scripts/<id>/<File>.js`
- `/libraries/<name>/<ver>/<File>.js` → same path on the mirror host

The file is still stored under the URL the script references, so looking it up
by `@require` URL works. A deleted script answers 410 on the mirror and is
recorded as a dead link.

### Path collisions

A host can serve one URL path as a file and use the same path as a directory
prefix for another (`/npm/sweetalert2@11` and `/npm/sweetalert2@11/dist/x.js`).
A filesystem can't have both, so the bare path becomes `<path>/index` — the same
convention already used for URLs ending in `/`.

### Stopping safely

Only a **429** aborts the run — that's the one status that means "slow down".
Everything else is scoped to the host or the URL:

- a host that 403s or won't connect is dropped after 3 strikes, and its
  remaining URLs are skipped
- 404/410 dead links are recorded and otherwise ignored
- the run aborts if more than `--max-broken-hosts` hosts go unreachable, which
  means the problem is on our end

Files already on disk are skipped, so re-running resumes where it left off.
Counts, dead links, blocked hosts, and every failed URL land in
`download-report.json`.

## Validating the corpus

Once the scripts are downloaded, SourceMonkey's install-time checks
(header validation, `@require` / `@resource` loading, syntax check) can
run over all of them without a browser:

```sh
node tests/greasyfork-examples/validate-corpus.mjs \
  --offline-root tests/greasyfork-examples/files tests/greasyfork-examples/files
```

`--offline-root` serves every dependency URL out of `files/` instead of
the network, so the run is reproducible and makes no requests.
`record-results.mjs validate` runs the same check and records each verdict in
`corpus.json` (see [Test results](#test-results)). See
[docs/corpus-validation.md](../../docs/corpus-validation.md) for the
tool and [docs/corpus-validation-results.md](../../docs/corpus-validation-results.md)
for the last run's findings.

## Analysis database

```sh
node tests/greasyfork-examples/build-db.mjs          # corpus.json + downloaded files → corpus.db
node tests/greasyfork-examples/render-analysis.mjs   # analysis.sql → analysis.html
```

`build-db.mjs` rebuilds `corpus.db` from scratch each run — it is derived data,
and both inputs are cheap to re-read. Header parsing reuses the extension's own
`dist/userscript-header.js`, so the database sees metadata blocks exactly the
way SourceMonkey does (`pnpm run build` first).

### Tables

| Table | Contents |
|-------|----------|
| `Scripts` | One row per corpus record's `listing` (including `rank`), plus `size` and `local_filename` of the downloaded body |
| `RequiresFiles` | One row per distinct `@require` URL, with `size` / `local_filename` |
| `ResourceFiles` | Same, for `@resource` URLs |
| `ScriptRequiresFiles` | script_id → require URL |
| `ScriptResourcesFiles` | script_id → resource URL, plus the `@resource` name it binds to |
| `ScriptHeaders` | Every metadata line: `header_field`, `header_field_full`, `header_field_suffix`, `argument` |
| `ScriptMatches` | Every `@match` / `@include` line, decomposed into `shape`, `scheme`, `host_pattern`, `site`, and per-component wildcard flags |
| `ScriptResults` | Validation status and error, and test status, reason, blame, date and version, for each record with findings (warnings and sites stay in `corpus.json`) |
| `ScriptTags` | Every tag, with `source` `validation` (derived) or `manual` |
| `ScriptNotes` | Every dated note |

Notes:

- `size` / `local_filename` are NULL when a file was never fetched — a dead
  link, a blocked host, or a URL the downloader skipped.
- `@description:ar` splits into `header_field` `description`, suffix `ar`,
  full `description:ar`. A tag with no suffix has `header_field_suffix = ''`.
- The join tables are keyed per (script, URL), so a script naming the same URL
  twice counts once. Reference counts mean "scripts referencing".
- `ScriptMatches.shape` classifies how open-ended a pattern is: `absolute` (no
  wildcard), `prefix-glob` (one trailing `*`), `inner-glob` (a `*` before the
  end), or `regex` (an `@include` slash-delimited form).
- `ScriptMatches.site` is the hostname a pattern resolves to, with one leading
  `*.` label stripped — NULL when the host itself is a wildcard (`*://*/*`), so
  site counts never attribute a match-everything pattern to a specific site.

### Reports

`analysis.sql` holds one statement per report, introduced by
`-- @report <title>` with optional `-- @note` prose. `render-analysis.mjs` runs them in
order and renders each result as a table in `analysis.html`, so adding a report
means adding a query — nothing else. The file is also plain SQL:

```sh
sqlite3 tests/greasyfork-examples/corpus.db < tests/greasyfork-examples/analysis.sql
```

## Test results

`corpus.json` also records what we learn about each script: whether it passes
SourceMonkey's install checks, and whether it works when run on its target
site. `record-results.mjs` is the only tool that writes these findings.

How to test scripts (the method, blame rules, tags, running batches with
agents, and re-testing after a fix) is in the `corpus-testing` skill,
[`.claude/skills/corpus-testing/`](../../.claude/skills/corpus-testing/SKILL.md).

**`record-results.mjs` records individual facts into the corpus**: one
script's test result, tag or note, as you (or an agent) learn it. It doesn't
compute anything over the corpus. The exception is `validate`, which checks
every downloaded script and records each verdict.

```sh
R=tests/greasyfork-examples/record-results.mjs
node $R validate                       # offline-validate every downloaded script, import verdicts
node $R list --untested --valid ok --limit 20
node $R show 14178                     # one record, plus its path under files/
node $R set 14178 --test pass --note "Redirect links rewritten on a bing.com search"
node $R set 14178 --test fail --blame sourcemonkey --note-file /tmp/why.md
node $R set 14178 --test n/a --reason requires-login --note "Every matched page needs an account"
node $R set 14178 --tag needs-GM_cookie
node $R set 14178 --replace-note 1 --note "Better wording"   # notes number from 1, in the order show lists them
node $R set 14178 --remove-note 2
```

`validate` needs a build (`pnpm run build`), like the other tools.

To try a script on its site, run it with `sm-dev`, pointing it at the
downloaded `@require`s so a dead or flaky host doesn't stop the run.
Give the run an ID of your own, since other agents may be testing too:

```sh
scripts/sm-dev --run D<yours> --local tests/greasyfork-examples/files start "<file from show>" <url> --detach
```

- It records a verdict for every downloaded script, `tool error` included.
- A listed script that isn't downloaded has its `valid`, `sites`,
  `version` and `file` cleared, so an old verdict can't pass for a current one.
- Each command refuses options it doesn't take, so a misspelled one fails loudly.

### Record format

Beside `listing`, a record can hold:

| Field | Written by | Contents |
|-------|------------|----------|
| `version` | `validate` | `@version` of the downloaded copy |
| `file` | `validate` | Where the downloaded copy is, relative to `files/` |
| `sites` | `validate` | What its `@match` / `@include` lines target, for the results page: a site, a host pattern, a regex, or `*` |
| `valid` | `validate` | The latest offline verdict: `status` (`ok` / `invalid` / `tool error`), `error`, `warnings`, derived `tags`, `date`, `version` |
| `test` | `set --test` | The latest run on the target site: `status`, `reason` or `blame`, `date`, `version` |
| `tags` | `set --tag` / `--untag` | Hand-added labels |
| `notes` | `set --note` | `{ date, version, text }` list, oldest first; `text` is markdown. `--replace-note` / `--remove-note` fix one |

- **Test statuses:**
  - `pass`: the script does what it promises.
  - `fail`: it doesn't. `--blame` says whose fault: `sourcemonkey`, `script`
    (broken or out of date against the site), or `unknown`.
  - `n/a`: we couldn't meaningfully try it. `--reason` is one of
    `requires-login`, `paid`, `geo-blocked`, `site-gone`,
    `needs-interaction`, `not-web`, `other-browser`, `other`.
  - `other-browser` is for a script that relies on another browser's
    features. It's `n/a`, not a failure, since no Chrome extension could run
    it. Say in the note what it relies on.
  - No `test` at all means nobody has tried it yet.
- `fail` and `n/a` require a note saying what happened.
- `date` defaults to today, and `version` to the `@version` of the copy in
  `files/` now (which can be newer than the one `validate` last recorded).
  `results.html` flags a test whose `version` is older than the current copy.
- A `sourcemonkey` failure should also get an entry in `TODO.md` (or a fix).

### Viewing results

`results.html` reads `corpus.json` when it loads, so it's always current and
never needs regenerating.

```sh
node tests/greasyfork-examples/serve-results.mjs   # then open http://localhost:8765/
```

- Served, the page fetches `corpus.json` itself. Its Reload button re-reads it
  and keeps your filters.
- Opened straight from disk, Chrome won't let the page fetch another file, so
  it asks you to choose `corpus.json`. You navigate to it once; after that the
  page offers to reopen the same file with one click.
- Every link opens in a new tab, except the Summary ones below.
- Summary shows each filter's choices (Validation, Testing, Tag) with how many
  scripts are in each; tags are listed most common first.
  - Each line links to the table filtered that way, and Full results goes
    back to the whole table.
  - These switch views in the same tab, so Back and Forward move between
    them; middle-click opens a new tab as usual.
- Under each name:
  - "Code" opens the downloaded copy in a viewer tab (this page with
    `?view=<id>`). A link straight to the `.user.js` file would make a
    userscript manager offer to install it.
  - "Copy filename" copies the file's full path, for opening it in an editor. Served,
    the page reads where `files/` is from `files/_location.json`, which every
    tool that uses `files/` writes.
- Any static server that serves this folder works for the page and viewer,
  not just `serve-results.mjs`.
- Opened from disk, the viewer asks once for access to the `files/` folder,
  since Chrome won't let the page read it otherwise.
- The filters, Notes setting and sort are kept in the URL, so a browser
  reload keeps them and the link reproduces the view. Reset clears them.
- Notes show in a full-width row under each script. The Notes selector sets
  them all to hidden, short or full.
  - Short shows the first entry, cut at three lines, with a Show full button
    when anything is hidden.
  - Full lets the browser's find (Ctrl+F) search them.
  - Each row's Show / Hide button overrides the setting for that row.

### Derived tags

`validate` replaces `valid.tags` each run with features the script uses that
SourceMonkey doesn't support but that don't make it invalid:

- `unsupported-grant:<name>`: an API-shaped `@grant` not in the catalog
  ([supported-GM-APIs.md](../../docs/supported-GM-APIs.md)).
- `malformed-grant`: a `@grant` line that isn't an API name at all (some
  scripts use them as comments).
- `ignored-match`: a `@match` Chrome would refuse, which SourceMonkey drops.
- `ignored-header:@<tag>`: a header another manager acts on and SourceMonkey
  ignores ([supported-headers.md](../../docs/supported-headers.md)).

Hand-added `tags` are for what only running the script shows, such as an
unsupported feature the checks can't see. Give a new one a description in
`HELP.tag` in `results.html`, which shows it as the tag's tooltip.

### Parallel writers

Several agents can record results at once:

- Every write re-reads `corpus.json` under a lock (`corpus.json.lock`),
  changes only the named record, and replaces the file by rename.
- Readers never see a half-written file, and concurrent writes don't lose each
  other's changes.
- A lock left by a crashed writer is broken after 30 seconds.

### What isn't stored

The script's path under `files/` is looked up from `listing.script_url` rather
than stored: over-long names are truncated to fit the filesystem, so the path
differs between machines. `show` prints it.
