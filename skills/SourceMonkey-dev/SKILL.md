---
name: SourceMonkey-dev
description: Develop, debug and test userscripts with SourceMonkey's sm-dev tool and Playwright harness. Run a script in a real browser behind real GM_* APIs, drive and inspect the page, read the script's state, work from saved pages, go beyond sm-dev over raw CDP, and turn the result into specs. Use when writing, debugging or testing a userscript in a repo with the `sourcemonkey` dev dependency.
---

# Userscript development with SourceMonkey

## What this is

- **SourceMonkey** is a Chrome userscript manager (like Tampermonkey).
  It ships as a dev dependency, `sourcemonkey`, with its built
  extension and install checks, so tests and tools use the manager's
  real behavior instead of stubs.
- **`sm-dev`** (`pnpm sm-dev ...`; `scripts/sm-dev` in a SourceMonkey
  checkout) is the interactive tool. It starts a
  **run**: a background process that connects to a Chromium over CDP
  (Chrome DevTools Protocol), pushes your scripts as they are on disk
  into the SourceMonkey extension there, opens tabs, and streams what
  the scripts do and log. You send the run commands to drive and read
  the page.
- **The Playwright fixture** (`import { test, expect } from
  'sourcemonkey/harness'`) runs scripts in specs, also in the real
  SourceMonkey extension.
