# sm-dev commands by task

A summary. `pnpm sm-dev help <command>` shows a command's exact
options; `pnpm sm-dev --help` lists everything.

## Shape of a command line

```sh
sm-dev [global options] <command> [args] [-- <command> ...]
```

- Global options go first: `--run ID`, `--browser URL|PORT`,
  `--open-browser`, `--temp-browser`, `--headed`, `--mute`, `--nomute`,
  `--stdin`, `--interactive`,
  `--root DIR`, `--local DIR`, `--json`.
- Read the text output by default: it's shorter, and says what an
  empty answer means and where to look next.
- Add `--json` when you'll parse the output, with `jq` or a script:
  `$R --json scripts | jq -r '.scripts[] | select(.status == "invalid") | .name'`.
  - `--json` works for `list`, `status`, `scripts`, `tabs`, `values`,
    `get`, `match`, `validate`, `menu`, `logs` and `probe`. Each prints
    one JSON object; other commands print text as usual.
  - Other messages and failures stay text, on stderr, with the usual
    exit code.
  - An empty list means nothing was found.
  - A script's `state` on a tab: `running` or `not-running`; for a
    SourceMonkey-managed script (E1, ...) also `kept-out` (the run
    keeps it out of its tabs), `not-started`, `error` (it threw),
    `refused` (Chrome refused it), `unexpected` (running though it
    doesn't match) and `changed` (changed since it started).
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

## Names

| Thing | Written | Notes |
| --- | --- | --- |
| Run | `D1`, or `Dname` from `--run` | `list` shows them |
| Script | `1`, its path, file name, `@name`, or a unique piece | `T2.3`: script 3 on tab T2 |
| Tab | `T1`, `targetId=<id>` (or 6+ chars of it) | Page commands take one first: `click T2 .x` |
| Menu command | `M1`, `T2.M1`, or its label | |
| Element | CSS or Playwright selector, or a ref (`e4`, `f2e6`) | Refs from the latest `snapshot` |
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
  User Scripts on.

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
| `status` | The run, its log file, tabs, and each script's state |
| `attach [ID]` | Follow a run's stream (Ctrl-C leaves it going) |
| `stop [ID]`, `stop --all` | End a run |
| `exit` | End this sm-dev (at a prompt or on stdin); runs it started without `--detach` stop |
| `start --idle-seconds N` | Idle timeout (default 30 minutes; `0` never) |

## Scripts

| Command | Does |
| --- | --- |
| `validate <path>...` | Header, `@require` and syntax checks, plus warnings (files, dirs, globs) |
| `match <script>... <url>...` | Would it run there; which rule decided |
| `match`, `match all` | In a run: the selected script on the current tab; all scripts on all tabs |
| `scripts`, `script <script>` | List; pick the one `get`/`set`/`match` use. It also lists SourceMonkey-managed scripts on the tab as E1, ...; `scripts E1` picks one for `get`/`set` (`set key --force <json>` outside a `--temp-browser`) |
| `load <script>...` | Add scripts to the run |
| `update [script]` | Re-read changed scripts and reload affected tabs |

## Tabs

| Command | Does |
| --- | --- |
| `tabs`, `tab T2` | List (with targetIds); pick the current tab |
| `newtab [page...]` | Open a controlled tab (becomes current) |
| `newtab --noscript <url>` | A tab the scripts stay out of (sticky) |
| `closetab [T2 T3...\|all]` | Close the current tab, the ones named, or all. A page's "Leave site?" dialog waits for `accept`/`dismiss`; `--force` skips it |
| `open [tab] [page]` | Navigate the current tab, or the one named |
| `reload [T2\|all]` | Reload |
| `focus [tab]` | Bring to the front |
| `--from-saved [--offline] [--url U]` | On `newtab`/`open`/`start`: serve `.html` files at their recorded URL |

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
| `eval --file <path>` | Evaluate a JavaScript file |
| `eval --out FILE <js>` | Write the result to a file; printed results are cut past 10,000 characters |
| `cdp <Method> [json]` | A raw CDP call on the tab; the result as JSON. A `{{` block or `--file` holds several, one per line (see [cdp.md](cdp.md)) |
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
| `key <keys>...` | `key j Shift+ArrowRight ctrl+end esc` |
| `accept [tab] [text]`, `dismiss [tab]` | Answer an open dialog |
| `--nowait` | On any of these: don't wait for the page to settle |

## Waiting

| Command | Waits for |
| --- | --- |
| `wait [T2\|all]` | The tab to settle |
| `wait selector <css>`, `wait selector-gone <css>` | An element to appear / disappear |
| `wait log <text>`, `wait log /regex/` | A log line since the previous command began (or `--since`). `--find <text>` works too |
| `wait 500ms`, `wait 2s` | Time (last resort) |
| `--timeout-seconds S` | Give up after S seconds (default 5). On `wait log`, put it after the text |

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
| `menu <label or M1>` | Fire one |
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
