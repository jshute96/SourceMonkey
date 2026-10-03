# sm-dev: JSON output

Status: built for the existing commands. The
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
  id?: string;           // "C2", once collections have ids
  name: string;
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
  scripts: string[];     // the ids of the run's scripts running in it
}

// A script: one the run loaded ("1"), or one installed in
// SourceMonkey ("E1").
interface Script {
  id: string;
  kind: "run" | "installed";
  name: string;
  file?: string;         // run's scripts: the path it was loaded from
  collection?: CollectionRef; // installed: the collection holding it
  status?: "ok" | "invalid"; // run's scripts
  error?: string;        // why it is invalid
  selected?: boolean;    // the script get and set act on
  tabs?: TabActivity[];  // in scripts and status
}

// What a script is doing on one tab.
interface TabActivity {
  tab: string;           // "T1"
  state: TabState;
}

type TabState =
  | "running"
  | "not-running"        // a run's script that isn't running there
  // An installed script, as the toolbar badge says:
  | "error"              // started, then threw
  | "refused"            // Chrome refused to run it
  | "not-started"        // it matches, but hasn't started
  | "unexpected"         // running, though it doesn't match
  | "changed"            // changed since it started
  | "kept-out";          // matches, but the run's claim keeps it out
```

## Commands

Each command's type (`StatusData`, ...) lists the fields that follow
`command` in its result. Each example shows the text form, then the
JSON for the same state.

### `status`

```ts
interface StatusData {
  run?: RunSummary & {
    sourceMonkey?: "installed" | "disabled" | "absent"; // left out when not known
    testCollection?: string; // once a script was pushed
    log?: string;            // the run's log file
  };
  tabs: Tab[];
  tab?: string;          // the selected tab
  scripts: StatusScript[]; // the run's, then the installed ones on the tab
}

// With no run picked (no --run, and no start or attach earlier in the
// line), every active run's, even when only one is going.
interface StatusRunsData {
  runs: StatusData[];
}

// The counts are for the run's scripts; installed ones have none.
interface StatusScript extends Script {
  menuCommands?: number; // on the selected tab
  values?: number;
  errors?: number;       // on the selected tab, or every tab with none
  lastError?: string;
}
```

Text (with several runs, each run's in turn, a blank line between):

```text
Run: D1 (pid 4171043), connected to owned headless browser 127.0.0.1:38583 (has SourceMonkey)
Backend: SourceMonkey extension, test collection D1-f691
Log: /tmp/sm-dev-logs-me/sm-dev-20261003-085822-497.log (D1.log)
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

JSON, with `--run D1` (without it: `{"command": "status", "runs": [...]}`,
each element this without `command`):

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
    "sourceMonkey": "installed",
    "testCollection": "D1-f691",
    "log": "/tmp/sm-dev-logs-me/sm-dev-20261003-085822-497.log"
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
  tabCount?: number;     // in list
  scriptFiles?: string[]; // in list: the loaded scripts' paths
}
```

Text:

```text
Run  PID      Uptime  Browser                            Tabs  Scripts
D3   3732823  3h52m   127.0.0.1:9233                     2     bold-on-hover.user.js, config-value.user.js
D1   4161390  0s      127.0.0.1:41139 (owned, headless)  1     gm-menu.user.js
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
      "tabCount": 1,
      "scriptFiles": [
        "/home/me/scripts/gm-menu.user.js"
      ]
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
  E1: Dark mode (Scripts from web): Kept out of the run's tabs
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
    }[];
  }[];
}
```

Text:

```text
match    file:///home/me/gm-menu/gm-menu.html (T1)
    Matched by:  @match file:///*/gm-menu/gm-menu.html
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

- The exit code still says whether every page matched.

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
    commands: { id: string; script: string; name: string }[];
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

### `logs [tab]`

```ts
interface LogsData {
  tab: string;
  pages: { url?: string; lines: string[] }[]; // each page load, oldest first
}
```

Text:

