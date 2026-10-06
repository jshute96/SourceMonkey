# Testing under other managers

A run can load its scripts into **Tampermonkey** (TM) or
**Violentmonkey** (VM) instead of SourceMonkey: to check a script is
portable across managers, or to debug something that works in one but
not another. Both work the same way; the examples use VM, and
`--manager tm` does the same under TM. Runs under each can go side by
side, with different `--run` ids, to compare.

```sh
pnpm sm-dev --manager vm manager fetch     # once: download VM into sm-dev's cache
R="pnpm sm-dev --manager vm --run Dvm"

$R --temp-browser start sites/x/y.user.js https://x.com/ --detach
$R scripts                                 # each tab's expected scripts, with their VM ids
$R logs                                    # the script's console lines and errors
$R stop                                    # removes the run's scripts from VM
```

- `--manager vm` goes before the command, and the run keeps it: later
  commands to the run work without it.
- `--temp-browser` loads the fetched manager, fetching it the first
  time, and lets scripts run on local `file://` pages:
  - VM blocks them by default, and sm-dev clears that in a
    `--temp-browser`;
  - TM needs Chrome's file access, which is on for the unpacked copy a
    `--temp-browser` loads, but off by default for one from the Chrome
    Web Store.
- For a site that needs a login, the person's `--open-browser` browser
  needs VM: `pnpm sm-dev --manager vm manager install`. Ask first, and
  about turning SourceMonkey off there (`--manager sm manager
  disable`), since every enabled manager runs its scripts.
- The run's scripts go into the manager as ordinary scripts, marked by
  a last line `// sm-dev: run=...`, and are removed when the run ends.
  - Under TM, local `@require` lines show rewritten to
    `https://sm-dev.invalid/...` in TM's editor: TM can't resolve them
    otherwise. `script print` shows them as written.
  - Each keeps its run number, with its VM id beside it: `1: Hello
    (hello.user.js), E6 in Violentmonkey`. Either names it.
  - `start` refuses a script VM already has by the same name and
    namespace, naming it. Ask the person before
    `script E<n> uninstall --force` to make room.

What differs from SourceMonkey:

- **Nothing reports what ran.** `scripts` and `status` list the run's
  scripts under `Expected on tab T1 using match rules:` and `Not
  expected on tab T1:`, from their headers. Check the page itself
  (`snapshot`, `eval --page`) to see a script worked.
- **Every script in the manager runs in every tab**, the person's own and other
  runs' too: nothing keeps them out of the run's tabs.
- **No reach into a script:** `values`, `get`, `set`, `menu`,
  `connect` and `--values` are refused, and `eval` runs in the page,
  not inside the script.
- **A script's uncaught error** is a `[script error]` log line, not a
  `threw` event.
- `collection` and `script` work on the manager's scripts, in one
  collection, `C0`, whose `disable` turns all its scripts off.
- Under TM, saving needs its "Easy save" setting on, as it is by
  default; sm-dev says so when it's off.
- More: [sm-dev-violentmonkey.md](https://github.com/jshute96/SourceMonkey/blob/main/docs/sm-dev-violentmonkey.md)
  and [sm-dev-tampermonkey.md](https://github.com/jshute96/SourceMonkey/blob/main/docs/sm-dev-tampermonkey.md).
