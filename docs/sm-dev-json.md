# sm-dev: JSON output

Status: built for the existing commands, and SourceMonkey's
`collection` and `script` commands. The
[planned commands](#planned-commands), events and the schema file are
not built yet; they come with [sm-dev-managers.md](sm-dev-managers.md).

`--json` makes sm-dev print each command's result as JSON instead of
text, for other programs to read.

## Turning it on

- **`--json` as a global option** (before the first command): every
  command that has a JSON form prints JSON. The rest print text as
  usual (see [Commands without a JSON form](#commands-without-a-json-form)).
- **`--json` / `--nojson` on one command** (`scripts --json`): turn it
  on or off for just that command, overriding the global option.
  Mostly for testing.
- **Both take a layout:** `--json=single` or `--json=multi` (see
  [Lines](#lines)). A command's own `--json` with none keeps the global
  option's.

## Lines

- **Each command prints one JSON object.**
  - At a terminal, multi-line, as in the examples below, so people can
    read it.
  - Piped, on one line each (JSON Lines), so a program can split the
    output on newlines. `gh --json` does the same.
  - `--json=single` or `--json=multi` picks one of these either way.
  - Programs that use a streaming JSON parser, or `jq`, can read either
    form.
- **What each object is:**
  - A command's result has no `type`. It has `command`, the command's
    name, then the command's own fields.
  - `"type": "event"` (not built yet): something that happened in the
    run, between commands. See [Events](#events).
  - So no command's result has a field named `type` or `command` of its
    own.
- **Other log messages** go to stderr as text under the global
  `--json`: the `[sm-dev] ...` lines and the `arg > ...` echoes.
  - So a line of JSON commands to a detached run puts only JSON on
    stdout.
  - A line that starts a run and follows its stream also shows the
    page's console lines on stdout.
- **A JSON command's other lines** go to stderr too, whichever way
  `--json` was given: a warning beside its result, or its failure.
- **A failure is text, not JSON.** It prints on stderr as it would
  without `--json`, in place of a result.
  - Many failures are formatted text (a table of runs), which a JSON
    string would only make harder to read.
  - A program tells a failure by the exit code, or by finding no
    result on stdout.
- **Exit codes** are the same as in text mode.

### Results

```json
{
  "command": "tabs",
  "tabs": [ ... ]
}
```

- `command`: the command's name, with a two-level command's verb
  (`script list`). Not its arguments.
- The rest are the command's own fields, below.

## Schemas

Written here as TypeScript types, which are shorter to read than JSON
Schema. `?` marks a field that can be left out. The source is
`src/harness/json-output.ts`; change the two together.

### Schema file (not built yet)

- The build generates a JSON Schema file from the types into `lib/`.
  The package ships it, for programs in any language to validate output
  or generate types from.
- The package also exports the TypeScript types.
- Tests check sm-dev's real `--json` output against the schema, so the
  two can't drift apart.

### Stability

- Field names and the meaning of enum values are fixed once released.
- New fields and new enum values can be added. Readers should ignore
  fields they don't know, and treat an unknown enum value as "other".
- Text values meant for people (`message`, `name`) can change wording.

### Shared types

```ts
// Short form of a collection, inside other objects.
interface CollectionRef {
  id?: string;           // "C2", or a run's test collection's run ("D1")
  name: string;
}

// A collection in the manager.
interface Collection {
  id?: string;           // "C2", or a run's test collection's run ("D1")
  internalId: string;    // its id inside the manager (a UUID in SourceMonkey)
  name: string;
  kind: "container" | "directory" | "manifest";
  location?: string;     // directory or manifest; none for a container
  runCollection?: string; // the run id, for a run's test collection
  enabled: boolean;
  status: "ok" | "load-failed";
  error?: string;        // why it failed to load
  scriptCount: number;
  // collection list and show: a local collection's files that differ
  // from what it loaded, as the collections page's "refresh pending" chip
  onDisk?: { modified: number; deleted: number; added: number; manifest?: true };
}

interface Tab {
  id: string;            // "T1"
  url: string;
  targetId?: string;     // the CDP target id
  selected: boolean;     // the tab the page commands act on
  noScript?: boolean;    // opened with --noscript
  savedFrom?: string;    // the .html file it serves, with --from-saved
  offline?: boolean;     // a saved page served with --offline
  openedBy?: string;     // the tab that opened it
  dialog?: { kind: string; message: string }; // waiting for an answer
  scripts: string[];     // the ids of the run's scripts running in its top frame
  frames?: Frame[];      // its iframes, absent for none
}

// One of a tab's iframes (see sm-dev-frames.md), each after its parent.
interface Frame {
  id: string;            // "F3": unique in the run; the top frame is the tab's id
  parent: string;        // "T1", or another frame's id
  url: string;
  scripts: string[];     // the ids of the run's scripts running in it
                         // (expected in it, under another manager)
  hidden?: true;         // its <iframe> isn't visible
  frameId?: string;      // its CDP frame id
  targetId?: string;     // its CDP target, when it runs in a process of its own
                         // (the same id as frameId)
}

// A script: one the run loaded ("1"), or one installed in the
// manager ("E1").
interface Script {
  id?: string;           // none in script list for another run's script
  installedAs?: string;  // under another manager, a run's script in scripts
                         // and status: its id there ("E6")
  kind: "run" | "installed";
  name: string;
  file?: string;         // run's scripts: the path it was loaded from
  collection?: CollectionRef; // installed: the collection holding it
  // Installed scripts, in `script list`:
  internalId?: string;   // its id inside the manager (a UUID in SourceMonkey)
  namespace?: string;
  version?: string;
  location?: string;     // where it is loaded from
  enabled?: boolean;
  status?: "ok" | "invalid"; // run's scripts, and in `script list`
  error?: string;        // why it is invalid
  refreshError?: string; // why its last refresh failed; its last good copy still runs
  onDisk?: "modified" | "deleted"; // script list and show: its local file, since it loaded
  selected?: boolean;    // the script get and set act on
  // Under another manager, in script list and show:
  run?: string;          // a live run's script: the run ("D1")
  leftBy?: string;       // left by a run that ended ("D1")
  tabs?: TabActivity[];  // in scripts and status
}

// What a script is doing on one tab.
interface TabActivity {
  tab: string;           // "T1"
  state: TabState;       // "running" when it runs in any of the tab's frames
  // Where in the tab it runs, the tab's id for its top frame. Absent
  // when that's the top frame only.
  frames?: string[];     // ["T1", "F1", "F3"]
}

type TabState =
  | "running"
  | "not-running"        // a run's script that isn't running there, or a
                         // picked installed one that isn't on the page
  | "manual"             // a run's manual script (@run-at context-menu)
                         // that matches, and hasn't been run there
  // An installed script, as the toolbar badge shows it:
  | "error"              // started, then threw
  | "refused"            // Chrome refused to run it
  | "not-started"        // it matches, but hasn't started
  | "unexpected"         // running, though it doesn't match
  | "changed"            // changed since it started
  | "kept-out"           // matches, but the run's claim keeps it out
  | "unknown"            // its page loaded before SourceMonkey started
  // Under another manager, which doesn't say what ran: by its match rules.
  | "expected"
  | "not-expected";
```

## Commands

Each command's type (`StatusData`, ...) lists the fields that follow
`command` in its result. Each example shows the text form, then the
JSON for the same state.

### `status`

```ts
interface StatusData {
  run?: RunSummary & {
    // How this sm-dev came to the run: it started it, attached to it, or
    // picked it otherwise (--run, or an earlier command on the line);
    // "other" for one listed with no run picked.
    connection?: "started" | "attached" | "selected" | "other";
    detached?: boolean;      // started with --detach
    sourceMonkey?: "installed" | "disabled" | "absent"; // left out when not known
    managers?: BrowserManager[]; // the managers in the browser; left out when not known
    testCollection?: string; // once a script was pushed
    log?: string;            // the run's log file
    downloads?: string;      // where a --temp-browser saves downloads
  };
  tabs: Tab[];
  tab?: string;          // the selected tab
  scripts: StatusScript[]; // the run's, then the installed ones on the tab
}

// A userscript manager extension in the browser, enabled or not.
interface BrowserManager {
  manager: ManagerName;
  name: string;          // as the extension names itself: "Tampermonkey BETA"
  version: string;
  id: string;            // its extension id
  enabled: boolean;
  userScripts: boolean;  // "Allow User Scripts" is on, which it needs to run scripts
}

// With no run picked (no --run, and no start or attach earlier in the
// line): the browser the line would use, and every active run's status,
// even when only one is going.
interface StatusRunsData {
  browser: BrowserStatus;
  runs: StatusData[];    // each with connection: "other"
}

interface BrowserStatus {
  address: string;       // --browser's, as host:port
  answering: boolean;    // whether a browser answers there
  version?: string;      // Chrome's, when it answers
  headless?: boolean;
  manager: ManagerName;  // the one --manager picks
  managers?: BrowserManager[]; // left out when not known
}

// The counts are for the run's scripts; installed ones have none.
interface StatusScript extends Script {
  menuCommands?: number; // on the selected tab
  values?: number;
  errors?: number;       // on the selected tab, or every tab with none
  lastError?: string;
  // Its permission prompts waiting for `connect`; the URL without its query.
  permissionPrompts?: { host: string; method: string; url: string }[];
}
```

Text, with `--run D1`. The first line's heading says how this sm-dev
came to the run: `Started run:`, `Started run (detached):`, `Attached
run:` or `Selected run:`.

```text
Selected run: D1 (pid 4171043), connected to owned headless browser 127.0.0.1:38583 (has SourceMonkey)
Managers: SourceMonkey 0.0.1 (in use)
Backend: SourceMonkey extension, test collection D1-f691
Log: /tmp/sm-dev-logs-me/sm-dev-20261003-085822-497.log (D1.log)
Downloads: /tmp/sm-dev-logs-me/sm-dev-20261003-085822-497-downloads
Tabs:
* T1: file:///home/me/gm-menu/gm-menu.html [targetId=CB4200EEA6397DAC9E7BC5A3B995A3A5]
   * 1: Menu example
Scripts (with status on active tab T1):
* 1: Menu example (scripts/gm-menu.user.js)
     Active
     1 menu command, 1 stored value
  2: Log example (scripts/gm-log.user.js)
     Not active
```

With no run picked, the browser the line would use, then every run,
each headed `Other run:`:

```text
No current run. (Use start or attach to connect to one.)
Browser: 127.0.0.1:9233 (Chrome 154.0.8037.57)
Managers: SourceMonkey 0.0.1 (chosen), Tampermonkey 5.5.1 (disabled)

Other active runs:

Other run: D1 (pid 4171043), connected to owned headless browser 127.0.0.1:38583 (has SourceMonkey)
...
```

(or `No other active runs`.)

JSON, with `--run D1` (without it: `{"command": "status", "browser":
{...}, "runs": [...]}`, each element this without `command`, with
`"connection": "other"`):

```json
{
  "command": "status",
  "run": {
    "id": "D1",
    "pid": 4171043,
    "browser": {
      "address": "127.0.0.1:38583",
      "owned": true,
      "headless": true
    },
    "manager": "sourcemonkey",
    "connection": "selected",
    "sourceMonkey": "installed",
    "managers": [
      {
        "manager": "sourcemonkey",
        "name": "SourceMonkey",
        "version": "0.0.1",
        "id": "bkgahdlbeddjginplgbipcefkefaflfa",
        "enabled": true,
        "userScripts": true
      }
    ],
    "testCollection": "D1-f691",
    "log": "/tmp/sm-dev-logs-me/sm-dev-20261003-085822-497.log",
    "downloads": "/tmp/sm-dev-logs-me/sm-dev-20261003-085822-497-downloads"
  },
  "tabs": [
    {
      "id": "T1",
      "url": "file:///home/me/gm-menu/gm-menu.html",
      "targetId": "CB4200EEA6397DAC9E7BC5A3B995A3A5",
      "selected": true,
      "scripts": [
        "1"
      ]
    }
  ],
  "tab": "T1",
  "scripts": [
    {
      "id": "1",
      "kind": "run",
      "name": "Menu example",
      "file": "scripts/gm-menu.user.js",
      "status": "ok",
      "selected": true,
      "tabs": [
        {
          "tab": "T1",
          "state": "running"
        }
      ],
      "menuCommands": 1,
      "values": 1,
      "errors": 0
    },
    {
      "id": "2",
      "kind": "run",
      "name": "Log example",
      "file": "scripts/gm-log.user.js",
      "status": "ok",
      "tabs": [
        {
          "tab": "T1",
          "state": "not-running"
        }
      ],
      "menuCommands": 0,
      "values": 0,
      "errors": 0
    }
  ]
}
```

### `list`

```ts
interface ListData {
  runs: RunSummary[];
}

interface RunSummary {
  id: string;            // "D1"
  pid: number;
  started?: string;      // ISO 8601, in list
  browser: { address: string; owned: boolean; headless: boolean };
  manager?: ManagerName; // the manager it works with (--manager)
  tabCount?: number;     // in list
  scriptFiles?: string[]; // in list: the loaded scripts' paths
}

type ManagerName = "sourcemonkey" | "tampermonkey" | "violentmonkey";
```

Text:

```text
Run  PID      Uptime  Browser                            Manager       Tabs  Scripts
D3   3732823  3h52m   127.0.0.1:9233                     SourceMonkey  2     bold-on-hover.user.js, config-value.user.js
D1   4161390  0s      127.0.0.1:41139 (owned, headless)  Tampermonkey  1     -
```

JSON:

```json
{
  "command": "list",
  "runs": [
    {
      "id": "D3",
      "pid": 3732823,
      "started": "2026-10-03T04:41:02.104Z",
      "browser": {
        "address": "127.0.0.1:9233",
        "owned": false,
        "headless": false
      },
      "manager": "sourcemonkey",
      "tabCount": 2,
      "scriptFiles": [
        "/home/me/scripts/bold-on-hover.user.js",
        "/home/me/scripts/config-value.user.js"
      ]
    },
    {
      "id": "D1",
      "pid": 4161390,
      "started": "2026-10-03T08:33:25.512Z",
      "browser": {
        "address": "127.0.0.1:41139",
        "owned": true,
        "headless": true
      },
      "manager": "tampermonkey",
      "tabCount": 1,
      "scriptFiles": []
    }
  ]
}
```

### `tabs`

```ts
interface TabsData {
  tabs: Tab[];
}
```

Text:

```text
Tabs:
* T1: file:///home/me/gm-menu/gm-menu.html [targetId=CB4200EEA6397DAC9E7BC5A3B995A3A5]
   * 1: Menu example
```

JSON:

```json
{
  "command": "tabs",
  "tabs": [
    {
      "id": "T1",
      "url": "file:///home/me/gm-menu/gm-menu.html",
      "targetId": "CB4200EEA6397DAC9E7BC5A3B995A3A5",
      "selected": true,
      "scripts": [
        "1"
      ]
    }
  ]
}
```

### `frames [tab|frame|all]`

```ts
interface FramesData {
  tabs: {
    tab: string;
    url: string;
    scripts: string[];   // the top frame's
    frames: Frame[];     // with a frame named, it and those in it
  }[];
}
```

JSON:

```json
{
  "command": "frames",
  "tabs": [
    {
      "tab": "T1",
      "url": "http://localhost:8765/frames/frames.html",
      "scripts": ["1", "3"],
      "frames": [
        { "id": "F1", "parent": "T1", "url": "http://localhost:8765/frames/frame-a.html", "scripts": ["1"] },
        { "id": "F2", "parent": "T1", "url": "http://127.0.0.1:8765/frames/frame-b.html", "scripts": ["1", "2"], "targetId": "C1E043C264F12D216F204784C021C567" },
        { "id": "F3", "parent": "F2", "url": "http://127.0.0.1:8765/frames/frame-nested.html", "scripts": ["1"] }
      ]
    }
  ]
}
```

### `scripts`

The run's scripts, then the installed scripts on the selected tab.

```ts
interface ScriptsData {
  tab?: string;          // the selected tab
  scripts: Script[];     // kind "run" first, then "installed"
}
```

Text:

```text
Loaded scripts (with status on active tab T1):
* 1: Menu example (scripts/gm-menu.user.js)
     Active
  2: Log example (scripts/gm-log.user.js)
     Not active
SourceMonkey-managed scripts on T1:
  E1: Dark mode (Scripts from web): SourceMonkey script not loaded in sm-dev tab
```

JSON:

```json
{
  "command": "scripts",
  "tab": "T1",
  "scripts": [
    {
      "id": "1",
      "kind": "run",
      "name": "Menu example",
      "file": "scripts/gm-menu.user.js",
      "status": "ok",
      "selected": true,
      "tabs": [
        {
          "tab": "T1",
          "state": "running"
        }
      ]
    },
    {
      "id": "2",
      "kind": "run",
      "name": "Log example",
      "file": "scripts/gm-log.user.js",
      "status": "ok",
      "tabs": [
        {
          "tab": "T1",
          "state": "not-running"
        }
      ]
    },
    {
      "id": "E2",
      "kind": "installed",
      "internalId": "9b2d4e61-7c3a-4b1f-8d5e-2a6f0c9e4b73",
      "name": "Broken",
      "location": "file:///home/me/scripts/broken.user.js",
      "collection": {
        "id": "C1",
        "name": "Scripts from local disk"
      },
      "enabled": true,
      "status": "invalid",
      "error": "The script has a syntax error: Unexpected end of input (in broken.user.js, line 12)"
    },
    {
      "id": "E1",
      "kind": "installed",
      "name": "Dark mode",
      "collection": {
        "name": "Scripts from web"
      },
      "tabs": [
        {
          "tab": "T1",
          "state": "kept-out"
        }
      ]
    }
  ]
}
```

### `values [what]`

```ts
interface ValuesData {
  tab?: string;          // values T2: only the scripts running there
  scripts: { script: string; name: string; values: Record<string, unknown> }[];
}
```

Text:

```text
Stored values:
* 1: Menu example (scripts/gm-menu.user.js)
    foo = {"a":1}
  2: Log example (scripts/gm-log.user.js)
    Nothing stored
```

JSON:

```json
{
  "command": "values",
  "scripts": [
    {
      "script": "1",
      "name": "Menu example",
      "values": {
        "foo": {
          "a": 1
        }
      }
    },
    {
      "script": "2",
      "name": "Log example",
      "values": {}
    }
  ]
}
```

### `get <key>`

```ts
interface GetData {
  script: string;
  key: string;
  found: boolean;        // false: not stored, and no value
  value?: unknown;
}
```

Text:

```text
  foo = {"a":1}
```

JSON:

```json
{
  "command": "get",
  "script": "1",
  "key": "foo",
  "found": true,
  "value": {
    "a": 1
  }
}
```

### `match`

```ts
interface MatchData {
  results: {
    script: string;      // its id in a run, else its file or URL
    name: string;
    valid: boolean;      // false: it can't run anywhere
    error?: string;      // why it is invalid
    pages: {
      url: string;
      tab?: string;
      matches: boolean;
      matchedBy: string[];
      excludedBy?: string[]; // absent for none
      frames?: MatchFrame[]; // with --frames, a tab's iframes
    }[];
  }[];
}

// An iframe, checked by its own URL.
interface MatchFrame {
  id: string;            // "F3"
  parent: string;        // "T1", or another frame's id
  url: string;
  matches: boolean;      // false for a @noframes script
  matchedBy: string[];
  excludedBy?: string[];
  noframes?: true;       // its rules match, but @noframes keeps it out
}
```

Text:

```text
Where  Result  Rules  URL
T1     match   M1     file:///home/me/gm-menu/gm-menu.html
Rules:
  M1: @match file:///*/gm-menu/gm-menu.html
```

JSON:

```json
{
  "command": "match",
  "results": [
    {
      "script": "1",
      "name": "Menu example",
      "valid": true,
      "pages": [
        {
          "url": "file:///home/me/gm-menu/gm-menu.html",
          "tab": "T1",
          "matches": true,
          "matchedBy": [
            "@match file:///*/gm-menu/gm-menu.html"
          ]
        }
      ]
    }
  ]
}
```

- The exit code still shows whether every page matched.

### `validate`

```ts
interface ValidateData {
  results: {
    script: string;      // its file or URL
    verdict: "ok" | "invalid" | "unchecked";
    error?: string;      // why it is invalid, or couldn't be checked
    warnings?: string[]; // absent when there are none
  }[];
}
```

Text:

```text
INVALID  bad.user.js
    @match nope has no path, so this script would never run on any page; add a trailing "/*" to match all pages on that host (in bad.user.js, line 3)
ok       scripts/gm-log.user.js

1 ok, 1 invalid
```

JSON:

```json
{
  "command": "validate",
  "results": [
    {
      "script": "bad.user.js",
      "verdict": "invalid",
      "error": "@match nope has no path, so this script would never run on any page; add a trailing \"/*\" to match all pages on that host (in bad.user.js, line 3)"
    },
    {
      "script": "scripts/gm-log.user.js",
      "verdict": "ok"
    }
  ]
}
```

### `menu [what]`

Listing only: `menu`, `menu T2`, `menu all`. Firing one prints text.

```ts
interface MenuData {
  tabs: {
    tab: string;
    url: string;
    // `builtin: "run"`: a manual script's "Run this script", listed
    // first under it whether or not it has run.
    commands: {
      id: string; script: string; name: string; builtin?: "run";
      frame?: string;    // registered in an iframe: its id ("F3")
    }[];
  }[];
}
```

Text:

```text
Menu commands:
* 1: Menu example (scripts/gm-menu.user.js)
    M1: Say hello
    M2: Reset counter
```

JSON:

```json
{
  "command": "menu",
  "tabs": [
    {
      "tab": "T1",
      "url": "file:///home/me/gm-menu/gm-menu.html",
      "commands": [
        {
          "id": "M1",
          "script": "1",
          "name": "Say hello"
        },
        {
          "id": "M2",
          "script": "1",
          "name": "Reset counter"
        }
      ]
    }
  ]
}
```

### `logs [tab|all] [script]`

```ts
interface LogsData {
  tab?: string;    // the tab asked for; absent for `all`
  script?: string; // the script asked for
  lines: LogLine[];
  until: number;   // the position reached, as a log ID, for --since
}

interface LogLine {
  id: number;      // log ID: when it arrived, in microseconds since the epoch
  time: string;    // ISO 8601
  tab?: string;
  frame?: string;  // from an iframe of the tab: its id ("F3")
  script?: string;
  source: "sm" | "event" | "script" | "page";
  also?: ("sm" | "event" | "script" | "page")[]; // other sources it belongs to
  kind: string;    // console type, Log entry level, or event name
  text: string;
}
```

See [sm-dev-logs.md](sm-dev-logs.md) for the sources and positions.
The `[sm-dev] Logs up to ...` line goes to stderr.

Text:

```text
08:58:22.904 T1 [event] Loaded file:///home/me/gm-menu/gm-menu.html
08:58:22.961 T1 [event] Menu example started on file:///home/me/gm-menu/gm-menu.html
08:58:22.963 T1 [event] GM_registerMenuCommand "Say hi"
[sm-dev] Logs up to 1791043102963118 (08:58:22.963)
```

JSON:

```json
{
  "command": "logs",
  "tab": "T1",
  "lines": [
    {
      "id": 1791043102904266,
      "time": "2026-10-03T15:58:22.904Z",
      "tab": "T1",
      "source": "event",
      "kind": "load",
      "text": "Loaded file:///home/me/gm-menu/gm-menu.html"
    },
    {
      "id": 1791043102961530,
      "time": "2026-10-03T15:58:22.961Z",
      "tab": "T1",
      "script": "1",
      "source": "event",
      "kind": "started",
      "text": "Menu example started on file:///home/me/gm-menu/gm-menu.html"
    },
    {
      "id": 1791043102963118,
      "time": "2026-10-03T15:58:22.963Z",
      "tab": "T1",
      "script": "1",
      "source": "event",
      "kind": "menu-command",
      "text": "GM_registerMenuCommand \"Say hi\""
    }
  ],
  "until": 1791043102963118
}
```

### `probe [tab] <selector>...`

```ts
interface ProbeData {
  tab: string;           // the tab probed
  url: string;           // its page
  selectors: {
    selector: string;
    count?: number;      // absent when the selector is invalid
    error?: string;      // why the selector is invalid
    frame?: string;      // with --css / --html, for matches in an iframe: F2
    matches?: { css?: string; html?: string }[]; // with --css / --html; css works within frame
  }[];
}
```

Text:

```text
found    body  (1)
missing  h1
```

JSON:

```json
{
  "command": "probe",
  "tab": "T1",
  "url": "file:///home/me/gm-menu/gm-menu.html",
  "selectors": [
    {
      "selector": "body",
      "count": 1
    },
    {
      "selector": "h1",
      "count": 0
    }
  ]
}
```

### `collection list`

Also `collection`, `collections` and `collections list`.

```ts
interface CollectionListData {
  collections: Collection[];
}
```

- Numbered collections first, by number, then runs' test collections.

Text:

```text
Collections in SourceMonkey:
  C1: Scripts from local disk (container): 3 scripts
  C2: Scripts from web (container): 1 script
  C3: My scripts (directory): 7 scripts, disabled
      file:///home/me/scripts/
  D1: sm-dev test collection (run D1-3fa2) (container): 2 scripts
```

- A location is shown under the name, unless it is the name.

JSON:

```json
{
  "command": "collection list",
  "collections": [
    {
      "id": "C1",
      "internalId": "6b1e2f0a-4c3d-4e5f-8a9b-0c1d2e3f4a5b",
      "name": "Scripts from local disk",
      "kind": "container",
      "enabled": true,
      "status": "ok",
      "scriptCount": 3
    },
    {
      "id": "C3",
      "internalId": "0f9e8d7c-6b5a-4c3d-2e1f-0a9b8c7d6e5f",
      "name": "My scripts",
      "kind": "directory",
      "location": "file:///home/me/scripts/",
      "enabled": false,
      "status": "ok",
      "scriptCount": 7
    },
    {
      "id": "D1",
      "internalId": "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d",
      "name": "sm-dev test collection (run D1-3fa2)",
      "kind": "container",
      "runCollection": "D1",
      "enabled": true,
      "status": "ok",
      "scriptCount": 2
    }
  ]
}
```

(`C2` left out here.)

### `script list [collection]`

```ts
interface ScriptListData {
  collection?: CollectionRef; // when one was named
  scripts: Script[];          // kind "installed", no `tabs`
}
```

- The JSON is a flat list, each script naming its collection, so it has
  the same `Script` shape as every other listing. The text groups the
  scripts under their collections, for reading.
- `collection <collection> show` gives one collection with its scripts
  nested.
- Runs' test collections' scripts are listed too, with `kind: "run"`.
  - In its own run, a script has its number there (`"1"`).
  - Elsewhere, it has no `id`, since only its run knows its number.
  - `file` is its path as the run was given it (often relative to where
    the run started), and the text shows that. `location` is its
    file's `file://` URL.
- In a run, the selected script has `selected: true`, and `*` in the
  text.

Text:

```text
C1: Scripts from local disk
  E2: Broken: INVALID
      file:///home/me/scripts/broken.user.js
      The script has a syntax error: Unexpected end of input (in broken.user.js, line 12)
C2: Scripts from web
  E1: Dark mode 2.1
      https://example.org/dark-mode.user.js
```

JSON:

```json
{
  "command": "script list",
  "scripts": [
    {
      "id": "E2",
      "kind": "installed",
      "internalId": "9b2d4e61-7c3a-4b1f-8d5e-2a6f0c9e4b73",
      "name": "Broken",
      "location": "file:///home/me/scripts/broken.user.js",
      "collection": {
        "id": "C1",
        "name": "Scripts from local disk"
      },
      "enabled": true,
      "status": "invalid",
      "error": "The script has a syntax error: Unexpected end of input (in broken.user.js, line 12)"
    },
    {
      "id": "E1",
      "kind": "installed",
      "internalId": "3f6c0a52-0d4e-4f8e-9a8e-6f1c2b7d9e10",
      "name": "Dark mode",
      "version": "2.1",
      "location": "https://example.org/dark-mode.user.js",
      "collection": {
        "id": "C2",
        "name": "Scripts from web"
      },
      "enabled": true,
      "status": "ok"
    }
  ]
}
```

### `script [script] show`

```ts
interface ScriptShowData {
  script: ScriptDetails;
}

interface ScriptDetails extends Script {
  description?: string;
  author?: string;
  updatedAt?: string;       // when its current text was loaded, ISO 8601
  matching: {
    match: string[];
    include: string[];
    exclude: string[];
    excludeMatch: string[];
  };
  runAt: string;            // "document-idle" when the header gives none
  grants: string[];
  requires: FileStatus[];
  resources: (FileStatus & { name: string })[];
  valueCount?: number;      // none when the manager doesn't say
}

interface FileStatus {
  url: string;              // as the header gives it
  status?: "ok" | "not-loaded"; // not-loaded when the script failed to load;
                            // none when the manager doesn't say
  local?: string;           // the local file read instead, if any
}
```

Text:

```text
E1: Dark mode 2.1
  Namespace:    https://example.org
  Description:  Dark colors on example.com
  Collection:   C2: Scripts from web
  Location:     https://example.org/dark-mode.user.js
  Status:       Enabled, ok
  Updated:      2026-09-28 19:03
  @match:       https://example.com/*
  @run-at:      document-start
  @grant:       GM_addStyle, GM_getValue, GM_setValue
  @require:     https://cdn.example.org/lib.js (ok)
  Tabs:         T1: SourceMonkey script not loaded in sm-dev tab
  Values:       2 stored (values E1 to see them)
```

JSON:

```json
{
  "command": "script show",
  "script": {
    "id": "E1",
    "kind": "installed",
    "internalId": "3f6c0a52-0d4e-4f8e-9a8e-6f1c2b7d9e10",
    "name": "Dark mode",
    "namespace": "https://example.org",
    "version": "2.1",
    "description": "Dark colors on example.com",
    "location": "https://example.org/dark-mode.user.js",
    "collection": {
      "id": "C2",
      "name": "Scripts from web"
    },
    "enabled": true,
    "status": "ok",
    "updatedAt": "2026-09-28T19:03:11Z",
    "matching": {
      "match": [
        "https://example.com/*"
      ],
      "include": [],
      "exclude": [],
      "excludeMatch": []
    },
    "runAt": "document-start",
    "grants": [
      "GM_addStyle",
      "GM_getValue",
      "GM_setValue"
    ],
    "requires": [
      {
        "url": "https://cdn.example.org/lib.js",
        "status": "ok"
      }
    ],
    "resources": [],
    "tabs": [
      {
        "tab": "T1",
        "state": "kept-out"
      }
    ],
    "valueCount": 2
  }
}
```

- `tabs` is there in a run only: what the script does on each of the
  run's tabs.
- The text leaves out a row with nothing in it.

### `script [script] print`

```ts
interface ScriptPrintData {
  script?: string;       // its id; none for another run's script
  name: string;
  file?: {               // with --file: the file printed
    kind: 'require' | 'resource';
    url: string;
    name?: string;       // a @resource's
  };
  text?: string;         // the installed text; none with --out
  out?: string;          // with --out: the file written, absolute
}
```

- The text form is the text alone, or with `--out`, `Wrote <file> (N
  bytes)`.

### `script [script] save <dir>`

```ts
interface ScriptSaveData {
  script?: string;       // its id; none for another run's script
  name: string;
  dir: string;           // absolute
  files: {
    kind: 'script' | 'require' | 'resource';
    url?: string;
    name?: string;       // a @resource's
    path: string;        // absolute
  }[];
  notes?: string[];      // what wasn't saved, and why
}
```

Text:

```text
Saved E3: Dark mode to out: 2 files
  out/dark.user.js
  out/cdn.example.com/lib/x.js
```

### `collection <collection> show`

```ts
interface CollectionShowData {
  collection: Collection & { scripts: Script[] };
}
```

Text:

```text
C3: My scripts
  Kind:       directory
  Location:   file:///home/me/scripts/
  Status:     Enabled
  Scripts:    2 scripts
  E4: Dark mode 2.1
  E5: Broken: INVALID
```

### Commands that change things

`collection enable`, `disable` and `rename`, and `script enable`,
`disable`, `install` and `move`, give the object as it is after the
change, and `script uninstall` as it was:

```ts
interface CollectionChangeData { collection: Collection }
interface ScriptChangeData {
  script: Script;
  removed?: true;        // script uninstall: the script as it was
  turnedOff?: Script[];  // enable, move, install: its other running copies, now off
  collectionDisabled?: true; // enabled, but its collection is disabled
}
interface ScriptInstallData {
  script: Script;
  turnedOff?: Script[];
  collectionDisabled?: true;
  already?: true;        // it was installed there already: nothing changed
  replaced?: true;       // under another manager: it replaced the script
                         // with the same name and namespace
}
```

- The text form starts with one line: `Disabled E4: Dark mode`,
  `Installed E6: Solo in C1: Scripts from local disk`.
  - Then a line for each copy turned off, and one when its collection
    is disabled (see [sm-dev-managers.md](sm-dev-managers.md)).
- `turnedOff` and `collectionDisabled` are left out when they don't
  apply.
- A change sm-dev or SourceMonkey refuses is a failure, as text on
  stderr, like any other.

The refreshes say what they updated:

```ts
interface ScriptRefreshData {
  script: Script;
  updated: boolean;      // it loaded different text
}
interface CollectionRefreshData {
  collection: Collection;
  updated: Script[];     // added, or loaded different text
  unchanged: number;
  removed: Script[];     // gone, as they were
  failed?: Script[];     // under TM or VM: couldn't be refreshed, each with refreshError
}
```

Text:

```text
Refreshed C3: My scripts: 1 updated, 4 unchanged, 1 removed
  Updated E7: New one
  Removed E5: Broken
```

- `script refresh` on one of the run's own scripts re-reads it from
  disk, as `update` does: its text is what `update` prints, and its
  JSON a `ScriptRefreshData`.

### What a result covers

- A list of things usually not there (`validate`'s `warnings`,
  `match`'s `excludedBy`) is left out when empty, as an `error` is, so
  the output is easier to scan.
- Any other list is kept when empty: `[]` means there are none (a menu's
  `commands`, `match`'s `matchedBy`).

- A result focused on one thing names it, so an empty list still shows
  where nothing was found: `menu` and `logs` give their `tab`, `values
  T2` its `tab`, `get` its `script` and `key`, `probe` its `tab` and
  `url`.
- New commands follow the same rule: `script list C2` names its
  `collection`.

### Commands without a JSON form

- `snapshot`, `eval` and `cdp` already print their own formats, and
  keep them under `--json`. `eval` and `cdp` print JSON values already.
  - An `eval` result over 10,000 characters is cut, so it no longer
    parses. Use `eval --out FILE` for those.
- `set`, the commands that pick (`tab T2`, `script 2`) and the ones that
  act on the page (`click`, `open`, `wait`, ...) print what they print
  now.
- A program mixing these with JSON commands reads each command's output
  knowing which command it sent.

## Planned commands

These come with [sm-dev-managers.md](sm-dev-managers.md).

- `collection add` gives the collection after, as the
  [commands that change things](#commands-that-change-things) do.
- `collection drop` gives the collection as it was, with
  `removed: true`.

## Events

A run reports things as they happen, between and during commands. In
text mode these are the `[event] ... started on ...` lines and the
console lines.

```ts
interface Event {
  type: "event";
  time: string;          // ISO 8601
  event:
    | "script-started" | "script-skipped" | "script-error"
    | "console" | "tab-opened" | "tab-closed" | "dialog"
    | "request" | "download" | "notification";
  tab?: string;
  script?: string;
  // ...fields for each event, matching the extension's event stream
}
```

```json
{
  "type": "event",
  "time": "2026-10-03T08:33:37.112Z",
  "event": "script-started",
  "tab": "T1",
  "script": "1",
  "url": "file:///home/me/gm-menu/gm-menu.html"
}
```

## Decisions

- **`--json=single` and `--json=multi` choose the layout**, over the
  terminal-or-pipe default, on the global option or one command.
- **Other log messages stay text on stderr.** Results already carry what a
  program needs. Revisit if a consumer wants them as events.
- **Event fields are settled when events are built**, from the
  extension's sm-dev event stream
  ([sm-dev-design.md](sm-dev-design.md#the-event-stream)).
- **A JSON Schema file ships with the package** (see
  [Schema file](#schema-file-not-built-yet)).
