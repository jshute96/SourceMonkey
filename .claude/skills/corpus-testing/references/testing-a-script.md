# Testing corpus scripts

How to test GreasyFork corpus scripts and record the results. Written so it
can be handed to an agent as its whole brief, along with its script IDs and a
run name prefix.

The method itself is in the `SourceMonkey-dev` skill. This file adds what's
particular to the corpus.

## Setup

- Work from the repo root. Load the `SourceMonkey-dev` skill and follow
  `references/testing-scripts.md` there, **non-interactively**, skipping its
  step 1 (getting the scripts and docs). Use `scripts/sm-dev` for `sm-dev`.
- `node greasyfork-testing/record-results.mjs show ID` prints the record as
  JSON, and on stderr a `File:` line naming the downloaded copy, under
  `greasyfork-testing/files/`. Test that copy, not a fresh download.
- The script's corpus ID is the result's `id`. The listing's description in the record
  is the doc to go by; there's no need to fetch the script's page.
- Corpus scripts are untrusted. Never test one as a real user.
- `sm-dev` runs the built `lib/`. Don't rebuild; report a documented command
  that's missing.

What the method's brief leaves open, for the corpus:

- Test against the downloaded `@require` and `@resource` files, so a dead or
  flaky host doesn't stop the run. Give `--root greasyfork-testing/files`
  before the `validate` and `start` commands. Later commands to the run don't
  take it.
  - Use `--root`, not `--local`. `--local` adds the folder but keeps the
    current directory (the repo) as the root that local copies are searched
    in, so a repo file whose path ends the same way can stand in for a dead
    dependency. Script 9630's dead `@resource LICENSE` was served the repo's
    `LICENSE`, with no warning.
- A script you ran that sends private data keeps its result. Add the
  `sends-browsing-data` tag.

## Finding the cause of a failure

The method's "Working out why a script failed" section covers who gets the blame.
This repo can also help show why a script failed:

- Read `docs/` for how SourceMonkey is meant to behave. A documented limitation
  explains a failure but doesn't change the blame: it stays `sourcemonkey` when
  another manager would run the script.
- Violentmonkey's source, if you have a copy, can show what it does differently.
- `@connect example.com` also covers subdomains, as in Tampermonkey. A failed
  request to a subdomain has some other cause.
- For a known gap, link the doc or TODO.md item in the note, so nobody files it
  again.

## Recording

After testing each script, write its result to a file in your scratchpad, in the
skill's `references/test-results-format.md` format, and import it:

```sh
R=greasyfork-testing/record-results.mjs
node $R import-results result-14178.json
```

- Import a file once: each import adds its notes again.
- To fix a note, `show ID` lists them in order, and `set ID --replace-note N
  --note-file F` rewrites note N (from 1).
- Every `fail`, `inconclusive` and `n/a` needs a note.

### Tags

Tags mark a reason that recurs across scripts. Reuse an existing one when it
fits; `record-results.mjs tag list` lists them with descriptions. For example:

- `trusted-types`: fails where the site enforces Trusted Types.
- `http-only-match`: matches only `http://` on a site that now redirects to
  https.

Tags name problems that still exist. Once a SourceMonkey gap is fixed and its
scripts re-tested, its tag comes off them and its definition goes; the notes
keep the history.

A new tag is fine when nothing fits. Put it in the result file's `newTags`,
short and kebab-case, with a one-sentence description, and report it. The import
defines it.

```json
{ "results": [ ... ], "newTags": { "needs-webgl": "Draws with WebGL, which the test browser lacks" } }
```

## Finishing

- Stop your runs and check with `scripts/sm-dev list`.
- Don't commit or change git staging. Change files in the repo only through
  `record-results.mjs`; copies go in your scratchpad.
- Report: one line per script (ID, name, result, tags, summary), new tags with
  descriptions, SourceMonkey gaps with evidence, and friction with the tools,
  briefly, skipping the known differences in the method.
