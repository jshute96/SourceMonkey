# Corpus validation

`tests/greasyfork-examples/validate-corpus.mjs` runs SourceMonkey's
install-time checks over the downloaded GreasyFork corpus, with no
browser and no network, and groups the failures into a survey.

```sh
node tests/greasyfork-examples/validate-corpus.mjs [options] <path>...
```

For checking your own scripts, use `sm-dev validate` instead; this tool
is only for the corpus.

| Option | Effect |
|--------|--------|
| `--offline-root DIR` | Serve every dependency from `DIR` instead of the network; see [Offline mode](#offline-mode) |
| `--json FILE` | Write one JSON record per script to `FILE` |
| `--limit N` | Stop after N scripts, in scan order (sorted, so a limited run is reproducible) |
| `--examples N` | Example script names printed per failure group (default 3) |
| `--quiet` | Summary only, no per-group examples |

Exit codes: `0` even when scripts are invalid (that's the finding, not a
failed run), `1` if the tool couldn't run, couldn't check some script
(a tool error), or was given no paths, and `2` for a usage error.

## What it shares with `sm-dev validate`

- Each script goes through `prepareScript` (`src/harness/prepare.ts`),
  the same call `sm-dev validate` makes. That is the extension's own
  install pipeline under Node: header, `@require` / `@resource`, then
  the syntax check.
- So the verdicts and messages are the ones a user would see. Where
  Node differs from the extension is listed in
  [harness-design.md](harness-design.md#preparets-script-in-injectable-script-out).
- What this tool adds is the offline fetch, the grouped report and the
  JSON output.
- It checks one script at a time, since `prepareScript` serializes
  calls. The whole corpus takes about 20 seconds.

## Offline mode

`--offline-root DIR` answers every `@require` / `@resource` fetch from a
downloaded tree, through `prepareScript`'s `fetch` option. Nothing is
fetched from the network; a URL that isn't in the tree reads as a dead
link.

- The tree layout is the one `download-scripts.mjs` writes
  (`<root>/<host>/<url-path>`), and the lookup is that tool's own
  `findExisting`, so percent-encoded, truncated and `<path>/index`
  names all resolve the way they were written.
- A script found under the root gets its original `https://` URL
  rebuilt from its path. Relative refs then resolve against the right
  directory, and aren't held to the containment rule that only applies
  to `file://` scripts.
- The rebuilt URL is not exact for two shapes the downloader produces
  (a truncated over-long name, and `<path>/index`). Both affect only
  the filename, so relative refs still resolve correctly.

### Content-Type

A downloaded file has no record of the Content-Type its server sent,
so the offline fetch sends none, the same as a `file://` read.

- The loader's markup sniff (`looksLikeMarkup`) still rejects an HTML
  page saved in place of a library.
- The message then lacks the `(Content-Type "…")` detail a real server's
  header would add.

## Reporting

Failures are grouped by category (`header`, `@require`, `@resource`,
`syntax error`) and then by message, with example script names.

- A message none of those recognize lands in **`other`**, not the
  nearest familiar bucket: a survey must not hide a new failure shape
  inside a count that already looks explained.
- **`parse check inconclusive`** / **`parse check errored`**: the syntax
  check couldn't decide, so the script stays `ok` (see "Failing open" in
  [parse-check.md](parse-check.md)). Counted separately, because over a
  corpus that silence is worth measuring.
- **`tool error`**: the pipeline itself threw. Never counted as a
  verdict on the script.
- A dependency the offline tree doesn't hold is reported as "not in the
  offline tree" rather than the pipeline's 404 wording, since the two
  are different facts.

Strings shared with the pipeline are imported, never copied or
pattern-matched, so they can't go stale when the wording changes:

- `SYNTAX_ERROR_PREFIX` (`script-store.ts`) and `isFetchFailureMessage`
  (`external-files.ts`) recognize syntax and fetch failures.
- `unusableMatchGroupKey` (`url-match.ts`) elides the pattern from an
  unusable-`@match` message, so every script making that mistake groups
  into one row.

### JSON records

`--json FILE` writes one record per script: name, status, category,
message, the structured `location` when there is one, and the
dependency `url` when one failed. It also carries:

- `errorMessage`, the message without its location.
- `version`, the script's `@version`.
- `warnings`, the load-time diagnostics the viewer's Log tab would show,
  each as `{ level, message, location? }`.

`record-results.mjs validate` runs the tool with `--json` and records
each verdict in `corpus.json`.

## Testing

- `tests/unit/validate-corpus.test.mjs` runs the tool as a subprocess
  over a hand-built offline tree: absolute and relative refs, missing
  libraries and resources, the printed summary, and a nonexistent root
  failing loudly.
  - A subprocess because arg parsing, discovery and the fetch each have
    a failure mode that reports *zero problems found*.
  - A hand-built tree because the real corpus is gitignored (~270 MB).
- The checking itself is tested through `sm-dev validate` in
  `tests/unit/harness-validate.test.mjs`, against the same
  `tests/bad-examples/` table the browser test uses.

## Running it

```sh
node tests/greasyfork-examples/validate-corpus.mjs \
  --offline-root tests/greasyfork-examples/files tests/greasyfork-examples/files
```

See [tests/greasyfork-examples/README.md](../tests/greasyfork-examples/README.md)
for downloading the corpus, and
[corpus-validation-results.md](corpus-validation-results.md) for what
the last run found.
