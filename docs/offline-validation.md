# Offline validation CLI

`scripts/validate-userscripts.mjs` runs SourceMonkey's install-time
checks over `*.user.js` files on disk, with no browser involved.

```sh
npm run validate -- [options] <path>...
```

Each `<path>` is a `*.user.js` file, or a directory scanned recursively
for them.

| Option | Effect |
|--------|--------|
| `--offline-root DIR` | Serve every http(s) dependency from `DIR` instead of the network — see [Offline mode](#offline-mode) |
| `--json FILE` | Write one JSON record per script to `FILE` |
| `--limit N` | Stop after N scripts, in scan order (sorted, so a limited run is reproducible) |
| `--concurrency N` | Scripts checked in parallel (default 8) |
| `--examples N` | Example script names printed per failure group (default 3) |
| `--quiet` | Summary only — no per-group examples |

Exit codes: `0` even when scripts are invalid (that's the finding, not a
failed run), `1` if the tool itself couldn't run, `2` for a usage error.

## What it checks

The same three steps, in the same order, that installing or refreshing
a script performs:

1. **Header** — split the metadata block, then `validateHeader`
   (`@name` plus at least one `@match` / `@include`).
2. **External files** — resolve and fetch every `@require` and
   `@resource` through `attachFiles`, including the `.js` suffix gate,
   the size cap, the HTML content-type rejection, and the strict UTF-8
   decode.
3. **Parse** — compose the exact text the injected entry compiles (GM
   bindings, every `@require` body, then the script), compile it
   without running it, and map any error back to the file and line it
   was written in.

Each script comes out `ok` or `invalid` with the extension's own
`errorMessage`, plus the `errorLocation` naming the file and line it is
about — see [diagnostics.md](diagnostics.md). The report renders the two
together through `describeDiagnostic`, so a line in the CLI's output
reads exactly as the same verdict does in the viewer.

## Why it is the production code

The interesting failures are the ones nobody predicted, so a
reimplementation would be measuring the wrong program. The CLI imports
`buildScriptFromText` and `applyFiles` from `dist/` and calls them the
way a fresh install does (no prior row, `recheck: 'all'`).

Only two pieces can't be shared, and both are contained:

| Piece | In the extension | Here |
|-------|------------------|------|
| The compile | `new Function` in a sandboxed extension page, located by appending a `<script>` and reading the window `error` event | `new Function` under Node, located by `new vm.Script` and the position V8 renders at the top of `err.stack` (`scripts/parse-check-node.mjs`) |
| The fetch | `fetch()` / XHR against the network | the global `fetch` is replaced; see below |

Everything downstream of the compile — probe selection, the range
check, the Script-only diagnostic filter, the line→file mapping — is
the extension's own `parse-location.ts`.

### Caveats

- **Node's V8 is not Chrome's V8.** Both accept the same language, but
  a very new syntax feature, or the wording of a `SyntaxError`, can
  differ between versions. `node --version` says which one answered.
- **The reported column is best-effort on a long line.** V8 clips the
  frame it renders in `err.stack` at ~1020 characters, so on a longer
  line — i.e. any minified file — there is no caret to measure against
  and the column falls back to 1. The line is still exact, and the
  verdict never depends on either. Chrome's path reads `event.colno`
  and has no such limit, so this is the one place the port is
  knowingly less precise.
- **`--offline-root` reconstructs Content-Type by sniffing**, since a
  downloaded file carries no record of the header its server sent.
  Bytes starting `<!doctype html` / `<html` are typed `text/html` —
  which is what the `@require` loader rejects — and everything else is
  typed off the file extension, falling back to
  `application/octet-stream` (which the loader accepts). A soft-failure
  page opening with `<?xml`, a BOM or a comment is therefore missed;
  it fails one step later as a syntax error instead.
- **The URL reconstruction is not exact for two shapes.** The
  downloader truncates over-long path segments and stores a
  path-that-is-also-a-directory as `<path>/index`; neither round-trips
  back to the original URL. Both affect only the filename, so the
  directory a relative ref resolves against is still right.

## Offline mode

`--offline-root DIR` serves every `@require` / `@resource` URL out of a
downloaded tree instead of the network. Nothing is fetched at all; a
URL that isn't in the tree reads as a dead link.

- The tree layout is the one
  `tests/greasyfork-examples/download-scripts.mjs` writes
  (`<root>/<host>/<url-path>`), and the lookup is that tool's own
  `findExisting`, so percent-encoded names, truncated over-long names,
  and `<path>/index` collisions all resolve the way they were written.
- A script found **under** the root gets its original `https://` URL
  reconstructed from its path. That matters for relative refs: against
  a `file://` URL they'd be subject to the containment rule that only
  applies to local files, and against the wrong directory they'd
  simply miss.
- `file://` refs are read from disk in both modes — Node's built-in
  `fetch` doesn't implement the scheme at all.

## Reporting

Failures are grouped by category (`header`, `@require`, `@resource`,
`syntax error`) and then by message, with example script names.

A message none of those recognize lands in **`other`** rather than the
nearest familiar bucket — a survey whose job is to find unanticipated
failures must not fold one into a count that already looks explained.

Two extra categories exist because the pipeline is *designed* to
swallow them, and over a corpus that silence is the thing most worth
measuring:

- **`parse check inconclusive`** — V8 threw something that wasn't a
  `SyntaxError` (see "Failing open" in
  [parse-check.md](parse-check.md)). The script stays `ok`.
- **`parse check errored`** — composing the checked text threw. The
  script stays `ok`.

Dependency failures mostly report themselves now: the pipeline names
which fetch failure it hit, so the validator passes the message
straight through.

The fetch shim's log is consulted for one case only — the offline
mirror answers a URL it doesn't hold with a `404`, and "not in the
offline tree" is a different fact from a server that really replied
404. Size and empty-file outcomes used to come from the log too; they
come from the pipeline now.

Strings shared with the pipeline are imported, never copied — a copy
would go stale the next time the wording improves.

`--json FILE` writes one record per script — name, status, category,
message, the structured `location` when the verdict has one, and the
dependency URL when one failed.

## Testing

`tests/unit/validate-userscripts.test.mjs` runs the CLI as a
subprocess, not as an imported function.

- Arg parsing, script discovery, the `fetch` replacement and the
  reporting are as much of the tool as the checking is.
- Each of them has a failure mode that returns *zero problems found* —
  a mistyped flag, a walker that matches nothing, a fetch shim that
  never installed.
- A test reaching past them into the internals would pass while the
  tool called an empty corpus clean.

It covers:

- `tests/examples/` — a clean sweep, with a floor on the script count
  so an empty walk can't pass.
- `tests/bad-examples/` — status, message and error line per file,
  from `tests/fixtures/bad-script-cases.mjs`. That table is shared with
  `tests/e2e/bad-scripts.spec.ts`, which pins the same expectations by
  driving the real extension in Chromium, so the two agreeing is the
  evidence that Node's V8 and Chrome's answer alike.
- `--offline-root` — a hand-built tree (absolute and relative refs
  resolved, a missing library reported as such), plus a nonexistent
  root failing loudly. The GreasyFork corpus is gitignored and 270 MB,
  so a test that needed it would skip on every fresh checkout.

## What to run it over

The example suites are the quick pass, and the one that says whether
the CLI still agrees with the browser — `tests/bad-examples/` has a
paired Playwright spec (`tests/e2e/bad-scripts.spec.ts`) that pins the
same verdicts from inside Chromium:

```sh
npm run validate -- tests/examples tests/bad-examples
```

The GreasyFork corpus is the broad pass — ~2000 real scripts in well
under a minute, once they're downloaded:

```sh
npm run validate -- --offline-root tests/greasyfork-examples/files \
                    tests/greasyfork-examples/files
```

See [tests/greasyfork-examples/README.md](../tests/greasyfork-examples/README.md)
for how the corpus is downloaded, and
[corpus-validation-results.md](corpus-validation-results.md) for what
the last run of each found.
