# sm-dev: managing userscript managers (design draft)

Status: proposal. Only `--json` on the existing commands is built (see
[sm-dev-json.md](sm-dev-json.md)).

sm-dev today runs scripts *through* SourceMonkey in a run's own test
collection. This adds commands to look at and change what a userscript
manager has installed: its collections, its scripts, and the extension
itself. They target SourceMonkey first, and are shaped so Tampermonkey
(TM) and Violentmonkey (VM) can implement them later.

## Goals

- See what a browser's manager has installed, with its status, from the
  command line.
- Add, remove, enable, disable and refresh scripts and collections
  without clicking through the manager's pages.
- Fetch and load a manager into a browser, for testing a script under
  TM or VM.
- Give machine-readable output (`--json`) for everything that lists or
  reports state.

## Non-goals (for now)

- Running sm-dev's own commands (reports, `get`/`set`, `menu`, tab
  claims) under TM or VM. Those stay SourceMonkey-only; see
  [What works under each manager](#what-works-under-each-manager).
- Editing a manager's settings.

## Choosing the manager

- **`--manager <name>`**: a global option, default SourceMonkey.
  - The name is `sm`, `tm` or `vm`, or the full `sourcemonkey`,
    `tampermonkey` or `violentmonkey`, in any case (`SM`,
    `Tampermonkey`).
  - Picks which extension the management commands talk to.
  - With `--temp-browser`, also picks which extension the temp browser
    loads.
- A browser can have several managers at once. The commands only talk
  to the one chosen, so a kept browser can hold all three.

## Where the commands run

- **No run needed.** They need a browser, not a run. Without a run,
  sm-dev connects to `--browser`, runs the command, and disconnects,
  the same way `match` and `validate` work without one.
- **In a run.** They talk to the run's browser.
- **`--temp-browser` with no run** would make a browser and drop it
  straight away, so it's only useful inside a run (`start --notab`, then
  the commands).

## Command form

- **Noun, then verb:** `manager <verb>`, `collection <verb>`,
  `script <verb>`. `help collection` lists everything you can do to a
  collection.
- **The plural lists:** `managers` and `collections` are short for
  `<noun> list`. `scripts` keeps what it shows now: the run's scripts
  and the installed scripts on the current tab. `script list` lists the
  whole manager.
- **One `script` noun for both kinds of script:**
  - the run's own scripts, loaded from disk into its test collection;
  - every other script installed in the manager.
  - Commands that only make sense for one kind refuse the other, saying
    why.
- **A bare id selects**, where there is a selection: `script <id>`
  picks the active script, as `tab <id>` picks the active tab. There is
  no active collection, so `collection <id>` alone is refused.
- **The verbs are reserved words.** A script or collection named like
  one (`enable`) is named by its id instead.

## Naming things

