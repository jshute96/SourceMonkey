---
name: SourceMonkey-dev
description: Develop, debug and test userscripts with SourceMonkey's sm-dev tool and Playwright harness. Run a script in a real browser behind real GM_* APIs, drive and inspect the page, read the script's state, work from saved pages, go beyond sm-dev over raw CDP, and turn the result into specs. Use when writing, debugging or testing a userscript in a repo with the `sourcemonkey` dev dependency.
---

# Userscript development with SourceMonkey

## What this is

- **SourceMonkey** is a Chrome userscript manager (like Tampermonkey).
  Its code for installing and injecting scripts ships as a dev
  dependency, `sourcemonkey`, so tests and tools use the manager's real
  behavior instead of stubs.
- **`sm-dev`** (`pnpm sm-dev ...`; `scripts/sm-dev` in a SourceMonkey
  checkout) is the interactive tool. It starts a
  **run**: a background process that connects to a Chromium over CDP
  (Chrome DevTools Protocol), opens tabs, injects your scripts as they
  are on disk, and streams what they log. You send the run commands to
  drive and read the page.
- **The Playwright fixture** (`import { test, expect } from
  'sourcemonkey/harness'`) runs the same injection in specs.
- Both use the **push backend** by default: SourceMonkey's injected
  code, with a Node stand-in for the extension.
  - Header rules, `@grant`, `@require`, `@run-at`, worlds and `GM_*`
    storage behave as in the extension.
  - `--extension` switches to the real extension for the few things
    only Chrome can answer (see
    [Testing in the real extension](#testing-in-the-real-extension)).
- **The browser's CDP port stays open** to you as well.
  - Anything sm-dev has no command for (back button, window size, mouse
    wheel, drag), do over CDP directly, in the same tab, while
    the run goes on.
  - `$R cdp` sends raw calls to a tab. See
    [Beyond sm-dev: raw CDP](#beyond-sm-dev-raw-cdp).

Paths below like `references/...` are relative
to this skill's directory (where this `SKILL.md` is, for example
`.claude/skills/SourceMonkey-dev/`).

Where to look:

- [references/commands.md](references/commands.md): the commands,
  grouped by task.
- [references/cdp.md](references/cdp.md): raw CDP recipes.
- [references/specs.md](references/specs.md): writing Playwright specs
  with the harness fixture.
- `pnpm sm-dev --help`, or `pnpm sm-dev help <command>`: the
  authoritative, current reference.
- The `SourceMonkey-friction` skill, when installed: log where these
  tools got in the way once the task is done.
- Full docs, when the above isn't enough:
  [harness-guide.md](https://github.com/jshute96/SourceMonkey/blob/main/docs/harness-guide.md).
  Long; search it rather than reading it through.

## Rules that save the most time

- **Never `sleep`.** Commands that act (`start`, `click`, `key`,
  `type`, `reload`, `open`, `newtab`) return once the page has settled:
  loaded, scripts started, no requests or DOM changes for a moment.
  For anything later, wait for the signal itself: `wait log <text>`,
  `wait selector <css>`, `wait selector-gone <css>`.
  - Waits give up after 5 seconds. Pass `--timeout-seconds S` for a
    slow site, and keep S under your shell tool's own time limit.
  - With no signal to wait for (sampling something over time), use
    `wait 2s`, not `sleep`.
- **Don't use `--seconds`.** A run that expires mid-test leaves pages
  with no script, and results that look like bugs. Use `--detach`, and
  `stop` when done.
- **Name your run**: `pnpm sm-dev --run Dagent start ... --detach`,
  then `--run Dagent` on each command.
  - The person may have runs of their own. `start --detach` without
    `--run` stops earlier detached runs, and with several runs active,
    commands without `--run` are refused.
  - Find and end runs with `sm-dev list` and `sm-dev stop <ID>`, never
    `pkill`.
- **Name tabs by `T<n>` or `targetId`, never by URL.** Two tabs on the
  same page are common, and acting on the wrong one looks like the
  script didn't run.
- **Read the run's output before theorizing.** It says whether the
  script started, was skipped (and which header rule decided), or
  threw, with file and line.
- **Write scripts as they ship.** No guards for missing `GM_*`, no
  test-only branches: the harness defines what a real manager defines.
- **Real sites have real data.** Only do reversible actions on
  account or shopping pages, and never submit or save. Use a saved
  page when that isn't enough.
  - The `--open-browser` browser may be signed in to the person's
    accounts. Stay read-only there: don't change any data or settings,
    or do anything else with side effects.

## Getting a browser

sm-dev connects to a browser on port 9233 (or `--cdp PORT`). With none
there, it says so: `Start one with sm-dev --open-browser, pass --cdp,
or use --temp-browser`.

- `pnpm sm-dev --open-browser`: a visible browser that stays open, with
  a kept profile, so sign-ins persist. Use it for sites that need a
  login; ask the person to sign in there. A no-op if one is already up.
- `pnpm sm-dev --temp-browser start ...`: a hidden throwaway browser
  for that run, on a random port, closed when the run ends. Good for
  pages with no login. With `start --extension`, it installs
  SourceMonkey in that browser (see
  [Testing in the real extension](#testing-in-the-real-extension)).
- If the person already has a browser on the port, use it: their tabs
  are left alone, and only the run's own tabs are touched.

The headless `--temp-browser` is often blocked by large sites (Reddit,
Google, Amazon, Vimeo, IMDb, parts of YouTube).

- The block page still loads, so `start` reports the script as
  started on it. Check the page (`eval document.title`, `screenshot`)
  before believing a result.
- Use `--open-browser` for those sites from the start.

In the shared `--open-browser` browser:

- Its background tabs are throttled, and a hidden tab can make
  `click` fail. `focus` brings the run's tab to the front.
- `stop` leaves the run's tabs open. `closetab all` first.

## The core loop

```sh
R="pnpm sm-dev --run Dagent"

$R validate sites/x/y.user.js                        # header, @require, syntax (see below)
$R match sites/x/y.user.js https://x.com/some/page   # would it run there, and why
$R start sites/x/y.user.js https://x.com/some/page --watch --detach
$R status                                            # tabs, scripts, what's active
# ... drive and read the page (recipes below) ...
# ... edit and save: --watch re-injects and reloads the affected tabs ...
$R stop
```

- `start --detach` returns once the page has settled, printing the
  run's startup output: whether the script started, and what it
  logged.
- Each later command prints its own output, including what the page
  and scripts logged during it, and exits.
- After a save, the next command's output shows the reload and the
  script's fresh startup lines. Without `--watch`, run `update`.
- The run's full stream, with timestamps, is in its log file. `status`
  shows the path; `<ID>.log` beside it links to the run's latest.

What the stream looks like:

```
[sm-dev] Injected sites/x/y.user.js in world USER_SCRIPT, run-at document-idle
[sm-dev] Opening https://x.com/some/page in T1 [targetId=61023580282B1D684FAF4072C201AB51]
[sm-dev] Y started on https://x.com/some/page
[page log] [y] toolbar found, button inserted
[sm-dev] GM_setValue lastItem = "42"
```

- `[sm-dev]` lines are the harness's reports; `[page log]` lines are
  console output from the script (or `[name]`-prefixed lines).
- Lines from other tabs are prefixed with `[T2]`.
- The site's own errors are hidden. Add `--page-errors` to `start` when
  the script may be breaking the page, or runs code outside its file
  (an added `<script>`, `eval`).

A person at a terminal can use `pnpm sm-dev --interactive start ...`
for a `> ` prompt instead. An agent should use `--detach` and separate
commands.

## Recipes

### Checking the header and script: `validate`

Run it after any edit, before loading the script anywhere. It is fast,
needs no browser or run, and runs the extension's own install checks:
the metadata block, `@match` / `@include`, `@require` loading (local
copies included), and a syntax check of the body.

```sh
$R validate sites/x/y.user.js
$R validate sites/x/                   # all scripts under a directory
$R validate 'sites/**/*.user.js'       # or a glob (quoted: sm-dev expands it)
```

```
INVALID  sites/x/bad.user.js
    Syntax error: Unexpected token ';' (in sites/x/bad.user.js, line 5, column 11)
ok       sites/x/y.user.js
    warn: Ignoring unsupported @grant GM_frobnicate (in sites/x/y.user.js, line 6)

1 ok, 1 invalid
```

- Exit code 1 when any script is invalid, so it works as a gate.
- The message is the one the extension's viewer would show, with the
  file and line. A script with no `@match` or `@include` is invalid
  (it would never run).
- `warn:` lines don't make it invalid, but read them. An unsupported
  or misspelled `@grant` is ignored, so that `GM_*` name won't exist
  at runtime.
- `UNCHECKED` means the syntax check couldn't finish (e.g. very deep
  nesting). The script still loads and the exit code is 0, but its
  syntax wasn't verified.
- An invalid script is refused by `start` and `loadUserscript` with the
  same message, so fixing it here saves a failed run.
- It doesn't check that `@grant` covers every `GM_*` the code calls; a
  missing one shows up at runtime as `GM_x is not defined`.
- In a run, `validate` re-reads the selected script from disk, and
  `validate all` checks all loaded scripts.

### Does the script run on this page?

```sh
$R match sites/x/y.user.js https://x.com/a https://x.com/b
$R start sites/x/y.user.js https://x.com/a --detach
$R status
```

- `match` names the rule that matched or excluded each URL. It is
  cheap: run it after any header edit.
- `status` shows each script as `Active` or `Not active` on the current
  tab, and the other tabs it runs on.
- On a single-page app the URL can change without a load. `match` in a
  run (no arguments) checks the selected script against the current
  tab's URL now.

### Finding selectors

```sh
$R snapshot --visible               # what's on screen, one line per element, with refs
$R probe --css e14                  # a short unique CSS selector for a ref
$R probe --css --html '.titleline > a'   # selector + HTML for the first 10 matches
$R probe '.title a' '[data-testid=post]' '#missing'   # which match, how many
$R click e14                        # refs work anywhere a selector does
```

- `snapshot` is the accessibility tree: roles, names, and a ref like
  `e14` (`f2e6` inside a frame). `snapshot <selector>` shows part of the
  page; `--out file` saves a large one.
- Refs only last until the page changes: take a new snapshot after a
  reload or navigation.
- `probe --css` skips ids and classes that look generated
  (`css-1x2y3z`). Elements inside a shadow root or frame get no
  selector; use the ref.
- Prefer selectors that describe purpose: ids and `data-*` the site
  put there, then meaningful class prefixes and `aria-label`, then
  role plus text. Avoid layout and SVG geometry.
- Verify the selector you'll put in the script with `probe` (count),
  then `eval` for its content:
  `$R eval "[...document.querySelectorAll('.titleline > a')].map(a => a.href).slice(0, 5)"`.
- Capture the states the script will walk before writing it: open each
  menu or popup (`click`), then `snapshot` or `probe --html` again.
  Menus often replace each other, and attributes like `aria-controls`
  often exist only while open.

### Driving an interaction and checking the result

```sh
$R click '[aria-label="Next"]'
$R click e14 --button right          # also middle; --modifiers Shift+Control
$R click '.word' --count 2           # double-click (3: triple)
$R key j j Shift+ArrowRight
$R type 'input[name=q]' 'hello world'
$R hover '.card:first-child'
$R wait selector '.result'           # when the result comes later than the settle
$R eval 'document.querySelector(".result")?.textContent'
$R screenshot shot.png               # then look at the PNG
```

- Clicks, hovers and keys are real input (scrolled into view, trusted
  events), so the page can't tell them from a person's.
- A `click` or `hover` that fails says why: the element stayed hidden,
  disabled or moving, or another element covered it (named). Fix that
  (hover first, wait, close the overlay) rather than clicking its
  pixels over `cdp`, which skips those checks.
- `--at x,y` clicks or hovers at a point in the element (pixels from
  its top left corner), for a spot other than its center, e.g. a row's
  empty space rather than the link in its middle. `hover` takes
  `--modifiers` too.
- A scroll from `eval` (`scrollIntoView`, `scrollBy`) fires no
  `wheel` event, so a script that watches for the user scrolling won't
  see it. Send a real wheel event over `cdp` (see
  [Mouse wheel](references/cdp.md#mouse-wheel)).
- Keys go to the page, not to Chrome: Chrome's shortcuts (back, reload,
  zoom, Escape leaving fullscreen) don't fire.
- A command that opens a dialog (`alert`, `confirm`, `prompt`) returns
  once it's up. Answer with `accept [text]` or `dismiss`; until then
  the page is frozen, and most commands refuse.
- `logs` prints everything the page logged, filtered or not.
- Quoting: quote selectors with spaces or `#` for the shell
  (`click '#submit'`).

### Seeing into the script: debug state and logging

A script's state is invisible from outside unless it exposes some.
Build this in while developing; it's cheap and can stay.

Expose state and functions on `window`:

```js
const state = { slide: 0, zoom: 1 };
window.myScript = { state, currentSlide, relayout };   // for eval --script
```

```sh
$R eval --script 'myScript.state'            # printed as JSON
$R eval --script 'myScript.currentSlide()'
$R eval --script 'myScript.relayout(); myScript.state'
```

- `eval --script` runs in the scripts' world. With any `@grant` other
  than `none`, that's an isolated world the page can't see, so a
  `window` property there is private to the script.
- A `@grant none` script shares the page's world: use plain `eval`,
  and pick a name the site won't collide with.
- It reaches what's on `window`, not local variables. Expose what you
  want to see.
  - The script's `GM_*` functions aren't there either. Read storage
    with `values` and `get`, and change it with `set`.
  - With `@grant none`, `--script` is just the page (there's no
    `unsafeWindow`).

Log what happens, and wait for it instead of sleeping:

```js
const log = (...args) => console.log('[my-script]', ...args);
log('applied preset', name);
```

```sh
$R click '.apply' -- wait log 'applied preset'
$R wait log '/saved record \d+/'           # a regex
```

- `wait log` also matches lines printed since the previous command
  began, so a line printed during the click counts.
- It sees the lines the run's output shows: the script's, and
  `[name]`-prefixed page lines. The site's other console lines, which
  `logs` shows, aren't among them.
- A command returns once the page settles, which can come before a
  script's delayed setup (a timer, a retry loop). `wait log` for the
  script's own ready line before driving it.
- Errors a script throws later, from events and timers, show in the
  output of whatever command was running, or only in `logs` if none
  was. Check `logs` before calling a script clean.
- `GM_log` shows as `<name> GM_log: ...` in the output. In the
  extension, it also goes to the page console and the script's Log tab.
- Async work fired from an event handler: have it log on completion
  and `wait log` for that, rather than polling the DOM for a state
  that may be intermediate.

Gate chatty logging on a stored value, so it can be switched live:

```js
let debug = GM_getValue('debug', false);          // @grant GM_getValue
GM_addValueChangeListener('debug', (key, old, value) => { debug = value; });
const trace = (...args) => debug && console.log('[my-script]', ...args);
```

```sh
$R start sites/x/y.user.js --values '{"debug": true}' --detach   # on from the start
$R set debug true                                                # or flip it live
```

- `set` writes as another tab would, so the change listener fires.
- For state a spec should read too, mirror it into the DOM:
  `document.documentElement.dataset.myScriptZoom = zoom`. Then
  `eval document.documentElement.dataset` or a Playwright locator reads
  it.

### Menu commands and stored values

```sh
$R menu                 # the tab's commands: M1, M2 ...
$R menu 'Toggle dark'   # fire by label (or: menu M1)
$R values               # what the scripts stored
$R get lastItem
$R set units '"metric"' # JSON; running scripts' change listeners fire
$R set prefs --file prefs.json                 # long JSON, from a file
$R start ... --values '{"units": "metric"}'    # seed before the script runs
$R start ... --values-file values.json         # seed from a JSON file
```

- `set <key> {{` ... `}}` takes several lines of JSON, on stdin or at a
  prompt, as `eval` does. Send it in a heredoc (see
  [Multi-step sequences](#multi-step-sequences)).
- Reads wait for the script's write batching, so `menu X` then
  `values` shows what X stored.
- Stored values belong to the script and survive `update` and reloads.
  Under `--extension` they live in the extension, so `--values` and
  `--values-file` can't be used with it.

### Working from a saved page

Use a saved copy when the live page needs a login, keeps changing,
has state you mustn't touch, or a spec needs to be stable.

`--from-saved` opens a saved HTML file at the URL it was saved from,
with the scripts matching and running as on the live site. The file
can come from:

- sm-dev's `savehtml` (below).
- Chrome's Save Page As ("HTML only", or "Webpage, Complete" with its
  `<name>_files` folder, which is served from disk);
- SeeWhatISee, a Chrome extension that captures screenshots and page
  HTML. The person may already given you a snapshot you can use.

```sh
$R newtab page.html --from-saved              # served at its recorded URL
$R newtab 'pages/*.html' --from-saved --offline   # several; no network
$R open page.html --from-saved --url https://x.com/some/page   # one that records no URL
```

- The tab shows the original URL, so `@match`, origin, cookies and
  relative URLs behave as live.
- Without `--offline`, the page's requests (images, fetches) go to the
  live site. A file that keeps the site's own JavaScript (Chrome's and
  SeeWhatISee's do) runs it on replay, and it may re-fetch or redirect:
  `--offline` stops that.
- `reload` re-reads the file, so it can be edited between loads.
- It sticks to that URL in that tab: other URLs load live, and coming
  back serves the file again.
- In a spec: `await page.goto(await serveHtml('pages/some-page.html'))`.

Saving one with sm-dev:

```sh
$R newtab --noscript https://x.com/some/page   # a tab without the scripts
$R savehtml pages/some-page.html              # the DOM, with the URL recorded
```

- Save from a `--noscript` tab. A page saved with the script running
  has its changes in it, and gets them twice on replay (sm-dev warns).
- Capture each state the script cares about (menu open, popup shown)
  as its own file: bring it up in the `--noscript` tab, then `savehtml`.
- A `savehtml` file has the site's JavaScript disabled, so it can't
  re-fetch or rebuild itself. Interactions that need the site's code
  won't work there; the script's own code runs normally.
- It can't capture shadow roots, typed form values or canvas pixels.
  Check selectors inside a shadow root on the live page.

### Several tabs

- Tabs the run's tab opens (links, `window.open`, `GM_openInTab`) get
  the scripts too, as `T2`, `T3`. Tabs the person opens are left
  alone.
- `newtab <url>` opens another controlled tab and makes it current;
  `tab T1` switches back. Page commands take a tab first:
  `click T2 '.x'`, `eval T2 location.href`, `open T2 <url>`,
  `wait T2 selector '.x'`, `menu T2.M1`.
- `closetab` closes the current tab; `closetab T2 T3` or `closetab all`
  close others. A page that asks first ("Leave site?") shows its
  dialog, answered with `accept` or `dismiss`; `--force` skips it.
- `tabs` lists them with their `targetId`s, for your own CDP clients.
- `reload all` reloads every tab; `wait all` waits for every tab to
  settle.

### Multi-step sequences

Commands on one line run in order and stop at the first failure (a
`click` with no element, an `eval` that threw, a `wait` that gives up),
like `&&`. A `match` or `validate` miss doesn't stop them, nor does an
`eval` or `cdp` call cut off by a navigation it set off. To check for
an element that may not be there, use `probe`, which doesn't fail.

```sh
$R start sites/x/y.user.js https://x.com/ --detach -- click '.open' -- wait selector '#modal' -- snapshot '#modal'
```

A longer script, or any command with quotes in its arguments (JSON
strings and selectors included), reads better as a heredoc (no shell
quoting).
Each line is a command:

```sh
$R --stdin <<'EOF'
click '.open-modal'
wait selector '#modal-dialog'
type '#input-name' 'Test User'
click '#modal-submit'
wait log /Saved record \d+/
eval --script myScript.state
EOF
```

- Blank lines and `# comments` are skipped.
- Quotes: most commands take one level of quotes off, as a shell
  would (`menu 'Toggle dark'`). `set` takes off single quotes around
  its JSON (`set k '["a"]'`), since double quotes are JSON's own.
  `eval` takes off none: the rest of its line is JavaScript as
  written, so `eval "abc"` is a string.
- A `{{` ... `}}` block spans several lines: JavaScript for
  `eval {{`, JSON for `set <key> {{`, text for `type <selector> {{`,
  CDP calls for `cdp {{` (see [references/commands.md](references/commands.md#eval)).
- `{{` ends its line, and the block's content starts on the next.
- `--file` reads the same from a file instead: `eval --file probe.js`,
  `set <key> --file value.json`, `type <selector> --file notes.txt`,
  `cdp --file calls.txt`.
- The whole input is checked before anything runs, so an invalid
  command anywhere in it runs nothing.

### Beyond sm-dev: raw CDP

For what sm-dev has no command for, `cdp` sends a raw CDP call to a
tab (the current one, or `T2` first), and prints the result as JSON.
A `{{` block, or `--file`, holds several calls, one per line, on one
session:

```sh
$R cdp Input.dispatchMouseEvent '{"type":"mouseWheel","x":400,"y":300,"deltaX":0,"deltaY":600}'
$R cdp T2 Page.getNavigationHistory
```

- [references/cdp.md](references/cdp.md) has details and recipes:
  back and forward, window size, mouse wheel, clicks at a point,
  drag, fullscreen, per-frame tracing.
- `cdp` doesn't wait for the page to settle. Run `wait` after it.
- For events, or state that outlasts one command, connect your own CDP
  client alongside the run (see the reference).
- For DevTools' own tools (network requests, performance traces,
  Lighthouse), `start --devtools` runs a Chrome DevTools MCP server on
  the run's tabs, for the `chrome-devtools` command. MCP (Model Context
  Protocol) is the protocol agent tools speak. `tabs` then shows each
  tab's DevTools `pageId`.
- Things sm-dev can do itself are better done there: it waits for the
  page to settle, and its output lands in the run's stream.
- Some things need no CDP: `eval history.back()` then `wait`,
  `eval 'scrollBy(0, 800)'`.

### Fullscreen (images, videos, lightboxes)

- Enter it as a person would: `key f`, or `click` the site's button.
- Exit with `eval document.exitFullscreen()`: `key Escape` doesn't
  exit (sm-dev says so).
- Checking the state, forcing it off, pitfalls, and tracing a
  transition frame by frame:
  [references/cdp.md](references/cdp.md#fullscreen).

### Testing in the real extension

Use it when the question is about Chrome itself:

- how a site treats a `GM_xmlhttpRequest` (the extension's cookies,
  no `Origin`, `Sec-Fetch-Site: none`);
- CSP, Chrome's own match gating, Chrome's download or notification
  UI.

```sh
$R start sites/x/y.user.js https://x.com/ --extension --solo --detach
# ... same commands ...
$R stop
$R clear --extension     # drop scratch scripts; restores other collections
```

- Needs SourceMonkey in the browser, with "Allow User Scripts" on.
  - **`--temp-browser` with `--extension` installs the extension**
    (Allow User Scripts on), so it needs no setup:
    `$R --temp-browser start x.user.js https://x.com/ --extension`.
    Its profile is empty (no logins), and the scratch scripts go with
    it. For a site that needs a login, or blocks headless browsers,
    use the `--open-browser` browser, once the extension is loaded
    there.
  - The run's first line (`Connected to browser ... (Chrome ...,
    has SourceMonkey)`) and `status` say whether the extension is
    there: `has SourceMonkey`, `SourceMonkey disabled` or `no
    extension`. They can't see "Allow User Scripts".
  - If the extension is missing or disabled there, use `--temp-browser`
    (when no login is needed), ask the person, or see
    [Setting it up](https://github.com/jshute96/SourceMonkey/blob/main/docs/harness-guide.md#setting-it-up).
- The script is pushed as a scratch script; relative `@require`s are
  refused, and remote ones are fetched live, not from local copies.
- Output is the script's Log tab entries plus page console lines.
- **Before building on a new request path, send one real request
  from it here.**
  - A request that works from the page can still be refused from the
    extension: different cookies, and headers a WAF (web application
    firewall) rejects.
  - A 403 the page can't reproduce often comes from the site's CDN
    edge, not its origin server.

### Turning it into a spec

```js
import { test, expect } from 'sourcemonkey/harness';

test('adds the button', async ({ page, loadUserscript, gm, reports }) => {
  await loadUserscript('sites/x/y.user.js');    // before the goto
  await page.goto('https://x.com/items/42');
  await reports.waitForStart();
  await expect(page.locator('#add-button')).toBeVisible();
  expect(reports.errors()).toEqual([]);
});
```

- Run it with `pnpm exec playwright test sites/x/y.spec.mjs`.
- [references/specs.md](references/specs.md) has the rest: mapping
  sm-dev commands to the fixture, network requests, and pages with no
  site behind them.

## Troubleshooting

- **`skipped on <url>: ...`**: the header doesn't cover the page; the
  extension would skip it too. `match` shows why.
- **`GM_x is not defined`**: missing `@grant GM_x`. Same in the
  extension.
- **A page global is `undefined` in the script**: it's in the isolated
  world. Use `unsafeWindow`, or `@grant none`.
- **The script never runs in an iframe**: sm-dev injects into the top
  frame only.
- **It works in sm-dev but not in the extension, or the reverse**: see
  [Known differences](https://github.com/jshute96/SourceMonkey/blob/main/docs/harness-guide.md#known-differences-under-the-push-backend):
  `document-start` code running after early page scripts, Trusted
  Types in the isolated world, an inserted inline `<script>` blocked by
  a strict page CSP, a `GM_setValue` lost to an unload. Check in the
  extension (above).
- **A command is `Unknown`, or behaves unlike these docs**: sm-dev may
  be older than the SourceMonkey source (it warns, and says what to
  run). Ask the person before building, since it changes the code
  under other running sessions.
- **The script seems stale**: check the reload lines after the save, or
  `update` (it skips files whose modification time hasn't changed; a
  `touch` forces it).
- **After changing SourceMonkey itself**: `pnpm run build` there, then
  `pnpm install` in the userscript repo. The dependency is a copy of
  the build, taken at install time, and sm-dev warns when it's behind.
- **`start` hangs connecting**: a tab in that browser is showing a
  dialog. The run names it; answer it or close the tab.
- **Commands refuse with a dialog open**: `accept` or `dismiss` first.
- **A wait gave up**: its message says what was still busy (requests,
  DOM changes). A page with a slow API or a never-ending resource never
  settles; `wait selector` for the element you need instead.
