# sm-dev commands by task

A summary. `pnpm sm-dev help` lists the help topics, and
`help <topic>` shows one. `help <command>` (or `<command> --help`)
shows a command's exact options; `help commands` lists the commands,
and `help all` everything.

## Shape of a command line

```sh
sm-dev [global options] <command> [args] [-- <command> ...]
```

- Global options go first: `--run ID`, `--browser URL|PORT`,
  `--manager sm|tm|vm`, `--open-browser`, `--temp-browser`, `--headed`,
  `--mute`, `--nomute`,
  `--stdin`, `--interactive`,
  `--root DIR`, `--local DIR`, `--json`.
- Read the text output by default: it's shorter, and says what an
  empty answer means and where to look next.
- Add `--json` when you'll parse the output, with `jq` or a script:
  `$R --json scripts | jq -r '.scripts[] | select(.status == "invalid") | .name'`.
  - `--json` works for `list`, `status`, `scripts`, `tabs`, `frames`,
    `values`, `get`, `match`, `validate`, `menu`, `logs`, `probe`, and every
    `collection` and `script` verb (`script list`, `script show`, ...).
    Each prints one JSON object; other commands print text as usual.
  - Other messages and failures stay text, on stderr, with the usual
    exit code.
  - An empty list means nothing was found.
  - A script's `state` on a tab: `running`, `not-running`, or
    `manual` (a `@run-at context-menu` script not run yet); for a
    SourceMonkey-managed script (E1, ...) also `kept-out` (the run
    keeps it out of its tabs), `not-started`, `error` (it threw),
    `refused` (Chrome refused it), `unexpected` (running though it
    doesn't match), `changed` (changed since it started) and `unknown`
    (the page loaded before SourceMonkey started).
  - Every field:
    https://github.com/jshute96/SourceMonkey/blob/main/docs/sm-dev-json.md
- `--` separates commands. They run in order and stop at the first
  failure (a `match` or `validate` miss excepted).
- Exit codes: 0 success, 1 a command failed (a check missed, no
  element, an `eval` threw, a `wait` gave up), 2 invalid command
  (`ERROR:`). A few commands still exit 0 when they fail, and `probe`
  reports a missing selector without failing: read the output.
- Flags take a value after a space or `=` (`--out f.txt`,
  `--out=f.txt`). An unknown flag's error lists the flags the command
  takes; stray arguments are refused, with the command's usage.
- Quotes: in `--stdin` lines, most commands take off one level of
  quotes around an argument. `eval` and `cdp` don't: their quotes are
  JavaScript's and JSON's. A quoted word is never a flag.
- Flags can go anywhere, also after or inside `eval`'s JavaScript or
  `wait log`'s text (`eval 'await x()' --timeout-seconds 45`). A word
  there shaped like a flag (`--name`) is taken as one, and an unknown
  one is an error. To keep one as text, quote the text as a whole
  (`type #q 'a --b'`), or in JavaScript write it so the `--` isn't a
  word of its own (`a = '--b'`, `(--n)`).

## Names

| Thing | Written | Notes |
| --- | --- | --- |
| Run | `D1`, or `Dname` from `--run` | `list` shows them |
| Script | `1`, its path, file name, `@name`, or a unique piece | `T2.3`: script 3 on tab T2 |
| Tab | `T1`, `targetId=<id>` (or 6+ chars of it) | Page commands take one first: `click T2 .x` |
| Installed script | `E1` | SourceMonkey's own number, the same in every run |
| Collection | `C1`, its name or a unique piece, `id=<id>` | A run's test collection: its run, `D1` |
| Menu command | `M1`, `T2.M1`, or its label | |
| Element | CSS or Playwright selector, or a ref (`e4`, `f2e6`) | Refs from the latest `snapshot`. A selector in an iframe: `--frame F2` |
| Frame | `F2`, `T1.F2`, `frameId=<id>`; the top frame is its tab, `T1` | From `frames`; kept across the frame's reloads |
| Page | URL, file, glob, or script number (its default page) | Scheme optional for hosts |

## Browsers

| Command | Use |
| --- | --- |
| `sm-dev --open-browser` | Start a lasting, visible browser on port 9233 (kept profile, so logins persist). A no-op if one is up |
| `sm-dev --temp-browser start ...` | A hidden throwaway browser for this run, with SourceMonkey loaded. Good for pages with no login |
| `--headed`, `--nomute` | With `--temp-browser`: a visible window; sound on (it's muted otherwise) |
| `sm-dev --browser 9300 ...` | Use the browser on another port |

- A run pushes its scripts into SourceMonkey in that browser. With
  `--open-browser` or `--browser`, it must be loaded there with Allow
  User Scripts on: `manager install` does both.

### Managers

`--manager` picks SourceMonkey (`sm`, the default), Tampermonkey (`tm`)
or Violentmonkey (`vm`). A run keeps the one it started with. How to
test a script under VM or TM:
[other-managers.md](other-managers.md).

| Command | Does |
| --- | --- |
| `--manager tm manager fetch` | Download or update TM (or VM) from the Chrome Web Store into `~/.cache/sm-dev/managers` |
| `[--manager tm] manager install` | Load the manager into the browser unpacked, with Allow User Scripts on. No run needed |
| `[--manager tm] manager enable` / `disable` | Turn it on or off in the browser. Not SourceMonkey while a run uses it |
| `--manager vm --temp-browser start <script> <url>` | A run under VM (or `tm`): its scripts are installed in the manager, and removed when it ends. `values`, `get`, `set`, `menu`, `connect` and `--values` are refused |
| `--manager vm script list`, `script E3 show`, ... | The manager's scripts, by E-ids, in one collection, `C0`. `collection C0 disable` is its switch for all scripts |

- A manager enabled beside the chosen one runs its scripts in the run's
  tabs too: the run's first lines and `status` warn of it.
- Under VM or TM, `scripts` and `status` show which scripts each tab
  is expected to run, by their match rules (`Expected on tab T1 using
  match rules:`), not what ran. A run's script shows its E-id there
  too: `1: Hello (hello.user.js), E6 in Violentmonkey`.
- Under VM or TM, a run never replaces a script the manager already
  has by the same name and namespace: `start` refuses, naming it.

## Runs

| Command | Does |
| --- | --- |
| `start [script]... [url]... --detach` | Start a run in the background; returns once pages settle |
| `start ... --watch` | Re-push and reload on each save of a script or local `@require` |
| `start ... --values '<json>'` | Seed GM storage first |
| `start ... --values-file <path>` | Seed GM storage first, from a JSON file |
| `start ... --log-source all` | Also stream the site's own lines and errors (sources: `sm`, `event`, `script`, `page`) |
| `start ... --lang zh-CN,en` | Tabs prefer these languages |
| `start ... --all` | Open each script's default page, a tab each |
| `start [url]...` | No scripts: just a browser to drive (`load` adds them later) |
| `start ... --notab` | No tab at first; `newtab` later |
| `start ... --detach --new` | Start another detached run, keeping earlier ones |
| `list` | The active runs |
| `status` | The run, its log file, tabs, and each script's state. With no run picked: the `--browser` browser and its managers, then every active run |
| `attach [ID]` | Follow a run's stream (Ctrl-C leaves it going) |
| `stop [ID]`, `stop --all` | End a run |
| `exit` | End this sm-dev (at a prompt or on stdin); runs it started without `--detach` stop |
| `start --stop-after-idle-seconds N` | Idle timeout (default 30 minutes; `0` never) |

## Scripts

| Command | Does |
| --- | --- |
| `validate <path>...` | Header, `@require` and syntax checks, plus warnings, e.g. an `@icon` that can't be shown (files, dirs, globs) |
| `match <script>... <url>...` | Would it run there; which rules matched or excluded it |
| `match`, `match all` | In a run: the selected script on the current tab; all scripts on all tabs. `--frames`: each of the tab's iframes too |
| `scripts`, `script <script>` | List; pick the one `get`/`set`/`match` use. It also lists SourceMonkey-managed scripts on the tab as E1, ...; `scripts E1` picks one for `get`/`set`, any installed script (`script list` lists them), on the tab or not (`set key --force <json>` outside a `--temp-browser`) |
| `load <script>...` | Add scripts to the run |
| `update [script]` | Re-read changed scripts and reload affected tabs |
| `collection list` (or `collections`) | SourceMonkey's collections (C1, ...), with kind, script count, enabled. No run needed |
| `script list [collection]` | Every installed script (E1, ...) under its collection, or one collection's. No run needed |
| `script [script] show`, `script [script] print` | One script in full (rules, status, files, values count, and in a run its state on each tab); its installed text. No run needed |
| `collection <collection> show` | One collection and its scripts. No run needed |

### Changing what's installed

The script or collection comes before the verb: `script E4 disable`,
`collection C3 refresh`; quote a name of several words. In a run, a
script left out is the selected one, except for `uninstall`.

These change SourceMonkey's real collections and scripts, as its pages
do, and need no run. Outside a `--temp-browser` they're the person's
own: change them only when asked to.

| Command | What it does |
| --- | --- |
| `script [script] enable` / `disable` | Turn one on or off. In a run, one of its own too |
| `script [script] refresh` | Re-read it from its location; a run's own from disk, as `update` does |
| `script install <file\|url>` | Install for every tab, to stay (`load` is for the run only). `--collection <C>`. Under VM, replacing the person's script of the same name needs `--force`: ask first |
| `script <script> uninstall`, `script [script] move <C>` | Remove one from, or move it between, container collections |
| `collection <C> enable` / `disable` / `refresh`, `collection <C> rename <name>` | The same for a whole collection |

- `script uninstall` needs `--force` outside a `--temp-browser`.
- A run's test collection and other runs' scripts are refused, as is
  uninstalling or moving a script that a directory or manifest
  collection lists.
- The listings mark a local file changed since it loaded: `(modified
  on disk)`, and a collection's `Refresh pending: ...`. `script
  refresh` / `collection refresh` load it.
- Installing, moving or enabling a script turns off its other running
  copies, as SourceMonkey does, and lists each one. Enabling a
  collection does the same without listing them, and disabling it
  turns back on what it turned off. A new file a `collection refresh`
  finds lands disabled when its script already has an enabled copy. An
  enabled script in a disabled collection is said not to run.

## Tabs

| Command | Does |
| --- | --- |
| `tabs`, `tab T2` | List (with targetIds); pick the current tab. `--frames`: each tab's iframes too |
| `frames [T2\|F3\|all]` | A tab's iframes (`F1`, ...) as a tree, with the scripts running in each, `(hidden)` ones marked, each one's CDP `frameId`, and the `targetId` of one from another site |
| `newtab [page...]` | Open a controlled tab (becomes current) |
| `newtab --noscript <url>` | A tab the scripts stay out of (sticky) |
| `closetab [T2 T3...\|all]` | Close the current tab, the ones named, or all. A page's "Leave site?" dialog waits for `accept`/`dismiss`; `--force` skips it |
| `open [tab] [page]` | Navigate the current tab, or the one named |
| `reload [T2\|all]` | Reload |
| `focus [tab]` | Bring to the front |
| `--from-saved [--offline] [--url U]` | On `newtab`/`open`/`start`: serve `.html` files at their recorded URL |
| `--timeout-seconds S` | On `newtab`/`open`/`reload`: give a slow page S seconds to load (default 30) and settle (default 5) |

## Reading the page

| Command | Does |
| --- | --- |
| `snapshot [sel] [--visible] [--out F]` | Accessibility tree with refs |
| `snapshot [sel] --find <text>` | Only elements containing the text (case insensitive), within `sel`'s matches |
| `snapshot ... [--up N] [--context] [--limit N]` | For each match of `sel` or `--find`: N levels up, or with wrapper divs and small containers; first 5 matches (0: all) |
| `probe <sel>... [--css] [--html]` | Which match and how many; selector / HTML of the first 10 |
| `eval <js>` | Evaluate inside the selected script, where its `GM_*` APIs, `@require` libraries, top-level declarations and IIFE locals are visible; prints JSON (promises awaited). In the page when no script is selected or it hasn't run there |
| `eval --page <js>` | Evaluate in the page, where the page's own globals are |
| `eval --script=<script> <js>` | Evaluate inside the named script |
| `eval --frame F2 <js>` | Evaluate in an iframe: in the script instance there, or in its page with `--page`. Cross-origin frames too |
| `eval --file <path>` | Evaluate a JavaScript file |
| `eval --out FILE <js>` | Write the result to a file; printed results are cut past 10,000 characters |
| `cdp <Method> [json]` | A raw CDP call on the tab; the result as JSON. A `{{` block or `--file` holds several, one per line (see [cdp.md](cdp.md)) |
| `cdp --frame F2 <Method> [json]` | The same on the target an iframe is in: its own (one from another site), else its page's |
| `screenshot [sel] [--full] <file>` | PNG of the view, the page, or an element |
| `savehtml <file>` | Save the DOM for `--from-saved` / `serveHtml` |
| `logs [T2\|all] [script]` | The run's log for the tab (its scripts' lines and events), timestamped and whole (the stream cuts a line past 1000 characters) |
| `logs ... --log-source all` | The site's own lines too; or a list, e.g. `sm` for SourceMonkey's Log entries alone |
| `logs ... --find <text\|/re/>`, `--tail 50`, `--tail 30s` | Only matching lines; the last N, or the last stretch of time |
| `logs ... --since <position>` | Only lines after a log ID (`Logs up to` gives the last), an ISO 8601 time, or a time of day (`14:05:12`) |

## Driving the page

| Command | Does |
| --- | --- |
| `click <sel>`, `hover <sel>` | Real mouse input, scrolled into view. A failure names the check that failed (hidden, disabled, moving, covered by what) |
| `click <sel> --button right --modifiers Shift --count 2` | Right or middle button, keys held (`Control+Alt`), double or triple click |
| `click <sel> --at 300,12`, `hover <sel> --at 4,4` | At that point in the element (pixels from its top left), not its center |
| `hover <sel> --modifiers Alt` | Keys held during the hover |
| `type <sel> <text>` | Type key by key |
| `type <sel> {{` | Type several lines exactly (line breaks are Enter; the final one before `}}` isn't typed) |
| `type <sel> --file <path>` | Type a file's text exactly, including a final line break |
| `type <sel> --clear [text]` | Empty the field first, then type the text if given |
| `key <keys>...` | `key j Shift+ArrowRight ctrl+end esc` |
| `accept [tab] [text]`, `dismiss [tab]` | Answer an open dialog |
| `connect once\|cancel\|allow\|deny\|allow-all [host]` | Answer SourceMonkey's prompt for a host the selected script's `@connect` doesn't cover |
| `--nowait` | On any of these: don't wait for the page to settle |
| `--timeout-seconds S` | On any command that waits (these, `start`, `eval`, `snapshot`, `probe`, `screenshot`, `closetab`, `load`, `update`, `menu`): S seconds for each wait, in place of its default. On `cdp`, for each call (default 10) |

## Waiting

| Command | Waits for |
| --- | --- |
| `wait [T2\|all]` | The tab to settle |
| `wait selector <css>`, `wait selector-gone <css>` | An element to appear / disappear |
| `wait log <text>`, `wait log /regex/` | A log line since the previous command began (or `--since`). `--find <text>` works too |
| `wait 500ms`, `wait 2s` | Time (last resort) |
| `--timeout-seconds S` | Give up after S seconds (default 5). On a delay, it may be given if not shorter |

- A tab goes before the form: `wait T2 selector '.x'`.
- `wait log` sees every log source, the site's own lines too, unless
  `--log-source` narrows it. Each is matched in the form the run
  would print it: `[page log] KEYUP 143`.
- It ends with `Found at <log ID>`, or `Searched up to <log ID>` when
  it gives up.

Settled means: loaded, scripts started, no requests (under 3 seconds
old) or DOM changes for 200ms. Timers aren't waited for.

## Scripts' GM state

| Command | Does |
| --- | --- |
| `menu`, `menu all` | List menu commands (`M1`...) |
| `menu <label or M1>` | Fire one. Piped in, waits up to 5 s for it to be registered; `--timeout-seconds S` for longer |
| `values [script\|T2\|E1]` | Stored values (`E1`: a SourceMonkey-managed script) |
| `get <key>`, `set <key> <json>` | One value; `set` fires change listeners |
| `set <key> --file <path>` | The value from a JSON file (or a `{{` block, as `eval` takes) |

## eval

- The rest of the line is JavaScript: `eval document.title`. Quote it
  for the shell when it has spaces or special characters.
- The value is the last expression, as in the DevTools console. A
  top-level `return` works too (the code runs as a function body).
  Its `const`/`let` then stay in that function, not kept for later
  evals.
- `eval --file probe.js` runs a file's JavaScript, with no shell
  quoting: handy for a probe you run more than once.
- Several lines, on stdin or at a prompt:

  ```
  eval {{
  const rows = [...document.querySelectorAll('.row')];
  rows.map((r) => r.id)
  }}
  ```

  `{{` ends the first line; a line of just `}}` closes it. A tab and
  flags go before the `{{`.
- Elements print as DevTools describes them; return
  `el.outerHTML` or specific fields for more.
- An expression that navigates prints a note instead of a value;
  follow it with `wait`.
