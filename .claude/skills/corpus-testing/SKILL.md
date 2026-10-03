---
name: corpus-testing
description: Test GreasyFork corpus scripts (tests/greasyfork-examples/) on their live sites and record the results in corpus.json. Covers testing one script, running a batch with parallel agents, pulling their results together, and re-testing earlier failures after a fix. Use when asked to test corpus scripts, re-test failures, or tidy corpus test results.
---

# Testing the GreasyFork corpus

The corpus (`tests/greasyfork-examples/`) is the 2000 most-installed
GreasyFork scripts, downloaded, with a record per script in `corpus.json`.
Testing a script means running the downloaded copy on its target site with
`sm-dev`, judging whether it does what it promises, and recording that.

Where things are:

- `tests/greasyfork-examples/README.md`: the tools and data. Downloading,
  validation, the record format, statuses and blames, the results page. Read
  its "Test results" section once. Downloading and re-validating are rare;
  follow the README when they're needed.
- [references/testing-a-script.md](references/testing-a-script.md): how to
  test one script and record it. Hand this file to each agent in a batch.
- The `SourceMonkey-dev` skill: how to drive `sm-dev` itself.
- The `SourceMonkey-friction` skill: log tool friction when the work is done.
- `results.html` (served by `serve-results.mjs`, or any static server for
  the folder): the results table, with each tag's description in `HELP.tag`.

Every `.mjs` tool takes `--help`.

## Build first

`sm-dev` runs the built `lib/`, and never builds it, so it can lag the
source: a stale build once made documented commands (`closetab`) fail as
unknown, and would test SourceMonkey as it was, not as it is.

- Run `pnpm run build` before starting any testing.
- Build before launching a batch's agents, not while they run: a build
  swaps `lib/` under every running `sm-dev` session, and a run started
  earlier keeps its old code anyway.
- Agents don't rebuild. One that finds a documented command missing
  reports it.

## Picking scripts to test

```sh
R=tests/greasyfork-examples/record-results.mjs
node $R list --untested --valid ok          # candidates, in listing order
```

`list` doesn't show update dates; filter on them in `results.html` (Test:
untested, sort by Updated) or in `corpus.db` (`Scripts.updated_date`, after
`build-db.mjs`).

- Prefer valid scripts updated in the last few years; older ones are mostly
  broken against today's sites, which teaches little about SourceMonkey.
- Skip what can't be judged without side effects or an account: game cheats
  and bots, login-only sites, social and dating apps, course and exam sites,
  shopping flows, paid features. Leave these untested rather than
  recording `n/a`: `n/a` is for a script you tried and couldn't judge.
- Group a batch by site (YouTube, search engines, scripts that run on every
  site...), so each agent learns one site.

## Running a batch with parallel agents

For more than a handful of scripts, split them across background agents,
about 6-10 scripts each. Each agent:

- Gets its script IDs, a run name prefix of its own (`DhA`, `DhB`, ...;
  never `D1`/`D2`, which are the person's), and
  [references/testing-a-script.md](references/testing-a-script.md) to read
  first. Add site hints (which sites block headless, which to avoid).
- Records its own results with `record-results.mjs`, which is safe to run in
  parallel.
- Doesn't edit results.html, TODO.md or the friction log: it reports new
  tags, SourceMonkey gaps and friction back, for one person to merge.

Keep notes as reports arrive (a scratchpad file), since there are many.

### Pulling the results together

When every agent has reported:

1. **Check completeness.** Every ID has a `test`; `scripts/sm-dev list`
   shows no leftover runs; `git status` shows no stray files.
2. **Merge duplicate tags.** Agents invent tags independently; two names for
   one problem (`idle-after-load` / `onload-after-idle`) become one with
   `set ID --untag old --tag new`.
3. **Describe new tags** in `HELP.tag` in `results.html`, one sentence each.
4. **Check blames against each other.** One agent's `sourcemonkey` blame can
   contradict another's evidence (for example our cross-manager tests showing
   Tampermonkey behaves the same). Re-record with `set ID --test fail --blame
   unknown --note-file F` saying why, rather than leave a wrong blame.
5. **Fix bad notes.** `show ID` lists them in order; `set ID
   --replace-note N --note-file F` rewrites note N (from 1), and
   `--remove-note N` drops a superseded one. Never edit corpus.json by hand.

6. **Report SourceMonkey gaps** to the person, with evidence, and offer
   TODO.md entries (the README says a `sourcemonkey` failure should get one).
7. **Log friction** with the `SourceMonkey-friction` skill: a new entry per
   batch, listing the IDs, with repeats of earlier items marked as such.
8. Tell the person the totals, the SourceMonkey gaps, and anything an agent
   did on a signed-in site.

## Re-testing after a fix

When a SourceMonkey fix lands, re-test the scripts it should have fixed.

Find them by tag or blame:

```sh
node $R list --tag shadows-window                  # a tag names the gap
node $R list --test fail                           # all failures
node tests/greasyfork-examples/build-db.mjs        # or query by blame:
sqlite3 tests/greasyfork-examples/corpus.db \
  "SELECT script_id, test_status, test_blame FROM ScriptResults WHERE test_blame = 'sourcemonkey'"
```

For each one:

- Build with the fix in it first (see [Build first](#build-first)).
- Re-read the old notes (`show ID`): they say what failed and how it was
  checked. Repeat that check.
- Record the new result with `set ID --test ...`. It replaces `test`, and the
  new note is appended, so say what changed: "Re-tested after <commit>
  (<fix>): now passes; ..." or "still fails: ...".
- Untag a gap tag that no longer applies (`--untag`), or keep it if the
  script still relies on the behavior and passes only because of the fix;
  say which in the note.
- A script can fail for a second reason once the first is gone. Record that
  as its own failure, with its own blame.

Results also go stale when the downloaded copy changes: `results.html`
flags a test whose `version` differs from the copy in `files/`. Re-test
those the same way.
