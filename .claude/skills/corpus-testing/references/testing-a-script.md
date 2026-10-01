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
     results), YouTube live chat and captions. Use the shared visible
     browser on port 9233 for those.
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
  `click` says the element wasn't ready, send `cdp Page.bringToFront` (a
  raw Chrome DevTools Protocol call).

### No side effects

No logins, posting, submitting, purchasing, or account changes, and no
downloads beyond what the check needs. A script that only works with an
account is `n/a` with `--reason requires-login`.

### sm-dev or SourceMonkey?

sm-dev imitates the extension, but not perfectly. Known differences, where
the real extension works and sm-dev doesn't:

- `@run-at document-start` bodies and their `@require`s can run before
  `<html>` exists; `document-body` scripts can run before `<body>`.
- A `GM_setValue` just before a reload, or in `beforeunload`, is lost.
- The isolated world (a granted script's own JavaScript context, apart from
  the page's) enforces the page's Trusted Types, a site policy that blocks
  setting HTML from plain strings (`innerHTML`).
- Only the top frame gets scripts.

When a failure might be one of these, confirm in the real extension. There
are two ways.

**`sm-dev --extension`**, in the `--open-browser` browser, when SourceMonkey
is installed there (the run's first line says `has SourceMonkey`):

```sh
scripts/sm-dev --run <prefix>1 start <file> <url> --extension --solo --detach
scripts/sm-dev --run <prefix>1 stop
scripts/sm-dev clear --extension        # remove the scratch script
```

- The run takes no commands but `stop` (not `logs` or `wait log`), so what
  you learn is its output: the script's log lines and the page's console.
  `start` prints what came before it returned; later lines go only to the
  file on its `Output log:` line, so read that. Use a copy with a
  `console.log` of the value in question when the script logs nothing.
- `--solo` switches off the person's other scripts while it runs, and it
  shares one extension with everyone, so only one agent at a time: not
  in a parallel batch.
- It leaves its tab open; close it by `targetId` (printed at start) with
  `curl http://127.0.0.1:9233/json/close/<targetId>`.

**A throwaway Playwright spec**, when you need to drive the page or check
state, or when other agents are running: it loads the extension in its own
headless browser, so sites that block headless block it too. Put it in
`tests/e2e/zz-tmp-<prefix>-<name>.spec.ts`:

```ts
import fs from 'node:fs';
import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test('script runs', async ({ extensionContext, sm }) => {
  const dir = ScriptsDir.create();
  try {
    // A copy you can edit (a probe log, a changed header) to test a theory.
    dir.writeRaw('s.user.js', fs.readFileSync('tests/greasyfork-examples/files/<file>', 'utf8'));
    await sm.addCollection(dir.path);
    await sm.syncNow();
    const page = await extensionContext.newPage();
    await page.goto('https://example.com/');
    // ... check what the script does, e.g. expect(page.locator(...))
  } finally {
    dir.cleanup();
  }
});
```

Run it with `pnpm exec playwright test <file> --retries=0`, and delete it
afterwards.

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
timing, `@run-at context-menu` unsupported).

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
"SourceMonkey:", "Script:" or "sm-dev:" where it helps. Say when the real
extension was used. No em-dashes.

> On a watch page the player fills the window (1393x983 at 0,0); `w`
> toggles it off and back. A `--noscript` tab stayed at 853x480.

### Tags

Tags mark a reason that recurs across scripts. Reuse an existing one when
it fits; the list, with descriptions, is `HELP.tag` in
`tests/greasyfork-examples/results.html`. Common ones:

- `needs-page-globals`: a granted script reading the page's own globals
  (its jQuery, a player API on an element) without `unsafeWindow`.
- `connect-undeclared`, `connect-subdomain`: `@connect` rules that block
  its requests.
- `trusted-types`: blocked by the site's Trusted Types in the page world.
- `tld-include`: `.tld` hosts in `@include`, which never match.
- `needs-onreadystatechange`, `xhr-response-readystate`,
  `needs-xhr-onprogress`: `GM_xmlhttpRequest` features SourceMonkey lacks.

A new tag is fine when nothing fits. Keep it short and kebab-case, and
report it with a one-sentence description, so it can be added to
`results.html`.

## Finishing

- Stop your runs and check with `scripts/sm-dev list`; close your tabs in
  the shared browser; delete your throwaway specs.
- Don't commit or change git staging. Change files only through
  `record-results.mjs` (and your deleted spec).
- Report: one line per script (ID, name, result, tags, summary), new tags
  with descriptions, SourceMonkey gaps with evidence, and friction with the
  tools, briefly, skipping the known differences above.
