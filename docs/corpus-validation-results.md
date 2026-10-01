# Corpus validation results

A snapshot of what SourceMonkey's install-time checks find over the
scripts we have: the repo's own example suites, then the top-2000
GreasyFork scripts.

See [corpus-validation.md](corpus-validation.md) for the tool, and
[tests/greasyfork-examples/README.md](../tests/greasyfork-examples/README.md)
for how the corpus is built.

## The example suites

Run these first — they're fast, they need no downloaded corpus, and
they're the check that Node still agrees with the browser:

```sh
scripts/sm-dev validate tests/examples tests/bad-examples
```

| Suite | Result |
|-------|--------|
| `tests/examples/` | 21 scripts, all `ok` |
| `tests/bad-examples/` | 18 scripts: 6 `ok`, 12 `invalid` |

- The bad-examples verdicts match `tests/e2e/bad-scripts.spec.ts` file
  for file — same status on every one, and the same message and line
  for each located syntax error.
- That spec drives the real extension in Chromium, so the agreement is
  the evidence that Node's V8 and Chrome's answer alike here.
- The failures cover every route: header (no block, unterminated block,
  missing `@name`, missing `@match`), a `@require` that isn't there,
  and syntax errors in the body, in a `@require`, from a join-only
  collision, and from each brace-imbalance shape.
- Both suites are asserted automatically by
  `tests/unit/harness-validate.test.mjs`.

## The GreasyFork corpus

Command, Node 22.22 (V8's verdict is the tool's verdict, so the version
is part of the result):

```sh
node tests/greasyfork-examples/validate-corpus.mjs \
  --offline-root tests/greasyfork-examples/files tests/greasyfork-examples/files
```

These numbers predate the user program moving into its own nested
scope (see [GM binding collisions](#gm-binding-collisions)), and some
later header-check changes. A rerun after that change found no parse
failures, with a leading `'use strict'` honored (so strict-only errors
like `with` count); the other groups have
drifted too and are not redone here.

| | Scripts | |
|---|---|---|
| Checked | 1996 | every `*.user.js` in the downloaded tree |
| `ok` | 1900 | 95.2% |
| `invalid` | 96 | 4.8% |

- No script produced an **inconclusive** parse verdict, and the checker
  never threw. Every one of the 1900 passes is V8 saying yes, not the
  check failing open.
- 575 of the scripts declare at least one `@require`, so dependency
  handling is exercised broadly rather than incidentally.

## Corpus failures by type

The Failure column summarizes each group rather than quoting the
classifier's `detail` verbatim — the messages are longer than a table
cell. Don't grep for these strings.

| Count | Step | Failure |
|-------|------|---------|
| 46 | `@require` | not in the offline tree |
| 14 | `@resource` | not in the offline tree |
| 10 | `@require` | filename must end in `.js` |
| 10 | `@require` | over the 1 MB per-file limit |
| 6 | `@resource` | over the 1 MB per-file limit |
| 3 | `@require` | an HTML page served in place of the JavaScript |
| 3 | parse | `Identifier '…' has already been declared` |
| 2 | header | metadata block never closed |
| 1 | `@require` | `data:` URL |
| 1 | header | no metadata block at all |

## What's a corpus artifact and what's real

### Artifact of the offline snapshot

- "Not in the offline tree" means the downloader never got the file —
  a dead link, a blocked host, or a URL it skipped.
- The corpus database agrees independently: 45 of 624 distinct
  `@require` URLs and 35 of 157 `@resource` URLs were never fetched.
- Most of these scripts would fail live too (dead dependency links are
  common in old userscripts), but this run can't prove which.

Not evidence about SourceMonkey either way.

### Real, and specific to SourceMonkey

#### `@require` URLs without a `.js` suffix

Every one is a CDN shorthand that serves JavaScript from an
extension-less path:

```
https://cdn.jsdelivr.net/npm/sweetalert2@11
https://cdn.jsdelivr.net/npm/lil-gui@0.19
https://unpkg.com/file-saver
https://bundle.run/p-queue@6.3.0
https://cdn.jsdelivr.net/combine/npm/@violentmonkey/dom@2,npm/@violentmonkey/ui@0.7
```

Tampermonkey does no suffix gating, so these scripts work there.
`isJsResourceUrl` in `file-loader.ts` is the gate.

#### Dependencies over the 1 MB cap

`MAX_FILE_BYTES` in `external-files.ts`. The rejected files are real
libraries a script legitimately pins — `opencv.js`, `babylon.min.js`,
MathJax's `tex-mml-chtml.js`, `video.js`, `babel-standalone`.

#### GM binding collisions

All three parse failures were the same class. When this was measured,
our `GM_*` bindings were `const` declarations in the same scope as the
user program, so a script that declared the same name was a genuine
duplicate declaration.

| Script | Line |
|--------|------|
| DIO-TOOLS | `var uw = …, DATA, GM;` |
| Mutik's DotD Script | `if (typeof GM_setValue === 'undefined') { var GM_setValue = function … }` |
| KissAnime Slimmer Header | `function GM_addStyle(text) { … }` |

The middle one is the classic feature-detect polyfill, and the last is
a script shipping its own `GM_addStyle` while also granting it. None of
the three is broken under Tampermonkey, where `GM_*` are sandbox
globals the script's own declaration simply shadows.

So the verdict was *correct* — that program really didn't compile — but
the program was ours, not theirs. Rate: 3 in 2000 (0.15%).

- Fixed since: the user program now runs in a scope nested inside our
  bindings, so all three shadow them as under Tampermonkey, and a
  rerun reports no parse failures. See
  [injection.md](injection.md#the-user-program-scope).

### Real, and arguably ours to be stricter about

| Case | Detail |
|------|--------|
| 2 × unterminated metadata block | `// ==/UserScript==////` and `// ==/UserScript==vvvvar thisUrl = …` — the closing marker has trailing junk on its own line, which our end-of-line-anchored regex won't match |
| 1 × no metadata block | the file opens `/// ==UserScript==` — three slashes |
| 3 × `@require` served HTML | two `http://cdn.staticfile.org/jquery/…` URLs and one `gitcdn.link` URL now answer with an HTML page; the markup check catches exactly the soft failure it exists for |
| 1 × `data:` URL `@require` | `data:application/javascript,%3Bwindow.Vue%3DVue%3B…` — an inline shim, rejected outright; the bytes are in the ref, so no fetch is involved |

The header cases are parser strictness: Tampermonkey's markers are
matched loosely, ours are anchored (`BLOCK_START` / `BLOCK_END` in
`userscript-header.ts`). GreasyFork accepted all three, so something in
the ecosystem parses them.

Every one of the 96 failures is now accounted for: 60 snapshot
artifacts, 29 real-and-ours, 7 here.

## Follow-ups

The fix list these findings imply lives in
[TODO.md](../TODO.md#greasyfork-corpus-findings), so there is one place
to work from rather than two. This page is the evidence behind it.
