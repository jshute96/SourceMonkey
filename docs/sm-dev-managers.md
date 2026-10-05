# sm-dev: managing userscript managers (design draft)

Status: proposal, partly built. Built so far:

- `--json` on the existing commands (see [sm-dev-json.md](sm-dev-json.md));
- script and collection numbers;
- for SourceMonkey: `collection list|show|enable|disable|refresh|rename`
  and `script list|show|print|enable|disable|refresh|install|uninstall|move`;
- `--manager`, `manager fetch|install|enable|disable`, the managers in
  `status`, and runs under TM that drive pages but load no scripts;
- under VM, the `collection` and `script` commands, and runs that load
  their scripts into it (see
  [sm-dev-external-managers.md](sm-dev-external-managers.md)).

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
  - Picks which extension the commands talk to, and the `manager`
    verbs act on. They take the manager only from it.
  - With `--temp-browser`, also picks which extension the temp browser
    loads.
- **A run works with one manager**, the one it started with, recorded
  with the run. A later line's `--manager` has to match it, as its
  `--browser` has to match the run's browser.
  - Not for the `manager` verbs, which act on the browser's extensions
    rather than the run: `--manager tm manager disable` beside a
    SourceMonkey run turns Tampermonkey off in its browser.
- **Each command lists the managers it works with**, in its help entry,
  and is refused under another: `The values command works with
  SourceMonkey only, and this run uses Tampermonkey`.
  - Commands that only drive Chrome (`snapshot`, `click`, `newtab`,
    ...) work under every manager.
  - Those that work through SourceMonkey list it alone, until TM and VM
    get their own way to do them.
- A browser can have several managers at once. The commands only talk
  to the one chosen, so a kept browser can hold all three.
  - Each enabled manager but the chosen one runs its scripts too, so
    sm-dev warns of it when it connects to the browser, and in
    `status`, with how to turn it off.

## Where the commands run

- **No run needed.** They need a browser, not a run. With no run to
  use, sm-dev connects to `--browser`, runs the command, and
  disconnects (`openManagerLink` in `extension-link.ts`).
  - That connection claims no tabs and hears no events.
  - It doesn't need "Allow User Scripts", since nothing it does runs
    a script.
- **In a run.** When there is a run to use (`--run`, or the only one
  going), the command goes to it, as the run's other commands do, and
  the run asks SourceMonkey through its own connection.
  - A `--browser` that names a browser no run is in lists that browser,
    with no run. One naming another run's browser than the run picked
    is refused, as for any command sent to a run.
- **The `manager` verbs** run in sm-dev itself, never in a run. They act
  on the `--browser` browser unless a run is picked (by `--run`,
  `start` or `attach`), and then on its browser. An active run that
  isn't picked is left alone, as `status` with no run shows.
- **`--temp-browser` with no run** would make a browser and drop it
  straight away, so it's only useful inside a run (`start --notab`, then
  the commands).

## Command form

- **Noun, then what it acts on, then verb:** `collection C3 refresh`,
  `script E4 move C2`. The `manager` verbs act on `--manager`'s
  manager: `sm-dev --manager tm manager enable`. `help collection` lists
  everything you can do to a collection.
  - Several commands on one script differ only at the end of the line.
  - A script left out is the run's selected one (`script enable`),
    except for `uninstall`. A collection is always named.
  - A name of several words is quoted: `script "Dark mode" enable`.
  - The old order (`script enable E4`) is refused, showing the new
    one.
  - `list` and `install` act on no one thing, so their verb comes
    first: `script list C3`, `script install x.user.js`.
