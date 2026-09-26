# Testing userscripts with the SourceMonkey harness

See [harness-design.md](harness-design.md) for how it works and why.

For a repo of userscripts that wants to probe sites, run a script under
development, and write regression tests, using SourceMonkey's own code
for the manager's half of the picture.

## What you get

- **The manager's semantics without the extension.** Your script runs
  behind SourceMonkey's real injected code: the header is validated,
  `@match` / `@include` / `@exclude` decide whether it runs, `@run-at`
  is honored, `@require` files load (with local copies overriding
  GitHub URLs the way the extension does), `@grant` decides which
  `GM_*` names exist, and the script lands in the same world (page or
  isolated) it would in Chrome.
- **Real `GM_*` behavior.** Storage with the real value codec and
  cross-page broadcast, `GM_xmlhttpRequest` gated by `@connect`, menu
  commands you can fire from a test, tab opens and notifications you
  can inspect.
- **The script's own reports.** Whether it started, was skipped for a
  URL miss, or threw, attributed the same way the extension's Log tab
  does.
- **A command-line loop** for interactive development, and a
  Playwright fixture for specs.
- **A switch to the real extension** for the cases only Chrome can
  answer.

## What you need

- Node 22+ and pnpm.
- A Chromium that Playwright can reach. Either let Playwright launch
  one, or start one yourself with a remote-debugging port and connect
  to it (the `userscripts` repo does the latter so Google sign-in
  works).
- For the extension backend only: that browser started with
  `--load-extension=<path to SourceMonkey's dist>`.

## Install

```sh
pnpm add -D github:jshute96/SourceMonkey#v0.x
```

Two things pnpm needs to be told, in your repo:

```yaml
# pnpm-workspace.yaml — SourceMonkey builds itself on install, and pnpm
# runs a dependency's build only for packages the project allows. The
# key is the dependency spec as the lockfile records it; pnpm prints
# the one it wants if this is wrong.
allowBuilds:
  "sourcemonkey@git+https://github.com/jshute96/SourceMonkey.git#<sha>": true
```

```json
{ "dependenciesMeta": { "sourcemonkey": { "injected": true } } }
```

The second matters when you install from a checkout on disk
(`file:../SourceMonkey`, while working on both):

- A plain symlink would leave the package resolving its own Playwright
  instead of yours, and Playwright refuses to run with two copies
  loaded.
- `injected` copies it into your project's store instead, where the
  peer resolves to your copy.
- Re-run `pnpm install` after rebuilding SourceMonkey, since the copy
  is taken at install time.

Writing specs against it:

