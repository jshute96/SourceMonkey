# GreasyFork top-scripts extraction

Builds a CSV of the most-installed userscripts on
[GreasyFork](https://greasyfork.org) — raw material for picking real-world
scripts to test SourceMonkey against.

## What's checked in

| In git | Local only (gitignored) |
|--------|-------------------------|
| the tools, `analysis.sql`, this README | `greasyfork-dump/` — the saved listing pages (6 MB) |
| `top-scripts.csv` — the extracted top 2000 | `files/` — downloaded scripts and dependencies (~270 MB) |
| `analysis.html` — the rendered report | `corpus.db` — rebuilt from the CSV + `files/` |
| | `download-report.json` — per-run counts, machine-specific |

`top-scripts.csv` is the artifact everything else reproduces from. The saved
listing pages stay out of git because the CSV already distills them, and because
re-saving them is a manual browser step either way (see below).

Rebuilding from a fresh checkout:

```sh
npm run build                                        # tools import dist/userscript-header.js
node tests/greasyfork-examples/download-scripts.mjs  # CSV → files/ (~20 min, 270 MB)
node tests/greasyfork-examples/build-db.mjs          # → corpus.db
node tests/greasyfork-examples/report.mjs            # → analysis.html
```

Only re-running `fetch-top-scripts.mjs` needs the saved pages, and only if you
want a newer top-2000 than the checked-in CSV.

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

Defaults to every `greasyfork-dump/gfpage<N>.html`, in page order, writing
`tests/greasyfork-examples/top-scripts.csv`.

Options:

- `--dir PATH` — where to look for the `gfpage*.html` set (default `greasyfork-dump/`)
- `--count N` — stop after N scripts
- `--out PATH` — CSV destination
- positional file paths — parse exactly these files instead of the default set

## CSV columns

| Column | Source in the listing markup |
|--------|------------------------------|
| `id` | `data-script-id` — GreasyFork's integer script ID |
| `name` | `data-script-name` |
| `info_page` | the `a.script-link` href, made absolute |
| `script_url` | `data-code-url` (the `update.greasyfork.org` `.user.js` URL) |
| `total_installs` | `data-script-total-installs` |
| `daily_installs` | `data-script-daily-installs` |
| `ratings_good` / `ratings_ok` / `ratings_bad` | the `good`/`ok`/`bad-rating-count` spans |
| `created_date` | `data-script-created-date` |
| `updated_date` | `data-script-updated-date` |

Notes:

- Install counts are plain integers (the visible page renders them with commas).
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

Three phases: every `script_url` from the CSV, then every unique `@require` URL
and `@resource` URL found in the metadata blocks of what it just downloaded.

Options: `--csv`, `--root`, `--count`, `--delay MS` (default 200),
`--concurrency N` (default 1), `--force`, `--scripts-only`, `--requires-only`,
`--resources-only`, `--max-broken-hosts N` (default 5).

Requires a build (`npm run build`) — the `@require` scan reuses the extension's
own metadata-block parser from `dist/userscript-header.js`.

**Re-run `npm run build` after any change to `src/userscript-header.ts`.** The
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
  CJK costs 9 bytes per character, which overruns the filesystem's per-name
  limit — 255 bytes normally, but only 143 on an eCryptfs-encrypted home, so
  the tool probes for the real ceiling at startup.

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
npm run validate -- --offline-root tests/greasyfork-examples/files \
                    tests/greasyfork-examples/files
```

`--offline-root` serves every dependency URL out of `files/` instead of
the network, so the run is reproducible and makes no requests. See
[docs/offline-validation.md](../../docs/offline-validation.md) for the
tool and [docs/corpus-validation-results.md](../../docs/corpus-validation-results.md)
for the last run's findings.

## Analysis database

```sh
node tests/greasyfork-examples/build-db.mjs   # CSV + downloaded files → corpus.db
node tests/greasyfork-examples/report.mjs     # analysis.sql → analysis.html
```

`build-db.mjs` rebuilds `corpus.db` from scratch each run — it is derived data,
and both inputs are cheap to re-read. Header parsing reuses the extension's own
`dist/userscript-header.js`, so the database sees metadata blocks exactly the
way SourceMonkey does (`npm run build` first).

### Tables

| Table | Contents |
|-------|----------|
| `Scripts` | One row per CSV row, plus `size` and `local_filename` of the downloaded body |
| `RequiresFiles` | One row per distinct `@require` URL, with `size` / `local_filename` |
| `ResourceFiles` | Same, for `@resource` URLs |
| `ScriptRequiresFiles` | script_id → require URL |
| `ScriptResourcesFiles` | script_id → resource URL, plus the `@resource` name it binds to |
| `ScriptHeaders` | Every metadata line: `header_field`, `header_field_full`, `header_field_suffix`, `argument` |
| `ScriptMatches` | Every `@match` / `@include` line, decomposed into `shape`, `scheme`, `host_pattern`, `site`, and per-component wildcard flags |

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
`-- @report <title>` with optional `-- @note` prose. `report.mjs` runs them in
order and renders each result as a table in `analysis.html`, so adding a report
means adding a query — nothing else. The file is also plain SQL:

```sh
sqlite3 tests/greasyfork-examples/corpus.db < tests/greasyfork-examples/analysis.sql
```