- So header rules, `@grant`, `@require`, `@run-at`, worlds, `GM_*`
  storage and `GM_xmlhttpRequest` behave as they will for users (see
  [How a run uses the extension](#how-a-run-uses-the-extension)).
- **A run can use Tampermonkey or Violentmonkey instead**: to check a
  script is portable across managers, or to debug something that works
  in one but not another. sm-dev downloads either. See
  [Testing under other managers](#testing-under-other-managers).
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
- [references/other-managers.md](references/other-managers.md): testing
  under Violentmonkey.
- `pnpm sm-dev help`: the authoritative, current reference. Alone it
  lists the topics; `help <topic>` or `help <command>` shows one,
  `help commands` lists the commands, and `help all` everything.
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
  - Waits give up after 5 seconds (page loads: 30). Pass
    `--timeout-seconds S` to any command that waits, for a slow site,
    and keep S under your shell tool's own time limit.
  - With no signal to wait for (sampling something over time), use
    `wait 2s`, not `sleep`.
- **Don't use `--stop-after-seconds`.** A run that expires mid-test leaves pages
  with no script, and results that look like bugs. Use `--detach`, and
  `stop` when done.
- **Name your run**: `pnpm sm-dev --run Dagent start ... --detach`,
  then `--run Dagent` on each command. Run IDs start with `D`.
  - The person may have runs of their own. `start --detach` without
    `--run` stops earlier detached runs, and with several runs active,
    commands without `--run` are refused (`status` and `list` show them all).
  - Find and end runs with `sm-dev list` and `sm-dev stop <ID>`, never
    `pkill`.
- **Name tabs by `T<n>` or `targetId`, never by URL.** Two tabs on the
  same page are common, and acting on the wrong one looks like the
  script didn't run.
- **Read the run's output before theorizing.** It says whether the
  script started, was skipped (and which header rule decided), or
  threw, with file and line.
- **Write scripts as they ship.** No guards for missing `GM_*`, no
  test-only branches: they run in the real manager.
- **Real sites have real data.** Only do reversible actions on
  account or shopping pages, and never submit or save. Use a saved
  page when that isn't enough.
  - The `--open-browser` browser may be signed in to the person's
    accounts. Stay read-only there: don't change any data or settings,
    or do anything else with side effects.

## Getting a browser

sm-dev connects to a browser on port 9233 (or `--browser PORT`). With
none there, it says so: `Start one with sm-dev --open-browser, pass
--browser, or use --temp-browser`.

- `pnpm sm-dev --temp-browser start ...`: a hidden throwaway browser
  for that run, on a random port, closed when the run ends, with
  SourceMonkey loaded and ready. Good for pages with no login. Its
  profile is empty.
- `pnpm sm-dev --open-browser`: a visible browser that stays open, with
  a kept profile, so sign-ins persist. Use it for sites that need a
  login; ask the person to sign in there. A no-op if one is already up.
- If the person already has a browser on the port, use it: their tabs
  are left alone, and only the run's own tabs are touched.

The run needs SourceMonkey in the browser, with "Allow User Scripts" on.

- `--temp-browser` always has it. An `--open-browser` or `--browser`
  browser needs it loaded once: `pnpm sm-dev manager install` loads it,
  with "Allow User Scripts" on.
- The run's first line (`Connected to browser ... (Chrome ..., has
  SourceMonkey)`) and `status` say which: `has SourceMonkey`,
  `SourceMonkey disabled` or `no SourceMonkey`. `status` also lists the
  browser's managers, marking one whose "Allow User Scripts" is off.
- When it is missing, use `--temp-browser` if no login is needed.
  Otherwise ask the person whether to install it into their browser
  with `manager install`, or `manager enable` if it's disabled.
- Another manager enabled there (Tampermonkey, Violentmonkey) runs its
  scripts in the run's tabs too. The run's first lines and `status`
  warn of it: ask the person before turning it off with
  `pnpm sm-dev --manager tm manager disable`.

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
# ... edit and save: --watch re-pushes and reloads the affected tabs ...
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
[sm-dev] Pushed to SourceMonkey: sites/x/y.user.js
[sm-dev] Opening https://x.com/some/page in T1 [targetId=61023580282B1D684FAF4072C201AB51]
[event] Y started on https://x.com/some/page
[script log] [y] toolbar found, button inserted
[event] GM_setValue lastItem = "42"
```

- Each line's prefix is its log source, narrowest first:
  - `[sm error]` (or `info`, `warning`): SourceMonkey logs, as the
    script's Log tab shows them;
  - `[event]`: script and tab events: started, threw, page loads (in
    `logs`), tabs opened and closed, dialog boxes, and some `GM_*`
    calls (requests, downloads, menu commands, notifications, values
    set or deleted);
  - `[script log]`: Chrome console logs from the script, by its stack,
    so a page helper it calls counts;
  - `[page log]`, `[page error]`: the rest of Chrome's console, hidden
    by default.
  - A line can be in several sources: `--log-source page` shows all
    the page's console, the script's lines too, and `[event] X threw`
    also counts as `sm`, `script` and `page`.
- `[sm-dev]` lines are sm-dev's own notices.
- Lines from other tabs are prefixed with `[T2]`.
- A DOM node logged to the console prints as its opening tag,
  `<div id="x" class="a b">`, cut at 120 characters.
- The site's own lines are hidden. Add `--log-source all` to `start`
  when the script may be breaking the page, or runs code outside its
  file (an added `<script>`, `eval`). `logs --log-source all` reads
  them back afterwards.
- For a script that acts on the site's or browser's language, add
  `--lang zh-CN` (or `--lang zh-CN,en`) to `start`: the run's tabs then
  report it in `navigator.language(s)`, `Accept-Language` and `Intl`.
  In a connected browser, cross-site iframes and workers keep the
  browser's languages; use `--temp-browser` for a script in frames.

A person at a terminal can use `pnpm sm-dev start ...` with no commands
after `start` for an interactive prompt. An agent should use `--detach`
and separate commands.

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
- Over many scripts, list only the ones that need a look:
  `$R --json validate sites/ | jq -c '.results[] | select(.verdict != "ok" or .warnings)'`.

### Does the script run on this page?

```sh
$R match sites/x/y.user.js https://x.com/a https://x.com/b
$R start sites/x/y.user.js https://x.com/a --detach
$R status
```

- `match` names the rule that matched or excluded each URL. It is
  cheap: run it after any header edit.
- `status` shows each script as `Active` or `Not active` on the current
  tab, and the other tabs and frames it runs on.
- On a single-page app the URL can change without a load. `match` in a
  run (no arguments) checks the selected script against the current
  tab's URL now.
- A script also runs in each iframe whose own URL it matches; see
  [Scripts in iframes](#scripts-in-iframes).

### Finding selectors

```sh
$R snapshot --visible               # what's on screen, one line per element, with refs
$R snapshot --find 'Liked Songs' --context   # only elements containing that, with their wrapper divs
$R probe --css e14                  # a short unique CSS selector for a ref
$R probe --css --html '.titleline > a'   # selector + HTML for the first 10 matches
$R probe '.title a' '[data-testid=post]' '#missing'   # which match, how many
$R click e14                        # refs work anywhere a selector does
```

- `snapshot` is the accessibility tree: roles, names, and a ref like
  `e14`, or `f2e6` with a frame number. `snapshot <selector>` shows
  each of its matches (the first 5; `--limit 0` for all); `--out file`
  saves a large one.
- When you know some text on the page (from a screenshot, the person,
  or an earlier look), use `snapshot --find <text>` instead of a full
  snapshot piped to `grep`. It shows the matching elements with refs.
  - With a selector, it looks only within the selector's matches.
  - `--context` adds the wrapper divs and small containers around each
    match (of `--find` or a selector); `--up N` climbs N levels.
- Refs only last until the page changes: take a new snapshot after a
  reload or navigation. Refs from `snapshot <selector>` and from the
  whole page both work.
- `snapshot` includes panels a script adds after `<body>` and inside
  open shadow roots.
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
  once it's up. Answer with `accept [tab] [text]` or `dismiss [tab]`;
  until then the page is frozen, and most commands refuse.
- A `*PERMISSION PROMPT*` line needs an answer before that request
  goes on: see [Permission prompts](#permission-prompts).
- `logs` reads the run's log back for the tab: its script's lines and
  events, timestamped. `logs all`, `logs 2` (one script),
  `--log-source all` (the site's own too), `--find <text|/re/>`,
  `--tail 50` or `--tail 30s`.
  - It ends with `Logs up to <log ID>`; pass that to `--since` next
    time to read only what came after.
- Quoting: quote selectors with spaces or `#` for the shell
  (`click '#submit'`).

### Seeing into the script: debug state and logging

`eval` runs inside the selected script (`--script=<script>` names
another), so it sees what the script's own code sees:

```sh
$R eval 'GM_info.script.version'
$R eval 'GM_getValue("prefs")'
$R eval 'config.mode'                        # a top-level const of the script
```

- That covers the script's `GM_*` functions, its `@require`
  libraries, its top-level declarations, and its world's globals.
- A script that opens with a `(function () { ... })()` wrapper (or an
  arrow or `async` one) gets it inside that wrapper, so its locals
  there are in reach too.
- Locals inside other functions aren't. Expose them on `window`
  (below).
- Use `eval --page` for the page's own globals (its `$`, an app's
  state object) as the page sees them. An isolated script can't see
  them, and a sandboxed one (below) may have its own `$` from a
  `@require`.

For state inside other functions, expose state and functions on
`window`. Build this in while developing; it's cheap and can stay:

```js
const state = { slide: 0, zoom: 1 };
window.myScript = { state, currentSlide, relayout };   // for eval
```

```sh
$R eval 'myScript.state'                     # printed as JSON
$R eval 'myScript.currentSlide()'
$R eval 'myScript.relayout(); myScript.state'
```

- Unless the script has `@grant none` (no `@grant` line counts as
  sandboxed too), its `window` is its own sandbox, as in Tampermonkey
  and Violentmonkey, so a `window` property there is private to the
  script.
  - The sandbox shows only the browser's built-ins. Read the page's
    globals by bare name (`$`, `appState`) or as `unsafeWindow.x`;
    `window.x` is `undefined` for them.
- A `@grant none` script shares the page's `window`: pick a name the
  site won't collide with. `eval --page` reaches it too.

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
- It sees every log source, including the site's own lines the stream
  leaves out. Each is matched as the stream would print it:
  `[page log] KEYUP 143`. `--log-source script,event` narrows it.
- It ends with `Found at <log ID>`, which `--since` takes.
- So a loose pattern (`error`, `done`) can match the site's own lines;
  use the script's `[name]` prefix or a regex.
- A command returns once the page settles, which can come before a
  script's delayed setup (a timer, a retry loop). `wait log` for the
  script's own ready line before driving it.
- Errors a script throws later, from events and timers, show in the
  output of whatever command was running, or only in `logs` if none
  was. Check `logs` before calling a script clean.
  - With several runs or long sessions, `logs --since <position>` from
    the previous `Logs up to` reads only what's new.
- `GM_log` goes to the page console and the script's Log tab, so it
  shows twice: `[script log] [SourceMonkey:...] ...` and
  `[sm info] <name>: ...`.
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
$R menu 'Run this script'  # run a @run-at context-menu script (again)
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
  They live in the extension; `--values` seeds them as the script is
  pushed.

### `@run-at context-menu` scripts

- These don't run on page load. The run says the script is waiting to
  be run, and `menu` lists `Run this script` first under it.
- Fire that to run the script. Each fire runs it again on the same
  page, so you can test what a second run does too.
- A reload or navigation leaves it unrun again.
- In a spec: `gm.runScript()`.

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
  - Such a tab is set up after its first load, so console lines from
    that load aren't shown. Starts, errors and other reports are.
- `newtab <url>` opens another controlled tab and makes it current;
  `tab T1` switches back. Page commands take a tab first:
  `click T2 '.x'`, `eval T2 location.href`, `open T2 <url>`,
  `wait T2 selector '.x'`, `menu T2.M1`.
- `closetab` closes the current tab; `closetab T2 T3` or `closetab all`
  close others. A page that asks first ("Leave site?") shows its
  dialog, answered with `accept` or `dismiss`; `--force` skips it.
- `tabs` lists them with their `targetId`s, for your own CDP clients.
  In a script: `$R --json tabs | jq -r '.tabs[] | select(.id == "T2") | .targetId'`.
- `reload all` reloads every tab; `wait all` waits for every tab to
  settle.

### Scripts in iframes

A script runs in each frame whose own URL it matches (the top page
needn't match), unless it has `@noframes`. Each frame gets its own copy
of the script; they share stored values, and can talk to each other with
`postMessage`.

```sh
$R frames                     # List the tab's iframes as a tree, with the scripts running in each
$R match --frames             # Check which iframes the script's rules match
$R snapshot --find Save       # Find elements in all frames; refs in iframes look like f2e4
$R click f2e4                 # Use a ref from any frame directly, with no --frame
$R probe --css f2e4           # Get a CSS selector for the element, and which frame it's in
$R eval --frame F2 'state'    # Run code in the script instance in F2 (--page: in F2's page)
$R click --frame F2 '.play'   # Look for a selector inside F2 (also hover, type, probe, snapshot, screenshot)
$R wait selector --frame F2 '.ready'   # Wait for an element inside F2
```

- Iframes are named `F1`, `F2`, ... for the whole run; the top frame
  is its tab (`T1`). An iframe keeps its id when it or the tab reloads,
  so you can keep using `F2` after a reload.
- Where a script runs: `frames`, or `tabs` / `status`, which list a
  script not only in the top frame as `(T1, F2)` or `(F2)`.
  - `frames` marks iframes that aren't visible `(hidden)`: often ad or
    tracking frames.
  - A frame added after load (a widget opened by a click) shows up
    once it exists. Run `frames` again after the click.
  - A frame with no URL of its own (`about:blank`, `srcdoc`) never
    runs scripts.
- To get at an element in a frame, a snapshot ref is the quickest: it
  reaches into any frame, cross-origin ones included, with no
  `--frame`. Refs change when the frame reloads, though, so for a
  selector that lasts (in a spec, or across `--watch` reloads), use
  `--frame F2 <selector>`.
- `wait` and the actions' own settling watch the top frame's page (and
  every frame's requests). After an action that makes a frame load or
  change, `wait selector --frame F2 ...` for what you need there.
- `eval --frame` reaches cross-origin frames too, and works like `eval`
  in the top frame: the selected script's scope, `--script=<script>`,
  or `--page`.
- Lines from a frame are prefixed with it: `[T1.F2] [event] ...
  started in an iframe on <frame URL>`, `[T1.F2] [script log] ...`.
- `menu` shows the script's one menu for the tab, as SourceMonkey's
  popup does, with every frame's commands in it. sm-dev labels a
  command an iframe registered with its frame: `M3: Toggle (F2)`.
  Firing it runs it in that frame. A command registered by the copies
  in several frames is listed once per frame.
- For raw CDP, `frames` shows each frame's `[frameId=...]`, which CDP
  calls on a frame take, and `--frame` accepts it too. A frame from
  another site (another domain, not just another subdomain) also has a
  `[targetId=...]` of its own to attach to. `cdp --frame F2 ...` sends
  calls to the target the frame is in.

### Multi-step sequences

Commands on one line run in order and stop at the first failure (a
`click` with no element, an `eval` that threw, a `wait` that gives up),
like `&&`. A `match` or `validate` miss doesn't stop them, nor does an
`eval` or `cdp` call cut off by a navigation it set off. To check for
an element that may not be there, use `probe`, which doesn't fail.

Keep sm-dev's stderr: that's where a mistyped command says what was
wrong. To keep output short, filter stdout (`| tail`, `| grep`) or send
only stdout to `/dev/null`, never `2>/dev/null`.

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
eval myScript.state
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

### Reading results in a script: `--json`

Most commands that report state can print JSON instead of text, with
`--json`.

- **Use it when you'll process the answer** with `jq` or code:
  - picking a few fields out of a long list (many scripts, tabs or
    matches);
  - checking a value in a script or a loop, rather than by reading;
  - comparing state before and after an action.
- **Don't use it when you're reading the answer yourself.** The text is
  shorter, and says what an empty answer means and where to look next.
- **Which commands:** `list`, `status`, `scripts`, `tabs`, `values`,
  `get`, `match`, `validate`, `menu`, `logs`, `probe`, and every
  `collection` and `script` verb (`script list`, `script show`, ...).
  The rest print text as usual.
- **Output:** one JSON object per command on stdout. Other messages
  and failures stay text, on stderr, with the usual exit code.
- **The fields**, and what each script `state` means:
  [references/commands.md](references/commands.md#shape-of-a-command-line).

```sh
$R --json values | jq '.scripts[] | {name, units: .values.units}'
$R --json probe '.result' | jq '.selectors[0].count'
```

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

### How a run uses the extension

```sh
$R start sites/x/y.user.js https://x.com/ --detach
$R stop                  # also removes the run's test collection
```

- The script is pushed into a test collection of the run's own
  (`sm-dev test collection (run D2-a3f9)` in the extension, the id
  `status` shows), removed when the run ends.
  - Each run starts with no stored values but those `--values` seeds.
  - `@require`s read from disk (relative ones, and local copies under
    the collection root or `--local` roots) are pushed with it;
    remote ones are fetched live.
- The run's tabs run only its own scripts: SourceMonkey-managed
  scripts are kept out of them. The run's scripts run only in the
  run's tabs, not in tabs you open yourself.
  - `scripts` lists those others on the tab by their SourceMonkey
    script numbers (`E12`, the same in every run);
    `values E1` reads one's stored values, and `scripts E1` picks it
    for `get`/`set` (`set key --force <json>` outside a
    `--temp-browser`, since that's the person's real data).
- A `document-start` script may run after the page's first inline
  scripts in a tab a run tab opened (a popup, a link to a new tab),
  where SourceMonkey alone would run it first: every script there waits
  for the extension's check before running. In the tabs the run opens
  itself, the run's scripts run as they would alone.
- **Before building on a new request path, send one real request
  from it.**
  - A request that works from the page can still be refused from the
    extension: different cookies, and headers a WAF (web application
    firewall) rejects.
  - A 403 the page can't reproduce often comes from the site's CDN
    edge, not its origin server.

### Permission prompts

A `GM_xmlhttpRequest` to a site the script's `@connect` lines don't
cover waits on SourceMonkey's permission prompt, as it would for a
user. Any script that uses `GM_xmlhttpRequest` can hit one, and one
with no `@connect` lines likely will. Until it's answered, that request
and whatever the script does with its response wait.

- The run prints `*PERMISSION PROMPT*: <script> requests permission to
  connect to <host> ...`. Answer it with `connect`:
  - `connect allow` to test the script as a user who allowed it (the
    usual case), or `connect allow-all` for one that reaches many sites;
  - `connect deny` to test what the script does when refused;
  - `connect once` or `connect cancel` for a one-time answer: the next
    request asks again.
- `allow`, `deny` and `allow-all` are kept for the run's copy of the
  script, so later requests to that site don't ask again in the run.
- `connect` answers the selected script's prompt; with several scripts
  loaded, `script N` first.
- When testing a script's real behavior, note which sites it asked
  about: its `@connect` lines may be missing some.

### Downloads

- Find a downloaded file at the path its `Download saved: <path>` line
  names (for an http(s) `GM_download`, the `GM_download` line's
  `-> <path>`).
- With `--temp-browser`, `status` shows the folder as `Downloads:` once
  something was downloaded.

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

## Testing under other managers

A run can load its scripts into **Tampermonkey** (`--manager tm`) or
**Violentmonkey** (`--manager vm`) instead of SourceMonkey: to check a
script is portable, or to debug a difference between managers by
running the same script and page under each.

```sh
pnpm sm-dev --manager tm manager fetch     # once each: download Tampermonkey,
pnpm sm-dev --manager vm manager fetch     # and Violentmonkey
pnpm sm-dev --manager tm --run Dtm --temp-browser start sites/x/y.user.js https://x.com/ --detach
pnpm sm-dev --manager vm --run Dvm --temp-browser start sites/x/y.user.js https://x.com/ --detach
```

It reports much less than SourceMonkey: which scripts a tab runs is
predicted from their match rules, and `values`, `menu` and the like are
refused. How it works and what differs:
[references/other-managers.md](references/other-managers.md).

## Troubleshooting

- **`skipped on <url>: ...`**: the header doesn't cover the page; the
  extension would skip it too. `match` shows why.
- **`GM_x is not defined`**: missing `@grant GM_x`. Same in the
  extension.
- **A page global is `undefined` in the script**: it's in the isolated
  world (`@inject-into content` or `@sandbox DOM`). Remove that line.
- **An early `document-start` change gets overwritten by the page
  under sm-dev only**: in a tab a run tab opened, the script may run
  after the page's first inline scripts (see
  [How a run uses the extension](#how-a-run-uses-the-extension)).
- **The run refuses to start, or says `no SourceMonkey` / `SourceMonkey
  disabled`**: see [Getting a browser](#getting-a-browser).
- **A command these docs name is unknown**: sm-dev is older than the
  docs. Ask the person whether to update it: `pnpm run build` in the
  SourceMonkey checkout, then `pnpm install` in a userscript repo. A
  run keeps the code it started with, so start it again after.
- **`start` says sm-dev or SourceMonkey is older than the other**:
  ask the person whether to update it as the message says. Building
  changes the code under other running sessions. If the run still
  started, keep working meanwhile.
- **The script seems stale**: check the reload lines after the save, or
  `update` (it skips files whose modification time hasn't changed; a
  `touch` forces it).
- **After changing SourceMonkey itself**: `pnpm run build` there, then
  `pnpm install` in the userscript repo. The dependency is a copy of
  the build, taken at install time.
- **`start` hangs connecting**: a tab in that browser is showing a
  dialog. The run names it; answer it or close the tab.
- **Commands refuse with a dialog open**: `accept` or `dismiss` first.
- **A `GM_xmlhttpRequest` never finishes, or the script stops after
  one**: look for a `*PERMISSION PROMPT*` line; the request is waiting
  for `connect` (see [Permission prompts](#permission-prompts)).
- **A wait gave up**: its message says what was still busy (requests,
  DOM changes). A page with a slow API or a never-ending resource never
  settles; `wait selector` for the element you need instead.
