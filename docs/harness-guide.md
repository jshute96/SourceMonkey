# Testing userscripts with the SourceMonkey harness

The harness is for a repo of userscripts that wants to probe sites,
run a script under development, and write regression tests, with the
script running in the real SourceMonkey extension.

It has two parts:

- **`sm-dev`**, a command-line tool for interactive work: open a site
  with your script running, watch what it does, poke at the page, edit,
  repeat.
- **A Playwright fixture** for writing specs once the script works.

For how it works inside, see [harness-design.md](harness-design.md)
and [sm-dev-design.md](sm-dev-design.md).

For coding agents, the
[SourceMonkey-dev skill](../skills/SourceMonkey-dev/SKILL.md) is a
shorter, task-focused version of this guide, and the
[SourceMonkey-friction skill](../skills/SourceMonkey-friction/SKILL.md)
has them log where the tools got in the way.

## Contents

- [What you get](#what-you-get)
- [Setup](#setup)
- [Quick start](#quick-start)
- [How sm-dev works](#how-sm-dev-works)
- [A browser to work in](#a-browser-to-work-in)
- [How scripts run](#how-scripts-run)
- [Starting a run](#starting-a-run)
- [Sending commands](#sending-commands)
- [Working with scripts](#working-with-scripts)
- [Working with tabs](#working-with-tabs)
- [Driving and reading the page](#driving-and-reading-the-page)
- [Saved pages](#saved-pages)
- [Logs](#logs)
- [Waiting](#waiting)
- [Background runs and logs](#background-runs-and-logs)
- [Writing specs: the Playwright fixture](#writing-specs-the-playwright-fixture)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)

## What you get

- **The real manager.** Your script runs in the SourceMonkey extension,
  in the browser sm-dev drives:
  - the header is validated;
  - `@match` / `@include` / `@exclude` decide whether it runs;
  - `@run-at` is honored;
  - `@require` files load, with local copies overriding GitHub URLs the
    way the extension does;
  - `@grant` decides which `GM_*` names exist;
  - the script lands in the world (page or isolated) Chrome gives it.
- **Real `GM_*` behavior.** Storage with cross-tab broadcast,
  `GM_xmlhttpRequest` with the extension's own request identity, menu
  commands you can fire, tab opens, downloads and notifications you can
  inspect.
- **Nothing left behind.** The run's scripts live in a test collection
  of its own, removed when it ends, and only they run in the run's tabs
  (see [How scripts run](#how-scripts-run)).
- **The script's own reports.** Whether it started, was skipped for a
  URL miss, or threw, attributed the same way the extension's Log tab
  does.

## Setup

### Requirements

- Node 22+ and pnpm.
- A Chromium that Playwright can reach, with a remote-debugging port.
  See [A browser to work in](#a-browser-to-work-in).
- SourceMonkey loaded in that browser, with "Allow User Scripts" on. A
  `--temp-browser` has it; for another browser, see
  [Setting it up](#setting-it-up).

### Install

```sh
pnpm add -D github:jshute96/SourceMonkey#v0.x
```

SourceMonkey builds itself on install, and pnpm runs a dependency's
build only for packages the project allows. So allow it in
`pnpm-workspace.yaml`:

```yaml
# The key is the dependency spec as the lockfile records it; pnpm
# prints the one it wants if this is wrong.
allowBuilds:
  "sourcemonkey@git+https://github.com/jshute96/SourceMonkey.git#<sha>": true
```

When you install from a checkout on disk (`file:../SourceMonkey`, while
working on both), also add this to `package.json`:

```json
{ "dependenciesMeta": { "sourcemonkey": { "injected": true } } }
```

- A plain symlink would leave the package resolving its own Playwright
  instead of yours, and Playwright refuses to run with two copies
  loaded.
- `injected` copies it into your project's store instead, where the
  peer dependency resolves to your copy.
- Re-run `pnpm install` after rebuilding SourceMonkey, since the copy
  is taken at install time.
  - It copies SourceMonkey's `lib/` as it is, without building it, so
    build there first (`pnpm run build`).

### Running `sm-dev`

- Installing the package puts `sm-dev` on your project's path (pnpm
  links it into `node_modules/.bin`). Run it as `pnpm sm-dev …` or
  `pnpm exec sm-dev …`.
- In a SourceMonkey checkout it is `scripts/sm-dev`. It runs what
  `lib/` has and never builds it; `pnpm run build` does.
- The examples below write it as plain `sm-dev`.

### Writing specs as ES modules

- The package is written as ES modules (ESM: files that use `import` /
  `export`, rather than CommonJS's `require()` / `module.exports`).
- A CommonJS spec can't `require()` it reliably, so write specs and
  fixtures as ESM: name them `.mjs`, or set `"type": "module"` in
  `package.json` so plain `.js` files count. Playwright runs either.
- Type declarations ship with the package, so a TypeScript spec gets
  types without extra setup. Keep `skipLibCheck` on, since some
  declarations mention Chrome's extension types.

## Quick start

### 1. Open a browser

```sh
sm-dev --open-browser
```

- A Chrome window opens, listening for sm-dev on port 9233.
- It stays open across runs, and keeps its profile, so sign in to the
  sites your scripts need once, there.
- The first time, load SourceMonkey into it (see
  [Setting it up](#setting-it-up)). The profile keeps it.
- For a quick try with no login, use `--temp-browser` on the next step
  instead, which comes with SourceMonkey.

### 2. Start a run

```sh
sm-dev --interactive start sites/example.com/add-button.user.js --watch
```

- Pushes the script into SourceMonkey, and opens its page (the first
  URL its `@match` implies) in tab `T1`, where it runs.
- Streams the script's console lines, errors, and whether it started.
- `--watch` pushes the script again and reloads the page on each save.
- `--interactive` then shows a `> ` prompt for more commands.

### 3. Work at the prompt

```
> status              # the run, its tabs, and each script's state
> snapshot --visible  # what's on screen, with element refs (e12)
> click e12           # click one, and wait for the page to settle
> menu                # the script's menu commands
> menu M1             # fire one
> values              # what the script stored
> exit                # end the run (or Ctrl-D)
```

### From an agent or a script

The same session without a prompt: `--detach` leaves the run in the
background, and each later `sm-dev` command talks to it.

```sh
sm-dev start sites/example.com/add-button.user.js --watch --detach
sm-dev snapshot --visible
sm-dev click e12
sm-dev menu Bump -- values    # fire a menu command, then show stored values
sm-dev stop
```

What a run prints as it goes:

```
[sm-dev] Pushed to SourceMonkey: sites/example.com/add-button.user.js
[sm-dev] Opening https://example.com/items/42 in T1 [targetId=61023580282B1D684FAF4072C201AB51]
[event] Add button started on https://example.com/items/42
[script log] [add-button] toolbar found, button inserted
[event] GM_setValue lastItem = "42"
```

- A page the header does not cover prints the rule that kept the
  script off it (`skipped on <url>: No @match or @include covers this
  URL`), and nothing runs.
- A header problem prints the same wording the extension's viewer
  would, and nothing is pushed.
- A long stored value is cut after 100 characters in its `GM_setValue`
  line; `get` and `values` show it whole.
- A DOM node logged to the console, at any level, prints as its opening
  tag (`<main id="target">`), cut at 120 characters.
- Stack refs to a script's own `sourcemonkey://SourceMonkey/...` URLs
  print decoded once, as the viewer's Log tab shows them, so a file
  named `a%20b.user.js` reads as that, not `a%2520b.user.js`.

Once the script works, capture it in a spec (see
[Writing specs](#writing-specs-the-playwright-fixture)):

```js
import { test, expect } from 'sourcemonkey/harness';

test('adds the button', async ({ page, loadUserscript, reports }) => {
  await loadUserscript('sites/example.com/add-button.user.js');
  await page.goto('https://example.com/items/42');
  await reports.waitForStart();
  await expect(page.locator('#add-button')).toBeVisible();
  expect(reports.errors()).toEqual([]);
});
```

## How sm-dev works

### Command-line syntax

```sh
sm-dev [global-options] <command> [args and options] [-- <command> ...]
```

- Global options (`--run`, `--browser`, `--interactive`, ...) go
  first, and hold for the whole line (see [Global options](#global-options)).
- `--` separates commands, which run in order (see
  [Sending commands](#sending-commands)).

### Runs and clients

- `sm-dev start` begins a **run**: a background process of its own
  that connects to the browser, pushes the scripts into SourceMonkey
  there, opens tabs, and logs what the scripts do.
- Each `sm-dev` command is a **client** of a run. It connects to the
  run, sends it commands, and prints what comes back.
- Any number of sm-devs, in any shells, can work with the same run.
- Everything sm-dev prints is plain text, meant to be read by a person
  or an agent.

### Names

Each kind of thing has its own style of name, so they can't be mixed
up:

| Thing | Names | Listed by |
| --- | --- | --- |
| Runs | `D1`, `D2` (or one you pick with `--run Dname`) | `sm-dev list` |
| Scripts | `1`, `2` | `scripts` |
| SourceMonkey-managed scripts | `E1`, `E2` | `scripts` (those on the tab), `script list` (all) |
| SourceMonkey's collections | `C1`, `C2` (a run's test collection: its run, `D1`) | `collection list` |
| Tabs | `T1`, `T2` | `tabs` |
| Menu commands | `M1`, `M2` | `menu` |

- A `T<n>.` prefix names one on another tab: `T2.3` is script 3 there,
  `T2.M1` that tab's first menu command.
- Tabs and menu commands always take their letter. `2` alone means
  script 2; given where a tab or menu command belongs, it gets a hint
  (`Did you mean T2?`).
- A script can also be named by its path, file name, or `@name`, or a
  piece of its name or path that no other loaded script shares.
- A run's number is reused once its run has ended.

### Two kinds of command

- **sm-dev's own**, which run in sm-dev itself: `start`, `attach`,
  `stop`, `exit`, `list`, `help`, and `match` / `validate`
  given files.
- **Run commands**, which go to a run: everything else (`status`,
  `eval`, `click`, `menu`, ...). `sm-dev eval document.title` sends
  `eval document.title` to the run sm-dev works with.

### Help

- The help is in sections, each a named topic: command input,
  examples, then the commands grouped by what they work on, then the
  flags (global and common), and how to name scripts, tabs and the
  rest.
- `sm-dev help` (or `sm-dev --help`) lists the topics, with a line on
  each.
- `sm-dev help <topic>` shows one, e.g. `sm-dev help tabs`.
  - A topic that is just one command (`frames`, `logs`) shows that
    command's help.
- `sm-dev help commands` lists each command with a line on what it
  does, under its topics.
- `sm-dev help all` (or `help full`) shows everything.
- `sm-dev help start` (or `sm-dev start --help`) shows one command: its
  usage, arguments, and only the options it takes.
  - `--help` on a command always gives the command, even where a
    topic shares its name (`scripts --help`).
- It takes several names at once: `sm-dev help status tabs`.
- At a terminal with color, commands and flags show in cyan, and
  headings in bold. `NO_COLOR` turns that off, and `FORCE_COLOR` on.
- `--help` (or `-h`) anywhere on a line shows the help for each command
  on it, once each, and runs none of them.
- In a run, `help [command]` or `?` does the same.

### Color

At a terminal with color, sm-dev's output is colored too:

- The prompt is green, and the commands you type cyan, as are commands
  echoed before their output (`stdin > status`).
- Errors are bold red, warnings bold magenta.
- Headings (`Tabs:`, `Scripts`) and the `*` marking what is selected
  are bold; IDs (`T1`, `E3`, `e4`) are green; URLs and file paths are
  underlined; script and menu names are italic.
- Commands and code in messages are cyan (`` Use `tabs` to list them ``).
  Without color, they keep their backticks where that helps them read.
- Log lines' time and source prefix are dimmed.
- `NO_COLOR` turns color off, and `FORCE_COLOR` on. `--json` results
  are never colored.

## A browser to work in

`sm-dev` connects to a browser over CDP (Chrome DevTools Protocol, the
remote-control interface DevTools and Playwright use). There are three
ways to get one. Each needs SourceMonkey in it (see
[A browser with SourceMonkey installed](#a-browser-with-sourcemonkey-installed)).

### A lasting browser: `--open-browser`

Best for sites that need a login.

```sh
sm-dev --open-browser                           # just the browser
sm-dev --open-browser start x.user.js --detach  # the browser, then a run in it
sm-dev --open-browser --browser 9300            # another one, on port 9300
```

- It has a window, and listens on `--browser`'s port (9233 by default),
  which is where later commands connect.
- It stays open after sm-dev ends. Close it as any browser: by closing
  its window.
- It has sound. `--mute` starts it muted (no effect on one already
  running).
- Google Chrome when it's installed (it handles Google sign-in), else
  Playwright's Chromium. `SM_DEV_BROWSER_BINARY` names another binary.
- Google Chrome ignores the flag that would load SourceMonkey, so load
  it there once with `sm-dev manager install` (see
  [Setting it up](#setting-it-up)).
- Its profile is kept, so sign-ins and extensions carry over:
  `~/.config/sm-dev/browser-profile-<port>`, or `--profile DIR`.
  - One per port, since only one browser at a time can use a profile.
    One already in use is refused, naming the port its browser is on.
- A browser already answering on the port is used as it is, whatever
  its profile, so `--open-browser` can go on any command line.
- It only starts one on this machine: `--browser` has to be a port alone
  (`9300`), or one on `127.0.0.1` or `localhost`.
- A browser that can't start, or whose port doesn't open within 10
  seconds, is closed again, with the reason.
- Its output goes to `sm-dev-browser.log` in the profile directory, and
  the log's last line is shown if it fails to start.

### A throwaway browser: `--temp-browser`

- Launches a hidden Chromium for each run, with an empty profile,
  closed when the run ends. `--headed` shows it.
- It's muted, headed or not. `--nomute` gives it sound.
- Useful for a quick run whose page needs no login.
- It needs no setup: it loads SourceMonkey's built extension (the
  `dist/` beside sm-dev: the checkout's own build, or the copy
  `pnpm install` took in a repo of userscripts), with "Allow User
  Scripts" on and pinned to the toolbar.
  - With `--manager tm` or `vm`, Tampermonkey or Violentmonkey instead
    (see [Other managers](#other-managers-tampermonkey-and-violentmonkey)).
- Starting it takes a few seconds, for the extension's first run in the
  new profile.
- Hidden, it still sends a windowed Chrome's user agent, not
  `HeadlessChrome`, which some servers refuse a script's `@require`s
  and requests for.
- Needs a `start` on the line (or `--interactive` or `--stdin`, where
  one can come).

### Your own browser

Any Chromium started with `--remote-debugging-port`, with SourceMonkey
loaded. Point sm-dev at it with `--browser`. Your ordinary browser with
SourceMonkey installed works too, given that port.

### A browser with SourceMonkey installed

- Every run needs SourceMonkey in its browser, with "Allow User
  Scripts" on. A `--temp-browser` has it; an `--open-browser` or your
  own browser needs it loaded once (see
  [Setting it up](#setting-it-up)).
  - Without it, with it turned off, or with "Allow User Scripts" off,
    the run refuses to start and says how to fix it.
  - `status` and the run's first line say which: `has SourceMonkey`,
    `SourceMonkey disabled` or `no SourceMonkey` (see
    [Managing runs](#managing-runs)). `status` also lists the browser's
    managers: `Managers: SourceMonkey 0.0.1 (in use), Tampermonkey
    5.5.1 (disabled)`.
  - Another manager enabled there runs its scripts in the run's tabs
    too, so the run's first lines and `status` warn of it, with how to
    turn it off.
- The run's tabs (the ones it opens, and the tabs those open) run only
  the run's scripts: SourceMonkey keeps its own scripts out of them.
  - They run there again from the tab's next load after the run ends.
  - That holds for a run started with no scripts too, so scripts it
    `load`s later run alone.
- Your other tabs are left alone, and the run's scripts don't run in
  them.
- In the run's tabs, SourceMonkey's toolbar icon has a cyan **T** in
  its corner, its badge counts the run's scripts, and both its tooltip
  and its popup say "Page under sm-dev control".
- When SourceMonkey and sm-dev come from incompatible builds, the run
  is refused, saying which one to update and how. When one is older but
  still compatible, the run starts with a note saying which, and how
  to update it.
- How it works: [sm-dev-design.md](sm-dev-design.md#tab-claims).

### Setting it up

For a browser that keeps the extension (and your logins):

1. Build SourceMonkey (`pnpm run build`), which writes the unpacked
   extension to its `dist/`. In a repo of userscripts, `pnpm install`
   already built it under `node_modules/sourcemonkey/dist/`.
2. With the browser open (`sm-dev --open-browser`), run
   `sm-dev manager install`. It loads `dist/` as an unpacked extension,
   with "Allow User Scripts" on. An `--open-browser` profile keeps it
   from then on.

By hand instead: in `chrome://extensions`, turn on Developer mode, then
"Load unpacked" and pick `dist/`. Then on SourceMonkey's details page,
turn on "Allow User Scripts".

- A Chromium started with `--load-extension=<SourceMonkey dist>` works
  as well, though Google Chrome itself ignores that flag.
- After rebuilding SourceMonkey, reload it in `chrome://extensions` so
  the browser runs the new build.

### Choosing the browser: `--browser`

- `--browser` takes a URL, a `host:port` (`http://` is added), or just a
  port on this machine (`9222` or `:9222`). An IPv6 host needs brackets
  (`[::1]:9222`).
- It defaults to the `SM_DEV_BROWSER` environment variable, which
  takes the same forms, then port 9233.
- `SM_DEV_BROWSER_BINARY` (not `SM_DEV_BROWSER`) names the binary
  `--open-browser` starts.
- These are global options, so they go first:
  `sm-dev --temp-browser start x.user.js`.
  - As a global option, `--browser` holds for the whole line (and
    `--open-browser`). After `start`, it's for that command alone.
- One browser choice per line: `--temp-browser` can't go with
  `--browser` or `--open-browser`, and after `--open-browser`, `start`
  takes no `--browser` of its own.
- A command sent to a run acts in the run's browser. A `--browser` that
  names another one is refused, rather than passed over.
  - The `collection` and `script` commands for what's installed
    (`collection list`, `script show`, ...) are the exception: they
    need no run, so with a `--browser` no run is in, they act on that
    browser.
  - The `manager` commands act on the `--browser` browser unless a run
    is picked (by `--run`, `start` or `attach`), and then on its
    browser. An active run that isn't picked is left alone.

### Other managers: Tampermonkey and Violentmonkey

`--manager` picks the userscript manager sm-dev works with: `sm`, `tm`
or `vm`, or `sourcemonkey`, `tampermonkey` or `violentmonkey`, in any
case. SourceMonkey is the default.

```sh
sm-dev --manager tm manager fetch                  # download Tampermonkey
sm-dev --manager tm --temp-browser start <url>     # a run in a browser with it
sm-dev --manager tm manager install                # into the --browser browser
sm-dev manager disable                             # turn SourceMonkey off there
```

| Command | What it does |
| --- | --- |
| `manager fetch` | Downloads Tampermonkey or Violentmonkey from the Chrome Web Store into `~/.cache/sm-dev/managers/<name>`, or updates it there to the newest version |
| `manager install` | Loads the manager into the browser unpacked, with "Allow User Scripts" on: this sm-dev's SourceMonkey, or the fetched copy, fetched first if need be. Updates one installed from there to the version fetched since |
| `manager enable` / `disable` | Turns it on or off in the browser. Not SourceMonkey while a run uses it |

- A fetched copy keeps its Web Store id, so its storage and settings
  carry over when it's updated.
- `--temp-browser` loads the chosen manager, fetching it the first
  time. Its Tampermonkey has its "installed" page turned off, which it
  would otherwise open in a new tab at each start.
- **A run works with one manager**, the one it started with. A later
  line's `--manager` has to match it, or it's refused.
  - Except for the `manager` commands, which act on the browser rather
    than the run: `--manager tm manager disable` beside a SourceMonkey
    run turns Tampermonkey off in its browser.
- **Under Tampermonkey or Violentmonkey**, a run drives its pages:
  `snapshot`, `click`, `newtab`, `eval --page`, `logs` and the rest.
  - The manager runs its own installed scripts in the run's tabs.
  - Tabs a page opens aren't followed.
  - The commands that work through SourceMonkey alone (`values`,
    `get`, `set`, `menu`, `connect`, `--values`) are refused: `The
    values command works with SourceMonkey only, and this run uses
    Violentmonkey`.
- **Under either**, a run loads its scripts too, as normal scripts in
  the manager, and removes them when it ends.
  - `scripts` shows each with its E-id there: `1: Hello
    (hello.user.js), E6 in Violentmonkey`.
  - Whether a script is on a tab is predicted from its match rules,
    since the manager doesn't say what ran. `scripts` and `status`
    list them under `Expected on tab T1 using match rules:` and `Not
    expected on tab T1:`.
  - A script the manager already has by the same name and namespace
    is never replaced: `start` refuses, naming it.
  - The `collection` and `script` commands work on its scripts, in one
    collection, `C0`.
  - Details: [sm-dev-violentmonkey.md](sm-dev-violentmonkey.md), and
    for Tampermonkey's differences,
    [sm-dev-tampermonkey.md](sm-dev-tampermonkey.md).
- A browser can hold several managers. Each one enabled beside the
  chosen one runs its scripts too, so sm-dev warns when it connects,
  and in `status`: `Warning: Tampermonkey is also enabled in this
  browser, so its scripts run too. To turn it off, use sm-dev --manager
  tm manager disable.`

## How scripts run

### A test collection per run

- `sm-dev start` pushes the script text into SourceMonkey, stored only
  there, in a **test collection** of the run's own.
  - It shows on the collections page as `sm-dev test collection (run
    D2-a3f9)`, the same id `status` shows on its `Backend:` line.
  - The script is registered before the page opens.
  - The next push of the same file in the run (`update`, `--watch`)
    replaces it in place, keeping its stored values. Each run starts
    with no stored values, or those `--values` seeds.
  - The `@require` and `@resource` files the script reads from disk are
    pushed with it: relative paths, and local copies of remote URLs
    under the collection root or a `--local` directory. Remote ones the
    extension fetches.
    - They're snapshots: a refresh in SourceMonkey doesn't reread them,
      and the script's page marks a `@require` tab `snapshot`. `update`
      (or a `--watch` save) pushes new versions.
  - Nothing on disk is scanned.
- The test collection is removed when the run ends, with its stored
  values. A run that crashed has its collection removed about 6 minutes
  later.
- Only the run changes it: the extension won't move scripts into or
  out of it, or install scripts into it.

### Which tabs they run in

- The run's tabs run only the scripts it pushed, across reloads and in
  the tabs they open, until the run ends.
- The scripts it pushed run only in the run's tabs: not in tabs you
  open yourself, another run's tabs, or anywhere once the run ends.
- The run's tabs show a cyan **T** at the top left of SourceMonkey's
  toolbar icon, so you can tell them apart from your own tabs.
- See [sm-dev-design.md](sm-dev-design.md#tab-claims) for how.

### What the run reports

- The script's starts, errors, menu commands and value writes.
- Its `GM_xmlhttpRequest`s, downloads, notifications and opened tabs.
- The entries it adds to its Log tab, and the page's console lines.
- Values and menu clicks sent from sm-dev go through the extension.

### SourceMonkey-managed scripts

- `scripts` and `status` also list the SourceMonkey-managed scripts
  that match the current tab, with their status. Each is named by its
  script number in SourceMonkey (`E12`), the same in every run, and
  the `#E12` its Log ID shows in the script viewer.
- `values E1` shows one's stored values, and `scripts E1` picks it for
  `get` and `set`. Any installed script can be picked (`script list`
  lists them), not only one on the current tab.
- Outside a `--temp-browser`, `set` on one needs `--force`, since it
  changes your real data: `set key --force <json>`.

## Starting a run

```sh
sm-dev start [script.user.js]... [url]... [options]
```

- Pushes the scripts as they are on disk, opens a tab at each URL, and
  streams the scripts' console lines, errors, and start / skipped /
  error reports.
- With no URL, it opens the first script's **default page**: the first
  URL its `@match` implies.
- Several scripts go into the same page, for interaction tests.
- Without `--detach`, the run stops when sm-dev ends.

`start` with nothing after it to keep the run going opens the `> `
prompt at a terminal (stdin and stdout both), as `--interactive`
would. Elsewhere it is refused:
`The start command with nothing after it would stop the run as soon as
it started. Add --interactive for a prompt, --detach to leave it
running, --stop-after-seconds N to watch it for a while, or commands after --.`

### Options at a glance

| Option | Effect |
| --- | --- |
| `--watch` | Push again and reload on each save of a script or local `@require` |
| `--detach` | Return once the pages settle, and leave the run going |
| `--new` | With `--detach`, keep earlier detached runs going |
| `--all` | Open each script's default page, one tab per page |
| `--notab` | Open no tab at startup |
| `--from-saved` | Open `.html` files as saved pages, at their URLs |
| `--values '<json>'` | Seed `GM_*` storage first |
| `--values-file <path>` | Seed `GM_*` storage first, from a JSON file |
| `--log-source <source>` | The log sources the stream shows (see [Logs](#logs)) |
| `--lang zh-CN,en` | The languages the run's tabs prefer |
| `--nowait` | Don't wait for the pages to settle |
| `--timeout-seconds S` | The longest the pages may take to load, and then to settle |
| `--stop-after-seconds N` | Stop the run after N seconds |
| `--stop-after-idle-seconds N` | Stop after N idle seconds (default 30 minutes; `0` never) |

Details on each are in [`start` options in detail](#start-options-in-detail).

### Scripts, URLs and files

- Arguments ending in `.user.js` are scripts, and the rest are URLs.
  They and the flags can come in any order. Each is taken once, however
  often it's given.
- Where scripts are expected (`start`, `match`, `validate`, `load`), a
  directory stands for all `*.user.js` files under it, skipping
  `node_modules` and hidden directories.
- `validate` and `match` also take a script by its `http(s)` URL, and
  fetch it. `start` needs a file.

Globs:

- A glob is expanded by sm-dev itself, so it also works quoted, on
  stdin, and at the prompt.
- `*` matches within a name, and `**` any number of directories:
  `src/*.user.js`, `**/*.user.js`.
- `**` must be a whole path part, and not the last one: `a**`,
  `**.user.js` and `src/**` are errors.
- A glob's matches are then sorted into scripts and URLs as above, so
  `pages/**/*.html` gives `start` and `match` pages. In `start`, each
  non-script match opens a tab.
- `open` and `newtab` expand globs too: `newtab` opens a tab per match,
  and `open` takes a glob that matches one file.
- A word with a `*` and no scheme is always a glob, even one that looks
  like a host (`example.com/*`). A URL with a `*` needs its `http://`.
- Symbolic links to directories are only followed where named, not
  while searching.
- A glob that matches nothing, or a directory with no scripts, is an
  error.

URLs without a scheme:

- A word gets `http://` only when it starts with a host: one with a `.`
  (`example.com/x`), `localhost`, a port (`localhost:3000/x`), or an
  IPv6 address (`[::1]/x`).
- Any other word is a local path, made a `file://` URL: one starting
  with `/` or `.`, one naming a file that exists, or one whose first
  part has no `.` (`pages/x.html`), existing or not.
- With `--from-saved`, a word ending `.html` or `.htm` is a file even
  where it would read as a host, so a mistyped name is reported as
  missing rather than opened live. Give such a URL its `http://`.

### `start` options in detail

What to open:

- `--all`, with several scripts, opens each one's default page, one tab
  per distinct page, instead of only the first script's.
  - The extra tabs are T2, T3, and stay open when the run ends.
  - Scripts it opened no tab for are listed at the end, with the
    reason.
  - Can't be combined with a URL.
- `--notab` opens no tab at startup. `newtab` opens one later, and the
  first it opens is T1.
  - That tab isn't one a later run closes (see
    [Which tab `start` uses](#which-tab-start-uses)).
  - The scripts run only in the tabs the run opens (`newtab`), not in
    pages you browse to yourself.
  - Can't be combined with a URL or `--all`.
- With no scripts given, it starts as a browser to drive with the run
  commands, on a blank page or the URLs given. `load` adds scripts
  later. It can't be combined with `--all`, `--values`,
  `--values-file` or `--watch`.
  - With `--temp-browser --headed`, that's a throwaway browser with
    SourceMonkey, to try by hand. The scripts it `load`s run only in
    the run's tabs (`newtab`, and the tabs those open), not in tabs you
    open yourself.
- `--from-saved` opens each `.html` file given as a saved page, at the
  URL it was saved from, with `--url` and `--offline` as for `newtab`.
  See [Saved pages](#saved-pages). Not with `--all` or `--notab`.

The scripts:

- `--watch` pushes again on each save of a script or a `@require`d file,
  and reloads the tabs it runs in or now matches, all at once. (The run
  command `update` does the same on demand.)
- `--values '{"key": 1}'` seeds `GM_*` storage before the script runs.
  `--values-file values.json` does the same from a file holding a JSON
  object.
- `--log-source all` also shows the page's own lines and errors (see
  [What the stream shows](#what-the-stream-shows)).

The browser's language:

- `--lang zh-CN` (or a list, `--lang zh-CN,en`) sets the languages the
  run's tabs prefer, for scripts that act on a site's language:
  - `navigator.language` and `navigator.languages`;
  - the `Accept-Language` header the tabs send;
  - `Intl`'s default locale (dates, numbers), from the first language.
- Each tab the run opens or follows gets it from its next load, over a
  CDP (Chrome DevTools Protocol) session held for the run. Other tabs
  in a shared browser keep theirs.
- In a browser the run connects to (`--browser`, `--open-browser`),
  cross-site iframes and workers keep the browser's own languages, so a
  script running in such an iframe sees those.
- A headless `--temp-browser` is also launched with Chrome's `--lang`
  and `--accept-lang`, which reach those iframes and workers too, and a
  popup's first page. Use it when a script runs in frames.
- `GM_xmlhttpRequest` and `GM_download` requests go from the
  extension's service worker (its background script), which the tab's
  setting doesn't reach. They carry the browser's own languages, unless
  the script sets `Accept-Language` itself.
  - A headless `--temp-browser`'s launch flags reach them, so there
    they carry the `--lang` languages.

The run's lifetime:

- `--detach` returns once the pages have settled, and leaves the run
  going. `--new` and `--stop-after-idle-seconds` go with it. See
  [Detached runs](#detached-runs).
- `--stop-after-seconds N` stops the run after N seconds, as a safety limit.
  - On its own (`sm-dev start x.user.js --stop-after-seconds 30`), sm-dev shows
    what the run prints until then.
  - To wait for a page or a script, use `wait` (see
    [Waiting](#waiting)) rather than a guess at a time.
  - For a longer session, leave it off and end the run with `sm-dev
    stop`, so it can't expire mid-test.
- `--nowait`: don't wait for the pages to settle before continuing. It
  still waits for the scripts to start.
- `--timeout-seconds S`: the longest each page may take to load
  (default 30 seconds), and then to settle (default 5).

### Which tab `start` uses

In a connected browser, `start` always opens a new tab, so the run
starts on a clean page.

- When the tab showing in its window is one an earlier run opened, and
  that run has ended, `start` closes it. Re-running with the old tab
  still selected then doesn't pile up tabs.
- A tab whose run is still going is never closed.
- With several windows open, each window's showing tab counts. The
  first such tab found is closed, if the new tab opened in its window.
- The tabs runs opened are recorded in `run-tabs.json` in
  `sm-dev-runs-<user name>` in the system temp directory, with the
  process that owns each.
- Each run only touches the entries for its own browser, so parallel
  sessions on other ports keep theirs.

### Replacing a run

- `start` while sm-dev works with a run replaces that run under the
  same ID: the old one stops, and the new one starts.
- To add a script to the run instead, use `load`; to open a page,
  `newtab`.

### What the stream shows

Each line the page and scripts produce has a log source, shown in its
prefix (see [Logs](#logs)). The stream shows all but the page's own
lines, since a busy site logs enough (blocked trackers, failed ad
requests) to bury the script's.

- Shown by default:
  - `[sm level]`: SourceMonkey's Log entries for the scripts;
  - `[event]`: what the scripts did (started, threw, `GM_*` calls);
  - `[script log]`: console lines from the scripts, by any frame of
    the call's stack, so a script logging through a page helper counts;
  - errors whose stack runs through the scripts, and a thrown value
    that isn't an `Error` (it has no stack, so it is always shown).
- A line from a tab after T1 starts with its tab: `[T2] [script log] ...`.
- A script's own throw prints once, as `<name> threw:`.
- Stack lines name the file and line the code was written on, as the
  extension's Log tab does. A script's `@require`s run concatenated
  ahead of it, so the raw frames count from the top of the requires;
  sm-dev maps them back, and a frame in a require names the require.
- `start --log-source all` shows the page's own lines too
  (`[page log]`, `[page error]`). Reach for it when the script may be
  breaking the page, or when it runs code outside its own file:
  - a `<script>` element it adds to the page;
  - code it `eval`s, whose console lines lose the script's location;
  - a throw deep inside page code (a framework's event dispatch) that
    the script's frame has scrolled off the stack.
- `attach --log-source ...` picks the sources for that sm-dev alone.
- `logs` reads them back, the page's too with `--log-source all`.
- A page whose `Content-Security-Policy` header sandboxes it without
  `allow-scripts` blocks scripts in the page's own context (`@grant
  none`, `@inject-into page`). On each load of such a page, the run
  names the loaded scripts that this blocks and suggests
  `@inject-into content`.

## Sending commands

A script's interesting moments are not all at startup: a menu command
may need firing twice, or only once some state exists, and what the
script stored is worth reading between steps. So a run takes commands
while it goes, from several places.

### On the command line

Any run command can be given to sm-dev directly:

```sh
sm-dev eval document.title
sm-dev --run D1 values         # when several runs are active
```

`--` separates several commands, which run in order:

```sh
sm-dev start sites/x/y.user.js -- menu Bump -- values
sm-dev start sites/x/y.user.js https://example.com/ --detach -- eval 'measure()' -- key x -- eval 'measure()'
```

- Each one's output is headed by the command (`arg > menu Bump`).
- They stop at the first that fails, as a shell's `&&` would: an
  invalid command, a `click` or `hover` whose element
  never became ready, an `eval` that threw, a `wait` that gave up. A
  `match` or `validate` that finds a miss doesn't stop them, and sets
  the exit code only when it comes last.
- `start` and `attach` switch the rest of the line to their run.
  - In `start a.user.js -- start b.user.js`, b's run replaces a's,
    under the same ID.
- Without `--detach`, a run a `start` began for the commands after it
  is stopped once they are done, and the line ends with its log file's
  name.

### At the prompt

`--interactive`, first on the line, shows a `> ` prompt once the line's
commands are done:

```sh
sm-dev --interactive start sites/x/y.user.js --watch
sm-dev --interactive      # no run yet: type start or attach
```

- sm-dev reads the terminal only then. It needs a terminal, and can't
  be combined with `--stdin`.
- With no commands on the line, at a terminal (stdin and stdout both),
  the prompt is the default: plain `sm-dev` is the same as
  `sm-dev --interactive`.
- Line editing and history work as in most shells (arrows, Ctrl-A /
  Ctrl-E, Ctrl-U), and Tab completes a command name.
- A `{{` block is typed and edited as one, over several lines:
  - Enter starts a new line until the `}}` line closes the block, then
    runs it, wherever the cursor is. Alt-Enter always starts a new
    line, such as inside a block brought back from the history.
  - Up and Down move between its lines, and go through the history
    from the first and last line.
  - Once Up or Down has brought back an entry, they step whole entries,
    a block in one step, until you press another key. Ctrl-P / Ctrl-N
    always step whole entries.
  - Home / End, Ctrl-A / Ctrl-E, Ctrl-U and Ctrl-K act on the cursor's
    line. Ctrl-K at a line's end joins the next line on, and Ctrl-Y
    brings back what Ctrl-U or Ctrl-K deleted.
  - A block taller than the terminal shows the rows around the cursor,
    scrolling as it moves. Once run, it is shown whole.
- At a terminal, history is kept across sessions in
  `~/.sm-dev-history`, readable only by you.
  - `SM_DEV_HISTORY` names another file, or set it empty for none.
  - A `{{` block is one entry, brought back whole to edit or run again.
  - Sessions open at once each add their own commands, without
    overwriting the others'. A session sees the others' only once it
    is restarted, as in a shell.
- Output streamed while you type is printed above the prompt, which is
  then redrawn with what you had typed so far.
- `--` splits a typed line into several commands, as on the command
  line, except inside a `{{` block.
- A command that fails is reported, and the prompt goes on.

Keys:

- Ctrl-C or Esc clears a half-typed command. One of several lines
  cleared this way stays in the history, to bring back. A one-line
  command doesn't.
- On an empty line, Ctrl-C or Ctrl-D exits, as `exit` does: a run this
  sm-dev started without `--detach` stops, and one it only attached to
  goes on.
- A running command can't be cancelled. Ctrl-C while one runs says so,
  and a second Ctrl-C exits.
- Ctrl-Z suspends sm-dev and `fg` resumes it, as in a shell. The run is
  a process of its own, so it keeps going meanwhile.

### From stdin

With no command on the line, commands piped in are read from stdin.
`--stdin`, first on a line, reads them too, after the line's own:

```sh
sm-dev --run D1 < steps.txt
printf 'tabs T2\nmenu Bump\nvalues\n' | sm-dev
sm-dev --stdin start sites/x/y.user.js --detach < steps.txt
sm-dev --stdin       # at a terminal: each runs on Enter; Ctrl-D ends
```

A heredoc makes a readable multi-step script:

```sh
sm-dev --stdin start my-script.user.js <<'EOF'
click '.open-modal'
wait selector '#modal-dialog'
type '#input-name' 'Test User'
click '#modal-submit'
wait log /Saved record \d+/
EOF
```

- Each line is one command; `--` splits it into several.
- They run in order, each finishing before the next starts. Their
  output is headed by the command (`stdin > menu Bump`).
- Blank lines are skipped, `#` starts a comment, and `{{` blocks work
  as at the prompt.
- A file, or what a pipe delivers at once, is checked in full first. A
  mistake anywhere in it (an unknown command, a `{{` after another
  command, a block never closed) runs none of it.
- Lines that come later, from a terminal or a slow writer, run as each
  is read, and a block on its `}}`.
- A mistake or a command that fails (a `wait` that gives up) stops the
  rest; a `match` or `validate` miss doesn't. To decide for yourself
  after each, use the prompt.
- A `start` read from stdin starts a run the rest go to (or replaces
  the one sm-dev works with). If it fails, the rest aren't run.
- One argument of several lines is a list the same way, checked in
  full: `sm-dev $'tabs T2\nmenu Bump'` (bash's `$'...'` quoting turns
  `\n` into a newline). Several arguments are one command, so `eval`'s
  JavaScript can be one multi-line argument.

When stdin is read:

- Without `--stdin`, a line with commands never reads stdin, so a
  caller's open pipe doesn't hold it up.
  - That includes piping into `sm-dev start`: add `--stdin` first to
    send it the pipe's commands.
- A bare `sm-dev` given a pipe nothing writes to waits on it.
- With no command on the line or in stdin, sm-dev says so, and exits 2.

### Multi-line blocks

Some commands take several lines as a block, at the prompt or on stdin:

- `eval`: JavaScript.
- `set <key>`: JSON.
- `type <selector>`: text, typed exactly as written, spaces and blank
  lines included, each line break pressed as Enter. The line break
  before `}}` isn't typed; end with a blank line for a final Enter.
- `cdp`: calls, one per line, sharing a session (see [`cdp`](#cdp)).

```
> eval T2 {{
... const rows = [...document.querySelectorAll('.athing')];
... rows.map((r) => r.id)
... }}
```

```
> set prefs {{
... { "units": "metric", "limit": 20 }
... }}
```

- `{{` at the end of the line opens the block, and a line of just `}}`
  closes it. A lone `}` is JavaScript or JSON, so it doesn't end the
  block.
- A tab and flags go before the `{{`. Words after a `}}` (`}} --nowait`)
  are an error, and the block is dropped. (`}});` or `}},` is still the
  block's own.)
- Only `cdp`, `eval`, `set` and `type` take a block; `{{` after another
  command is refused.
- The prompt shows `... ` while a block is open.
- `--` inside a block is the block's own, not a command separator.
- Input that ends inside a block reports it rather than running half of
  it.

### Quoting and flags

- Quote a selector or text with spaces: `probe '.athing .title a'`,
  `type input 'hello world'`. `click`, `hover`, `snapshot` and `wait
  selector` take the rest of the line as the selector, so need no
  quotes: `click .athing .title a`.
- On sm-dev's command line, quote `#` too, since the shell reads it as
  a comment: `sm-dev click '#submit'`. The shell's quoting is final
  there.
- Typed or piped in, a quote that starts a word groups it and is taken
  off, as in a shell. One inside a word stays, so a selector keeps its
  own: `probe a[href="x.html"]`.
- Text quoted as a whole is unquoted, for a menu label, `type`'s text,
  `wait log`'s text: `menu 'Toggle dark'`, `menu T2.'Toggle dark'`. A
  quoted menu label is always a label, even `menu 'all'`. `set` takes off single
  quotes only, since JSON's strings are double-quoted. `eval` and
  `cdp` take off none: their quotes are JavaScript's and JSON's.
- Flags:
  - A flag that takes a value takes it after a space or `=`:
    `--out tree.txt`, `--out=tree.txt`.
  - An unknown flag, a missing or empty value, a value on a flag that
    takes none, and a flag given twice are refused. An unknown flag's
    error names the flags the command takes.
  - `--help` on any command shows its help, as `help <command>` does,
    rather than running it.
  - A quoted word is never a flag: `probe '--x'` looks for `--x`.
  - In free text (`eval`'s JavaScript, `type`'s text, a menu label), a
    `--word` is the text's own. Flags go before it.
- Arguments a command doesn't take are refused: `status now`, `focus T1
  T2 T3`, `stop D1 D2` (with its usage).
- An invalid command prints `ERROR:` and its message, not the help,
  and fails.

### Global options

- Options for the whole line go first, before any command
  (`sm-dev --run D2 status`).
- They only go on sm-dev's own command line, not a stdin or prompt
  line.
- Later on the line they are refused: `The --run flag is for the whole
  command line, so it goes first, before any command: sm-dev --run ...
  <command>`.
  - That includes one ending a command's text (`eval 1 --run D1`),
    unless the command takes the flag itself, or the text is quoted
    as a whole.
- A command's own flag goes after it. One put before it is refused
  with the line as it should be: `The --nowait flag goes after the
  command: open <url> --nowait`.

The options:

- `--run ID` names the run to work with. It's needed only when several
  are active; otherwise the command says so, and lists them.
  - With `start`, it's the ID for the new run: `D` and then letters,
    digits, `_` or `-` (`sm-dev --run Dmain start ...`). A run already
    using it is stopped first.
- `--root DIR` names the repo root, searched for local copies of
  `@require` URLs the way the extension searches a collection's
  directory. Defaults to the current directory.
  - A script outside it uses the nearest directory above it with a
    `script_manifest.json` instead, its collection's root. `--root`
    then joins the `--local` directories. So a sibling repo's script
    needs no `--root`.
- `--local DIR` adds another directory to that search; repeatable.
  - A run keeps the `--root` and `--local` it started with. A line that
    sends a command to a run it didn't start refuses them.
- `--stdin` and `--interactive`, above.
- The browser options, `--browser`, `--open-browser`, `--profile`,
  `--temp-browser` and `--headed` (see
  [A browser to work in](#a-browser-to-work-in)).
- `--manager NAME` picks the userscript manager (see
  [Other managers](#other-managers-tampermonkey-and-violentmonkey)).
- `--json` prints results as JSON (see [JSON output](#json-output)).

### JSON output

For a program reading sm-dev's answers rather than a person.

- `--json`, first on the line, makes the commands that have a JSON form
  print it: `list`, `status`, `scripts`, `tabs`, `values`, `get`,
  `match`, `validate`, `menu`, `logs`, `probe`, and each `collection`
  and `script` verb (`script list`, `script disable`, ...).
  - The listing forms only of the others: `tabs`, `scripts` and
    `menu T2`, not `tab T2`, `script 2` or a menu command fired.
  - The rest print text as usual.
- `--json` or `--nojson` after one command turns it on or off for that
  command alone (`sm-dev scripts --json`).
- Each result is one JSON object: multi-line at a terminal, on one line
  when piped. It starts with `"command"`, then that command's fields.
  - `--json=single` or `--json=multi` picks one line or multi-line,
    wherever the output goes. On one command it wins over the global
    option's; a plain `--json` there keeps the global one's.
- A failed command prints its usual text on stderr, in place of a
  result, with the usual exit code.
- Other log messages (`[sm-dev] ...` lines, `arg > ...` echoes) go to
  stderr.
  - So stdout holds only JSON when sm-dev isn't following a run's
    stream: a run started with `--detach`, or one named with `--run`.
  - A line that starts a run and sends it commands also shows the
    page's console lines on stdout.

- `status` without `--run` (or a `start` / `attach` before it) shows
  the `--browser` browser and every run, so its result holds them in
  `browser` and a `runs` array.

```sh
sm-dev --run D1 --json status | jq '.scripts[] | {name, values}'
```

The shapes of every command's result, with examples:
[sm-dev-json.md](sm-dev-json.md).

### Paths

- Files are named from sm-dev's directory, not the run's.
- Paths in output are relative to the current directory when inside
  it, and otherwise in full, never climbing with `../`.
  - `validate`, `match` and a script that fails to load name it as
    given.
  - `list` shows only file names, to fit its table.

### Exit codes

- 0 on success.
- 1 when a check fails (a script is invalid, a URL doesn't match), the
  command fails, or an explicit `wait` gave up.
- 2 for an invalid command (`ERROR:`).
- Sent to a run, these exit as above: `match`, `validate`, a `wait`
  that gives up, `menu`, `open`, and the page commands (`click`,
  `eval`, `cdp` and the rest).
  - `probe` reports a missing selector without failing. Use it to
    check for an element that may not be there.
  - An `eval` or `cdp` call cut off by the page loading a new document
    succeeds, since navigating may have been the point.
  - A few other commands exit 0 when the run answered (or 2 for an
    invalid command), even when they fail, for now. Read their output.
- For a line or input of several commands, the code is the last one
  run's, or 2 after a mistake found in the up-front check (1 after one
  found later).

## Working with scripts

| Run command | What it does |
| --- | --- |
| `scripts` | Lists the loaded scripts, numbered, and where each is active, then the SourceMonkey-managed scripts on the current tab (E1, ...) |
| `script <script>` | Picks the script `get`, `set`, `match` and `validate` act on (the first, until changed). `scripts <script>` works too |
| `load <script>...` | Loads more scripts from disk (files, directories, globs), and reloads the tabs they match. Quote a path with spaces |
| `update [script]` | Re-reads one script from disk, or all (with no argument, or `all`), as `--watch` does on a save |
| `collection list` | Lists SourceMonkey's collections (`C1`, ...), with each one's kind, script count and whether it's enabled. `collection`, `collections` and `collections list` do the same. Works with no run too, against `--browser` |
| `script list [collection]` | Lists every installed script (`E1`, ...) under its collection, or one collection's (`C3`, a name, or `id=<id>`). Runs' test collections' scripts too: this run's as `1`, `2`, another run's by name. The selected script is marked `*`. `scripts list` does the same. Works with no run too |
| `status` | The run and its log file, the tab list, and each script's state on the current tab |
| `menu` | Lists the registered menu commands, numbered `M1`, `M2`, under the script that registered each |
| `menu <M-number or label>` | Fires one, as picking it from the toolbar would |
| `values [what]` | Prints what all scripts have stored (`all` too), one script's, or those of the scripts running on a tab (`T2`) |
| `get <key>` | Prints one stored value |
| `set <key> <json>` | Stores a value, as another tab's write would: a running script sees it and its change listeners fire |
| `set <key> --file <path>` | Stores a value read from a JSON file; a running script sees it and its change listeners fire |

- `update` only counts a script whose file or local `@require`s were
  modified since it was read, so touching a file forces it.
  - It reloads, all at once, the tabs where an updated script runs or
    where its rules now match. Stored values are kept.
- Per script, `status` gives active or not, the other tabs it is
  active on, and counts of its menu commands, stored values and errors
  that are not zero.
- `menu <label>` piped in while none is registered yet waits a moment
  for a script that is still loading. Typed at the prompt, it answers
  at once.
- A read waits out the page's write batching first, so `menu Bump`
  followed by `values` prints what the command just stored rather than
  what was there before it.
- Stored values belong to the script, so all tabs see the same ones.

### Managing what's installed

These change SourceMonkey's own collections and scripts, as its pages
do. Like the listings, they work with no run too, against `--browser`.

- **The script or collection comes first**, then the verb:
  `script E4 enable`, `collection C3 refresh`.
  - In a run, a script left out is the selected one, except for
    `uninstall`.
  - Quote a name of several words: `script "Dark mode" enable`.

| Command | What it does |
| --- | --- |
| `collection <collection> show` | One collection's kind, location and status, and its scripts |
| `collection <collection> enable` / `disable` | Turns a whole collection on or off |
| `collection <collection> refresh` | Re-reads it from its location, and says which scripts it updated |
| `collection <collection> rename <name>` | Renames it |
| `script [script] show` | One script in full: header rules, status, files, values count, and in a run, what it does on each tab |
| `script [script] print` | Its installed text |
| `script [script] enable` / `disable` | Turns a script on or off; in a run, one of its own too |
| `script [script] refresh` | Re-reads it from its location; one of the run's own from disk, as `update` does |
| `script install <file\|url>` | Installs a `.user.js` file or URL for every tab, to stay. `--collection <collection>` picks the container collection. Under Violentmonkey, replacing your script with the same name and namespace needs `--force` |
| `script <script> uninstall` | Removes a script from its container collection |
| `script [script] move <collection>` | Moves a script to another container collection |

- **`--force`:** outside a `--temp-browser` the scripts are the
  person's own, so `script uninstall` needs `--force`. Enabling and
  disabling are easily undone, so they don't need it.
- **What's refused:**
  - every change to a run's test collection, and to another run's
    scripts;
  - uninstalling or moving a script a directory or manifest collection
    lists, since it comes from that collection's files;
  - uninstalling the run's own scripts: they go when the run ends.
- **One copy runs.** Installing, moving or enabling a script turns off
  its other running copies, as the viewer does, with a line for each:
  `Another version of this script was disabled: Version 1.0 (E7) in
  collection C3: Mine`.
- **Changed on disk.** A local script file modified or deleted since
  it loaded, and a local collection a refresh would change, are marked
  as on the collections page: `(modified on disk)`, `Refresh pending:
  1 file modified on disk`.
- **A disabled collection** keeps an enabled script from running, so
  that gets a line too: `E4: Dark mode is enabled, but won't run
  because it's inside disabled collection C3: Mine`.

### Checking scripts: `match` and `validate`

On their own, with files:

- `sm-dev match <script>... <url>...` shows whether each script would
  run on each URL, in a table per script. A `start` command line works
  with `match` in its place.
  - Its `Rules` column names each rule that matched or excluded the
    URL, by an id (`M1`, `I2`, `X3`) that the `Rules:` list under the
    table spells out. See [match](sm-dev-design.md#match-output).
- `sm-dev validate <path>...` checks script validity (header,
  `@require`, syntax) over files, directories, globs or script URLs,
  with the message the extension would show, plus all warnings (each
  with its line). `UNCHECKED` means the syntax check couldn't finish;
  the script still loads.
- These run in the shell, run or no run.

In a run, not given files, they act on the run's scripts and tabs:

| Command | What it checks |
| --- | --- |
| `match` | The selected script on the current tab |
| `match 3`, `match T2.3`, `match <name>` | Script 3 on the current tab, or on T2; or a loaded script by its exact name or path |
| `match T2`, `match <url>...` | The selected script on T2, or on those URLs |
| `match <file.user.js>... [url]...` | Those files, on the URLs or the current tab |
| `match all-scripts [tab or url]` | All loaded scripts on the current tab, or the one named |
| `match all-tabs [script] [url]...` | The selected script, or the one named, on all tabs, and on any URLs named |
| `match all` | All loaded scripts on all tabs |
| `validate` | The selected script, re-read from disk without loading it |
| `validate 3`, `validate all` | Script 3, or all loaded scripts |
| `validate <path>...` | Files and directories, as `sm-dev validate` does |

- The output is the command line's: a heading per script when there are
  several, and each page with the rules that matched or excluded it. A
  tab's page is named by the tab when there are several.
- `match` answers what the run has loaded, so an edit on disk counts
  once `update` has re-read it. `validate` reads the file as it is now.
- With no run active, a form that needs one says what the command-line
  form needs.
- A word that is also a file or directory in the shell's directory
  (`all`, `2024`) is taken for the path, not the run's scripts.
- `--root` and `--local` are the run's own.

## Working with tabs

| Run command | What it does |
| --- | --- |
| `tabs` | Lists the controlled tabs |
| `tab <tab>` | Picks the current tab, which the page commands act on. `tabs <tab>` works too |
| `newtab [page...\|all]` | Opens a new tab with the scripts for each page, or a blank tab |
| `closetab [tab...\|all]` | Closes the current tab, the tabs named, or all of them. Runs the pages' `beforeunload` handlers unless `--force` (see [Page dialogs](#page-dialogs)) |
| `open [tab] [page]` | Navigates the current tab, or the one named, to a URL or file (a glob matching one), or to a script's default page |
| `reload [tab\|all]` | Reloads the page, another tab's, or all tabs at once. `--noscript` / `--script` switch the tabs' scripts off or back on first |
| `focus [tab]` | Brings the tab to the front, un-minimizing its window |
| `accept [tab] [text]`, `dismiss [tab]` | Answers an open dialog (see [Page dialogs](#page-dialogs)) |
| `connect once\|cancel\|allow\|deny\|allow-all [host]` | Answers SourceMonkey's prompt for a host the script's `@connect` lines don't cover: the selected script's oldest waiting, or its one for `host` |

- A `[page]` is a URL, a file, a glob, or a script's number for its
  default page (the first page its `@match` names). Only a number
  counts as a script there, so a URL is never mistaken for one.
- `open` with no page goes to the selected script's default page; one
  by number works too (`open 2`, or `open T2.3` in T2).
- `newtab`:
  - The first new tab becomes the current tab and is brought to the
    front.
  - Unlike one you open in the browser, it is controlled from the
    start. It stays open when the run ends.
  - `newtab all` opens one tab per script's default page, as `--all`
    does at startup, and leaves the current tab as it was. Scripts it
    opened no tab for are listed at the end.
- In the browser, a tab the run controls shows SourceMonkey's toolbar
  icon with a cyan **T** in its corner, and its badge counts the run's
  scripts there (see
  [A browser with SourceMonkey installed](#a-browser-with-sourcemonkey-installed)).
- `newtab`, `open` and `reload` take `--noscript` / `--script` (see
  [Tabs without scripts](#tabs-without-scripts)); `newtab` and `open`
  take `--from-saved` (see [Saved pages](#saved-pages)).

### The current tab

- `tabs T2` makes T2 the current tab, which `status`, `menu`, `reload`,
  `open`, `focus`, `accept`, `dismiss` and the page commands act on. It
  starts as T1.
- If the current tab closes, the first one still open takes over.
- Any tab can be closed, T1 included, and the run notes it. With none
  left, `tabs` says `No active tabs`, `status` still lists the scripts
  with their stored values and errors, and `newtab` opens another.

### What `tabs` and `status` show

- `tabs` lists each tab's URL, which tab opened it, any open dialog,
  and the scripts running there, with `*` on the current tab and, under
  it, on the selected script.
  - A tab with iframes shows how many: `(+3 frames)`. A script running
    in any of them is listed, with where it runs when that isn't the
    top frame alone: `(T1, F1, F3)` or `(F2)`. See
    [Frames](#frames).
- `status` lists the tabs first, then the scripts on the current tab.
- `status` and `scripts` give each script a line saying whether it runs
  on the current tab, and on which others:
  - The list's heading names the tab:
    `Scripts (with status on active tab T1):`.
  - Each script's line: `Active` (the current tab's top frame only),
    `Active on T1 (T1, F2), T2`, `Not active on T1. Active on T2.`, or
    `Not active`.
  - With no tabs open, there is no heading note and no line.
- Per tab:
  - `menu T2` lists T2's commands, and `menu T2.M1` fires one there
    without switching tabs. `menu all` shows all tabs in turn, each
    under a `Tab T<n>: <url>` heading.
  - `values T2` shows the scripts running on T2. `values all` is all
    scripts' values, as `values` alone is.
  - `scripts T2.3` picks script 3 and tab T2 together.

### Frames

A script runs in each iframe whose URL it matches (see
[docs/frames.md](frames.md)). sm-dev gives each iframe an id, `F1`,
`F2`, ... across the run; the top frame goes by its tab's id.

- An iframe keeps its id when it reloads or navigates, and when the tab
  reloads or navigates: a new frame in the same place, with the same
  URL, takes the id of the one that was there.
- `frames` shows the current tab's frame tree, with the scripts running
  in each frame. `frames T2`, `frames all`, or `frames F3` (that frame
  and those in it) for others.
- `tabs --frames` and `status --frames` show each tab's tree in place
  of its script list.
- `match --frames` checks each iframe of a tab by its own URL, and
  shows when `@noframes` keeps a script out.
- `menu` shows the script's menu for the tab, as SourceMonkey's popup
  does, with each command an iframe registered labeled with its frame:
  `M3: Toggle (F2)`. Firing it runs it in that frame.
- A line from a frame is prefixed with it: `[T1.F2] [event] ... started
  in an iframe on ...`, `[T1.F2] [script log] ...`. Its loads show in
  `logs` as `T1.F2 [event] Loaded <URL>`.
- `eval --frame F2` runs in that frame, in the script's scope there (or
  `--script=<script>`, or `--page` for the frame's own page world).
  Cross-origin frames work too.
- `click`, `hover`, `type`, `snapshot`, `screenshot`, `probe` and
  `wait selector` take `--frame F2` for a selector in that frame. A
  snapshot ref (`f2e4`) already names its frame, so it needs none.
  `screenshot --frame F2` with no selector shows the whole frame.
- `frames` marks an iframe that isn't visible `(hidden)`, and shows
  each frame's CDP `[frameId=...]`, and the `[targetId=...]` of one
  from another site (another domain, which Chrome runs in a process of
  its own). `--frame` and `frames` take `frameId=...` too.
  `cdp --frame F2` sends raw CDP calls to the target the frame is in.
- `wait` and the settling after an action watch the top frame's page
  and every frame's requests. For something a frame shows, use
  `wait selector --frame F2 ...`.

### Tabs the page opens

A tab the run's tab opens is the run's too: it runs the run's scripts
(each one's `@match` decides), and only those.

- Covered: links and `window.open` calls, `GM_openInTab`, and tabs
  those tabs open in turn.
- Tabs you open yourself are left alone, unless you open them from a
  controlled tab's link (Ctrl-click, middle-click), which gives them
  that tab as their opener.
- A followed tab's lines, its page output and the run's reports alike,
  are prefixed with its name, as in `[T2]`.
- The scripts run there from its first load. sm-dev finds the tab just
  after, so console lines from that first load aren't shown; the
  scripts' reports are.
- When the run ends, these tabs stay open.

### Tabs without scripts

Tabs can be put in a sticky no-scripts state, to view and compare
unmodified pages, or save one for a spec (`savehtml`).

- `--noscript` on `newtab`, `open` or `reload` enters it; `--script`
  leaves it.
- All pages the tab loads, and all tabs it opens, get no scripts.
- `tabs` marks it `(no scripts)`, and `load` and `update` skip it.
- SourceMonkey-managed scripts stay out of it too, while the run lasts.

### Tab ids for other tools

Each tab's CDP target id is shown with it, for a debugging session
alongside the run to name the same tab:

- As `[targetId=61023580282B1D684FAF4072C201AB51]`, at the end of the
  line the run prints when it opens or finds the tab, and in `tabs`.
- It's the `targetId` CDP's `Target.*` calls take, and in a browser you
  connected to, the `id` in its `/json/list`.
- The `cdp` command needs neither id nor port: it sends calls to the
  tab through the run itself.
- A command that takes a tab alone (`tabs`, `reload`, `focus`) also
  takes the id: whole, its first 6 or more characters, or pasted as
  shown, `targetId=` and all.

### Page dialogs

A script's `alert`, `confirm` or `prompt` is left open and reported in
the stream, rather than being answered automatically.

- In a browser on screen, answer it there.
- Or use `accept` (a prompt's text after it) or `dismiss`, with a tab
  (`accept T2`) for a dialog on another tab. This works in a headless
  browser too.
  - With several tabs, the report names the tab to give:
    `Use accept T2 or dismiss T2`.
  - Prompt text that starts with a tab's name is taken as the tab
    unless quoted: `accept "T2"`.
- In a headless run that can't take commands (it couldn't open its
  socket for other shells), nothing could answer it, so it is dismissed
  and reported.
- While one is open, the page's JavaScript is stopped, so:
  - `menu`, `set`, `reload` and `open` refuse until it is answered;
  - `load` and `update` refuse for a dialog in any tab;
  - `reload all` skips that tab and says so;
  - `closetab` leaves that tab open and says so, unless `--force`.
- `closetab` runs the page's `beforeunload` handlers, as closing a tab
  by hand does. A page that asks first ("Leave site?") opens a
  `beforeunload` dialog: `accept` leaves and closes the tab, `dismiss`
  keeps it open.
  - Chrome only asks on a page that has had a click or key press
    (sm-dev's `click`, `type` and `key` count).
  - `closetab --force` closes without running the handlers, even with
    a dialog open.
- A command that opens a dialog returns once the dialog is up, and says
  so.
- A dialog in a tab the run doesn't use is left alone, for you to
  answer.
- A tab already showing a dialog when `sm-dev start` starts stops it
  connecting: nothing in that tab answers until the dialog closes. The
  run names the tab and waits; answer the dialog or close the tab to
  continue, or Ctrl-C to abort.

## Driving and reading the page

These act on a tab's page, as a person would, and read it back. Each
takes a tab first (`T2`, `targetId=…`), or acts on the
current one.

| Run command | What it does |
| --- | --- |
| `click <selector>`, `hover <selector>` | A real mouse click or hover, scrolled into view. With several matches, the first |
| `click <selector> --button right --modifiers Shift --count 2` | A right or middle click, with keys held, or a double (`--count 2`) or triple click |
| `click <selector> --at 300,12`, `hover <selector> --modifiers Alt --at 4,4` | At a point in the element, in pixels from its top left corner, rather than its center. `hover` takes `--modifiers` too |
| `type <selector> <text>` | Types into an element, key by key |
| `type <selector> --file <path>` | Types a file's text into an element, a last line break included |
| `type <selector> --clear [text]` | Empties the element first, then types the text if given |
| `key <keys>...` | Presses keys in order: `key j Shift+ArrowRight Escape` (`keys` works too) |
| `eval <js>` | Evaluates inside the selected script (or in the page, with none) and prints the result |
| `eval --page <js>` | Evaluates in the page |
| `eval --script=<script> <js>` | Evaluates inside the named script |
| `eval --file <path>` | Evaluates JavaScript from a file |
| `eval --out FILE <js>` | Writes the result to a file, uncut |
| `snapshot [selector] [--visible] [--out file]` | The page (or each element the selector matches) as its accessibility tree, one line per element, each with a ref. `--visible`: only what's on screen. `--out` writes it to a file. `--find <text>`: only elements containing that text (case insensitive). For each match, `--up n` / `--context` add its containers; `--limit n`: how many matches to show (5; 0 for all) |
| `screenshot [selector] [--full] <file>` | A PNG of what's showing, of the whole page (`--full`), or of one element |
| `savehtml <file>` | The page's HTML, to replay later (see [Saved pages](#saved-pages)) |
| `probe <selector>... [--html] [--css]` | Which selectors match, and how many |
| `logs [tab\|all] [script]` | The run's log lines, read back (see [Logs](#logs)) |
| `cdp <Method> [params]` | Sends a raw CDP call to the tab and prints the result as JSON (see [`cdp`](#cdp)) |

### Actions

- `click`, `hover`, `type` and `key` wait for the page to settle (see
  [Waiting](#waiting)) before returning, so the next command sees what
  they did. `--nowait` skips that.
- One that opens a dialog returns once the dialog is up; answer it with
  `accept` or `dismiss`.
- `click` and `hover` wait up to 5 seconds (or `--timeout-seconds S`)
  for their element to be visible, not moving, and not covered by
  another element (`click`: also enabled).
  - Failing, they say which check it kept failing, and name a covering
    element.
- `key` takes the standard key names, case-insensitive (`home`,
  `ctrl+end`), and common short ones (`ctrl`, `cmd`, `esc`, `pgdn`,
  `del`).
- Keys go to the page, not to Chrome, so Chrome's own shortcuts
  (reload, back, zoom) do nothing.
  - Escape doesn't leave fullscreen either. When the page is still
    fullscreen after one, `key` says so; exit with
    `eval document.exitFullscreen()`.

### `eval`

- Takes the rest of the line as JavaScript, quotes and all, or several
  lines as a block (see [Multi-line blocks](#multi-line-blocks)).
- `eval --file probe.js` takes the JavaScript from a file instead,
  for a reusable probe with no shell quoting.
- The value is the last expression, as in the DevTools console.
  - Code with a top-level `return`, written as a function body, works
    too: it runs again as an async function's body, and prints what
    it returns.
  - Its `const`/`let` then stay in that function, where console-style
    code keeps them for later `eval`s.
- Prints JSON, or an element's or function's description. A promise
  prints what it settles to.
  - A result over 10,000 characters is cut, which leaves it no longer
    valid JSON. `eval --out FILE` writes the whole of it to a file
    instead.
- On a page that is reloading or navigating, it waits up to 5 seconds
  for the new document, and runs there.
- `eval` runs inside the selected script (`scripts` shows it);
  `--script=<script>` names another, as `scripts` does. `eval --page`
  runs in the page, where its own globals are.
  - It sees what the script's own code sees: its `GM_*` functions, its
    `@require` libraries, its top-level `const`/`let`/`function`s, and
    the globals of its world.
  - A script that opens with a wrapper function, the usual
    `(function () { ... })()`, an arrow or `async` one included, gets
    it inside that function, so its locals are in reach too.
  - Not the locals inside other functions. Expose what you want to see
    from there on `window`.
  - What it declares (`const`, `let`, `var`, `function`) lasts for that
    one `eval` only. Assigning to the script's variables changes them.
  - `await x` gives x, as in the console. Longer code with `await`
    needs a `return` for its value.
  - With no script selected, `eval` runs in the page.
  - A selected script that hasn't run on the page (it doesn't match,
    or hasn't reached its `@run-at` yet) runs the code in the page
    too, and says so. With `--script` that is the scripts' shared world
    instead. A named one is an error.
  - How it works: sm-dev's scripts carry a small eval hook in their
    wrapper (see [injection.md](injection.md#sm-devs-eval-hook)).

### Snapshots and refs

- Anywhere a command takes a selector, it also takes a ref from the
  latest `snapshot`: `click e4` (or `ref=e4`, `[ref=e4]`).
  - Playwright makes the refs; `f2e4` is one it numbered for a frame.
- A command says what a ref named, from its snapshot line:
  `Clicked e5 (link "past")`.
- A ref names the same element in later snapshots, until its role or
  name changes (a button relabeled after a click gets a new one).
- Only refs in the latest snapshot work, so take a new one after the
  page changes. A reload or navigation drops them all; a route change
  within the page (a single-page app's) doesn't.
  - Refs from `snapshot <selector>` work beside the rest's: it shows
    parts of a snapshot of the whole page.
- The whole page includes what scripts add after `<body>` (to
  `<html>`), and open shadow roots.
- `[cursor=pointer]` marks an element the mouse shows a hand over: one
  that looks clickable though it isn't a link or button.
- `--visible` goes by the viewport: content scrolled out of sight
  inside a scrolling box on screen still counts.

### `probe`

- Says which selectors match, and how many.
- For the first 10 matches, `--css` prints a CSS selector for each and
  `--html` its HTML, paired when both are given.
- `--css` suggests a short selector that finds just that element:
  `probe --css e4` for a ref's, or `probe --css '.titleline > a'` for
  one per match.
  - It passes over ids and classes that look generated (`css-1x2y3z`).
  - For an element in an iframe, it names the frame first
    (`selector (in F2): #save`), since the selector works only with
    `--frame F2`.
  - Elements in a shadow root get none; use their ref.

### `cdp`

`cdp` sends raw CDP calls to the tab, for what can't be done with sm-dev commands
(mouse wheel, drag, window size). Each command, or block, opens a CDP
session of its own:

```sh
sm-dev cdp Input.dispatchMouseEvent '{"type": "mouseWheel", "x": 400, "y": 300, "deltaX": 0, "deltaY": 600}' -- wait
```

```
> cdp {{
... Emulation.setEmulatedMedia {"features": [{"name": "prefers-color-scheme", "value": "dark"}]}
... Runtime.evaluate {"expression": "matchMedia('(prefers-color-scheme: dark)').matches"}
... }}
```

- A call is a `Domain.method`, then its params as a JSON object (bare,
  or in single quotes).
- One call per command. A `{{` block, or `--file <path>`, holds
  several, one per line, sharing a session. They run in order and stop
  at the first failure.
  - Blank lines and `#` comments are skipped, and a mistake names its
    line.
- `Browser.*` and `Target.*` work too, and default to the tab
  (`Browser.getWindowForTarget` with no params).
- The session ends with the command or block, and with it anything
  set for it (`Emulation.*` overrides, enabled domains).
- `cdp` doesn't wait for the page to settle, and each call gets 10
  seconds to answer.

### `screenshot`

A whole-page `screenshot` gives up after 5 seconds (or
`--timeout-seconds S`) if the browser hasn't captured the page.

## Saved pages

`savehtml` saves the page's DOM, and `--from-saved` opens it again as
if it were the live page, so the scripts can be tried against it with
no login or live data.

### Saving

- The page's own JavaScript is kept but disabled, so it can't re-fetch
  or rebuild what was saved.
- A header records the URL, and each userscript running in the tab
  (`<!-- SourceMonkey: userscript active: Name 1.2.0 -->`).
- A saved page has the scripts' changes in it, and would get them twice
  on replay. For one to replay, open the page with
  `newtab --noscript <url>` and save that.
- A page saved with Chrome's Save Page As records its URL the same way,
  so it opens too.
- A "Webpage, Complete" save (Chrome or Firefox) also writes a
  `<name>_files` folder beside it.
  - Its files are served from disk, even with `--offline`.
  - Unlike a `savehtml` file, such a page keeps its own JavaScript
    running.

### Opening

`--from-saved` on `open`, `newtab` or `start` opens each `.html` file
given as a saved page, one per tab: `open page.html --from-saved`,
`newtab 'saves/*.html' --from-saved`.

- The tab loads the recorded URL, and the file answers it.
- Scripts match the URL as on the live site: nothing is forced to run.
- URLs given beside the files open live, as without the flag.
- `--url <url>` serves a single file at another URL, or one that
  records none. With several files it's an error: open such a file by
  itself.
- `--from-saved` with no `.html` file is an error.
- Its network requests (images, styles, fetches) go to the live site.
  `--offline` blocks them instead.
  - One that never answers (a site that needs a login) can keep the
    page from loading. The timeout then suggests `--offline`.
- The file is only known by its URL: a page whose own JavaScript
  changes it (`history.pushState`) sends its requests live from then
  on, even with `--offline`.
- A file saved with userscripts running gets a warning, since their
  changes are in it and they will run again.

### Afterwards

It's sticky, for that URL only:

- `reload` serves the file again, re-read from disk, so it can be
  edited between loads. If it can't be read, the page and the run's
  output both say why.
- Other URLs in the tab load from the live site; coming back serves the
  file. Tabs it opens don't inherit it.
- Another `--from-saved` replaces it. For the live page at the same
  URL, use another tab.
- `tabs` and `status` show `(from saved: page.html)` after the URL
  while it shows, or `(from saved: page.html, offline)` with
  `--offline`.

## Logs

A run logs every line the page and scripts produce, each with a source,
from narrowest to broadest:

- `sm`: SourceMonkey logs, as a script's Log tab shows them (reloads,
  updates, errors its wrapper caught, `@require` failures).
- `event`: script and tab events sm-dev sees: starts, page loads,
  errors, menu commands, dialog boxes, tabs opened, requests, values.
- `script`: Chrome console logs that came from the run's scripts.
- `page`: full Chrome console logs. (Off by default, except for
  `wait log`.)

A line can be in several sources, and asking for any of them shows it:

- A script's console line is `script`, and also `page`.
- A script's throw is an `event`, and also `sm`, `script` and `page`.

`logs` reads them back:

```sh
sm-dev logs                                  # this tab: its scripts' lines and events
sm-dev logs 2 --log-source sm               # script 2's SourceMonkey Log
sm-dev logs all --log-source all --find /error/i --tail 5m
```

```text
14:05:12.345 T1 [event] Add button started on https://example.com/items/42
14:05:12.351 T1 [script log] [add-button] toolbar found, button inserted
14:05:13.118    [sm error] Add button: The @require https://x.test/lib.js could not be loaded
[sm-dev] Logs up to 1759512345678901 (14:05:13.118)
```

- A tab (`T2`) or `all` picks the tabs; a script picks one script.
  Without a tab, the current one, and the lines its scripts logged
  outside any tab.
- `--log-source <source>`: `sm`, `event`, `script`, `page` or `all`;
  several can be given, separated by commas.
- `--find <text>`: only lines with the text, or matching `/regex/`.
- `--tail N` or `--tail 30s`: the last N lines, or those from the last
  stretch of time.
- `--since <position>`: only lines after it. A position is a log ID,
  an ISO 8601 time (`2026-10-03T14:05:12Z`; local without a zone), or a
  time of day today (`14:05:12`).
- Each line's log ID is when it arrived, in microseconds since the
  epoch. `logs` ends with the newest, `Logs up to ...`, to pass to the
  next `--since`.
- Identical lines in a row show once, marked `(N times)`.
- The run keeps the last 5000 lines. A `--since` from before them says
  `Lines before ... are no longer kept`.

The design: [sm-dev-logs.md](sm-dev-logs.md).

## Waiting

`wait` holds the next command until something has happened, in place
of a guess at a time:

```sh
sm-dev start x.user.js https://example.com/ -- screenshot before.png \
  -- click '.btn' -- wait log saved -- snapshot --visible -- logs
```

| Form | Waits until |
| --- | --- |
| `wait [T<n>\|all]` | The tab (or all tabs) settles |
| `wait selector <css>` | An element matches |
| `wait selector-gone <css>` | No element matches |
| `wait log <text>` or `wait log /regex/` | The run prints a matching line |
| `wait {500ms\|2s}` | That long passes |

- A tab goes first: `wait T2 selector .x`. One after the form's word
  (`wait selector T2 .x`) is refused, rather than taken for the
  selector.

### When a tab has settled

All of these hold together for 200ms:

- The document has loaded.
- Each script the page runs whose rules cover it has started (or been
  skipped, or thrown).
- None of its scripts' `GM_xmlhttpRequest`s is in flight, apart from
  ones open over 3 seconds.
- None of the page's requests is in flight, apart from ones open over 3
  seconds (a socket, a stream, a long poll).
- The DOM hasn't changed.
- Then the page's main thread has a moment with nothing to do.

Timers aren't waited for: they are set up to run later.

- A short one that matters changes the DOM when it fires, which the
  200ms catches.
- For a script that finishes later than that, print a line when done
  and `wait log` for it.

Limits of the heuristic:

- A request over 3 seconds that the page is still waiting on (a slow
  API call) counts as long-lived, so the page can settle before its
  results show. `wait selector` for them instead.
- A resource that never finishes loading holds the page's `load` event,
  so the page never settles.

### Commands that wait on their own

- `start` settles its tabs before taking commands (or `--detach`
  returning). `start --nowait` skips that.
- `click`, `hover`, `type`, `key`, `reload`, `open` and `newtab` settle
  the tabs they touch before returning. Each takes `--nowait`.

### Giving up

- The waits other than a delay give up after 5 seconds (a page load
  after 30), or `--timeout-seconds S`, and say what was still busy:
  `T1 did not settle within 5s: 2 requests pending (/api/poll,
  /ads.js); the DOM is still changing (div#ticker)`.
- `--timeout-seconds S` works on every command that waits, and sets
  each of its waits (an element being ready, a load, settling).
  - On `cdp`, it's each call's limit (default 10 seconds).
- An explicit `wait` that gives up fails, so a line of several commands
  (or a list in one argument, or commands piped in) stops there, and
  says the rest weren't run.
- A command's own wait that gives up only says so, since the command
  itself worked.

### `wait log`

- `wait log /pattern/flags` is a regular expression; any other text is
  a plain substring.
  - Quotes around the whole text are removed first, so `wait log
    "/abc/"` is a regex too. For the literal characters, use
    `wait log /\/abc\//`.
- The text can also be given with `--find`: `wait log --find saved`.
- It looks at log lines (see [Logs](#logs)) logged since the previous
  command began (not counting a `wait` or a command that only looks),
  so one a click set off while it settled counts. Then at new ones.
  - `--since <position>` looks from there instead.
- It sees every source, the page's own lines too, unless
  `--log-source` says otherwise. Each is matched in the form the
  stream would print it, whole: `[page log] KEYUP 143`.
- sm-dev's own replies and notices aren't looked at.
- It ends with the line it matched, then where:
  `[sm-dev] Found at 1759512345678901 (14:05:12.678)`. One that gives up
  says where it searched to: `[sm-dev] Searched up to ...`.
- A near miss of `--timeout-seconds` ending unquoted text (`--timeout
  40`) is refused, rather than looked for as text. Other `--words` in
  the text are text.

## Background runs and logs

### Which run, and what you see

- sm-dev works with one run at a time: `--run`'s, else the one it
  started or attached to, else the only one going.
- `start` prints the run's startup output. The run's first line names
  it, and how to reach it:
  `[sm-dev] Started as run D1. Other shells reach it with sm-dev --run
  D1 <command>, or sm-dev attach D1, and stop it with sm-dev stop D1.`
- After that, what sm-dev shows depends on the line:
  - A line with a command that acts (`eval`, `click`, `type`, `key`,
    `reload`, `open`, `newtab`, `load`, `update`, `set`, firing a
    `menu` command, `wait`, `start`, `attach`), or input with no known
    end (`--stdin`, `--interactive`), follows the run's whole stream,
    between commands too.
  - A line of only commands that look (`status`, `values`, `get`,
    listing `tabs`, `scripts` or `menu`, `snapshot`, `probe`, `logs`,
    `match`, `validate`, `list`, `help`) prints just their answers.
- Commands that only look answer the sender alone. Ones that change
  something (`reload`, `click`, `menu Bump`) also show in the run's
  log, and to other clients following it.

When a command's reply is complete:

- Each command prints its output, and returns as soon as it is done.
- A command that loads a page (`reload`, `open`, `newtab`, `load`) is
  done once the tab's scripts have started and their top-level code has
  run, so that output is in the reply.
- `menu` and `eval` include what the handler or expression printed
  while it ran.
- Output a script prints later, from a timer or event, goes to the
  run's log file and to the clients following the run. `sm-dev logs`
  reads it back (see [Logs](#logs)).

### Managing runs

```sh
sm-dev start sites/x/y.user.js --detach
sm-dev list
sm-dev menu Bump                          # the command's output
sm-dev --run D1 values                    # when several runs are active
sm-dev attach D1                          # watch it; Ctrl-C leaves it going
sm-dev stop                               # or stop D1, or stop --all
```

- `sm-dev attach [ID]` connects to a run that is going (default:
  `--run`'s, or the only one) and shows what it prints from now on. On
  its own, until the run ends or Ctrl-C, which leaves it going.
- `sm-dev stop [ID]` stops the run sm-dev works with (or the one
  named); `--all` stops all of them. One that doesn't respond is
  killed.
- `exit` (or Ctrl-C) ends sm-dev. A run it started without `--detach`
  stops with it; a run it only attached to goes on.
- At the prompt or on stdin, `start`, `attach`, `stop`, `exit` and
  `list` work as on sm-dev's command line. `stop` there leaves sm-dev
  with no run.

`list` prints a table of the runs active on this machine, with the
first few scripts' files and a count of the rest:

```
Run  PID    Uptime  Browser                            Manager       Tabs  Scripts
D1   81234  2m      127.0.0.1:9233                     SourceMonkey  2     a.user.js, b.user.js, c.user.js, (2 more)
D2   81502  1m      127.0.0.1:41234 (owned, headless)  SourceMonkey  1     a.user.js
```

- Browser is where the run's browser takes CDP connections.
- Manager is the one the run works with (`--manager`).
- `owned` marks one the run launched (`--temp-browser`), which closes
  when it ends; `headless`, one without a window.
- `status` says the same on its first line:
  `Attached run: D2 (pid 81502), connected to owned headless browser
  127.0.0.1:41234 (has SourceMonkey)`.
  - The heading says how this sm-dev came to the run: `Started run:`
    (`Started run (detached):`), `Attached run:`, or `Selected run:`
    (by `--run`, or an earlier command on the line).
  - With no run picked, `status` says `No current run`, then shows the
    browser commands with no run use (`--browser`'s) and its managers,
    then every active run, each headed `Other run:`.
  - `has SourceMonkey`, `SourceMonkey disabled` or `no SourceMonkey`
    says whether the run's manager is there. Checked each time.
  - The `Managers:` line after it lists every manager in the browser,
    with its version, and whether it's in use, disabled, or has "Allow
    User Scripts" off.
  - The run's first line says it too, after the Chrome version.

### How a run ends

- Prefer `stop` to `--stop-after-seconds` for a background run, so the run can't
  expire while you're still testing.
- Every run stops itself after 30 minutes with no command sent, unless
  a client is following it. `start --stop-after-idle-seconds N` changes that, and
  `--stop-after-idle-seconds 0` turns it off.
- Piping sm-dev's output into something that stops reading (`| head`)
  ends sm-dev.
- Every run's last line says it has ended. Its test collection is
  removed, and its tabs are SourceMonkey's again: from their next load
  they run SourceMonkey-managed scripts, not the run's.
- Pages already open keep what the run's scripts did until reloaded,
  but nothing from them streams anywhere.

### Detached runs

`start --detach` is the way for an agent to start a background run: no
`&`, and no guessing how long to wait before the first command.

```sh
sm-dev start sites/x/y.user.js https://example.com/ --detach
# [sm-dev] Run D1 now running detached, with idle timeout 30 minutes
# [sm-dev] Output log: /tmp/sm-dev-logs-you/sm-dev-20260926-063756-629.log (D1.log)
sm-dev eval 'measure()'
sm-dev stop
```

- The run goes on when sm-dev ends. It is also marked as detached, for
  a later `start --detach` to replace.
- Alone on the line, it returns once the run would take its first
  command: the pages have settled (see [Waiting](#waiting)), or it gave
  up on them. Its output until then is printed, then the lines above.
- With commands after it (`start x.user.js --detach -- eval
  'measure()'`), it sends them, and leaves the run going.
- It exits with the run's code if the run ends before that (a script
  that doesn't parse, no browser to connect to).
- Starting one stops any earlier detached run first, and closes its
  tab when that tab is selected. Runs started without `--detach` are
  left alone.
  - `--new` leaves the earlier ones going, and starts another beside
    them.
  - `sm-dev --run Dname start ... --detach` stops only the run named
    that, if one is going.
- `sm-dev attach` shows its output from then on.

### The log file

Every run keeps a log of its stream, to tail for what the scripts and
page print on their own, or to look back at what happened when.

- It's `/tmp/sm-dev-logs-<user>/sm-dev-<timestamp>.log`, with a
  timestamp starting each line. It's kept after the run ends.
- `D1.log` beside it links to the latest log of the run named `D1`.
- Its name is printed as `Output log: <path> (D1.log)`: once a detached
  run has started, and when sm-dev stops a run it started (at the end
  of the line, or on `exit`). `status` shows it too, as `Log: ...`.
- Its first line says which browser the run uses:
  `Connected to browser 127.0.0.1:9233 (Chrome 153.0.8010.12)`, or
  `Launched owned headless browser ...` for `--temp-browser`.
- The run's output all goes there. A client following the run shows the
  same lines, without the timestamps.

It's what the page and scripts do, not all the replies:

- Commands a client sent that change something show where they
  happened, with their replies, headed by who sent them and how:
  `primary:arg > reload`, `remote:stdin > menu Bump`.
  - Who: `primary` is the sm-dev that started the run, `remote` any
    other.
  - How: `arg` from its command line, `stdin` piped in, `prompt` typed
    at the `--interactive` prompt.
  - An `eval` block shows as `primary:arg > eval {{`, then `... `
    before each line of code, then `... }}`.
- Clients following the run see other clients' commands headed the
  same way. Their own go without the who (`arg > reload`), and ones
  typed at their prompt aren't repeated.
- Commands that only look (`status`, `snapshot`) and their replies are
  left out.

## Writing specs: the Playwright fixture

```js
import { test, expect } from 'sourcemonkey/harness';

test('adds the button to the toolbar', async ({ page, loadUserscript, gm, reports }) => {
  await loadUserscript('sites/example.com/add-button.user.js', {
    values: { units: 'metric' },
  });
  await page.goto('https://example.com/items/42');
  await reports.waitForStart();
  await expect(page.locator('#add-button')).toBeVisible();
  expect(reports.errors()).toEqual([]);
  expect(await gm.get('lastItem')).toBe('42');
});
```

### How it runs the scripts

- In the real SourceMonkey, as `sm-dev`'s runs do. Each test's scripts
  go into a test collection of its own, removed when the test ends.
- The test's `page` is claimed for the test, so only its scripts run
  there, and SourceMonkey-managed ones stay out.
- The browser: by default each Playwright worker process launches one
  hidden Chromium with the package's built extension (its `dist/`),
  and its tests share it.
  - Starting it takes a few seconds, once per worker.
  - `--headed` shows it.
- A worker's tests share the browser's own context: cookies and
  storage carry over between them, and Playwright's context options
  (`baseURL`, `viewport`, `locale`) don't apply. Each test's tabs are
  closed at its end.
- A repo that drives its own browser (a logged-in one, over CDP)
  overrides `browser`, `context` and `page` in its fixture file, and
  re-exports the harness `test` extended with them. That browser needs
  SourceMonkey loaded with "Allow User Scripts" on (see
  [Setting it up](#setting-it-up)).

### What the fixture provides

| Name | Purpose |
| --- | --- |
| `loadUserscript(path, options?)` | Checks the file with the real pipeline and pushes it into SourceMonkey, before the navigation that should see it |
| `gm` | The scripts' storage, menu commands, and recorded `GM_*` side effects |
| `reports` | `started()`, `skipped()` (with the rule that missed), `errors()` (message and stack, its lines mapped to the `@require` or script file as in the run's output) |
| `serveHtml(file, url?, { block? })` | Routes a saved HTML file at its URL, so `@match` and relative URLs behave as on the live site |
| `saveHtml(file)` | Writes the page's current DOM to `file`, for `serveHtml` to replay later |
| `host`, `attachment` | The underlying objects, for anything the others don't cover: the reports' host, and the page's watcher |

`loadUserscript`:

- A relative path is taken from the Playwright config's root.
- Throws with the extension's own message if the script is invalid.
- Call it twice for two scripts on one page.
- Options:
  - `values` seeds storage.
  - `url` checks the match now, and throws if it misses.
  - `copy` loads the same file again as a second installed copy, with
    its own id and storage.
  - `collectionRoot` and `localRoots` set the `@require` lookups
    (default: the config's root). Files read from disk are pushed with
    the script.
    - A script outside `collectionRoot` uses its own collection's root,
      as `sm-dev`'s `--root` does.

`gm`:

- Storage: `get(key)`, `set(key, value)` (reaches a running script like
  another tab's write), `list()`.
- Menus: `menuCommands()`, `fireMenu(label)`.
- Manual scripts (`@run-at context-menu`): `runScript()` runs one, as
  the popup's "Run this script" does; `fireMenu('Run this script')`
  does too, and `menuCommands()` lists it first.
- Side effects: `openedTabs()`, `downloads()`, `requests()`,
  `notifications()`, `clickNotification(requestId)`,
  `closeNotification(requestId)`.
  - SourceMonkey reports each one a moment after the script's call, so
    check them with `expect.poll`, not once.
- Connection prompts: `connectPrompts()`, and
  `answerConnectPrompt(promptId, choice)` with `once`, `cancel`,
  `allow`, `deny` or `allow-all`. A request to a host the script's `@connect` lines don't cover
  waits on one.
- Network control: `failHosts(...hosts)` gives a synthetic 503 for
  those hosts, to force a fallback path. `interceptRequests(fn)`
  answers any request from the test. Await either before the request
  can go.
  - A `load` answer's status, headers, `responseText` and `finalUrl`
    are what the script sees; `finalUrl` by a redirect to it.
  - An `error`, `timeout` or `abort` answer reaches the script as a
    network failure, with the extension's own message.
  - The interceptor gets a script id only when one script is loaded.
  - In a browser of your own, other tabs' scripts' requests are
    intercepted too while it is set.
- `downloads()` lists the ones the extension handles: http(s) URLs.
  A `data:` or `blob:` download happens in the page, and isn't listed.
- Values and commands are per script. When several are loaded, name one
  by the path it was loaded from, its basename, or its `@name`.

`reports`:

- `await reports.waitForStart()` is the usual gate before interacting.
  When nothing starts, it says which script was skipped where, and why.

`serveHtml`:

- `url` is matched exactly, query string included. Without it, the URL
  the file records is used.
- Resolves to the URL, to pass to `page.goto`.
- A `<name>_files` folder beside the file is served too.
- Other requests fall through to the page's other routes and the
  network, unless `block` is set.
- Pair it with Playwright's `routeFromHAR` for pages that fetch data.
- `saveHtml` writes the same file the `savehtml` run command writes.

Other notes:

- `sourcemonkey/harness` loads Playwright when imported. A Node-only
  tool that wants just `prepareScript` can import
  `sourcemonkey/harness/prepare` instead.

### From `sm-dev` to a spec

What `sm-dev` does by hand, a spec does through the fixture:

| `sm-dev` | In a spec |
| --- | --- |
| `start <script>` | `loadUserscript(path)` |
| `--values '{…}'` | `loadUserscript(path, { values })` |
| `menu`, `menu <label>` | `gm.menuCommands()`, `gm.fireMenu(label)` |
| `menu 'Run this script'` | `gm.runScript()` |
| `values`, `get <key>` | `gm.list()`, `gm.get(key)` |
| `set <key> <json>` | `gm.set(key, value)` |
| `reload`, `open <url>` | `page.reload()`, `page.goto(url)` |
| `savehtml <file>` | `saveHtml(file)` |
| `open <file> --from-saved` | `page.goto(await serveHtml(file))` |
| `click`, `type`, `key`, `eval`, `screenshot` | Playwright's own `page` and locator methods |
| `probe <selector>` | `page.locator(selector).count()` |
| `snapshot` | `locator.ariaSnapshot({ mode: 'ai' })` |
| `logs` | `page.on('console', …)` |
| `match <script> <url>` | `loadUserscript(path, { url })`, which throws on a miss |
| `validate <path>` | `loadUserscript(path)`, which throws with the same message |
| the streamed reports | `reports.started()`, `skipped()`, `errors()` |
| the streamed `GM_*` lines | `gm.requests()`, `gm.openedTabs()`, `gm.downloads()`, `gm.notifications()` |

A spec can also answer the script's network requests itself
(`gm.interceptRequests`, `gm.failHosts`). `sm-dev` has no command for
that, since the answer is a function.

## Known limitations

- A `document-start` script may run after the page's first inline
  `<head>` scripts in a tab a run tab opened, where SourceMonkey alone
  would usually run it first.
  - In the tabs the run opens itself, the run's scripts run as they
    would alone. In the tabs those open, every script waits for the
    extension's check before running (see
    [sm-dev-design.md](sm-dev-design.md#making-wrappers-ask)).
  - A script whose early change a page script then overwrites (a class
    on `<html>`) can work there and not in the run's own tab, or the
    reverse.
  - The person's own scripts wait for the check in every tab of a
    browser a run is connected to.
- A tab a run tab opens is found just after its first load, so console
  lines from that load aren't shown; the scripts' reports are (see
  [Tabs the page opens](#tabs-the-page-opens)).
- When Chrome restarts SourceMonkey's service worker (its background
  script) during a run, what the scripts did meanwhile may be missing
  from the run's output. The run says when this happens.
- A log line from an iframe can lack its frame prefix: an event from a
  SourceMonkey before protocol 2.2, or a console line logged before
  sm-dev reached the frame's process.
- `--lang` doesn't reach `GM_xmlhttpRequest` and `GM_download` in a
  connected browser (see [`start` options in detail](#start-options-in-detail)).
- In specs, a worker's tests share the browser's context (see
  [How it runs the scripts](#how-it-runs-the-scripts)).

## Troubleshooting

- **"SourceMonkey is not installed in this browser"**, **"is turned
  off"**, or a message that "Allow User Scripts" is off: load it, or
  turn it on, as in [Setting it up](#setting-it-up), or use
  `--temp-browser`.
- **"skipped on <url>: No @match or @include covers this URL"**, or
  another rule named there: the script would not run there outside
  sm-dev either. Broaden the pattern or change the URL; see
  `sm-dev match`.
- **`GM_getValue is not defined`**: the script uses an API it did not
  `@grant`.
- **The script sees `undefined` for a page global**: it is in the
  isolated world. Reading page globals needs `@grant none` or
  `unsafeWindow`.
- **A `@require` fails to load**: sm-dev resolves it the way the
  extension does, including local overrides. The message names the URL
  and the reason.
- **`sm-dev start` hangs at connect**: a tab in the browser is showing
  a dialog. The run names it; answer the dialog or close the tab (see
  [Page dialogs](#page-dialogs)).