```text
--- file:///home/me/gm-menu/gm-menu.html
[log] [SourceMonkey] script Menu example running on file:///home/me/gm-menu/gm-menu.html
```

JSON:

```json
{
  "command": "logs",
  "tab": "T1",
  "pages": [
    {
      "url": "file:///home/me/gm-menu/gm-menu.html",
      "lines": [
        "[log] [SourceMonkey] script Menu example running on file:///home/me/gm-menu/gm-menu.html"
      ]
    }
  ]
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
    matches?: { css?: string; html?: string }[]; // with --css / --html
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

### Saying what a result covers

- A list of things usually not there (`validate`'s `warnings`,
  `match`'s `excludedBy`) is left out when empty, as an `error` is, so
  the output is easier to scan.
- Any other list is kept when empty: `[]` says there are none (a menu's
  `commands`, `match`'s `matchedBy`).

- A result focused on one thing names it, so an empty list still says
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

These come with [sm-dev-managers.md](sm-dev-managers.md). For them,
`Script` gains the fields an installed script has: `managerId` (the
manager's own id), `namespace`, `version`, `location`, and `enabled`,
with `"load-failed"` and `"not-loaded"` added to its `status`.

### Collection

```ts
interface Collection {
  id: string;            // "C2"
  managerId?: string;
  name: string;
  kind: "container" | "directory" | "manifest" | "all-scripts";
  location?: string;     // directory or manifest; none for a container
  runCollection?: string; // the run id, for a run's test collection
  enabled: boolean;
  status: "ok" | "load-failed" | "not-loaded";
  error?: string;
  scriptCount: number;
  scripts?: Script[];    // in `collection show`
}
```

- `all-scripts` is the one collection TM and VM show.

### Manager

```ts
interface Manager {
  name: "sourcemonkey" | "tampermonkey" | "violentmonkey";
  extensionId: string;
  version: string;
  enabled: boolean;
  userScriptsAllowed: boolean;
  chosen: boolean;       // the one --manager picks
  source: "unpacked" | "store" | "fetched"; // how it got into the browser
}
```

### `script list [C]`

```ts
interface ScriptListData {
  collection?: CollectionRef; // when one was named
  scripts: Script[];          // kind "installed", no `tabs`
}
```

- The JSON is a flat list, each script naming its collection, so it has
  the same `Script` shape as every other listing. The text groups the
  scripts under their collections, for reading.
- `collection show <C>` gives one collection with its scripts nested.

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
      "id": "E1",
      "kind": "installed",
      "managerId": "3f6c0a52-0d4e-4f8e-9a8e-6f1c2b7d9e10",
      "name": "Dark mode",
      "version": "2.1",
      "location": "https://example.org/dark-mode.user.js",
      "collection": {
        "id": "C2",
        "name": "Scripts from web"
      },
      "enabled": true,
      "status": "ok"
    },
    {
      "id": "E2",
      "kind": "installed",
      "managerId": "9b2d4e61-7c3a-4b1f-8d5e-2a6f0c9e4b73",
      "name": "Broken",
      "location": "file:///home/me/scripts/broken.user.js",
      "collection": {
        "id": "C1",
        "name": "Scripts from local disk"
      },
      "enabled": true,
      "status": "invalid",
      "error": "The script has a syntax error: Unexpected end of input (in broken.user.js, line 12)"
    }
  ]
}
```

### `script show <id>`

```ts
interface ScriptShowData {
  script: ScriptDetails;
}

interface ScriptDetails extends Script {
  description?: string;
  author?: string;
  localOverride?: boolean;  // a local file stands in for its URL
  refreshed?: string;       // ISO 8601 times
  changed?: string;
  matching: {
    match: string[];
    include: string[];
    exclude: string[];
    excludeMatch: string[];
  };
  runAt: string;            // "document-idle"
  grants: string[];
  requires: FileStatus[];
  resources: (FileStatus & { name: string })[];
  valueCount: number;
}

interface FileStatus {
  url: string;
  status: "ok" | "load-failed" | "not-loaded";
  local?: string;           // the local file used instead, if any
  error?: string;
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
  Refreshed:    2026-10-03 08:12, changed 2026-09-28 19:03
  @match:       https://example.com/*
  @run-at:      document-start
  @grant:       GM_addStyle, GM_getValue, GM_setValue
  @require:     https://cdn.example.org/lib.js (ok)
  Tabs:         T1: Kept out of the run's tabs
  Values:       2 stored (values E1 to see them)
```