- **Singular and plural are the same command,** as `tab` and `tabs`
  are: `collection list` and `collections list`, `script list` and
  `scripts list`.
  - `collection` (or `collections`) alone lists, as `tabs` does.
  - `scripts` alone keeps what it shows now: the run's scripts and the
    installed scripts on the current tab. `script list` lists every
    installed script, runs' test collections' included.
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
- **`C1`, `C2`, ...**: collections, by the number SourceMonkey gives
  each one, the same way as scripts (see
  [Collection numbers](#collection-numbers)). Run test collections have
  none, and are named by their run (`D1`) instead.
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
  [storage.md](storage.md#sticky-numbers)).
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

## Collection numbers

SourceMonkey numbers collections the same way, and the C-id is that
number (`C3`).

- **Same rules** as script numbers: lowest free first, and a removed
  collection's number held for 7 days.
- **Stored** in its own `collectionNumbers` row (see
  [storage.md](storage.md#sticky-numbers)).
- **Order:** new numbers go to collections by path.
- **Not numbered:** sm-dev's test collections.
- **Not shown** anywhere in the extension.
- **Assigned at a sync:** adding a collection with no scripts doesn't
  start a registration sync, so it has no number until a later one.
  So the extension's calls behind the `collection` and `script`
  commands number first (`assignNumbers`), and `collection add` will too.
- **Other managers:** Tampermonkey and Violentmonkey show one virtual
  collection, so it needs no number.

## Commands

### Managers

| Command | What it does | sm | tm / vm |
| --- | --- | --- | --- |
| `manager fetch` | Download the manager from the Chrome Web Store into `~/.cache/sm-dev/managers/<name>`, unpacked, or update it there to the newest version | refused: it comes with sm-dev | yes |
| `manager install` | Load it into the browser unpacked, with "Allow User Scripts" on | from sm-dev's `dist/` | from the fetch cache, fetched first if empty |
| `manager enable` / `manager disable` | Turn the extension itself on or off in the browser | yes; not disabled while a run uses it | yes |
| `status` | Lists the managers in the browser, with version, enabled, and "Allow User Scripts"; leaves out the ones not there | yes | yes |

- **Where it is:**
  - [managers.ts](../src/harness/managers.ts): the managers, their
    `--manager` names, and TM's and VM's Web Store ids.
  - [manager-fetch.ts](../src/harness/manager-fetch.ts): `manager
    fetch`, the CRX and zip reading.
  - [browser-extensions.ts](../src/harness/browser-extensions.ts):
    finding the managers in a browser, loading, enabling, "Allow User
    Scripts".
  - [manager-actions.ts](../src/harness/manager-actions.ts): the
    `manager` verbs and their messages.
  - [extension-launch.ts](../src/harness/extension-launch.ts): the
    temp browser's launch with a fetched manager.
- **Where it downloads from:** Chrome's own extension update service,
  `https://clients2.google.com/service/update2/crx`, the one URL
  written into the code. Asked with the store id, it gives the newest
  version, its download URL and the file's SHA-256.
- **The Web Store ids** (`dhdgffkkebhmkfjojejmpbldmpobfkfo` for TM,
  `jinjaccalgkegednnccohejagnlnfdag` for VM) are in `managers.ts`, and
  again in `tests/fixtures/managers.mjs` for the cross-manager e2e
  suite, which has no build step to import them.
- **The fetch cache:** one folder per manager, replaced whole by a newer
  version.
  - The Web Store's download is a CRX: signatures and public keys, then
    a zip. The key whose hash is the store id goes into the unpacked
    manifest as `key`, so the copy keeps the store's id, and with it
    its storage across updates.
  - `$XDG_CACHE_HOME` replaces `~/.cache` when set.
- **`manager install`:**
  - Done with CDP's `Extensions.loadUnpacked`, which works over a
    debugging port in Chrome and Chromium alike. Tested in Google
    Chrome 154 and Playwright's Chromium.
  - "Allow User Scripts" is turned on through
    `chrome.developerPrivate`, the call behind its toggle on the
    extension's details page, from a hidden `chrome://extensions`
    target.
  - A copy already there is left as it is, but for turning that on.
    One loaded from the fetch cache is reloaded when a newer version
    was fetched since.
- **The temp browser** loads the chosen manager from `dist/`
  (SourceMonkey) or the fetch cache (TM, VM), and fetches it first if
  the cache is empty.
- **`manager enable` / `disable`:**
  - Lets one kept browser hold several managers and run a script under
    one at a time, rather than once in each.
  - Done by calling `chrome.management.setEnabled` from a hidden
    `chrome://extensions` target over CDP, the call behind that page's
    own toggle. CDP has no call of its own for it.
  - No user gesture is needed, and the worker is back within a second
    of enabling.
  - Disabling SourceMonkey is refused while a run in that browser uses
    it.
- **The managers in a browser** come from
  `chrome.developerPrivate.getExtensionsInfo()` on the same hidden
  target: every extension, enabled or not. A manager is known by:
  - SourceMonkey's id, which comes from the `key` in its own manifest,
    so every unpacked load of it has the same id;
  - a Web Store id: a store install's, or a fetched copy's, which keeps
    it through the key put into its manifest;
  - else its name (`Tampermonkey BETA`, or an unpacked copy without the
    store's key, whose id comes from its folder).
- **One id for both:** a fetched copy has its store install's id, so
  the two can't sit side by side. `manager install` finds the store's
  copy there and leaves it, saying so.

### Collections

SourceMonkey groups scripts into collections. TM and VM don't, so they
show one collection, `All scripts`, that holds everything and can't be
added to or removed.

| Command | What it does | sm | tm / vm |
| --- | --- | --- | --- |
| `collection list` | List collections: id, name, kind, location, script count, enabled, status | yes | one `All scripts` row |
| `collection <C> show` | Show one collection's details and its scripts | yes | yes |
| `collection add [location] [--name N]` | Add a collection, the same as the Add dialog: the kind comes from the location. With no location, an empty container collection to install scripts into | yes | refused |
| `collection <C> drop` | Remove a collection and its scripts | yes | refused |
| `collection <C> rename <name>` | Rename a collection | yes | refused |
| `collection <C> enable` / `collection <C> disable` | Turn a whole collection on or off | yes | refused |
| `collection <C> refresh` | Re-read a collection from its location (rescan a directory, re-fetch a manifest, re-fetch each container script) | yes | checks each script for updates |

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
| `script list [C]` | List every script in the manager, or one collection's: id, name, version, collection, enabled, status, location | yes: in its own run as `1`, `2`; another run's by name only | yes |
| `scripts` | The run's scripts, then the installed scripts on the current tab, as now | yes | yes |
| `script <id>` | Select the active script, as now | yes | yes |
| `script [id] show` | Show one script's details (see [Script details](#script-details)) | yes | yes, fewer fields under TM / VM |
| `script [id] print` | Print the script's installed text | yes | yes |
| `script [id] enable` / `script [id] disable` | Turn a script on or off | yes, in the run's tabs | yes |
| `script [id] refresh` | Re-read it: from disk for the run's scripts (as `update` does), from its location under SourceMonkey, or an update check under TM / VM | yes | yes |
| `script install <file\|url>` | Install a script in the manager, for every tab, to stay | n/a | yes |
| `script install --text {{` | Install from text (block, `--file`, or stdin) (not built) | n/a | see below |
| `script <id> uninstall` | Remove a script | refused: they go when the run ends | yes, from a container collection |
| `script [id] move <C>` | Move a script to another container collection | refused | SourceMonkey only, between container collections |

- **`script install --collection <C>`:** the container collection to
  add it to. Default: the built-in one for its scheme ("Scripts from
  local disk", "from web", "from GitHub"), as the Add dialog does.
- **Install from text under SourceMonkey: not supported.** SourceMonkey
  installs scripts by location, and has no user-visible "pasted text"
  script outside sm-dev's test collections, so it is refused, asking
  for a file. TM and VM take text.
- **Another run's scripts** can be listed and shown, but every change
  to them is refused: only their own run changes them.
- **Which scripts can be uninstalled or moved:** only one in a
  container collection. A directory or manifest collection lists its
  own scripts, from its files, so one of those is refused, and a move
  into one is too.
- **Turning one copy on turns the others off.** `script enable`,
  `install` and `move` turn off the script's other running copies, as
  the viewer does (`turnOffOtherCopies`, see
  [script-identity.md](script-identity.md)).
  - Each one turned off gets a line: `Another version of this script
    was disabled: Version 1.0 (E7) in collection C3: Mine`.
  - Not when the copy itself won't run: it is invalid, or its
    collection is disabled.
  - A run's test collection is left out both ways.
- **An enabled script in a disabled collection** gets a line too, after
  `script enable`, `install` or `move`: `E4: Dark mode is enabled, but
  won't run because it's inside disabled collection C3: Mine`.
- **`load` vs `script install`.** `load` adds a script to the run's
  test collection, for the run's tabs only, and it goes away with the
  run. `script install` puts it in the manager for every tab, and it
  stays. `load` and `update` keep their names.

### Changes on disk

What the collections page's chips show, from the same code
(`file-changes.ts`, see [file-changes.md](file-changes.md)), through
`managed.onDisk`:

- **A script's local file**, modified or deleted since it loaded:
  `(modified on disk)` in `script list` and `collection show`, in
  `script show`'s Status, and `onDisk` in JSON.
- **A local collection's "refresh pending"**: files modified, deleted
  or new, or its manifest changed. `Refresh pending: 1 file modified on
  disk` in `collection list`, an `On disk` row in `collection show`, and
  `onDisk` counts in JSON.
- With an extension older than 1.5 the listings leave it out.

### Script details

What `script show` shows, where the manager has it:

- Name, namespace, version, description, author.
- Collection, and location (file or URL; a run's script by its file).
- Enabled, status (ok or invalid), the error message, and why its last
  refresh failed.
- Whether its local file was modified or deleted since it loaded, as
  the collections page's chip shows it.
- When its current text was loaded (`Updated`).
- `@match` / `@include` / `@exclude` / `@exclude-match` rules,
  `@run-at`, `@grant`s, and `@require`s and `@resource`s, each loaded
  or not, with the local file read in its place.
- In a run, what it does on each of the run's tabs.
- Values: the count, with `values <id>` for the values themselves.

### Existing commands that change

- **`scripts`**: unchanged, except that its E-ids come from the wider
  numbering.
- **`status`**: gains a `Managers:` line (each manager's version,
  whether it's enabled and in use, and "Allow User Scripts" when off;
  done), and counts of collections and installed scripts.
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

| Feature | sm | vm | tm now | tm planned |
| --- | --- | --- | --- | --- |
| `manager` commands, `status` | yes | yes | yes | yes |
| `start`, page commands, `eval --page`, `snapshot`, `logs` | yes | yes | yes, in a run with no scripts | yes |
| `collection` and `script` verbs | yes | yes, with one collection, `C0` | refused | yes, with one collection, `C0` |
| Run's scripts, `load`, `update`, `--watch` | yes, in a test collection | installed as normal scripts, removed at the end of the run | refused | as under VM |
| `scripts`, `status`: scripts on a tab | reported by the extension | predicted by their match rules | refused | as under VM |
| `eval` in a script | yes | no: a script's scope can't be reached. `eval --page` works | no scripts to eval in | as under VM |
| Reports, `wait` for script starts | yes | no | refused | no |
| `menu`, `get`/`set`, `values`, `--values` | yes | no; future work | refused | no; future work |
| Tab claims (other scripts kept out of run tabs) | yes | no: all the manager's scripts run | no | no |
| Following tabs a page opens | yes | no | no | no |

- A run under TM or VM has no link to SourceMonkey:
  `ExtensionLink.without` stands in, claiming no tabs, hearing no
  events, and throwing on every call into the extension.

## How TM and VM are driven

- Running scripts and the `collection` / `script` commands under them
  are designed in
  [sm-dev-external-managers.md](sm-dev-external-managers.md).
- Neither has an API other extensions or CDP can call. sm-dev drives
  their own pages over CDP, as the cross-manager e2e drivers already do
  (`tests/fixtures/manager.ts`):
  - VM: messages sent from its options page, the calls its own UI makes.
  - TM: reading and clicking its dashboard. This breaks when TM changes
    its pages, and the docs will say so.
- The `collection` and `script` commands call `ManagerControl`
  (`manager-commands.ts`): SourceMonkey's through its `ExtensionLink`,
  and another manager's through `ExternalManager`
  (`external-manager.ts`), which VM implements and TM will. Commands a
  manager can't do are refused by its per-command list
  (`unsupportedCommand`).

## Build order

1. `--json` on the existing commands (done).
2. Script numbers in SourceMonkey, and E-ids taken from them (done).
3. Collection numbers in SourceMonkey (done).
4. SourceMonkey collections and installed scripts: the `collection`
   and `script` verbs, with `--json`. In slices:
   - `collection list` and `script list`, with and without a run
     (done);
   - `show`, `print`, `enable`, `disable`, `refresh`, `rename`, and
     `script install` / `uninstall` / `move` (done);
   - `collection add` / `drop`, and `script install --text`.
5. `ManagerControl` around those, with SourceMonkey as its first
   implementation (done).
6. `--manager`, `manager fetch|install|enable|disable`, the managers in
   `status`, and runs under TM or VM that drive pages (done).
7. VM (done), then TM, behind the same commands.
8. Separate: move the cross-manager e2e projects onto fetched copies.

## Changing the person's real scripts

- Outside a `--temp-browser`, the scripts and collections are the
  person's own. The commands that remove something need `--force`
  there, as `set` on an E-script does now: `script uninstall`, and
  `collection drop`.
- Enabling and disabling are easily undone, so they don't need it.
  Nor do adding things (`script install`, `collection add`) and
  refreshing.
- Except under Violentmonkey, where `script install` replaces the
  script with the same name and namespace: replacing the person's own
  needs `--force` too.

## Open questions

- None now.
