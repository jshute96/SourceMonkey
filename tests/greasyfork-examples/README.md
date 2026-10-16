# GreasyFork corpus

Tools and data for testing SourceMonkey against real-world userscripts: the
2000 most-installed scripts on [GreasyFork](https://greasyfork.org) plus
others added since, downloaded with their dependencies, and a record of what
testing each one found.

This README covers the tools and data. For how to test scripts on their
live sites and record results (also for agents), see the `corpus-testing`
skill in [`.claude/skills/corpus-testing/`](../../.claude/skills/corpus-testing/SKILL.md).

## Overview

### State files

| File | In git | Contents | Written by | Read by |
|------|:------:|----------|------------|---------|
| `corpus.json` | yes | One record per script: its GreasyFork `listing` stats, plus test findings | `add-scripts.mjs` (listings), `record-results.mjs` (findings) | every tool |
| `files/` | no | Downloaded scripts and their `@require` / `@resource` files (~270 MB) | `download-scripts.mjs` | `build-db.mjs`, `record-results.mjs` |
| `download-report.json` | no | Last download run's counts and failures | `download-scripts.mjs` | you |
| `corpus.db` | no | SQLite database of listings, parsed headers, dependencies and findings; rebuilt from scratch each run | `build-db.mjs` | `render-analysis.mjs`, ad hoc SQL |
| `analysis.sql` | yes | The queries behind `analysis.html` | you | `render-analysis.mjs` |
| `analysis.html` | yes | Corpus statistics report | `render-analysis.mjs` | you |
| `results.html` | yes | Static page that reads `corpus.json` and shows a sortable, filterable table of every script's validity, test status, tags and notes | you (hand-written) | you, in a browser |
| `corpus-help.js` | yes | One-sentence description of each test status, n/a reason, fail blame and tag, shown as its tooltip | you | `results.html`, `show-on-GreasyFork.user.js` |

`corpus.json` is the source of truth. Everything not in git can be rebuilt
from it.

### Scripts

| Script | Reads | Writes | Does |
|--------|-------|--------|------|
| `add-scripts.mjs` | GreasyFork, `corpus.json` | `corpus.json` listings | [Finds script IDs](#adding-scripts) from IDs, URLs or pages, and compares or adds them |
| `download-scripts.mjs` | `corpus.json` | `files/`, `download-report.json` | [Downloads](#downloading-the-scripts-themselves) each script, then its dependencies |
| `record-results.mjs` | `corpus.json`, `files/` | `corpus.json` findings | **Records individual facts about one script at a time** (a test result, tag or note) as you learn them. [More](#test-results). Its `validate` subcommand is the one bulk step |
| `build-db.mjs` | `corpus.json`, `files/` | `corpus.db` | [Loads everything into SQLite](#analysis-database) |
| `validate-corpus.mjs` | `files/` | stdout, `--json` file | [Validates](#validating-the-corpus) every downloaded script offline; `record-results.mjs validate` runs it |
| `render-analysis.mjs` | `corpus.db`, `analysis.sql` | `analysis.html` | Renders the statistics report |
| `serve-results.mjs` | `results.html`, `corpus.json`, `corpus-help.js` | | [Serves the results page](#viewing-results) on localhost |
| `show-on-GreasyFork.user.js` | `corpus.json`, `corpus-help.js`, from `serve-results.mjs` | | Userscript that shows each script's validation and test status on Greasy Fork's script pages and listings |
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

## Adding scripts

```sh
A=tests/greasyfork-examples/add-scripts.mjs
node $A 14178 https://greasyfork.org/en/scripts/4391-name   # IDs and script URLs
node $A "https://greasyfork.org/en/scripts?q=youtube&sort=total_installs" --pages 3
node $A https://github.com/someone/awesome-userscripts      # every GreasyFork script link on the page
node $A ~/Downloads/some-page.html                          # the same, from a saved page
node $A --add <sources>                                     # add the new ones
```

Sources:

- A script ID, or a GreasyFork script URL (any page under it, or its
  `update.greasyfork.org` code URL).
- A GreasyFork listing or search URL (`/scripts?...`,
  `/scripts/by-site/<domain>`). `--pages N` reads N pages from the one given,
  and `--all-pages` reads them all from page 1.
- A GreasyFork user page (`/users/<id>-<name>`): all that user's scripts.
- Any other URL: every link on it to a GreasyFork script is taken.
- A saved HTML file: every GreasyFork script link in it, as for a URL.
  Relative links resolve against the URL the browser recorded when saving
  (or `<base href>`, or the canonical link).

Modes:

- `--compare` (default): one line per ID, showing whether it's new to the
  corpus and, if not, its validation status (whether it passes
  SourceMonkey's offline install checks) and test result. See
  [Record format](#record-format).
  - TESTED is blank for an untested script, or shows the kind of
    validation error when it's invalid (`invalid (require-dead-link)`).
- `--list`: just the unique IDs, for piping.
- `--show`: prints the records `--add` would write, as JSON, without
  writing them.
- `--add`: adds the IDs not yet in the corpus, each with a `listing` block.
  Existing records are left alone.
  - After adding, run `download-scripts.mjs` and `record-results.mjs validate`.

From sources to test results, for a new collection labeled L:

```sh
node $A --compare <sources>                      # what's new, and what's already tested
node $A --add --label-new L <sources>            # or --label-all L, plus --label-with-rank
node tests/greasyfork-examples/download-scripts.mjs
node tests/greasyfork-examples/record-results.mjs validate
node tests/greasyfork-examples/record-results.mjs list --label L --untested --valid ok
```

Then test them as the `corpus-testing` skill
([`.claude/skills/corpus-testing/`](../../.claude/skills/corpus-testing/SKILL.md)) describes.

Where the data comes from:

- GreasyFork's JSON API (`api.greasyfork.org`). A listing URL becomes the
  same path with `format=json`, and one script is `/scripts/<id>.json`.
- Listing and user results already carry each script's data, so `--add` fetches
  only the IDs that came from plain IDs or scraped links.
- GreasyFork's HTML pages have at times been behind a Cloudflare bot check
  (an anti-scraping filter) that blocks scripted fetches. The API hasn't.
  Scraping links from a GreasyFork page, such as a user's favorites, reads its
  HTML, and so does `--all-pages` to count the pages. Both fail while the
  check is on; `--pages N` doesn't.

### Labels

A label marks a collection of scripts, like the ones from one listing:

- `--label-new L` gives label L to the scripts `--add` adds.
- `--label-all L` also gives it to the scripts found that are already in the
  corpus.
- `--label-with-rank` ranks each script under the label by the order the
  sources found it, from 1, across pages and sources. Without it, labels
  carry no `rank`.
  - With `--label-new`, only the new scripts get ranks, so the ranks have
    gaps where existing scripts were found.
  - With `--label-all`, existing scripts that already had the label take
    their new rank. Ones that had it but weren't found keep their old rank.
- `top2000` marks scripts from GreasyFork's top-installs listing, ranked by
  installs when the listing was last read. Scripts that have dropped out
  keep their older rank, so ranks can repeat. `results.html` shows that
  rank in its `#` column, and the other tools process scripts in that
  order, then the rest by ID.

```sh
node $A --add --label-all wiki --label-with-rank --all-pages \
  "https://greasyfork.org/en/scripts/by-site/wikipedia.org?sort=total_installs"
```

## Listing fields

Each record is keyed by GreasyFork's integer script ID. Its `listing` block
holds:

| Field | Source in the API's script data |
|-------|---------------------------------|
| `name` | `name` |
| `info_page` | `url`, with the `/en/` locale added |
| `script_url` | `code_url` (the `update.greasyfork.org` `.user.js` URL) |
| `total_installs` | `total_installs` |
| `daily_installs` | `daily_installs` |
| `ratings_good` / `ratings_ok` / `ratings_bad` | `good_ratings` / `ok_ratings` / `bad_ratings` |
| `created_date` | `created_at`, as YYYY-MM-DD |
| `updated_date` | `code_updated_at`, as YYYY-MM-DD |

Notes:

- Counts are JSON numbers, or `null` when GreasyFork gives none.
- GreasyFork listings show English-language results only by default. To
  include the rest, add `&filter_locale=0` to the listing URL.

## Downloading the scripts themselves

The raw `.user.js` URLs fetch normally:

```sh
node tests/greasyfork-examples/download-scripts.mjs [--count N]
```

Four phases: every `script_url` from `corpus.json`, then every unique `@require`
URL, `@resource` URL and `@icon` URL found in the metadata blocks of what it just
downloaded. For icons, that's the one icon SourceMonkey would show.

Options: `--corpus`, `--root`, `--count`, `--delay MS` (default 200),
`--concurrency N` (default 1), `--force`, `--include PARTS` (a comma-separated list
of `scripts`, `requires`, `resources`, `icons`, or `all`; default `all`),
`--max-broken-hosts N` (default 5).

`requires`, `resources` and `icons` are found in the headers of scripts already on
disk, so `--include icons` alone needs the scripts from an earlier run.

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

`@require` URLs pointing at `greasyfork.org` itself hit the same bot check as its
HTML pages and always 403. `update.greasyfork.org` serves the same bytes
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
| `Scripts` | One row per corpus record's `listing`, plus `size` and `local_filename` of the downloaded body |
| `RequiresFiles` | One row per distinct `@require` URL, with `size` / `local_filename` |
| `ResourceFiles` | Same, for `@resource` URLs |
| `ScriptRequiresFiles` | script_id → require URL |
| `ScriptResourcesFiles` | script_id → resource URL, plus the `@resource` name it binds to |
| `ScriptHeaders` | Every metadata line: `header_field`, `header_field_full`, `header_field_suffix`, `argument` |
| `ScriptMatches` | Every `@match` / `@include` line, decomposed into `shape`, `scheme`, `host_pattern`, `site`, and per-component wildcard flags |
| `ScriptResults` | Validation status and error, and test status, reason, blame, date and version, for each record with findings (warnings and sites stay in `corpus.json`) |
| `ScriptTags` | Every tag, with `source` `validation` (derived) or `manual` |
| `ScriptLabels` | Every label, with its `rank` when it has one |
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
node $R list --label awesome-userscripts --untested   # one collection, in its rank order
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
- A verdict that matches the one recorded keeps its old `date`, so a rerun
  redates only the scripts whose result changed.
- A listed script that isn't downloaded has its `valid`, `sites`,
  `version` and `file` cleared, so an old verdict can't pass for a current one.
- Each command refuses options it doesn't take, so a misspelled one fails loudly.

### Record format

Beside `listing`, a record can hold:

| Field | Written by | Contents |
|-------|------------|----------|
| `labels` | `add-scripts.mjs` | `{ label, rank }` list naming the collections the script belongs to; `rank` (from 1) only where the label was given one. [More](#labels) |
| `version` | `validate` | `@version` of the downloaded copy |
| `file` | `validate` | Where the downloaded copy is, relative to `files/` |
| `sites` | `validate` | What its `@match` / `@include` lines target, for the results page: a site, a host pattern, a regex, or `*` |
| `valid` | `validate` | The latest offline verdict: `status` (`ok` / `invalid` / `tool error`), `error`, `warnings` (`warn`-level diagnostics only), derived `tags`, `date`, `version` |
| `test` | `set --test` | The latest run on the target site: `status`, `reason` or `blame`, `date`, `version` |
| `tags` | `set --tag` / `--untag` | Hand-added labels |
| `notes` | `set --note` | `{ date, version, text }` list, oldest first; `text` is markdown. `--replace-note` / `--remove-note` fix one |

- **Test statuses:**
  - `pass`: the script does what it promises.
  - `fail`: it doesn't. `--blame` says whose fault: `sourcemonkey`, `script`
    (broken or out of date against the site), or `unknown`.
  - `inconclusive`: we ran it on its target site, but what it acts on never
    showed up (no ad served, the popup never appeared, a redesign not served
    to us), so there's no verdict. The note says what was missing.
  - `n/a`: we couldn't meaningfully try it. `--reason` is one of
    `requires-login`, `paid`, `geo-blocked`, `bot-blocked`, `site-gone`,
    `needs-interaction`, `not-web`, `other-browser`, `unsafe`, `game`,
    `other`.
  - An `n/a` can also record a script we chose not to run, with a note
    starting "Not run:": `unsafe` for one that looked dangerous, or the
    reason that kept us from trying it (`requires-login`, `paid`, or
    `game` for game cheats, bots and tools).
  - `other-browser` is for a script that relies on another browser's
    features. It's `n/a`, not a failure, since no Chrome extension could run
    it. Say in the note what it relies on.
  - No `test` at all means nobody has tried it yet.
- `fail`, `inconclusive` and `n/a` require a note saying what happened.
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
- The search box matches names, IDs, sites, tags and notes. A number on its
  own finds only the script with that ID, with its notes shown in full, or
  a "Script N not in test corpus." row (`results.html?q=<id>` links to one).
- Min year and Max year limit the scripts to those last updated on GreasyFork
  in that range; "none" leaves that end open.
- Summary shows each filter's choices (Validation, Testing, Tag) with how many
  scripts are in each; tags are listed most common first.
  - It has the same filter bar as the table, and counts only the scripts the
    filters match ("1500 of 2000 scripts").
  - Last update counts the scripts by the year of their last update, oldest
    first; each year links to the table with Min and Max year set to it.
  - Each line links to the table with the current filters plus that choice
    (replacing that filter's own setting).
  - Summary and Full results switch between the two views, keeping the
    filters. They switch in the same tab, so Back and Forward move between
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

`validate` replaces `valid.tags` each run. An invalid script gets
`invalid:<reason>` saying why (`require-dead-link`, `require-too-large`,
`bad-match`, `user-style`, ...; the list is in `corpus-help.js`).
Any script also gets tags for features it uses that SourceMonkey doesn't
support but that don't make it invalid:

- `unsupported-grant:<name>`: an API-shaped `@grant` not in the catalog
  ([supported-GM-APIs.md](../../docs/supported-GM-APIs.md)).
- `malformed-grant`: a `@grant` line that isn't an API name at all (some
  scripts use them as comments).
- `ignored-match`: a `@match` Chrome would refuse, which SourceMonkey drops.
- `unsupported-run-at`: a `@run-at` value SourceMonkey doesn't support, so the
  script runs at `document-idle` instead.
- `icon-dead-link`, `icon-too-large`: an `@icon` that won't download, or is
  over the icon size limit.
- `ignored-header:@<tag>`: a header another manager acts on and SourceMonkey
  ignores ([supported-headers.md](../../docs/supported-headers.md)).

Hand-added `tags` are for what only running the script shows, such as an
unsupported feature the checks can't see. Give a new one a description in
`corpus-help.js`, which `results.html` and `show-on-GreasyFork.user.js` show
as the tag's tooltip. A tag names a problem that still exists: once a
SourceMonkey gap is fixed and its scripts re-tested, the tag comes off them
and out of `corpus-help.js`.

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