JSON:

```json
{
  "command": "script show",
  "script": {
    "id": "E1",
    "kind": "installed",
    "managerId": "3f6c0a52-0d4e-4f8e-9a8e-6f1c2b7d9e10",
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
    "refreshed": "2026-10-03T08:12:40Z",
    "changed": "2026-09-28T19:03:11Z",
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

### `script print <id>`

```ts
interface ScriptPrintData {
  script: string;        // its id
  text: string;          // the installed text
}
```

### `collection list`

```ts
interface CollectionListData {
  collections: Collection[];  // without `scripts`
}
```

Text:

```text
Collections in SourceMonkey:
  C1: Scripts from local disk (container): 3 scripts
  C2: Scripts from web (container): 1 script
  C3: scripts (directory): 7 scripts, disabled
      file:///home/me/scripts/
  C4: sm-dev test collection (run D1) (container): 2 scripts, run D1
```

JSON:

```json
{
  "command": "collection list",
  "collections": [
    {
      "id": "C1",
      "managerId": "container:file",
      "name": "Scripts from local disk",
      "kind": "container",
      "enabled": true,
      "status": "ok",
      "scriptCount": 3
    },
    {
      "id": "C2",
      "managerId": "container:http",
      "name": "Scripts from web",
      "kind": "container",
      "enabled": true,
      "status": "ok",
      "scriptCount": 1
    },
    {
      "id": "C3",
      "managerId": "file:///home/me/scripts/",
      "name": "scripts",
      "kind": "directory",
      "location": "file:///home/me/scripts/",
      "enabled": false,
      "status": "ok",
      "scriptCount": 7
    },
    {
      "id": "C4",
      "managerId": "container:sm-dev:D1",
      "name": "sm-dev test collection (run D1)",
      "kind": "container",
      "runCollection": "D1",
      "enabled": true,
      "status": "ok",
      "scriptCount": 2
    }
  ]
}
```

### `collection show <C>`

```ts
interface CollectionShowData {
  collection: Collection;     // with `scripts`
}
```

### `manager list`

```ts
interface ManagerListData {
  managers: Manager[];
}
```

Text:

```text
Userscript managers:
* SourceMonkey 0.9.0 [abcdefghijklmnopabcdefghijklmnop] (unpacked)
  Violentmonkey 2.31.0 [jinjaccalgkegednnccohejagnlnfdag] (fetched): disabled
```

JSON:

```json
{
  "command": "manager list",
  "managers": [
    {
      "name": "sourcemonkey",
      "extensionId": "abcdefghijklmnopabcdefghijklmnop",
      "version": "0.9.0",
      "enabled": true,
      "userScriptsAllowed": true,
      "chosen": true,
      "source": "unpacked"
    },
    {
      "name": "violentmonkey",
      "extensionId": "jinjaccalgkegednnccohejagnlnfdag",
      "version": "2.31.0",
      "enabled": false,
      "userScriptsAllowed": true,
      "chosen": false,
      "source": "fetched"
    }
  ]
}
```

### Commands that change things

`script install`, `script enable`, `collection add`, `collection
rename` and the rest return the object as it is after the change:

```ts
interface ScriptChangeData { script: Script }
interface CollectionChangeData { collection: Collection }
interface ManagerChangeData { manager: Manager }
```

- `script uninstall`, `collection drop`: the object as it was, with
  `removed: true`.
- `manager fetch` / `update`:
  `{ name, version, path, updated: boolean }`.

## Events

A run reports things as they happen, between and during commands. In
text mode these are the `[sm-dev] ... started on ...` lines and the
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
