# sm-dev: log handling

A run collects output from several places: the page's console, the
extension's per-script Log, and the events sm-dev sees. They share one
model:

- Each line has a source.
- Every consumer (the stream, `logs`, `wait log`) selects sources the
  same way.
- Positions let a reader pick up where it left off.

The code is in `src/harness/run-logs.ts`: the run-wide buffer, the
flags' parsing and how lines read.

## Log sources

From narrowest to broadest:

- `sm`: SourceMonkey logs, as a script's Log tab shows them: reloads,
  updates, errors caught by its wrapper, `@require` failures.
- `event`: script and tab events sm-dev sees:
  - a script started, threw or was skipped;
  - page loads, tabs opened and closed, dialog boxes;
  - menu commands registered, values changed, requests and downloads,
    notifications.
- `script`: Chrome console logs that came from the run's scripts.
- `page`: full Chrome console logs, uncaught errors and SourceMonkey's
  own lines included. (Off by default, except for `wait log`, though
  the scripts' lines show anyway as `script`.)

`all` stands for every source.

### Lines in several sources

Some lines belong to more than one source, so asking for any of them
shows the line, once, under its first source's prefix:

- A script starting or being skipped: `event`, also `sm`, as
  SourceMonkey's Log has an entry for it.
  - Not when the run found the script's `@match` rules miss the page:
    SourceMonkey logs nothing for that.
- A script's console line or uncaught error: `script`, also `page`,
  as the page's console shows it.
- A script's throw: `event`, also `sm`, `script` and `page`, since
  it's the script's own error, and the page's console shows it.
  - Its other copies (the page's uncaught error and the Log entry) are
    dropped, so it shows once.

## Flags

| Flag | On | Takes |
|---|---|---|
| `--log-source <source>` | `start`, `attach`, `logs`, `wait log` | A source, several separated by commas, or `all`. Replaces the default. |
| `--find <text>` | `logs`, `wait log` | A plain substring, or `/regex/flags` |
| `--since <position>` | `logs`, `wait log` | Lines after this position (exclusive). See [Positions](#positions). |
| `--tail <N or duration>` | `logs` | The last N lines (`50`), or those from the last stretch of time (`30s`) |

- `wait log` also takes its text without `--find`:
  `wait log saved` and `wait log --find saved` are the same.
- `--tail` and `--since` combine: the last N lines after a position.
- Durations are written as `wait <time>` takes them: `500ms`, `30s`,
  `5m`, `1h`.

## Defaults

| Consumer | Sources | Lines from |
|---|---|---|
| Stream | `sm,event,script` | Every tab of the run |
| `logs` | `sm,event,script` | The current tab, and the scripts that ran on it |
| `wait log` | `all` | Every tab, since the previous command began |

- The stream's sources are the run's, set by `start --log-source`.
  - They're what the run's log file holds, and what a client following
    the run sees, the one that started it included.
  - So `start --log-source all` shows the page's lines from the first
    load on.
- `attach --log-source` picks other sources for that client alone.
  Two clients following one run can see different sources.
  - Sent in the connection's hello (`runs.ts`), so it lasts for the
    connection. There's no command to change them mid-session.
- A dialog box's line, and a permission prompt's, are streamed
  whatever the sources, since the page or request waits until it's
  answered.

## The `logs` command

```text
logs [tab|all] [script] [--find <text>] [--log-source <source>] [--since <position>] [--tail <N|duration>]
```

- A tab (`T2`) or `all` picks which tabs; a run script's number (`2`),
  or a piece of its name, picks one script. Either can be left out, and
  they combine.
- "The scripts that ran on it" are the ones running there now. It
  covers lines with no tab: an `sm` entry for a refresh or a failed
  `@require` shows when its script runs on the tab.
- Examples:
  - `logs`: the current tab's scripts' output and events.
  - `logs 2 --log-source sm`: script 2's SourceMonkey Log, on its own.
  - `logs all --log-source all --find /error/i --tail 5m`: anything
    with "error" in it, from any tab, in the last five minutes.
- Identical lines in a row still show once, marked `(N times)`.

### Line format

The stream prints the source prefix and text, with `[T2] ` in front for
a tab after T1. `logs` adds the time and tab in front instead:

```text
14:05:12.345 T1 [event] Menu example started on https://example.com/
14:05:12.351 T1 [script log] [menu] ready, 3 items
14:05:13.002 T1 [page warning] Third-party cookie will be blocked
14:05:13.118    [sm error] Menu example: The @require https://x.test/lib.js could not be loaded
14:05:14.500 T1 [event] Loaded https://example.com/next
```

- `script` and `page` lines carry the console type (`log`, `warning`,
  `error`, ...). `sm` lines carry the entry's level.
- A line with no tab leaves the tab column blank.
- Page loads are `event` lines (`Loaded <url>`) for `logs` and
  `wait log`. The stream leaves them out, since it says what loads
  where its own way.
- The stream cuts a console line past 1000 characters. `logs` and
  `wait log` see it whole, up to the 2000 kept.
- sm-dev's own notices (`[sm-dev] ...`) aren't log lines: the stream
  shows them, but `logs` and `wait log` don't. What happens in a tab
  (it opened or closed, a dialog box came up) is an `event` instead.

## Positions

Every line gets an ID: its arrival time, in microseconds since the
epoch.

- Read from the wall clock (to the millisecond), the clock `--since`
  times are read by.
- When two lines would share one, or the clock steps back, the later
  gets the previous ID + 1, so IDs are unique and in order.

`--since` takes any of:

| Form | Example | Meaning |
|---|---|---|
| Log ID | `1759512345678901` | Exactly after that line |
| ISO 8601 | `2026-10-03T14:05:12.345Z`, `2026-10-03T14:05:12+02:00` | That moment. With no zone, local time. |
| Time of day | `14:05:12`, `14:05:12.345` | That moment today, local time |

### End-of-logs messages

`logs` and `wait log` end by saying the position they reached, so the
next call can pass it to `--since`:

```text
[sm-dev] Logs up to 1759512345678901 (14:05:12.678)
[sm-dev] Found at 1759512345678901 (14:05:12.678)
```

- `logs` ends with `Logs up to`: the newest line in the run's buffer,
  whether or not it matched the filters. That way resuming from it
  skips lines already passed over.
- With nothing to show, `logs` says so first:
  `[sm-dev] No log lines match on tab T4` (or `on any tab` for
  `logs all`).
- `wait log` says the line it matched, then `Found at` with its ID:
  `[sm-dev] Wait matched log line: [script log] saved`.
- A `wait log` that times out gives its timeout message, then
  `[sm-dev] Searched up to 1759512345678901 (14:05:22.678)`.
- A `--since` older than the buffer's oldest line says lines were lost
  before the output:
  `[sm-dev] Lines before 14:01:02.003 are no longer kept`.
- Under `--json`, these lines go to stderr. The result carries the
  position as `until`.

## JSON

`logs --json` gives records rather than strings. It replaced the
earlier `LogsData` (lines grouped by page load). See
[sm-dev-json.md](sm-dev-json.md#logs).

```ts
interface LogsData {
  tab?: string;      // the tab asked for; absent for `all`
  script?: string;   // the script asked for
  lines: LogLine[];
  until: number;     // the position reached, as a log ID
}

interface LogLine {
  id: number;        // log ID, microseconds since the epoch
  time: string;      // ISO 8601
  tab?: string;
  script?: string;
  source: "sm" | "event" | "script" | "page";
  also?: ("sm" | "event" | "script" | "page")[]; // other sources it belongs to
  kind: string;      // console type, Log level, or event name
  text: string;
}
```

Microsecond times stay well inside JavaScript's safe integer range
until the year 2255.

## Storage

- One run-wide buffer of tagged lines, for every source and tab.
  - It keeps the last 5000 lines, oldest dropped first. Long lines are
    cut at 2000 characters.
- Reading back from Chrome isn't enough: Playwright keeps only the last
  200 console messages per page, and nothing of the extension's.
- The log file holds what the run's sources show. By default `page`
  lines stay out of it, so a busy site doesn't flood it.

## Attributing console lines

- The tab is already exact: Playwright reports console lines per page.
- Script vs page within a tab used to be a heuristic: a line was the
  script's when the call site was in the script's file, or the text
  started with `[name]`. The `[name]` rule passed many sites' own lines
  (`[Analytics] ...`) into the stream.
- Now the run reads raw CDP console events (the Chrome DevTools
  Protocol's `Runtime.consoleAPICalled`) on sessions of its own per
  tab (`ConsoleStacks` in run.ts): the page's, and one per
  cross-origin iframe Chrome runs in a process of its own
  (frame-sessions.ts). They carry the JavaScript context the call ran
  in, and so its frame, and its stack.
  - Each is paired with Playwright's console event by the call's
    timestamp, which both carry. A line waits up to 250ms for its
    copy, then falls back to the call site.
  - A call from SourceMonkey's own world (a context whose origin is
    the extension's) is the scripts'.
  - Otherwise a line is the scripts' when any stack frame is in
    SourceMonkey's code (`sourcemonkey://`), not only the call site.
    That covers a script calling a page helper that logs.
  - Which script: the first frame in one of the run's scripts' entry
    URLs (`ExtensionHost.scriptOf`).
- Uncaught errors go by their stack's text: the scripts' when it
  names SourceMonkey's code, or has no frames at all (a thrown
  string). A script body's throw prints as its `threw` event instead.
  - A stackless error thrown in an iframe none of the run's scripts
    match (by URL, `@noframes` counted) is the page's: an ad frame's
    cross-origin `SecurityError`, say.
  - The frame comes from the protocol's copy of the error
    (`Runtime.exceptionThrown`), paired with Playwright's by its
    message.
- The `[name]` rule is gone.
- Under Violentmonkey or Tampermonkey, the same with its URLs
  (`ExtensionHost.external`): its worlds and its code
  (`chrome-extension://<its id>/`) are the scripts', and a script is
  named by its code's URL.
  - Violentmonkey's is `<name>.user.js#<its id>`, Tampermonkey's
    `userscript.html?name=<name>.user.js&id=<uuid>`.
  - Neither reports `threw` events, so a script's uncaught error is a
    `script` line.
  - Tampermonkey moves a script's lines; the manager maps the run's
    scripts' back (`ExtensionHost.external.remap`).
  - See [sm-dev-violentmonkey.md](sm-dev-violentmonkey.md#logs-and-errors)
    and [sm-dev-tampermonkey.md](sm-dev-tampermonkey.md#logs-and-errors).

## Catching up after a service worker restart

- Events sent while the extension's service worker restarts are lost,
  and the run says so.
- The run reads each script's Log again after a restart
  (`ExtensionHost.catchUpLogs`) and logs the entries newer than the
  last it saw.
  - Up to the first entry the new worker sent live meanwhile, which
    was logged already.
  - Entries from reports (started, threw, skipped) come back as plain
    `sm` lines, since the stored Log doesn't mark them.
  - They get IDs from when they're read, so `--since` positions stay
    in order.
  - Other events from the gap are still lost.
