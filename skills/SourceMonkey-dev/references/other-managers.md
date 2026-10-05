# Testing under other managers

A run can load its scripts into **Violentmonkey** (VM) instead of
SourceMonkey, to check a script behaves the same under a manager its
users have. Tampermonkey (TM) isn't supported for this yet: `--manager
tm` runs only drive pages, loading no scripts.

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
- `--temp-browser` loads the fetched VM, fetching it the first time,
  and lets scripts run on local `file://` pages, which VM otherwise
  blocks.
- For a site that needs a login, the person's `--open-browser` browser
  needs VM: `pnpm sm-dev --manager vm manager install`. Ask first, and
  about turning SourceMonkey off there (`--manager sm manager
  disable`), since every enabled manager runs its scripts.
- The run's scripts go into VM as ordinary scripts, marked by a last
  line `// sm-dev: run=...`, and are removed when the run ends.
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
- **Every VM script runs in every tab**, the person's own and other
  runs' too: nothing keeps them out of the run's tabs.
- **No reach into a script:** `values`, `get`, `set`, `menu`,
  `connect` and `--values` are refused, and `eval` runs in the page,
  not inside the script.
- **A script's uncaught error** is a `[script error]` log line, not a
  `threw` event.
- `collection` and `script` work on VM's scripts, in one collection,
  `C0`, whose `disable` turns all VM's scripts off.
- More: [sm-dev-external-managers.md](https://github.com/jshute96/SourceMonkey/blob/main/docs/sm-dev-external-managers.md).
