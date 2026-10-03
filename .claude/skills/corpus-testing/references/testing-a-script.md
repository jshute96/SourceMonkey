# Testing one corpus script

How to test a GreasyFork corpus script on its live site and record the
result. Written so it can be handed to an agent as its whole brief, along
with its script IDs and a run name prefix.

## Setup

- Work from the repo root. Load the `SourceMonkey-dev` skill and follow it:
  named runs (`--run <prefix>1`), `--detach`, never `sleep`, `stop` when
  done.
- `node tests/greasyfork-examples/record-results.mjs show ID` prints the
  record. Its `file` is the downloaded copy, under
  `tests/greasyfork-examples/files/`. Test that copy, not a fresh download.
- `sm-dev` runs the built `lib/`. If the task is about a recent fix, make
  sure it's built (`pnpm run build`).

## Method

1. **Read the script.** Work out what it promises, and pick a concrete check
   that proves it: a DOM state, a measured value, a stored value. A
   `newtab --noscript` tab on the same page is the control to compare with.
2. **Run it on the live site** with `start <file> <url> --detach`.
   - Use `--temp-browser` (headless, muted) by default.
   - Many big sites block headless: Google (`/sorry`), Reddit, Amazon,
     IMDb (403), Codeforces and other Cloudflare sites, DuckDuckGo (empty
     results), Metacritic (its `GM_xmlhttpRequest` too), YouTube live chat
     and captions. Use the shared visible browser on port 9233 for those.
   - Headless also has overlay scrollbars, no clipboard access, and
     background tabs that stay visible and focused.
3. **Judge it**, and time-box it (about 10-15 minutes). Read the run's
   output before theorizing: it says whether the script started, and what
   threw. Errors from later events show up only in `logs`, and "settled"
   can come before a script's delayed setup; `wait log` for its own ready
   line.

### The shared browser

Other runs live there: the person's (`D1`, `D2`) and other agents'.

- Name tabs by `T<n>` or `targetId`, never touch other runs' tabs, and
  `closetab` your own before `stop`.
- Mute any media you start (YouTube plays with sound there):
  `eval 'document.querySelectorAll("video,audio").forEach(m => m.muted = true)'`.
- It's normally signed in nowhere, but the person may have a profile of
  their own on the port. If a page shows you signed in, stay read-only: no
  votes, comments, follows, setting changes, or anything saved to the
  account, and say so in your report. Put back anything a script changed
  locally (a stored setting, a localStorage entry) when you can do it
  safely; otherwise leave it and report it.
- Its background tabs are throttled. If a script's timers seem stalled or a
  `click` says the element wasn't ready, `focus` the run's tab.

### No side effects

No logins, posting, submitting, purchasing, or account changes, and no
downloads beyond what the check needs. A script that only works with an
account is `n/a` with `--reason requires-login`.

### The real extension

Every run runs the script in the real SourceMonkey:

- `--temp-browser` installs it in a throwaway headless browser, so it
  needs no setup and is safe beside other agents.
- The shared browser on port 9233 works too, when the run's first line
  says `has SourceMonkey`.
- Each run pushes its scripts into a test collection of its own, which
  `stop` removes, so parallel agents don't see each other's scripts.
  Always `stop` your runs.
- The script's remote `@require`s are fetched live, not from the copies
  in `files/`.
- While a run is live, `@run-at document-start` code may run after the
  page's first inline scripts, where SourceMonkey alone would run it
  first. A script that hooks `fetch` or `XMLHttpRequest` early may miss
  page code for that reason; say so in the note.

## Blame

A `fail` needs `--blame`:

- `sourcemonkey`: SourceMonkey's behavior is the cause, and Tampermonkey or
  Violentmonkey would work. Show the evidence: a copy changed to avoid the
  gap (`@inject-into page`, an extra `@connect`) that then works, or the
  source of the manager that differs.
- `script`: broken or out of date against the current site, or broken in
  every manager. A `@grant none` (page-world) script blocked by the site's
  Trusted Types is the script's fault: every manager runs it there.
- `unknown`: can't tell. Say what's missing. For example, SourceMonkey runs
  `document-idle` after the `load` event, and our cross-manager test finds
  Tampermonkey's idle scripts also see `readyState=complete`, so a script
  that waits for `load` is `unknown` until checked in Tampermonkey.

Check SourceMonkey's intended behavior in `docs/` before blaming it; some
differences are deliberate and documented (strict `@connect`, the idle
timing, `@run-at context-menu` unsupported). A bare `@connect example.com`
does cover its subdomains, as in Tampermonkey.

## Recording

```sh
R=tests/greasyfork-examples/record-results.mjs
node $R set ID --test pass --note-file note.md
node $R set ID --test fail --blame script --tag trusted-types --note-file note.md
node $R set ID --test n/a --reason requires-login --note-file note.md
```

- Write the note to a file in your scratchpad and use `--note-file`:
  shell quoting mangles backticks and quotes.
- To fix a note, `show ID` lists them in order, and `set ID --replace-note N
  --note-file F` rewrites note N (from 1).
- Every `fail` and `n/a` needs a note. `--reason` is only for `n/a`.

### Note style

Markdown, short, factual. Say the page, the action, and what was observed,
with numbers where there are any. Bullets for separate facts, prefixed
"SourceMonkey:", "Script:" or "sm-dev:" where it helps. No em-dashes.

> On a watch page the player fills the window (1393x983 at 0,0); `w`
> toggles it off and back. A `--noscript` tab stayed at 853x480.

### Tags

Tags mark a reason that recurs across scripts. Reuse an existing one when
it fits; the list, with descriptions, is `HELP.tag` in
`tests/greasyfork-examples/results.html`. Common ones:

- `needs-page-globals`: a granted script reading the page's own globals
  (its jQuery, a player API on an element) without `unsafeWindow`.
- `connect-undeclared`: no `@connect` rule for a host it requests.
- `needs-xhr-onprogress`: a `GM_xmlhttpRequest` feature SourceMonkey
  lacks.

Some tags name gaps since fixed (`connect-subdomain`,
`xhr-response-readystate`, `shadows-window`). They stay on scripts that
pass only because of the fix; don't use them for new failures.

A new tag is fine when nothing fits. Keep it short and kebab-case, and
report it with a one-sentence description, so it can be added to
`results.html`.

## Finishing

- Stop your runs and check with `scripts/sm-dev list`; close your tabs in
  the shared browser.
- Don't commit or change git staging. Change files in the repo only
  through `record-results.mjs`; copies go in your scratchpad.
- Report: one line per script (ID, name, result, tags, summary), new tags
  with descriptions, SourceMonkey gaps with evidence, and friction with the
  tools, briefly, skipping the known differences above.