- The package is written as ES modules (ESM: files that use `import` /
  `export`, rather than CommonJS's `require()` / `module.exports`).
- A CommonJS spec can't `require()` it reliably, so write specs and
  fixtures as ESM: name them `.mjs`, or set `"type": "module"` in
  `package.json` so plain `.js` files count. Playwright runs either.
- Type declarations ship with the package, so a TypeScript spec gets
  types without extra setup. Keep `skipLibCheck` on, since some
  declarations mention Chrome's extension types.

## The interactive loop: `sm-dev`

`sm-dev` is the harness's command-line tool.

- Installing the package puts it on your project's path: it is the
  package's `bin`, so pnpm links it into `node_modules/.bin`. Run it as
  `pnpm sm-dev …` or `pnpm exec sm-dev …`.
- In a SourceMonkey checkout it is `scripts/sm-dev`. It runs what
  `lib/` has and never builds it; `pnpm run build` does.

It connects to a running browser over CDP (`--cdp 9233`, a port on
this machine, or the `SM_DEV_CDP` environment variable) and
drives it. Everything it prints is plain text meant to be read by a
person or an agent.

Help:
- `sm-dev --help` lists everything: the commands, their flags, and the
  commands a run takes.
- `sm-dev help start` (or `sm-dev start --help`) shows one command and
  only the flags it takes.
- It covers a run's typed commands too: `sm-dev help status tabs`.
- `--help` (or `-h`) anywhere on a line shows the help for each
  command on it, once each, and runs none of them.
- A mistake in how a command was typed prints `ERROR:` and its
  message, not the help, and fails the command.

| Command | What it does |
| --- | --- |
| `sm-dev start <script.user.js> [url]...` | Opens a tab at each URL (default: the first URL the script's `@match` implies), injects the script as it is on disk, and streams the script's console lines, errors, and start / skipped / error reports until Ctrl-C, `quit` or `sm-dev stop`, or for `--seconds N`. |
| `sm-dev start ... --watch` | Same, and on every save of the script or a `@require`d file, re-injects it and reloads the tabs it runs in or now matches, all at once. The typed `update` does the same on demand. |
| `sm-dev start a.user.js b.user.js` | Injects several scripts into the same page, for interaction tests. |
| `sm-dev start ... --detach` | Returns once the pages have settled (see [Waiting](#waiting)), and leaves the run going in the background (see [Detached runs](#detached-runs)). |
| `sm-dev match <script>... <url>...` | Says whether each script would run on each URL, with all rules that matched it (`Matched by:`) or excluded it (`Excluded by:`). A `start` command line works with `match` in its place. |
| `sm-dev validate <path>...` | Checks script validity (header, `@require`, syntax) over files, directories or script URLs, with the message the extension would show. |
| `sm-dev list` | Lists the runs active on this machine in a table: id (`D1`), pid, uptime, browser, how many tabs, and the scripts' files (the first few, and a count of the rest). |
| `sm-dev <command>` | Runs any command a run takes (`sm-dev eval document.title`) in the run from another shell, and prints its output (see [Runs in the background](#runs-in-the-background)). |
| `sm-dev send <command>` | The same, and also takes several commands, one per line, or reads them from stdin. |
| `sm-dev stop`, `--all` | Ends the run as `quit` would, or all runs. |

- For `start` and `match`, arguments ending in `.user.js` are scripts,
  and the rest are URLs. They and the flags can come in any order.
  - Each is taken once, however often it's given.
- A URL with no scheme gets `http://`, unless it's a local path: it
  starts with `/`, `./` or `../`, names a file that exists, or starts
  with a directory that does (and has no `.` in its name, so
  `example.com/x` stays a host). A path becomes a `file://` URL.
- `validate` and `match` also take a script by its `http(s)` URL, and
  fetch it. `start` needs a file.

Every command exits 0 on success, 1 when a check fails (a script is
invalid, a URL doesn't match) or the command fails, and 2 when it was
typed wrong.

Options for every command:

- `--root DIR` names the repo root, searched for local copies of
  `@require` URLs the way the extension searches a collection's
  directory. Defaults to the current directory.
- `--local DIR` adds another directory to that search; repeatable.

Options for the commands that act on a run (its commands, `send`,
`stop`, `start`):

- `--run ID` names the run. It's needed only when several are active;
  otherwise the command says so, and lists them.
  - With `start`, it's the ID for the new run: `D` and then letters,
    digits, `_` or `-` (`Dmain`). A run already using it is stopped
    first.

Options for the browser commands (`start`, `clear`):

- `--cdp URL or port` names the browser to connect to: a URL, a
  `host:port` (`http://` is added), or just a port on this machine
  (`9222` or `:9222`). An IPv6 host needs brackets (`[::1]:9222`).
  Defaults to the `SM_DEV_CDP` environment variable, which takes the
  same forms, then port 9233.
- `--launch` starts a Chromium instead of connecting to one, and
  `--headed` shows it. Useful when no browser is running and the page
  needs no login.

Other `start` flags:

- `--all`, with several scripts, opens each one's default page, one
  tab per distinct page, instead of only the first script's. The
  extra tabs are T2, T3 (see [Several tabs](#several-tabs)), and stay
  open when the run ends. Scripts it opened no tab for are listed at
  the end, with the reason. Works with `--extension` too, where only
  page output carries the tab's name (the extension's Log entries
  don't say which tab). It can't be combined with a URL.
- `--noscript` starts with no scripts at all, on a blank page or the
  URLs given, as a browser to drive with the typed commands. The flags
  that act on scripts (`--all`, `--values`, `--watch`)
  and `--extension` can't be combined with it.
- `--notab` opens no tab at startup. `newtab` opens one later, and
  the first it opens is T1. That tab isn't one a later run takes over
  (see [Which tab `start` uses](#which-tab-start-uses)). With
  `--extension`, the scripts just run in whatever pages you browse to,
  and after a `--watch` save you reload them yourself. It can't be
  combined with a URL or `--all`.
- `--values '{"key": 1}'` seeds `GM_*` storage before the script runs.
- `--page-errors` also shows the page's own errors (see
  [What the output looks like](#what-the-output-looks-like)).
- `--seconds N` stops after N seconds, as a safety limit; without it
  the stream runs until Ctrl-C, `quit` or `sm-dev stop`.
  - To wait for a page or a script, use `wait` (see
    [Waiting](#waiting)) rather than a guess at a time.
  - For a longer session, leave it off and end the run with `sm-dev
    stop`, so it can't expire mid-test.
- `--nowait`: don't wait for the pages to settle before continuing.
  It still waits for the scripts to start.
- `--extension` uses the real extension in that browser instead of
  the built-in stand-in (see below); `--solo` silences the other
  collections for the run.
- `--devtools` starts a Chrome DevTools server for the run, for
  DevTools' own tools on its tabs (see
  [DevTools alongside a run](#devtools-alongside-a-run)).
  `SM_DEV_DEVTOOLS=1` makes it the default, and `--nodevtools` turns it
  off again.

### Which tab `start` uses

In a connected browser, `start` opens a new tab, unless the tab showing
in its window is one an earlier run opened and that run has ended.
Then it takes that tab over. So re-running with the old tab still
selected reuses it rather than piling up tabs.

- The tabs runs opened are recorded in `run-tabs.json` in
  `sm-dev-runs-<user name>` in the system temp directory, with the process
  that owns each.
- Each run only touches the entries for its own browser, so parallel
  sessions on other ports keep theirs.
- A tab whose run is still going is never taken.
- With several windows open, each window's showing tab counts, and the
  first free one found is taken.

### Tabs the page opens

A tab the run's tab opens gets the loaded scripts too, as it would
under the extension, where each one's `@match` decides:
- Covered: links and `window.open` calls, `GM_openInTab`, and tabs
  those tabs open in turn.
- Tabs you open yourself are left alone, unless you open them from a
  controlled tab's link (Ctrl-click, middle-click), which gives them
  that tab as their opener.
- Tabs are named `T1` (the run's own), `T2` and so on. A followed
  tab's lines, its page output and the harness's reports alike, are
  prefixed with its name, as in `[T2]`.
- The typed commands can list these tabs and act on any of them (see
  [Several tabs](#several-tabs)).
- When the run ends, link and `window.open` tabs stay open.
  `GM_openInTab` ones close, as they do in tests, so runs don't pile
  up tabs.
- The harness only sees such a tab once its page has started loading,
  so a `document-start` script can run late there. The run prints a
  note when that may have happened; `document-idle` scripts, the
  default, run on time.

### Marked tabs

Each tab the run controls gets a badge over its icon in the tab
strip, in the colors the extension's toolbar badge uses:
- The number is how many scripts are in play on the page: the ones
  whose `@match` covers it, plus any that ran there anyway. `0` means
  the tab is controlled, but no script applies.
- Green: all is well. Red: a script reported an error. Orange: a
  script that should run hasn't started yet, or one ran that
  shouldn't have.
- Grey: the run has ended, or was killed, so nothing streams from
  this tab anymore. Reload it to get the site's own icon back.
  - After a kill it takes a few seconds, or up to a minute in a tab
    that isn't showing, since Chrome slows timers there.
- Only without `--extension`: there, the extension's toolbar badge
  covers the tabs.
- To have only the badge as the tab's icon, the site's own icon links
  get their `rel` renamed (see
  [What is and isn't faithful](#what-is-and-isnt-faithful)).

### Page dialogs

A script's `alert`, `confirm` or `prompt` is left open and reported in
the stream, rather than being answered automatically:

- In a browser on screen, answer it there.
- Or type `accept` (a prompt's text after it) or `dismiss`.
- In a headless run with no typed commands, nothing could answer it,
  so it is dismissed and reported.
- While one is open, the page's JavaScript is stopped, so `menu`,
  `set`, `reload` and `open` refuse until it is answered, as do `load`
  and `update` for a dialog in any tab. `reload all` skips that tab and
  says so.
- A dialog in a tab the run doesn't use is left alone, for you to
  answer.
- A tab already showing a dialog when `sm-dev start` starts stops it
  connecting: nothing in that tab answers until the dialog closes. The
  run names the tab and waits; answer the dialog or close the tab to
  continue, or Ctrl-C to abort.

### Driving the script while it runs

A script's interesting moments are not all at startup: a menu command
may need firing twice, or only once some state exists, and what the
script stored is worth reading between steps. So `start` also reads
commands from its own input while it streams.

| Typed command | What it does |
| --- | --- |
| `scripts` | Lists the loaded scripts, numbered (`script` works too) |
| `scripts <script>` | Picks the script `get` and `set` act on (the first, until changed) |
| `load <file>` | Loads another script from disk, and reloads the tabs it matches |
| `update [script]` | Re-reads one script from disk, or all (with no argument, or `all`), as `--watch` does on a save. Only a script whose file or local `@require`s were modified since it was read counts, so touching a file forces it. Reloads, all at once, the tabs where an updated script runs or where its rules now match. Stored values are kept |
| `status [what]` | Prints the page's URL, any open dialog, and each script's state: started or skipped, and counts of its menu commands, stored values and errors (those that are not zero). Also takes a script, a tab (`T2`, `T2.3`) or `all` |
| `menu` | Lists the registered menu commands, numbered `M1`, `M2`, under the script that registered each |
| `menu <M-number or label>` | Fires one, as picking it from the toolbar would. Piped in while none is registered yet, it waits a moment for a script that is still loading |
| `values [script]` | Prints what every script has stored, or just one script |
| `get <key>` | Prints one stored value |
| `set <key> <json>` | Stores a value, as another tab's write would: a running script sees it and its change listeners fire |
| `tabs [tab]` | Lists the controlled tabs, or picks the one the page commands act on (see [Several tabs](#several-tabs)) |
| `newtab [page]` | Opens a new tab with the scripts, picks it and brings it to the front. `newtab all` opens one per script's default page. `newtab --noscript [page]` opens one the scripts stay out of (see [Driving and reading the page](#driving-and-reading-the-page)) |
| `reload [tab]` | Reloads the page, or another tab's. `reload all` reloads every tab at once. `--noscript` / `--script` switch the tabs' scripts off or back on first |
| `open [page]` | Navigates to a URL, or to a script's default page: the selected script's when bare, or one by number (`open 2`, or `open T2.3` in T2). `open all` is `newtab all`. `--noscript` / `--script` switch the tab's scripts off or back on (see [Driving and reading the page](#driving-and-reading-the-page)) |
| `focus [tab]` | Brings the tab to the front, un-minimizing its window |
| `accept [text]`, `dismiss` | Answers an open dialog (see [Page dialogs](#page-dialogs)) |
| `help [command]`, `quit` | The list, or one command's entry (`help status`); and stop |

A `<script>` is its number in the `scripts` list, its path, file name or
`@name`, or a piece of its name or path that no other loaded script
shares.

A `[page]` is a URL, or a script's number for its default page: the
first page its `@match` names. Only a number counts as a script there,
so a URL is never mistaken for one.

#### Driving and reading the page

These act on a tab's page, as a person would, and read it back. Each
takes a tab first (`T2`, `targetId=…`, `pageId=…`), or acts on the
current one.

| Typed command | What it does |
| --- | --- |
| `click <selector>`, `hover <selector>` | A real mouse click or hover, scrolled into view. With several matches, the first |
| `type <selector> <text>` | Types into an element, key by key |
| `key <keys>...` | Presses keys in order: `key j Shift+ArrowRight Escape` (`keys` works too). Takes the standard key names, case-insensitive (`home`, `ctrl+end`), and common short ones (`ctrl`, `cmd`, `esc`, `pgdn`, `del`) |
| `eval <js>` | Evaluates in the page and prints the result: JSON, or an element's or function's description |
| `eval --script <js>` | The same in the scripts' world, where a script without `@grant none` keeps its globals |
| `snapshot [selector] [--visible] [--css] [--out file]` | The page (or an element) as its accessibility tree, one line per element, each with a ref. `--visible`: only what's on screen. `--css`: a CSS selector for each element. `--out` writes it to a file |
| `screenshot [selector] [--full] <file>` | A PNG of what's showing, of the whole page (`--full`), or of one element |
| `savehtml <file>` | The page's HTML, for a spec to replay with `serveHtml` |
| `probe <selector>... [--html]` | Which selectors match, and how many; `--html` prints each first match |
| `logs` | Every console line and error the page has had, not only the ones the stream shows |

- `click`, `hover`, `type` and `key` wait for the page to settle (see
  [Waiting](#waiting)) before returning, so the next command sees what
  they did. `--nowait` skips that.
- One that opens a dialog returns once the dialog is up, and says so;
  answer it with `accept` or `dismiss`.
- Keys go to the page, not to Chrome, so Chrome's own shortcuts
  (reload, back, zoom) do nothing.
  - Escape doesn't leave fullscreen either. When the page is still
    fullscreen after one, `key` says so; exit with
    `eval document.exitFullscreen()`.
- A whole-page `screenshot` gives up after 5 seconds if the browser
  hasn't captured the page.
- Anywhere a command takes a selector, it also takes a ref from the
  latest `snapshot`: `click e4` (or `ref=e4`, `[ref=e4]`). Playwright
  makes the refs; `f2e4` is one it numbered for a frame.
  - `[cursor=pointer]` marks an element the mouse shows a hand over:
    one that looks clickable though it isn't a link or button.
  - A command says what a ref named, from its snapshot line:
    `Clicked e5 (link "past")`.
  - A ref names the same element in later snapshots, until its role or
    name changes (a button relabeled after a click gets a new one).
  - Only refs in the latest snapshot work, so take a new one after the
    page changes. A reload or navigation drops them all; a route change
    within the page (a single-page app's) doesn't.
- `--css` suggests a short selector that finds just that element,
  passing over ids and classes that look generated (`css-1x2y3z`).
  - Elements in a frame or a shadow root get none; use their ref.
  - On a large page it takes a while; add `--visible` or a selector.
- `--visible` goes by the viewport: content scrolled out of sight
  inside a scrolling box on screen still counts.
- A word starting with `--` that isn't one of the command's flags is
  refused, except in free text (`eval`'s JavaScript, `type`'s text, a
  menu label).
- Quote a selector or text with spaces: `click '.athing .title a'`,
  `type input 'hello world'`. From another shell, quote `#` too,
  since the shell reads it as a comment: `sm-dev click '#submit'`.
- Typed, a quote that starts a word groups it and is taken off, as in
  a shell. One inside a word stays, so a selector keeps its own:
  `probe a[href="x.html"]`. From another shell, the shell's quoting is
  final.
- `eval` takes the rest of the line as JavaScript, quotes and all, or
  several lines as a block (see below). A promise prints what it
  settles to.
- From another shell, files are named from that shell's directory.
- `eval --script` reaches what scripts put on `window`, not their local
  variables. A `@grant none` script runs in the page's world, so plain
  `eval` reaches it.
- A saved page has the scripts' changes in it, and a spec replaying it
  would apply them twice. For one to replay, open the page with
  `newtab --noscript <url>` and save that.

#### Tabs without scripts

Tabs can be opened in a sticky no-scripts state, so you can view and
compare unmodified pages, or save one for a spec (`savehtml`).
- Every page the tab loads, and every tab it opens, gets no scripts.
- `tabs` marks it `(no scripts)`. It has no badge, and `load` and
  `update` skip it.

To enter (or leave) no-scripts state, use `--noscript` (or `--script`)
on `newtab`, `open`, or `reload`.

#### Several tabs

Once the page opens tabs of its own (see
[Tabs the page opens](#tabs-the-page-opens)), each kind of thing has its
own style of name, so they can't be mixed up:
- Scripts are `1`, `2`, as `scripts` lists them.
- Tabs are `T1`, `T2`, as `tabs` lists them.
- Menu commands are `M1`, `M2`, as `menu` lists them for one tab.
- A `T<n>.` prefix names one on another tab: `T2.3` is script 3 there,
  `T2.M1` that tab's first menu command.
- Tabs and menu commands always take their letter: `2` alone means
  script 2, and typed where a tab or menu command belongs, it gets a
  hint (`Did you mean T2?`).

Each tab's CDP target id is shown with it, for a debugging session
alongside the run to name the same tab:
- As `[targetId=61023580282B1D684FAF4072C201AB51]`, at the end of the
  line the run prints when it opens or finds the tab, and in `tabs`.
- It's the `targetId` CDP's `Target.*` calls take, and in a browser
  you connected to, the `id` in its `/json/list`.
- A command that takes a tab alone (`tabs`, `reload`, `focus`) also
  takes the id: whole, its first 6 or more characters, or pasted as
  shown, `targetId=` and all.
- With `--devtools`, `tabs` also shows each tab's DevTools page id,
  as `[targetId=… pageId=4]`. Those commands take either id, pasted
  on its own.

How the commands treat tabs:
- `tabs T2` picks the tab that `status`, `menu`, `reload`, `open`,
  `focus`, `accept` and `dismiss` act on. It starts as T1. If the
  picked tab closes, the first one still open takes over.
- Any tab can be closed, T1 included, and the run notes it. With none
  left, `tabs` says `No active tabs`, `status` still lists the scripts
  with their stored values and errors, and `newtab` opens another.
- `newtab [page]` opens a tab of your own with the scripts, picks it
  and brings it to the front. Unlike one you open in the browser, it
  is controlled from the start. It stays open when the run ends.
- `newtab all` (or `open all`) opens one tab per script's default
  page, as `--all` does at startup, and leaves the picked tab as it
  was. Scripts it opened no tab for are listed at the end.
- `tabs` lists each tab's URL, which tab opened it, any open dialog,
  and the scripts running there, with `*` on the picked tab and, under it,
  on the selected script.
- `status` covers the picked tab. A script also running on other tabs
  gets an `Also active on N other tabs` line, and the tab list follows
  at the bottom.
- `status all`, `menu all` and `values all` show every tab in turn,
  each under a `Tab T<n>: <url>` heading.
- `menu T2` lists T2's commands, and `menu T2.M1` fires one there
  without switching tabs.
- `values T2` shows the scripts running on T2. Stored values belong to
  the script, so every tab sees the same ones.
- `scripts T2.3` picks script 3 and tab T2 together.

When both input and output are a terminal, commands are typed at a
`> ` prompt:

- Line editing and history work as in most shells (arrows, Ctrl-A / Ctrl-E,
  Ctrl-U), and Tab completes a command name.
- Output streamed while you type is printed above the prompt, which is
  then redrawn with what you had typed so far.
- Ctrl-C clears a half-typed line. On an empty line, Ctrl-C or Ctrl-D
  stops the run, except that Ctrl-C inside an `eval` block drops the
  block.
- A running command can't be cancelled. Ctrl-C while one runs says so,
  and a second Ctrl-C stops the run.
- Ctrl-Z suspends sm-dev and `fg` resumes it, as in a shell. The browser
  keeps running meanwhile, but script calls that sm-dev answers, such as
  `GM_xmlhttpRequest`, wait until it is resumed.

`eval` can take several lines of JavaScript as a block:

```
> eval T2 --script {{
... const rows = [...document.querySelectorAll('.athing')];
... rows.map((r) => r.id)
... }}
```

- `{{` at the end of the line opens the block, and a line of just `}}`
  closes it. A lone `}` is JavaScript, so it doesn't end the block.
- A tab and flags go before the `{{`.
- Only `eval` takes a block; `{{` after another command is refused.
- The prompt shows `... ` while a block is open.

A read waits out the page's write batching first, so `menu Bump`
followed by `values` prints what the command just stored rather than
what was there before it.

Piping works as well as typing, for a fixed sequence:

```sh
printf 'menu Bump\nvalues\nquit\n' | sm-dev start sites/x/y.user.js --seconds 30
```

Piped input takes `eval` blocks too. Blank lines are skipped, and a
line starting with `#` is a comment. Input that ends inside a block
reports it rather than running half of it.

### Waiting

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

A tab has settled when all of these hold together for 200ms:
- The document has loaded.
- Each script the page runs whose rules cover it has started (or been
  skipped, or thrown).
- None of its scripts' `GM_xmlhttpRequest`s is in flight, apart from
  ones open over 3 seconds.
- None of the page's requests is in flight, apart from ones open over
  3 seconds (a socket, a stream, a long poll).
- The DOM hasn't changed.
- Then the page's main thread has a moment with nothing to do.

Timers aren't waited for: they are set up to run later. A short one
that matters changes the DOM when it fires, which the 200ms catches.
For a script that finishes later than that, print a line when done and
`wait log` for it.

Limits of the heuristic:
- A request over 3 seconds that the page is still waiting on (a slow
  API call) counts as long-lived, so the page can settle before its
  results show. `wait selector` for them instead.
- A resource that never finishes loading holds the page's `load`
  event, so the page never settles.

Waits of their own:
- `start` settles its tabs before taking commands (or `--detach`
  returning). `start --nowait` skips that.
- `click`, `hover`, `type`, `key`, `reload`, `open` and `newtab` settle
  the tabs they touch before returning. Each takes `--nowait`.

Giving up:
- The waits other than a delay give up after 5 seconds, or
  `--timeout-seconds S`, and say what was still busy:
  `T1 did not settle within 5s: 2 requests pending (/api/poll,
  /ads.js); the DOM is still changing (div#ticker)`.
- An explicit `wait` that gives up fails, so a line of several commands
  (or a `send` list, or commands piped to `send -`) stops there, and
  says the rest weren't run. Input piped into `start` itself goes on. A
  command's own wait that gives up only says so, since the command
  itself worked.
- `wait log /pattern/flags` is a regular expression; any other text
  is a plain substring. Quotes around the whole text are removed first,
  so `wait log "/abc/"` is a regex too. For the literal characters, use
  `wait log /\/abc\//`.
- `wait log` looks at lines the page and scripts printed since the
  previous command began (not counting a `wait` or a command that only
  looks), so one a click set off while it settled counts. Then at new
  ones. sm-dev's own replies aren't looked at.

### Runs in the background

A run started in the background (by an agent, or with `&`) has no
terminal to type into. Other shells give its commands to `sm-dev`
directly instead:

```sh
sm-dev start sites/x/y.user.js --detach   # see Detached runs, below
sm-dev list
sm-dev menu Bump                          # the command's output
sm-dev values --run D1                    # when several runs are active
sm-dev stop                               # or stop --run D1, or stop --all
```

`list` prints a table:

```
Run  PID    Uptime  Browser         Tabs  Scripts
D1   81234  2m      127.0.0.1:9233  2     a.user.js, b.user.js, c.user.js, (2 more)
```

- Runs are named `D1`, `D2`, like tabs (`T1`) and menu commands (`M1`).
  A number is reused once its run has ended. `start --run Dname`
  picks a name instead.
- Each command prints its output, and returns as soon as it is done:
  - A command that loads a page (`reload`, `open`, `newtab`, `load`)
    is done once the tab's scripts have started and their top-level
    code has run, so that output is in the reply.
  - `menu` and `eval` include what the handler or expression printed
    while it ran.
- Output a script prints later, from a timer or event, only goes to
  the run's stream, and its log file (see [The log file](#the-log-file)).
  `sm-dev logs` shows its console lines.
- A command that only inspects (`status`, `values`, `snapshot`,
  `logs`, and so on) answers the sender alone. Ones that change
  something (`reload`, `click`, `menu Bump`) also show in the run's
  stream.
- A command exits 0 when the run answered, 1 when an explicit `wait`
  gave up, and 2 when it was typed wrong (`ERROR:`). Otherwise read its
  output for the result.
- `accept` and `dismiss` answer a page dialog, so a dialog waits for
  an answer even in a headless browser.
- `stop` ends a run as `quit` does. One that doesn't respond is
  killed.
- Prefer `stop` to `--seconds` for a background run, so the run can't
  expire while you're still testing.
- Piping a run's output into something that stops reading (`| head`)
  ends the run.

Every run's last line says it has ended. From then on, pages loaded
don't get the scripts; pages already open keep them until reloaded,
but nothing from them streams anywhere, and their badge turns grey.

#### Detached runs

`start --detach` is the way for an agent to start a background run: no
`&`, and no guessing how long to wait before the first command.

```sh
sm-dev start sites/x/y.user.js https://example.com/ --detach
# [sm-dev] Run D1 now running detached, with idle timeout 30 minutes
# [sm-dev] Output log: /tmp/sm-dev-logs-you/sm-dev-20260926-063756-629.log
sm-dev eval 'measure()'
sm-dev stop
```

- It returns once the run would take its first command: the pages
  have settled (see [Waiting](#waiting)), or it gave up on them. Its
  output until then is printed, then the lines above.
- It exits with the run's code if the run ends before that (a script
  that doesn't parse, no browser to connect to).
- Starting one stops any earlier detached run first, and reuses its
  tab. Runs started without `--detach` are left alone.
  - `--new` leaves the earlier ones going, and starts another beside
    them.
  - `--run Dname` stops only the run named that, if one is going.
- It stops itself after 30 minutes with no command sent.
  `--idle-seconds N` changes that, and `--idle-seconds 0` turns it
  off. `--seconds` still sets a limit from the start.
- Its output goes only to its log file (see
  [The log file](#the-log-file)), so output a script prints between
  commands is only there.

#### The log file

Every run keeps a log of its stream, to tail for what the scripts and
page print on their own, or to look back at what happened when:
- It's `/tmp/sm-dev-logs-<user>/sm-dev-<timestamp>.log`, with a
  timestamp starting each line. It's kept after the run ends.
- Its name is printed as `Output log: ...`: first thing in a foreground
  run, once a detached one has started, and at the end of a line that
  started a run for its commands.
- `sm-dev-D1.log` beside it links to the latest log of the run named
  `D1`.
- A detached run's output goes only there. A run in the foreground
  prints to the terminal as usual, and copies each line to the log.
- It's what the page and scripts do, not all the replies:
  - Commands that change something show where they happened, with
    their replies. In a detached run, and for those typed at a
    foreground run's prompt, as `> command`. One sent to a foreground
    run from another shell shows as `Sent from another shell: ...`.
  - Commands that only look (`status`, `snapshot`) and their replies
    are left out.

#### Several commands on one line

`--` separates commands, which run in order:

```sh
sm-dev start sites/x/y.user.js https://example.com/ --detach -- eval 'measure()' -- key x -- eval 'measure()'
sm-dev start sites/x/y.user.js -- menu Bump -- values
```

- Each one's output is headed by the command (`> menu Bump`).
- They stop at the first that fails, as a shell's `&&` would.
- `start` can only come first, so the line holds at most one run of
  its own, and `start` never picks up a `--run` meant for another
  command.
- `--run` carries on to the commands after it, and `start` sets it to
  the run it started.
- Without `--detach`, a run a `start` began for the commands after it
  is stopped once they are done, and the line ends with its log
  file's name.

#### Several commands in one `send`

`send` takes a list of commands as one argument, a line each, or from
stdin:

```sh
sm-dev send $'tabs T2\nmenu Bump\nvalues'
sm-dev send --run D1 < steps.txt
sm-dev send -        # each runs on Enter; Ctrl-D ends
```

- Each line is one command, split as the prompt splits a typed line.
- They run in order, each finishing before the next starts, and each
  one's output is headed by the command (`> menu Bump`).
- Blank lines are skipped, `#` starts a comment, and `eval {{ ... }}`
  blocks work as at the prompt.
- A list with a mistake in it (a `{{` after another command, a block
  never closed) is refused whole; none of it runs.
- `send -` instead sends each command as its line is read, from a
  terminal or a pipe: a command runs on Enter, and a block on its
  `}}`. A mistake is reported and the rest go on.
- With several arguments, `send` is still one command, so eval's
  JavaScript can be one multi-line argument.

### DevTools alongside a run

The run's own commands (see
[Driving and reading the page](#driving-and-reading-the-page)) cover
most of what a script needs. For the rest of DevTools (network
requests, performance traces, Lighthouse), the `chrome-devtools`
command (`npm i -g chrome-devtools-mcp`) can reach the run's own tabs
with `start --devtools`:

```sh
sm-dev start sites/x/y.user.js --devtools &
# [sm-dev] DevTools: chrome-devtools --sessionId=D1 <tool> <pageId> ...
# [sm-dev] T1 is DevTools page 3
chrome-devtools --sessionId=D1 take_snapshot 3
chrome-devtools --sessionId=D1 click 3 1_2     # an element id from the snapshot
chrome-devtools --sessionId=D1 press_key 3 "Shift+ArrowRight"
chrome-devtools --sessionId=D1 evaluate_script "() => document.title" --pageId 3
```

- Each tab's page id is printed as it's found, and shown by `tabs`.
  `status` shows the command to use.
- Most page tools take the page id first; `evaluate_script` takes it
  as `--pageId`.
- The page ids only work with the run's `--sessionId`. DevTools MCP
  tools in an agent use a server of their own, with other numbers.
- The run starts its DevTools server, and stops it when it ends. If a
  run is killed, `chrome-devtools --sessionId=D1 stop` stops the one
  it left behind.
- Without the `chrome-devtools` command, the run says so and carries
  on without it.
- A tab whose page id isn't found after several tries is named; reload
  it to try again.
- Not with `--launch` or `--extension`, and not on Windows yet.

Things to know:
- The session id is the run's id, unless `start --run` named it
  something that isn't hex (as DevTools requires); then it is a random
  one, printed on the `DevTools:` line.
- DevTools only sees the run's tabs; your other tabs are hidden from it.
- DevTools makes the run's tabs report that they have focus, even when
  they don't, which can hide a script's focus bugs. That's why
  `--devtools` is off by default; `SM_DEV_DEVTOOLS=1` turns it on for
  every run.
- If one of the run's tabs stops answering DevTools, every DevTools
  call waits on it. The run says so when that happens.
- `evaluate_script` answers a dialog that opens while it runs with OK.
  Pass `--dialogAction dismiss`, or answer through the run (`sm-dev
  accept`) when a dialog matters.
- To find a tab, the run briefly sets a hidden property on the page's
  `window`, under `Symbol.for('sm-dev')`.

### What the output looks like

```
[sm-dev] Injected sites/example.com/add-button.user.js in world USER_SCRIPT, run-at document-idle
[sm-dev] Opening https://example.com/items/42 in T1 [targetId=61023580282B1D684FAF4072C201AB51]
[sm-dev] Add button started on https://example.com/items/42
[page log] [add-button] toolbar found, button inserted
[sm-dev] GM_setValue lastItem = "42"
```

A page the header does not cover prints the rule that kept the script
off it (`skipped on <url>: No @match or @include covers this URL`) and
nothing runs. A header problem prints the same wording the extension's
viewer would, and nothing is injected.

The page's own errors are left out, since a busy site logs enough of
them (blocked trackers, failed ad requests) to bury the script's lines:
- Shown: console lines from the script, `[name]`-prefixed console
  lines, and errors whose stack runs through the script.
- A thrown value that isn't an `Error` has no stack, so it is always
  shown.
- A script's own throw prints once, as `<name> threw:` (with
  `--extension`, also as the Log tab's entry).
- `--page-errors` shows the rest too. Reach for it when the script may
  be breaking the page, or when it runs code outside its own file:
  - a `<script>` element it adds to the page;
  - code it `eval`s, whose console lines lose the script's location;
  - a throw deep inside page code (a framework's event dispatch) that
    the script's frame has scrolled off the stack.

## Writing specs: the Playwright fixture

```js
import { test, expect } from 'sourcemonkey/harness';

test('adds the button to the toolbar', async ({ page, loadUserscript, gm, reports }) => {
  await loadUserscript('sites/example.com/add-button.user.js', {
    values: { units: 'metric' },
  });
  await page.goto('https://example.com/items/42');
  await expect(page.locator('#add-button')).toBeVisible();
  expect(reports.errors()).toEqual([]);
  expect(await gm.get('lastItem')).toBe('42');
});
```

What the fixture provides:

| Name | Purpose |
| --- | --- |
| `loadUserscript(path, options?)` | Prepares the file with the real pipeline and attaches it to `page` (before the navigation that should see it). A relative path is taken from the Playwright config's root. Options: `values` to seed storage, `url` to check the match now and throw if it misses, `copy` to load the same file again as a second installed copy (its own id and storage), `collectionRoot` and `localRoots` for `@require` lookups (default: the config's root). Throws with the extension's own message if the script is invalid. Call it twice for two scripts on one page. |
| `gm` | `get(key)`, `set(key, value)` (reaches a running script like another tab's write), `list()`, `menuCommands()`, `fireMenu(label)`, `openedTabs()`, `notifications()`, `clickNotification(requestId)`, `closeNotification(requestId)`, `downloads()`, `requests()`, `failHosts(...hosts)` (a synthetic 503 for those hosts, to force a fallback path), `interceptRequests(fn)` (answer any request from the test). Values and commands are per script; when several are loaded, name one by the path it was loaded from, its basename, or its `@name`. |
| `reports` | `started()`, `skipped()` (with the rule that missed), `errors()` (message and stack). `await reports.waitForStart()` is the usual gate before interacting; when nothing starts it says which script was skipped where, and why. |
| `serveHtml(file, url, { block? })` | Routes a saved HTML file at `url` (matched exactly, query string included), so `@match` and relative URLs behave as on the live site. Other requests fall through to the page's other routes and the network, unless `block` is set. Pair with Playwright's `routeFromHAR` for pages that fetch data. |
| `saveHtml(file)` | Writes the page's current DOM to `file`, for `serveHtml` to replay later. The same file the `savehtml` run command writes. |
| `host`, `attachment` | The underlying objects, for anything the two above don't cover. |

### The same actions from either side

What `sm-dev` does by hand, a spec does through the fixture:

| `sm-dev` | In a spec |
| --- | --- |
| `run <script>` | `loadUserscript(path)` |
| `--values '{…}'` | `loadUserscript(path, { values })` |
| `menu`, `menu <label>` | `gm.menuCommands()`, `gm.fireMenu(label)` |
| `values`, `get <key>` | `gm.list()`, `gm.get(key)` |
| `set <key> <json>` | `gm.set(key, value)` |
| `reload`, `open <url>` | `page.reload()`, `page.goto(url)` |
| `savehtml <file>` | `saveHtml(file)` |
| (a saved page) | `serveHtml(file, url)` |
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

- The fixture leaves `browser` and `context` to you. A repo that
  attaches to a manually launched browser keeps that logic in its own
  fixture file and re-exports the harness `test` extended with it.
- `sourcemonkey/harness` loads Playwright when imported. A Node-only
  tool that wants just `prepareScript` can import
  `sourcemonkey/harness/prepare` instead.

## The extension backend

For what only Chrome can answer:

- Content security policy, Chrome's own match gating, and cross-tab
  broadcast between real tabs.
- The real identity of a `GM_xmlhttpRequest`: the extension's cookies,
  no `Origin` header, `Sec-Fetch-Site: none`. A request that works from
  a page can still be refused when it comes from the extension, so send
  one real request per endpoint here before building on it.

- Start the browser with `--load-extension=<SourceMonkey dist>` and
  turn on "Allow User Scripts" for it once. The user's ordinary browser
  with SourceMonkey installed works too, as long as it has a
  remote-debugging port.
- `sm-dev start --extension` pushes the script text into the extension as
  a **scratch script**, stored only in the extension: it lands in the
  "Scratch" collection, is registered before the page opens, and is
  replaced in place on the next push of the same file name, keeping its stored values. Nothing
  on disk is scanned. What it prints are the entries the script adds to
  its own Log tab, plus the page's console lines.
- `--solo` disables every other collection for the run and restores
  them after, so the scratch script runs without noise from the rest.
- `sm-dev clear --extension` drops all scratch scripts and their stored
  values, and turns solo mode off. If a `--solo` run was killed rather
  than stopped, this is how to get the other collections back; they
  are restored to how they were.
- `--values` has no effect here: the extension keeps its own storage.
- Only the script's own text is pushed, not the files beside it. A
  relative `@require` is refused, and a local copy of a remote
  `@require` is not used: the extension fetches the URL.
- Specs stay on the push backend; for a check that needs the real
  extension, drive it from a spec with SourceMonkey's own test fixtures
  or by hand with `sm-dev start --extension`.

## What is and isn't faithful

Faithful under the push backend:

- Header validation, URL matching, `@run-at`, `@noframes`, `@require`
  scope and local overrides, `@grant` gating, world choice.
- `GM_*` storage semantics, including the write batching and
  broadcast to other pages running the script.
- `@connect` gating of `GM_xmlhttpRequest`.
- Which of a script's messages the web page can see or fake.
- Error attribution to file and line.

Close, but not the same:

- `GM_xmlhttpRequest` goes out from Node with the browser's cookies for
  the target copied onto it (unless the request is `anonymous` or sets
  its own `Cookie` header), and with any header the script asked for.
  A server sees a request from Node, not from the extension: no
  `Sec-Fetch-Site: none`, cookies are not re-attached after a
  cross-origin redirect, and a `Set-Cookie` in the response does not
  reach the browser.

- `GM_info.userAgentData` is read from the browser once a page has
  reached a secure origin (`https:`, `localhost`, `file:`); a script
  loaded before that sees `null` there.
- A tab `GM_openInTab` opens is a real page in the same context, born
  at its URL as Chrome's would be. In the fixture no scripts are
  injected into it; the extension would inject whatever matches the
  new page (`sm-dev start` does, see
  [Tabs the page opens](#tabs-the-page-opens)). It is closed when the
  attachment is disposed, where the extension would leave it open, so
  a test run leaves no tabs behind. It needs a context that belongs to
  a browser, so it fails under Playwright's `launchPersistentContext`.
- `GM_download` fetches the file from Node into a directory of the
  host's choosing (the fixture uses the test's output directory) and
  reports the extension's events, numbering a taken name as Chrome
  does. There is no download bar or prompt, and no `onprogress`.
- `GM_notification` shows nothing; a `timeout` still fires `ondone`,
  and a test delivers the click.
- Under `sm-dev start`, the page's favicon links are not as the site
  left them: its icon links have `rel="sm-set-aside-icon"`, and the
  badge's own `rel="icon"` link is added. A script that reads or
  changes the favicon sees that. The fixture leaves them alone.

Not faithful, use the extension backend:

- The request identity of `GM_xmlhttpRequest` as a site's edge sees it.
- Chrome's own download manager and notification UI.
- Chrome refusing a registration, and page CSP effects on
  `GM_addStyle` in the page world.
- Anything about the extension's UI: badge, collections page, Log tab.

## Troubleshooting

- **"skipped on <url>: No @match or @include covers this URL"**, or
  another rule named there: the script would not run
  there in the extension either. Broaden the pattern or change the
  URL; see `sm-dev match`.
- **`GM_getValue is not defined`**: the script uses an API it did not
  `@grant`. The extension behaves the same way.
- **The script sees `undefined` for a page global**: it is in the
  isolated world. Reading page globals needs `@grant none` or
  `unsafeWindow`.
- **A `@require` fails to load**: the harness resolves it the way the
  extension does, including local overrides. The message names the
  URL and the reason.