- **`1`, `2`, ...**: the run's scripts, as now.
- **`E1`, `E2`, ...**: other installed scripts. Today E-ids name the
  SourceMonkey-managed scripts on the current tab, numbered by the run.
  This widens them to every installed script, using the number
  SourceMonkey gives each one (see [Script numbers](#script-numbers)),
  so an E-id means the same script in every run and every command.
- **`C1`, `C2`, ...**: collections, in the order `collections` lists
  them.
- **By name**: a collection or script can also be named by its name, or
  a unique part of it, as loaded scripts are now.
- **By the manager's own id** (`id=<uuid>`), for scripts that share a
  name.

## Script numbers

SourceMonkey gives each installed script a short number, and the E-id
is that number (`E12`). It stays the same across runs, sm-dev commands
and other scripts being added or removed.

- **Assigning:** each new script gets the lowest free number. The
  service worker assigns numbers, one call at a time, before each
  registration sync, so two installs can't get the same one.
- **Retiring:** when a script is removed, its number is recorded with
  the time it was last used, and is not given out again for 7 days.
  - So an E-id seen a moment ago never names a different script: a
    stale one finds nothing. (Later, sm-dev could say `E5 was removed
    yesterday` rather than `no such script`.)
  - After that, it can be reused, so a long-lived SourceMonkey with many
    installs and reinstalls keeps its numbers small.
- **Stored state:** one `scriptNumbers` row, with each script's number
  and the retired numbers with when each was last used (see
  [storage.md](storage.md#script-numbers)).
  - A number is free when no script has it and it isn't retired, or
    its 7 days have passed.
- **Reconciling** (when the worker starts, and before each
  registration sync):
  - a number whose script is gone is retired from now, so it still
    waits its 7 days;
  - a retired number some script has is dropped from the list;
  - a script without a number (one installed before numbers existed)
    gets one;
  - two scripts with the same number (a restored backup, say): one
    keeps it and the other gets a new number.
- **Not numbered:** scripts in sm-dev's test collections, which a run
  names `1`, `2` itself. Runs push and remove them often, which would
  otherwise churn the numbers.
- **Shown in the extension:** as part of the log ID (see
  [logging.md](logging.md#log-ids)).
  - The log ID is `<basename>#E<number>` (`foo.user.js#E4`). It
    replaced a `#N` that only marked scripts sharing a file name, and
    renumbered when one was added or removed.
  - The collections page no longer shows a suffix after the name: it
    was confusing there.
  - The viewer always shows its `Log ID` row, not only for a shared
    file name. Its tooltip gets a third line: `E4 is the script's ID in
    sm-dev.`
  - The service worker's console lines use the same log ID, so it
    matches what the viewer shows.
  - Stack traces name a script's code by a `sourcemonkey://` URL with
    the log ID as its folder (`script-source-url.ts`), so every
    script's frames carry it too, encoded:
    `sourcemonkey://SourceMonkey/foo.user.js%23E4/...`. That keeps the
    stack trace, the console and the viewer naming a script alike.
- **Other managers:** Violentmonkey has numeric script ids of its own,
  used the same way. Tampermonkey uses UUIDs, so under it E-ids follow
  the stored order instead, and can shift when scripts are added or
  removed.

## Commands

### Managers

| Command | What it does | sm | tm / vm |
| --- | --- | --- | --- |
| `manager list` | List the userscript managers in the browser: name, version, extension id, enabled, user scripts allowed | yes | yes |
| `manager fetch <tm\|vm>` | Download the manager from the Chrome Web Store into a cache under `~/.cache/sm-dev/`, unpacked | n/a: built from `dist/` | yes |
| `manager update <tm\|vm>` | Re-download if the store has a newer version | n/a | yes |
| `manager enable <name>` / `manager disable <name>` | Turn the extension itself on or off in the browser | yes, not during a run | yes |

- The temp browser loads the chosen manager from `dist/` (SourceMonkey)
  or the fetch cache (TM, VM), and runs `manager fetch` first if the
  cache is empty.
- `manager enable` / `disable`:
  - Lets one kept browser hold several managers and run a script under
    one at a time, rather than once in each.
  - Done by calling `chrome.management.setEnabled` from a hidden
    `chrome://extensions` target over CDP, the call behind that page's
    own toggle. CDP has no call of its own for it.
  - Tested in Playwright's Chromium (headless and headed, launched or
    connected over its port) and Google Chrome: no user gesture is
    needed, and the worker is back within a second of enabling.
  - A disabled manager has no service worker, so the other commands
    refuse until it is enabled. `managers` still lists it, as disabled.
  - Disabling SourceMonkey is refused while a run is using it.
- "Allow User Scripts" has no command. A browser sm-dev launches gets it
  turned on in its preferences before launch, as the temp browser does
  for SourceMonkey now. In any other browser the user turns it on in
  the extension's details page, and `managers` says when it is off.
- Loading into a kept browser (`--open-browser`): Chrome only loads an
  unpacked extension at launch, so `--open-browser` would take
  `--manager` too and pass the cached copy. Adding one to a browser
  already running isn't supported: relaunch it.

### Collections

SourceMonkey groups scripts into collections. TM and VM don't, so they
show one collection, `All scripts`, that holds everything and can't be
added to or removed.

| Command | What it does | sm | tm / vm |
| --- | --- | --- | --- |
| `collection list` | List collections: id, name, kind, location, script count, enabled, status | yes | one `All scripts` row |
| `collection show <C>` | Show one collection's details and its scripts | yes | yes |
| `collection add [location] [--name N]` | Add a collection, the same as the Add dialog: the kind comes from the location. With no location, an empty container collection to install scripts into | yes | refused |
| `collection drop <C>` | Remove a collection and its scripts | yes | refused |
| `collection rename <C> <name>` | Rename a collection | yes | refused |
| `collection enable <C>` / `collection disable <C>` | Turn a whole collection on or off | yes | refused |
| `collection refresh <C>` | Re-read a collection from its location (rescan a directory, re-fetch a manifest, re-fetch each container script) | yes | checks each script for updates |

- The location takes the same shapes as the Add dialog:
  - a local directory path or `file://` URL: a directory collection;
  - a manifest file or URL: a manifest collection;
  - a GitHub folder URL: a directory collection;
  - a single `.user.js` path or URL: refused, with a pointer to
    `script install`.
  - no location: an empty container collection.
- `--name <name>` sets its name, with or without a location. Without
  it, the collection gets the default name the Add dialog gives.
- It needs at least one of a location and `--name`. With neither, it is
  refused.
- sm-dev's own test collections (`container:sm-dev:<run>`) are listed,
  marked as a run's, and refused by every changing command, as the
  extension already refuses them.

### Scripts

| Command | What it does | Run's scripts | Other installed scripts |
| --- | --- | --- | --- |
| `script list [C]` | List every script in the manager, or one collection's: id, name, version, collection, enabled, status, location | yes | yes |
| `scripts` | The run's scripts, then the installed scripts on the current tab, as now | yes | yes |
| `script <id>` | Select the active script, as now | yes | yes |
| `script show <id>` | Show one script's details (see [Script details](#script-details)) | yes | yes, fewer fields under TM / VM |
| `script print <id>` | Print the script's installed text | yes | yes |
| `script enable <id>` / `script disable <id>` | Turn a script on or off | yes, in the run's tabs | yes |
| `script refresh <id>` | Re-read it: from disk for the run's scripts (as `update` does), from its location under SourceMonkey, or an update check under TM / VM | yes | yes |
| `script install <file\|url>` | Install a script in the manager, for every tab, to stay | n/a | yes |
| `script install --text {{` | Install from text (block, `--file`, or stdin) | n/a | see below |
| `script uninstall <id>` | Remove a script | removes it from the run | yes |
| `script move <id> <C>` | Move a script to another container collection | refused | SourceMonkey only |

- **`script install` options:**
  - `--collection <C>`: the container collection to add it to. Default: the
    built-in one for its scheme ("Scripts from local disk", "from
    web", "from GitHub"), as the Add dialog does.
  - `--disabled`: install it turned off.
- **Install from text under SourceMonkey: not supported.** SourceMonkey
  installs scripts by location, and has no user-visible "pasted text"
  script outside sm-dev's test collections, so it is refused, asking
  for a file. TM and VM take text.
- **`load` vs `script install`.** `load` adds a script to the run's
  test collection, for the run's tabs only, and it goes away with the
  run. `script install` puts it in the manager for every tab, and it
  stays. `load` and `update` keep their names.

### Script details

What `script show` shows, where the manager has it:

- Name, namespace, version, description, author.
- Collection, location (file, URL, or `scratch`), and whether it's a
  local file override.
- Enabled, status (ok, invalid, failed to load, not loaded) and the
  error message.
- Last refreshed and last changed times.
- `@match` / `@include` / `@exclude` rules, `@run-at`, `@grant`s,
  `@require`s and `@resource`s with each one's status.
- The tabs it is running on now.
- Values: the count, with `values <id>` for the values themselves.

### Existing commands that change

- **`scripts`**: unchanged, except that its E-ids come from the wider
  numbering.
- **`status`**: gains a manager line (which manager, version, user
  scripts allowed) and counts of collections and installed scripts.
- **`values <E>`, `get`/`set` with an E-id**: unchanged, SourceMonkey
  only.

## JSON output

- **`--json`**: a global option that puts every command with a JSON
  form into JSON mode. `--json` / `--nojson` on one command override it.
  The full spec, with schemas and examples, is in
  [sm-dev-json.md](sm-dev-json.md).
- **Why a flag rather than always:** text stays readable for people and
  for agents reading a terminal, and the tables can change wording
  freely. JSON is the stable form scripts can parse.

## What works under each manager

| Feature | sm | tm / vm |
| --- | --- | --- |
| Management commands above | all | all but collections |
| `start`, page commands, `eval`, `snapshot`, `logs` | yes | yes |
| Run's scripts in a test collection, `load`, `update`, `--watch` | yes | installed as normal scripts and removed at the end of the run |
| `eval --script` | yes | yes, in the manager's world where it can be found |
| Reports, `wait` for script starts, `menu`, `get`/`set` | yes | no |
| Tab claims (other scripts kept out of run tabs) | yes | no: all the manager's scripts run |

## How TM and VM are driven

- Neither has an API other extensions or CDP can call. sm-dev drives
  their own pages over CDP, as the cross-manager e2e drivers already do
  (`tests/fixtures/manager.ts`):
  - VM: messages sent from its options page, the calls its own UI makes.
  - TM: reading and clicking its dashboard. This breaks when TM changes
    its pages, and the docs will say so.
- One interface, `ManagerBackend` in `src/harness/managers/`, with one
  implementation per manager. Commands call the interface and refuse
  with a clear message where a manager has no such feature.

## Build order

1. `--json` on the existing commands (done).
2. Script numbers in SourceMonkey, and E-ids taken from them (done).
3. SourceMonkey collections and installed scripts: the `collection`
   and `script` verbs, with `--json`.
4. `ManagerBackend` around those, with SourceMonkey as its first
   implementation.
5. `manager list`, `manager fetch`, `--manager` for `--temp-browser` and
   `--open-browser`.
6. VM, then TM, behind the same commands.
7. Separate: move the cross-manager e2e projects onto fetched copies.

## Changing the person's real scripts

- Outside a `--temp-browser`, the scripts and collections are the
  person's own. The commands that take something away need `--force`
  there, as `set` on an E-script does now:
  - `script uninstall`, `script disable`;
  - `collection drop`, `collection disable`.
- Adding things (`script install`, `collection add`) and refreshing
  don't.

## Open questions

- None now.
