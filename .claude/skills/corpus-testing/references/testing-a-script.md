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
   - Use the default temp browser (headless, muted), a browser of the
     run's own: pass no `--existing-browser` or `--open-browser`.
   - A browser shared between runs is a last resort:
     - One agent's busy tab there stalls every other agent's `start`.
     - It keeps a persistent profile, which is riskier for an untrusted
       script than a throwaway one (see [Untrusted scripts](#untrusted-scripts)).
     - Use one (`--open-browser`) only when a site blocks temp browsers
       but not a regular one (Google's `/sorry`), and only for a script
       that looks low-risk.
   - Many big sites block headless: Google (`/sorry`), Reddit, Amazon,
     IMDb (403), Codeforces and other Cloudflare sites, DuckDuckGo (empty
     results), Metacritic (its `GM_xmlhttpRequest` too), YouTube live chat
     and captions. Use `--headed` for those, a visible
     browser of your own (muted too).
   - A bot check that stops the headed browser too (a captcha, a
     Cloudflare checkbox, a firewall's "Access Blocked") makes the script
     `n/a --reason bot-blocked`, unless the script can still be judged
     elsewhere. Don't solve captchas.
   - Headless also has overlay scrollbars, no clipboard access, and
     background tabs that stay visible and focused. A `--headed` browser's
     background tabs are throttled: if a script's timers seem stalled or a
     `click` says the element wasn't ready, `focus` the run's tab.
3. **Judge it**, and time-box it (about 10-15 minutes). Read the run's
   output before theorizing: it says whether the script started, and what
   threw. Errors from later events show up only in `logs`, and "settled"
   can come before a script's delayed setup; `wait log` for its own ready
   line.

### Untrusted scripts

Corpus scripts are strangers' code. We don't trust them, and we don't run
one that looks risky.

- We're mostly safe because the test browser holds no real credentials:
  it's a throwaway profile, signed in to nothing. Keep it that way, and
  never test a script as a real user.
  - A shared `--open-browser` browser is persistent: what a script
    stores or changes there stays for later runs. Prefer a temp browser,
    and never sign in to anything in a shared one either.
- No deep audit is needed before a run. But if the name, the description,
  or the read you do to learn what the script promises looks dangerous,
  don't run it. For example, a script that:
  - collects cookies, tokens, passwords or form input and sends them
    somewhere;
  - posts page contents or browsing data to a third-party server, beyond
    what its feature plainly needs;
  - downloads and runs code from an unexpected host, or obfuscates what
    it does;
  - mines, spams, or drives accounts or payments.
- Stay alert while testing and debugging too. If a script starts doing
  something strange (requests to unexpected hosts, reading storage it has
  no use for), stop the run.
- Record a script you won't run as `n/a --reason unsafe`, with a note
  saying what looked dangerous, so nobody picks it up later. It's the one
  `n/a` that needs no run.
- A script you already ran that turns out to send private data (page URLs
  or contents to its author's server, say) keeps its result; add the
  `sends-browsing-data` tag and say what it sends in a note.

### No side effects

No logins, posting, submitting, purchasing, or account changes, and no
downloads beyond what the check needs. A script that only works with an
account is `n/a` with `--reason requires-login`.

### The real extension

Every run runs the script in the real SourceMonkey:

- A temp browser (the default) installs it in a throwaway browser, so it needs no
  setup and is safe beside other agents.
- Each run pushes its scripts into a test collection of its own, which
  `stop` removes, so parallel agents don't see each other's scripts.
  Always `stop` your runs.
- The script's remote `@require`s are fetched live, not from the copies
  in `files/`.
- While a run is live, `@run-at document-start` code may run after the
  page's first inline scripts, where SourceMonkey alone would run it
  first. A script that hooks `fetch` or `XMLHttpRequest` early may miss
  page code for that reason; say so in the note.
- A `*PERMISSION PROMPT*` line is SourceMonkey asking whether the script
  may reach a site its `@connect` lines don't cover. Answer `connect
  allow` (as a user trying the script would), and name the sites it
  asked about in the note: Tampermonkey asks about the same ones.

## Blame

A `fail` needs `--blame`:

- `sourcemonkey`: SourceMonkey's behavior is the cause, and Tampermonkey or
  Violentmonkey would work. Show the evidence: a copy changed to avoid the
  gap (`@inject-into page`, say) that then works, or the
  source of the manager that differs.
- `script`: broken or out of date against the current site, or broken in
  every manager. A `@grant none` (page-world) script blocked by the site's
  Trusted Types is the script's fault: every manager runs it there.
- `unknown`: can't tell. Say what's missing.

Blame follows the outcome, not the intent:

- A limitation SourceMonkey documents or chose on purpose (`@run-at
  context-menu` unsupported, say) is still a `sourcemonkey` failure when
  another manager would run the script. Say in the note that it's a known
  gap, and link the doc or TODO.md item, so nobody files it again.
- It's `script` only when we've decided the script is what's wrong.
- Read `docs/` to find the cause, not to excuse it. Some behavior is easy
  to misread: a bare `@connect example.com` does cover its subdomains, as
  in Tampermonkey, so a failed subdomain request has another cause.

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
`tests/greasyfork-examples/results.html`. For example:

- `needs-page-globals`: a granted script reading the page's own globals
  (its jQuery, a player API on an element) without `unsafeWindow`.

Some tags name gaps since fixed (`connect-subdomain`, `connect-undeclared`,
`value-sync-latency`, `xhr-response-readystate`, `needs-xhr-onprogress`,
`shadows-window`, `idle-after-load`). They stay on scripts that pass only
because of the fix; don't use them for new failures.

A new tag is fine when nothing fits. Keep it short and kebab-case, and
report it with a one-sentence description, so it can be added to
`results.html`.

## Finishing

- Stop your runs and check with `scripts/sm-dev list`.
- Don't commit or change git staging. Change files in the repo only
  through `record-results.mjs`; copies go in your scratchpad.
- Report: one line per script (ID, name, result, tags, summary), new tags
  with descriptions, SourceMonkey gaps with evidence, and friction with the
  tools, briefly, skipping the known differences above.
