# Testing userscripts with the SourceMonkey harness

The harness is for a repo of userscripts that wants to probe sites,
run a script under development, and write regression tests, using
SourceMonkey's own code for the manager's half of the picture.

It has two parts:

- **`sm-dev`**, a command-line tool for interactive work: open a site
  with your script injected, watch what it does, poke at the page, edit,
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
- [Starting a run](#starting-a-run)
- [Sending commands](#sending-commands)
- [Working with scripts](#working-with-scripts)
- [Working with tabs](#working-with-tabs)
- [Driving and reading the page](#driving-and-reading-the-page)
- [Saved pages](#saved-pages)
- [Waiting](#waiting)
- [Background runs and logs](#background-runs-and-logs)
- [DevTools alongside a run](#devtools-alongside-a-run)
- [Writing specs: the Playwright fixture](#writing-specs-the-playwright-fixture)
- [The extension backend](#the-extension-backend)
- [What is and isn't faithful](#what-is-and-isnt-faithful)
- [Troubleshooting](#troubleshooting)

## What you get

- **The manager's semantics without the extension.** Your script runs
  behind SourceMonkey's real injected code:
  - the header is validated;
  - `@match` / `@include` / `@exclude` decide whether it runs;
  - `@run-at` is honored;
  - `@require` files load, with local copies overriding GitHub URLs the
    way the extension does;
  - `@grant` decides which `GM_*` names exist;
  - the script lands in the same world (page or isolated) it would in
    Chrome.
- **Real `GM_*` behavior.** Storage with the real value codec and
  cross-page broadcast, `GM_xmlhttpRequest` gated by `@connect`, menu
  commands you can fire, tab opens and notifications you can inspect.
- **The script's own reports.** Whether it started, was skipped for a
  URL miss, or threw, attributed the same way the extension's Log tab
  does.
- **A switch to the real extension** for the cases only Chrome can
  answer (see [The extension backend](#the-extension-backend)).

## Setup

### Requirements

- Node 22+ and pnpm.
- A Chromium that Playwright can reach, with a remote-debugging port.
  See [A browser to work in](#a-browser-to-work-in).
- For the extension backend only: SourceMonkey loaded in that browser
  (see [Setting it up](#setting-it-up)).

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
  - `sm-dev` warns when the SourceMonkey checkout has changes the copy
    lacks, and says which of the two steps is needed.

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

### 2. Start a run

```sh
sm-dev --interactive start sites/example.com/add-button.user.js --watch
```

- Opens the script's page (the first URL its `@match` implies) in tab
  `T1`, with the script injected.
- Streams the script's console lines, errors, and whether it started.
- `--watch` re-injects the script and reloads the page on each save.
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
[sm-dev] Injected sites/example.com/add-button.user.js in world USER_SCRIPT, run-at document-idle
[sm-dev] Opening https://example.com/items/42 in T1 [targetId=61023580282B1D684FAF4072C201AB51]
[sm-dev] Add button started on https://example.com/items/42
[page log] [add-button] toolbar found, button inserted
[sm-dev] GM_setValue lastItem = "42"
```

- A page the header does not cover prints the rule that kept the
  script off it (`skipped on <url>: No @match or @include covers this
  URL`), and nothing runs.
- A header problem prints the same wording the extension's viewer
  would, and nothing is injected.
- A long stored value is cut after 100 characters in its `GM_setValue`
  line; `get` and `values` show it whole.

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

- Global options (`--run`, `--cdp`, `--interactive`, ...) go first, and
  hold for the whole line (see [Global options](#global-options)).
- `--` separates commands, which run in order (see
  [Sending commands](#sending-commands)).

### Runs and clients

- `sm-dev start` begins a **run**: a background process of its own
  that connects to the browser, opens tabs, injects the scripts, and
  logs what they do.
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
  `stop`, `exit`, `list`, `clear`, `help`, and `match` / `validate`
  given files.
- **Run commands**, which go to a run: everything else (`status`,
  `eval`, `click`, `menu`, ...). `sm-dev eval document.title` sends
  `eval document.title` to the run sm-dev works with.

### Help

- `sm-dev --help` lists everything, in sections: command input,
  examples, then all commands grouped by what they work on, then the
  global and common options, and how to name scripts, tabs and the
  rest.
- `sm-dev help start` (or `sm-dev start --help`) shows one command: its
  usage, arguments, and only the options it takes.
- It takes several names at once: `sm-dev help status tabs`.
- `--help` (or `-h`) anywhere on a line shows the help for each command
  on it, once each, and runs none of them.
- In a run, `help [command]` or `?` does the same.

## A browser to work in

`sm-dev` connects to a browser over CDP (Chrome DevTools Protocol, the
remote-control interface DevTools and Playwright use). There are three
ways to get one.

### A lasting browser: `--open-browser`

Best for sites that need a login.

```sh
sm-dev --open-browser                           # just the browser
sm-dev --open-browser start x.user.js --detach  # the browser, then a run in it
sm-dev --open-browser --cdp 9300                # another one, on port 9300
```

- It has a window, and listens on `--cdp`'s port (9233 by default),
  which is where later commands connect.
- It stays open after sm-dev ends. Close it as any browser: by closing
  its window.
- Google Chrome when it's installed (it handles Google sign-in), else
  Playwright's Chromium. `SM_DEV_BROWSER` names another binary.
- Its profile is kept, so sign-ins and extensions carry over:
  `~/.config/sm-dev/browser-profile-<port>`, or `--profile DIR`.
  - One per port, since only one browser at a time can use a profile.
    One already in use is refused, naming the port its browser is on.
- A browser already answering on the port is used as it is, whatever
  its profile, so `--open-browser` can go on any command line.
- It only starts one on this machine: `--cdp` has to be a port alone
  (`9300`), or one on `127.0.0.1` or `localhost`.
- A browser that can't start, or whose port doesn't open within 10
  seconds, is closed again, with the reason.
- Its output goes to `sm-dev-browser.log` in the profile directory, and
  the log's last line is shown if it fails to start.

### A throwaway browser: `--temp-browser`

- Launches a hidden Chromium for each run, with an empty profile,
  closed when the run ends. `--headed` shows it.
- Useful for a quick run whose page needs no login.
- With `start --extension`, it loads SourceMonkey's built extension
  (its `dist/`), with "Allow User Scripts" on and pinned to the toolbar. See
  [The extension backend](#the-extension-backend).
- Needs a `start` on the line (or `--interactive` or `--stdin`, where
  one can come).

### Your own browser

Any Chromium started with
`--remote-debugging-port`. Point sm-dev at it with `--cdp`.

### Choosing the browser: `--cdp`

- `--cdp` takes a URL, a `host:port` (`http://` is added), or just a
  port on this machine (`9222` or `:9222`). An IPv6 host needs brackets
  (`[::1]:9222`).
- It defaults to the `SM_DEV_CDP` environment variable, which takes the
  same forms, then port 9233.
- These are global options, so they go first:
  `sm-dev --temp-browser start x.user.js`.
  - As a global option, `--cdp` holds for the whole line (and
    `--open-browser`). After `start` or `clear`, it's for that command
    alone.
- One browser choice per line: `--temp-browser` can't go with `--cdp`
  or `--open-browser`, and after `--open-browser`, `start` takes no
  `--cdp` of its own.

## Starting a run

```sh
sm-dev start [script.user.js]... [url]... [options]
```

- Opens a tab at each URL, injects the scripts as they are on disk, and
  streams the scripts' console lines, errors, and start / skipped /
  error reports.
- With no URL, it opens the first script's **default page**: the first
  URL its `@match` implies.
- Several scripts go into the same page, for interaction tests.
- Without `--detach`, the run stops when sm-dev ends.

`start` with nothing after it to keep the run going is refused:
`The start command with nothing after it would stop the run as soon as
it started. Add --interactive for a prompt, --detach to leave it
running, --seconds N to watch it for a while, or commands after --.`

### Options at a glance

| Option | Effect |
| --- | --- |
| `--watch` | Re-inject and reload on each save of a script or local `@require` |
| `--detach` | Return once the pages settle, and leave the run going |
| `--new` | With `--detach`, keep earlier detached runs going |
| `--all` | Open each script's default page, one tab per page |
| `--notab` | Open no tab at startup |
| `--from-saved` | Open `.html` files as saved pages, at their URLs |
| `--values '<json>'` | Seed `GM_*` storage first |
| `--values-file <path>` | Seed `GM_*` storage first, from a JSON file |
| `--page-errors` | Also stream the page's own errors |
| `--nowait` | Don't wait for the pages to settle |
| `--seconds N` | Stop the run after N seconds |
| `--idle-seconds N` | Stop after N idle seconds (default 30 minutes; `0` never) |
| `--extension`, `--solo` | Use the real extension; silence its other collections |
| `--devtools` | Start a Chrome DevTools server for the run |

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
  - Works with `--extension` too, where only page output carries the
    tab's name (the extension's Log entries don't say which tab).
  - Can't be combined with a URL.
- `--notab` opens no tab at startup. `newtab` opens one later, and the
  first it opens is T1.
  - That tab isn't one a later run takes over (see
    [Which tab `start` uses](#which-tab-start-uses)).
  - With `--extension`, the scripts just run in whatever pages you
    browse to, and after a `--watch` save you reload them yourself.
  - Can't be combined with a URL or `--all`.
- With no scripts given, it starts as a browser to drive with the run
  commands, on a blank page or the URLs given. `load` adds scripts
  later. It can't be combined with `--all`, `--values`,
  `--values-file`, `--watch` or `--solo`.
  - With `--extension`, it's a browser whose SourceMonkey runs its own
    collections. With `--temp-browser --headed`, that's a throwaway
    browser with the extension, to try by hand.
- `--from-saved` opens each `.html` file given as a saved page, at the
  URL it was saved from, with `--url` and `--offline` as for `newtab`.
  See [Saved pages](#saved-pages). Not with `--all` or `--notab`.

The scripts:

- `--watch` re-injects on each save of a script or a `@require`d file,
  and reloads the tabs it runs in or now matches, all at once. (The run
  command `update` does the same on demand.)
- `--values '{"key": 1}'` seeds `GM_*` storage before the script runs.
  `--values-file values.json` does the same from a file holding a JSON
  object.
- `--page-errors` also shows the page's own errors (see
  [What the stream shows](#what-the-stream-shows)).

The run's lifetime:

- `--detach` returns once the pages have settled, and leaves the run
  going. `--new` and `--idle-seconds` go with it. See
  [Detached runs](#detached-runs).
- `--seconds N` stops the run after N seconds, as a safety limit.
  - On its own (`sm-dev start x.user.js --seconds 30`), sm-dev shows
    what the run prints until then.
  - To wait for a page or a script, use `wait` (see
    [Waiting](#waiting)) rather than a guess at a time.
  - For a longer session, leave it off and end the run with `sm-dev
    stop`, so it can't expire mid-test.
- `--nowait`: don't wait for the pages to settle before continuing. It
  still waits for the scripts to start.

Other modes:

- `--extension` uses the real extension in that browser instead of the
  built-in stand-in; `--solo` silences the other collections for the
  run. See [The extension backend](#the-extension-backend).
- `--devtools` starts a Chrome DevTools server for the run. See
  [DevTools alongside a run](#devtools-alongside-a-run).
  `SM_DEV_DEVTOOLS=1` makes it the default, and `--nodevtools` turns it
  off again.

### Which tab `start` uses

In a connected browser, `start` opens a new tab, unless the tab showing
in its window is one an earlier run opened and that run has ended. Then
it takes that tab over, so re-running with the old tab still selected
reuses it rather than piling up tabs.

- A tab whose run is still going is never taken.
- With several windows open, each window's showing tab counts, and the
  first free one found is taken.
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

The page's own errors are left out, since a busy site logs enough of
them (blocked trackers, failed ad requests) to bury the script's lines.

- Shown:
  - console lines from the script;
  - `[name]`-prefixed console lines;
  - errors whose stack runs through the script;
  - a thrown value that isn't an `Error` (it has no stack, so it is
    always shown).
- A script's own throw prints once, as `<name> threw:` (with
  `--extension`, also as the Log tab's entry).
- `--page-errors` shows the rest too. Reach for it when the script may
  be breaking the page, or when it runs code outside its own file:
  - a `<script>` element it adds to the page;
  - code it `eval`s, whose console lines lose the script's location;
  - a throw deep inside page code (a framework's event dispatch) that
    the script's frame has scrolled off the stack.
- `logs` shows everything the page logged, filtered or not.
- A page whose `Content-Security-Policy` header sandboxes it without
  `allow-scripts` blocks scripts in the page's own context (`@grant
  none`, `@inject-into page`), under sm-dev and in the extension
  alike. On each load of such a page, the run names the loaded scripts
  that this blocks and suggests `@inject-into content`.

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
- Line editing and history work as in most shells (arrows, Ctrl-A /
  Ctrl-E, Ctrl-U), and Tab completes a command name.
- Output streamed while you type is printed above the prompt, which is
  then redrawn with what you had typed so far.
- `--` splits a typed line into several commands, as on the command
  line, except inside a `{{` block.
- A command that fails is reported, and the prompt goes on.

Keys:

- Ctrl-C clears a half-typed line, and inside a `{{` block drops the
  block.
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
> eval T2 --script {{
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
- Arguments a command doesn't take are refused: `status now`, `logs T2
  x`, `stop D1 D2` (with its usage).
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

The options:

- `--run ID` names the run to work with. It's needed only when several
  are active; otherwise the command says so, and lists them.
  - With `start`, it's the ID for the new run: `D` and then letters,
    digits, `_` or `-` (`sm-dev --run Dmain start ...`). A run already
    using it is stopped first.
- `--root DIR` names the repo root, searched for local copies of
  `@require` URLs the way the extension searches a collection's
  directory. Defaults to the current directory.
- `--local DIR` adds another directory to that search; repeatable.
  - A run keeps the `--root` and `--local` it started with. A line that
    sends a command to a run it didn't start refuses them.
- `--stdin` and `--interactive`, above.
- The browser options, `--cdp`, `--open-browser`, `--profile`,
  `--temp-browser` and `--headed` (see
  [A browser to work in](#a-browser-to-work-in)).

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
| `scripts` | Lists the loaded scripts, numbered, and where each is active |
| `script <script>` | Picks the script `get`, `set`, `match` and `validate` act on (the first, until changed). `scripts <script>` works too |
| `load <script>...` | Loads more scripts from disk (files, directories, globs), and reloads the tabs they match. Quote a path with spaces |
| `update [script]` | Re-reads one script from disk, or all (with no argument, or `all`), as `--watch` does on a save |
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
- `status` also shows the DevTools address with `--devtools`. Per
  script, it gives active or not, the other tabs it is active on, and
  counts of its menu commands, stored values and errors that are not
  zero.
- `menu <label>` piped in while none is registered yet waits a moment
  for a script that is still loading. Typed at the prompt, it answers
  at once.
- A read waits out the page's write batching first, so `menu Bump`
  followed by `values` prints what the command just stored rather than
  what was there before it.
- Stored values belong to the script, so all tabs see the same ones.

### Checking scripts: `match` and `validate`

On their own, with files:

- `sm-dev match <script>... <url>...` says whether each script would
  run on each URL, with all rules that matched it (`Matched by:`) or
  excluded it (`Excluded by:`). A `start` command line works with
  `match` in its place.
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
| `accept [text]`, `dismiss` | Answers an open dialog (see [Page dialogs](#page-dialogs)) |

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
- `status` lists the tabs first, then the scripts on the current tab.
- `status` and `scripts` give each script a line saying whether it runs
  on the current tab, and on which others:
  - The list's heading names the tab:
    `Scripts (with status on active tab T1):`.
  - Each script's line: `Active`, `Active (Also active on T2,T4.)`, or
    `Not active (Active on T2.)`.
  - With no tabs open, there is no heading note and no line.
- Per tab:
  - `menu T2` lists T2's commands, and `menu T2.M1` fires one there
    without switching tabs. `menu all` shows all tabs in turn, each
    under a `Tab T<n>: <url>` heading.
  - `values T2` shows the scripts running on T2. `values all` is all
    scripts' values, as `values` alone is.
  - `scripts T2.3` picks script 3 and tab T2 together.

### Tabs the page opens

A tab the run's tab opens gets the loaded scripts too, as it would
under the extension, where each one's `@match` decides.

- Covered: links and `window.open` calls, `GM_openInTab`, and tabs
  those tabs open in turn.
- Tabs you open yourself are left alone, unless you open them from a
  controlled tab's link (Ctrl-click, middle-click), which gives them
  that tab as their opener.
- A followed tab's lines, its page output and the harness's reports
  alike, are prefixed with its name, as in `[T2]`.
- When the run ends, link and `window.open` tabs stay open.
  `GM_openInTab` ones close, as they do in tests, so runs don't pile up
  tabs.
- The harness only sees such a tab once its page has started loading,
  so a `document-start` script can run late there. The run prints a
  note when that may have happened; `document-idle` scripts, the
  default, run on time.

### Tabs without scripts

Tabs can be put in a sticky no-scripts state, to view and compare
unmodified pages, or save one for a spec (`savehtml`).

- `--noscript` on `newtab`, `open` or `reload` enters it; `--script`
  leaves it.
- All pages the tab loads, and all tabs it opens, get no scripts.
- `tabs` marks it `(no scripts)`. It has no badge, and `load` and
  `update` skip it.

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
- With `--devtools`, `tabs` also shows each tab's DevTools page id, as
  `[targetId=… pageId=4]`. Those commands take either id, pasted on its
  own.

### Tab badges

Each tab the run controls gets a badge over its icon in the tab strip,
in the colors the extension's toolbar badge uses:

- The number is how many scripts are in play on the page: the ones
  whose `@match` covers it, plus any that ran there anyway. `0` means
  the tab is controlled, but no script applies.
- Green: all is well. Red: a script reported an error. Orange: a script
  that should run hasn't started yet, or one ran that shouldn't have.
- Grey: the run has ended, or was killed, so nothing streams from this
  tab anymore. Reload it to get the site's own icon back.
  - After a kill it takes a few seconds, or up to a minute in a tab
    that isn't showing, since Chrome slows timers there.
- Not with `--extension`: there, the extension's toolbar badge covers
  the tabs.
- To have only the badge as the tab's icon, the site's own icon links
  get their `rel` renamed (see
  [What is and isn't faithful](#what-is-and-isnt-faithful)).

### Page dialogs

A script's `alert`, `confirm` or `prompt` is left open and reported in
the stream, rather than being answered automatically.

- In a browser on screen, answer it there.
- Or type `accept` (a prompt's text after it) or `dismiss`. This works
  in a headless browser too.
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
takes a tab first (`T2`, `targetId=…`, `pageId=…`), or acts on the
current one.

| Run command | What it does |
| --- | --- |
| `click <selector>`, `hover <selector>` | A real mouse click or hover, scrolled into view. With several matches, the first |
| `click <selector> --button right --modifiers Shift --count 2` | A right or middle click, with keys held, or a double (`--count 2`) or triple click |
| `click <selector> --at 300,12`, `hover <selector> --modifiers Alt --at 4,4` | At a point in the element, in pixels from its top left corner, rather than its center. `hover` takes `--modifiers` too |
| `type <selector> <text>` | Types into an element, key by key |
| `type <selector> --file <path>` | Types a file's text into an element, a last line break included |
| `key <keys>...` | Presses keys in order: `key j Shift+ArrowRight Escape` (`keys` works too) |
| `eval <js>` | Evaluates in the page and prints the result |
| `eval --script <js>` | Evaluates in the scripts' world |
| `eval --file <path>` | Evaluates JavaScript from a file |
| `snapshot [selector] [--visible] [--out file]` | The page (or an element) as its accessibility tree, one line per element, each with a ref. `--visible`: only what's on screen. `--out` writes it to a file |
| `screenshot [selector] [--full] <file>` | A PNG of what's showing, of the whole page (`--full`), or of one element |
| `savehtml <file>` | The page's HTML, to replay later (see [Saved pages](#saved-pages)) |
| `probe <selector>... [--html] [--css]` | Which selectors match, and how many |
| `logs` | All console lines and errors the page has had, not only the ones the stream shows |
| `cdp <Method> [params]` | Sends a raw CDP call to the tab and prints the result as JSON (see [`cdp`](#cdp)) |

### Actions

- `click`, `hover`, `type` and `key` wait for the page to settle (see
  [Waiting](#waiting)) before returning, so the next command sees what
  they did. `--nowait` skips that.
- One that opens a dialog returns once the dialog is up; answer it with
  `accept` or `dismiss`.
- `click` and `hover` wait up to 5 seconds for their element to be
  visible, not moving, and not covered by another element (`click`:
  also enabled).
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
- `eval --script` runs in the scripts' world, where a script without
  `@grant none` keeps its globals.
  - It reaches what scripts put on `window`, not their local variables.
  - A `@grant none` script runs in the page's world, so plain `eval`
    reaches it.

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
  - Elements in a frame or a shadow root get none; use their ref.

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

A whole-page `screenshot` gives up after 5 seconds if the browser
hasn't captured the page.

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

- The waits other than a delay give up after 5 seconds, or
  `--timeout-seconds S`, and say what was still busy:
  `T1 did not settle within 5s: 2 requests pending (/api/poll,
  /ads.js); the DOM is still changing (div#ticker)`.
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
- It looks at lines the page and scripts printed since the previous
  command began (not counting a `wait` or a command that only looks),
  so one a click set off while it settled counts. Then at new ones.
- sm-dev's own replies aren't looked at.
- It sees the lines the run's stream shows. The site's own console
  lines, which `logs` shows, aren't among them.
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
  shows its console lines.

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
- At the prompt or on stdin, `start`, `attach`, `stop`, `exit`, `list`
  and `clear --extension` work as on sm-dev's command line. `stop` there leaves
  sm-dev with no run.

`list` prints a table of the runs active on this machine, with the
first few scripts' files and a count of the rest:

```
Run  PID    Uptime  Browser                            Tabs  Scripts
D1   81234  2m      127.0.0.1:9233                     2     a.user.js, b.user.js, c.user.js, (2 more)
D2   81502  1m      127.0.0.1:41234 (owned, headless)  1     a.user.js
```

- Browser is where the run's browser takes CDP connections.
- `owned` marks one the run launched (`--temp-browser`), which closes
  when it ends; `headless`, one without a window.
- `status` says the same on its `Run:` line:
  `connected to owned headless browser 127.0.0.1:41234 (no extension)`.
  - `has SourceMonkey`, `SourceMonkey disabled` or `no extension`
    says whether the real extension is there, for `--extension`.
    Checked each time. It doesn't check "Allow User Scripts".
  - A disabled copy installed from the Chrome Web Store shows as `no
    extension`; one loaded unpacked shows as disabled.
  - The run's first line says it too, after the Chrome version.

### How a run ends

- Prefer `stop` to `--seconds` for a background run, so the run can't
  expire while you're still testing.
- Every run stops itself after 30 minutes with no command sent, unless
  a client is following it. `start --idle-seconds N` changes that, and
  `--idle-seconds 0` turns it off.
- Piping sm-dev's output into something that stops reading (`| head`)
  ends sm-dev.
- Every run's last line says it has ended. From then on, pages loaded
  don't get the scripts. Pages already open keep them until reloaded,
  but nothing from them streams anywhere, and their badge turns grey.

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
- Starting one stops any earlier detached run first, and reuses its
  tab. Runs started without `--detach` are left alone.
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

## DevTools alongside a run

The run's own commands cover most of what a script needs. For the rest
of DevTools (network requests, performance traces, Lighthouse), the
`chrome-devtools` command from Chrome DevTools MCP (a DevTools server
for agents; MCP is Model Context Protocol), installed with
`npm i -g chrome-devtools-mcp`, can reach the run's own tabs with
`start --devtools`:

```sh
sm-dev start sites/x/y.user.js --devtools --detach
# [sm-dev] DevTools: chrome-devtools --sessionId=D1 <tool> <pageId> ...
# [sm-dev] T1 is DevTools page 3
chrome-devtools --sessionId=D1 take_snapshot 3
chrome-devtools --sessionId=D1 click 3 1_2     # an element id from the snapshot
chrome-devtools --sessionId=D1 press_key 3 "Shift+ArrowRight"
chrome-devtools --sessionId=D1 evaluate_script "() => document.title" --pageId 3
```

Using it:

- Each tab's page id is printed as it's found, and shown by `tabs`.
  `status` shows the command to use.
- Most page tools take the page id first; `evaluate_script` takes it as
  `--pageId`.
- The page ids only work with the run's `--sessionId`. DevTools MCP
  tools in an agent use a server of their own, with other numbers.
- The session id is the run's id, unless `--run` named it something
  that isn't hex (as DevTools requires). Then it is a random one,
  printed on the `DevTools:` line.
- A tab whose page id isn't found after several tries is named; reload
  it to try again.

Its lifetime:

- The run starts its DevTools server, and stops it when it ends.
- If a run is killed, `chrome-devtools --sessionId=D1 stop` stops the
  one it left behind.
- Without the `chrome-devtools` command, the run says so and carries on
  without it.
- Not with `--temp-browser` or `--extension`, and not on Windows yet.

Things to know:

- DevTools only sees the run's tabs; your other tabs are hidden from
  it.
- DevTools makes the run's tabs report that they have focus, even when
  they don't, which can hide a script's focus bugs. That's why
  `--devtools` is off by default.
- If one of the run's tabs stops answering DevTools, all DevTools calls
  wait on it. The run says so when that happens.
- `evaluate_script` answers a dialog that opens while it runs with OK.
  Pass `--dialogAction dismiss`, or answer through the run
  (`sm-dev accept`) when a dialog matters.
- To find a tab, the run briefly sets a hidden property on the page's
  `window`, under `Symbol.for('sm-dev')`.

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

### What the fixture provides

| Name | Purpose |
| --- | --- |
| `loadUserscript(path, options?)` | Prepares the file with the real pipeline and attaches it to `page`, before the navigation that should see it |
| `gm` | The scripts' storage, menu commands, and recorded `GM_*` side effects |
| `reports` | `started()`, `skipped()` (with the rule that missed), `errors()` (message and stack) |
| `serveHtml(file, url?, { block? })` | Routes a saved HTML file at its URL, so `@match` and relative URLs behave as on the live site |
| `saveHtml(file)` | Writes the page's current DOM to `file`, for `serveHtml` to replay later |
| `host`, `attachment` | The underlying objects, for anything the others don't cover |

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
    (default: the config's root).

`gm`:

- Storage: `get(key)`, `set(key, value)` (reaches a running script like
  another tab's write), `list()`.
- Menus: `menuCommands()`, `fireMenu(label)`.
- Side effects: `openedTabs()`, `downloads()`, `requests()`,
  `notifications()`, `clickNotification(requestId)`,
  `closeNotification(requestId)`.
- Network control: `failHosts(...hosts)` gives a synthetic 503 for
  those hosts, to force a fallback path. `interceptRequests(fn)`
  answers any request from the test.
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

- The fixture leaves `browser` and `context` to you. A repo that
  attaches to a manually launched browser keeps that logic in its own
  fixture file, and re-exports the harness `test` extended with it.
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

## The extension backend

Everything above runs your script behind a stand-in for the extension.
`--extension` runs it in the real SourceMonkey instead, for what only
Chrome can answer:

- Content security policy, Chrome's own match gating, and cross-tab
  broadcast between real tabs.
- The real identity of a `GM_xmlhttpRequest`: the extension's cookies,
  no `Origin` header, `Sec-Fetch-Site: none`. A request that works from
  a page can still be refused when it comes from the extension, so send
  one real request per endpoint here before building on it.

### Setting it up

The quickest way needs no setup: `--temp-browser` loads the extension
into a throwaway browser for the run.

```sh
sm-dev --temp-browser start my-script.user.js https://example.com/ --extension
```

- It loads the extension from the `dist/` beside sm-dev: the checkout's
  own build, or the copy `pnpm install` took in a repo of userscripts.
- The profile is empty, so the site has no login, and the scripts
  pushed are gone when the run ends (no `clear` needed).
- Starting it takes a few seconds longer than a plain `--temp-browser`.

For a browser that keeps the extension (and your logins):

1. Build SourceMonkey (`pnpm run build`), which writes the unpacked
   extension to its `dist/`.
2. Load it into the browser sm-dev uses: in `chrome://extensions`, turn
   on Developer mode, then "Load unpacked" and pick `dist/`. An
   `--open-browser` profile keeps it from then on.
3. On SourceMonkey's details page there, turn on "Allow User Scripts".
4. Start runs with `--extension`:
   ```sh
   sm-dev start my-script.user.js https://example.com/ --extension --solo
   ```
5. When done, drop the scratch scripts with `sm-dev clear --extension`.

- Your ordinary browser with SourceMonkey installed works too, as long
  as it has a remote-debugging port.
- A Chromium started with `--load-extension=<SourceMonkey dist>` works
  as well, though Google Chrome itself ignores that flag.

### How it works

- `sm-dev start --extension` pushes the script text into the extension
  as a **scratch script**, stored only in the extension.
  - It lands in the "Scratch" collection, and is registered before the
    page opens.
  - The next push of the same file name replaces it in place, keeping
    its stored values.
  - Nothing on disk is scanned.
- What it prints are the entries the script adds to its own Log tab,
  plus the page's console lines.
- `--solo` disables all other collections for the run and restores them
  after, so the scratch script runs without noise from the rest.
- `sm-dev clear --extension` drops all scratch scripts and their stored
  values, and turns solo mode off. If a `--solo` run was killed rather
  than stopped, this is how to get the other collections back; they are
  restored to how they were.

### Differences from the push backend

- `--values` and `--values-file` can't be used: the extension keeps
  its own storage, which the run can't seed.
- Only the script's own text is pushed, not the files beside it. A
  relative `@require` is refused, and a local copy of a remote
  `@require` is not used: the extension fetches the URL.
- No tab badges; the extension's toolbar badge covers the tabs.
- Specs stay on the push backend. For a check that needs the real
  extension, drive it from a spec with SourceMonkey's own test
  fixtures, or by hand with `sm-dev start --extension`.

## What is and isn't faithful

### Faithful

Under the push backend (the default):

- Header validation, URL matching, `@require` scope and local
  overrides, `@grant` gating, world choice.
- `@run-at` order, apart from the early-start cases under
  [Known differences](#known-differences-under-the-push-backend).
- `GM_*` storage semantics, including the write batching and broadcast
  to other pages running the script.
- `@connect` gating of `GM_xmlhttpRequest`.
- Which of a script's messages the web page can see or fake.
- Error attribution to file and line.

### Close, but not the same

- **`GM_xmlhttpRequest`** goes out from Node.
  - The browser's cookies for the target are copied onto it, unless
    the request is `anonymous` or sets its own `Cookie` header.
  - Any header the script asked for is sent.
  - A server sees a request from Node, not from the extension: no
    `Sec-Fetch-Site: none`, cookies are not re-attached after a
    cross-origin redirect, and a `Set-Cookie` in the response does not
    reach the browser.
- **`GM_info.userAgentData`** is read from the browser once a page has
  reached a secure origin (`https:`, `localhost`, `file:`). A script
  loaded before that sees `null` there.
- **`GM_openInTab`** opens a real page in the same context, born at its
  URL as Chrome's would be.
  - In the fixture no scripts are injected into it; the extension would
    inject whatever matches the new page. (`sm-dev start` does, see
    [Tabs the page opens](#tabs-the-page-opens).)
  - It is closed when the attachment is disposed, where the extension
    would leave it open, so a test run leaves no tabs behind.
  - It needs a context that belongs to a browser, so it fails under
    Playwright's `launchPersistentContext`.
- **`GM_download`** fetches the file from Node into a directory of the
  host's choosing (the fixture uses the test's output directory).
  - It reports the extension's events, numbering a taken name as Chrome
    does.
  - There is no download bar or prompt, and no `onprogress`.
- **`GM_notification`** shows nothing. A `timeout` still fires
  `ondone`, and a test delivers the click.
- **Favicons under `sm-dev start`** are not as the site left them: its
  icon links have `rel="sm-set-aside-icon"`, and the badge's own
  `rel="icon"` link is added. A script that reads or changes the
  favicon sees that. The fixture leaves them alone.

### Known differences under the push backend

These apply to `sm-dev start` and to specs alike.

- Scripts run in the top frame only. A script meant for an iframe
  (`@match` of the frame's URL, no `@noframes`) never starts there.
- `@run-at document-start` code (and its `@require`s) can run before
  `<html>` exists, and `document-body` code before `<body>` does.
- The isolated world enforces the page's Trusted Types policy, so a
  granted script setting `innerHTML` fails on sites like YouTube. The
  extension's `USER_SCRIPT` world is exempt.
- A `GM_setValue` made just before the page unloads (a "save and
  reload" button, a `beforeunload` handler) can be lost.

### Not faithful: use the extension backend

- The request identity of `GM_xmlhttpRequest` as a site's edge sees it.
- Chrome's own download manager and notification UI.
- Chrome refusing a registration, and page CSP effects on `GM_addStyle`
  in the page world.
- Anything about the extension's UI: badge, collections page, Log tab.

## Troubleshooting

- **"skipped on <url>: No @match or @include covers this URL"**, or
  another rule named there: the script would not run there in the
  extension either. Broaden the pattern or change the URL; see
  `sm-dev match`.
- **`GM_getValue is not defined`**: the script uses an API it did not
  `@grant`. The extension behaves the same way.
- **The script sees `undefined` for a page global**: it is in the
  isolated world. Reading page globals needs `@grant none` or
  `unsafeWindow`.
- **A `@require` fails to load**: the harness resolves it the way the
  extension does, including local overrides. The message names the URL
  and the reason.
- **`sm-dev start` hangs at connect**: a tab in the browser is showing
  a dialog. The run names it; answer the dialog or close the tab (see
  [Page dialogs](#page-dialogs)).
- **The other collections stay disabled after `--solo`**: the run was
  killed. `sm-dev clear --extension` restores them.
