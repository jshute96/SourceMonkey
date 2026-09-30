# sm-dev commands by task

A summary. `pnpm sm-dev help <command>` shows a command's exact
options; `pnpm sm-dev --help` lists everything.

## Shape of a command line

```sh
sm-dev [global options] <command> [args] [-- <command> ...]
```

- Global options go first: `--run ID`, `--cdp PORT|URL`,
  `--open-browser`, `--temp-browser`, `--stdin`, `--interactive`,
  `--root DIR`, `--local DIR`.
- `--` separates commands. They run in order and stop at the first
  failure (a `match` or `validate` miss excepted).
- Exit codes: 0 success, 1 a check failed or a `wait` gave up, 2 typed
  wrong (`ERROR:`). Most other commands sent to a run exit 0 even when
  they fail: read the output.

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
| `sm-dev --temp-browser start ...` | A hidden throwaway browser for this run. Good for pages with no login |
| `sm-dev --cdp 9300 ...` | Use the browser on another port |

## Runs

| Command | Does |
| --- | --- |
| `start <script>... [url]... --detach` | Start a run in the background; returns once pages settle |
| `start ... --watch` | Re-inject and reload on each save of a script or local `@require` |
| `start ... --values '<json>'` | Seed GM storage first |
| `start ... --values-file <path>` | Seed GM storage first, from a JSON file |
| `start ... --page-errors` | Also stream the site's own errors |
| `start ... --all` | Open each script's default page, a tab each |
| `start ... --noscript` | No scripts: just a browser to drive |
| `start ... --notab` | No tab at first; `newtab` later |
| `start ... --extension [--solo]` | Push into the real extension instead |
| `clear --extension` | Drop the extension's scratch scripts; turn solo mode off |
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
| `scripts`, `script <script>` | List; pick the one `get`/`set`/`match` use |
| `load <script>...` | Add scripts to the run |
| `update [script]` | Re-read changed scripts and reload affected tabs |

## Tabs

| Command | Does |
| --- | --- |
| `tabs`, `tab T2` | List (with targetIds); pick the current tab |
| `newtab [page...]` | Open a controlled tab (becomes current) |
| `newtab --noscript <url>` | A tab the scripts stay out of (sticky) |
| `closetab [T2 T3...\|all]` | Close the current tab, the ones named, or all. A page's "Leave site?" dialog waits for `accept`/`dismiss`; `--force` skips it |
| `open [page]` | Navigate the current tab |
| `reload [T2\|all]` | Reload |
| `focus [tab]` | Bring to the front |
| `--from-saved [--offline] [--url U]` | On `newtab`/`open`/`start`: serve `.html` files at their recorded URL |

## Reading the page

| Command | Does |
| --- | --- |
| `snapshot [sel] [--visible] [--out F]` | Accessibility tree with refs |
| `probe <sel>... [--css] [--html]` | Which match and how many; selector / HTML of the first 10 |
| `eval <js>` | Evaluate in the page; prints JSON (promises awaited) |
| `eval --script <js>` | Evaluate in the scripts' world |
| `eval --file <path>` | Evaluate a JavaScript file |
| `cdp <Method> [json]` | A raw CDP call on the tab; the result as JSON. A `{{` block or `--file` holds several, one per line (see [cdp.md](cdp.md)) |
| `screenshot [sel] [--full] <file>` | PNG of the view, the page, or an element |
| `savehtml <file>` | Save the DOM for `--from-saved` / `serveHtml` |
| `logs` | All console lines and errors so far |

## Driving the page

| Command | Does |
| --- | --- |
| `click <sel>`, `hover <sel>` | Real mouse input, scrolled into view. A failure names the check that failed (hidden, disabled, moving, covered by what) |
| `click <sel> --button right --modifiers Shift --count 2` | Right or middle button, keys held (`Control+Alt`), double or triple click |
| `type <sel> <text>` | Type key by key |
| `type <sel> {{` | Type several lines exactly (line breaks are Enter; the final one before `}}` isn't typed) |
| `type <sel> --file <path>` | Type a file's text exactly, including a final line break |
| `key <keys>...` | `key j Shift+ArrowRight ctrl+end esc` |
| `accept [text]`, `dismiss` | Answer an open dialog |
| `--nowait` | On any of these: don't wait for the page to settle |

## Waiting

| Command | Waits for |
| --- | --- |
| `wait [T2\|all]` | The tab to settle |
| `wait selector <css>`, `wait selector-gone <css>` | An element to appear / disappear |
| `wait log <text>`, `wait log /regex/` | A line printed since the previous command began |
| `wait 500ms` | Time (last resort) |
| `--timeout-seconds S` | Give up after S seconds (default 5). On `wait log`, put it after the text |

Settled means: loaded, scripts started, no requests (under 3 seconds
old) or DOM changes for 200ms. Timers aren't waited for.

## Scripts' GM state

| Command | Does |
| --- | --- |
| `menu`, `menu all` | List menu commands (`M1`...) |
| `menu <label or M1>` | Fire one |
| `values [script\|T2]` | Stored values |
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
  eval --script {{
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
