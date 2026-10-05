# sm-dev under Violentmonkey

Status: built.

- This doc covers Violentmonkey (VM), and the parts every manager
  other than SourceMonkey shares: the mark, the run's scripts, `C0`,
  and the commands.
- Tampermonkey (TM) works the same way, with the differences in
  [sm-dev-tampermonkey.md](sm-dev-tampermonkey.md).

[sm-dev-managers.md](sm-dev-managers.md) covers choosing a manager
(`--manager`) and installing it. This doc covers what comes next:
running a test session's scripts in VM or TM, and the `collection` and
`script` commands against them, so sm-dev can drive testing under each
manager about as well as under SourceMonkey (SM).

## Goals

- `start` and `load` put the run's scripts into the manager, and
  `update` / `--watch` replace them.
- `collection` and `script` commands list, show, print, enable,
  disable, refresh, install and uninstall the manager's scripts.
- `scripts` and `status` list the scripts expected on each tab.
- Logs and errors traced to the script they came from, where the
  manager makes that possible.

## Non-goals

- Keeping other scripts out of a run's tabs. SM can limit a run's
  scripts to its tabs, and other scripts to the rest; VM and TM run
  every enabled script that matches.
- `eval` inside a script's scope, `connect`, and SM's reports (the
  `sm` log source, `wait` for a script start).
- Following tabs a page opens.

## How sm-dev talks to Violentmonkey

- VM's background takes `{cmd, data}` messages through
  `chrome.runtime.sendMessage`, but only from VM's own pages.
  - So sm-dev opens a hidden target at VM's options page
    (`chrome-extension://<id>/options/index.html`) over CDP, and calls
    `chrome.runtime.sendMessage` there with `Runtime.evaluate`.
  - That is what VM's own dashboard does. The e2e driver
    (`tests/fixtures/violentmonkey-driver.mjs`) already uses it for
    `GetData` and `ParseScript`.
- A run keeps one such target open. A command with no run opens one,
  as the `manager` commands open `chrome://extensions`.
- Calls start once the page has finished loading. A call made while
  its own scripts start can get its answer wrapped (`[result]`), as
  VM's pages get theirs.
- Tried against VM 2.49.0. A message VM doesn't know gets no answer,
  and the send fails; sm-dev turns that into an error naming the call
  and the VM version.

### The calls

| Need | VM call | Notes |
| --- | --- | --- |
| List scripts | `GetData {}` | `scripts[]`: `props.id`, `meta` (name, namespace, version, match, include, exclude, grant, require, resources), `config.enabled`, `config.removed`, `custom.lastInstallURL` |
| One script's code | `GetScriptCode <id>` | The installed text |
| Install or replace | `ParseScript {code, id?, url?, require?, cache?, config?}` | Replaces the script with the same name and namespace, or with `id` when given; `isNew` says which. Returns the script's `id`. `config: {shouldUpdate: 0}` turns off its update checks |
| Enable, disable | `UpdateScriptInfo {id, config: {enabled: 0 or 1}}` | |
| Uninstall | `MarkRemoved {id, removed: true}` | To VM's recycle bin, from which it can be restored |
| Remove for good | `RemoveScripts [ids]` | Only scripts in the recycle bin, so `MarkRemoved` comes first |
| Read settings | `GetAllOptions` | `isApplied`, `blacklist` |
| All scripts on or off | `SetOptions {isApplied}` | VM's own on/off switch, which leaves the extension on |
| Scripts on `file://` pages | `SetOptions {blacklist}` | Without its `file://*/*` line |
| Scripts that ran on a tab | `PopupShown` to the tab, then `InitPopup` | Only for the tab showing in its window. Later; see [Future and alternate work](#future-and-alternate-work) |

## Ids

- **Scripts:** `E<n>`, from VM's own numeric id (`props.id`). They stay
  the same across runs, as SM's numbers do.
- **The run's scripts** have E-ids too, since they are ordinary VM
  scripts.
  - They keep their numbers in the run (`1`, `2`), as under SM, so
    `update 1` and `open 2` work alike under any manager.
  - `scripts` shows both (`1: Hello (hello.user.js), E6 in
    Violentmonkey`), and either names the script.
  - `script list` shows the E-id, with `run D1's script 1`.
- **Collection `C0`:** VM has no collections, so sm-dev shows one,
  `C0` (named Violentmonkey), holding every script.
  - SM's own collections start at `C1`, so `C0` can't name a real one.
  - `script list C0` lists the same scripts as `script list`, and each
    script shows `C0` as its collection.
- **By name, or `id=<n>`:** as under SM.

## Where scripts come from

- VM keeps `lastInstallURL` only for http(s) sources, not `file://`.
- So sm-dev marks each script it installs with a comment it adds as
  the script's last line, e.g.
  `// sm-dev: run=D1 started=2026-10-04T12:00:00Z file=/home/me/foo.user.js`.
  - `file`: the file it came from, which `script show` shows and
    `refresh` re-reads.
  - `run` and `started`: only on a run's script. They make it a run's
    script rather than an installed one (see
    [The run's scripts](#the-runs-scripts)). The start time tells a
    live run from an old one with the same id.
- Why a comment at the end:
  - It's in the script's text, which every manager keeps as given, so
    it relies on no manager's internals, and TM shares it.
  - Last, it shifts no line numbers in logs and errors. In the header
    it would, and would also look like a change to the script itself.
  - Someone looking at the script in VM's editor can see where it
    came from.
- sm-dev strips it where the text is shown or compared: `script print`
  leaves it out, and a refresh that only changes the comment doesn't
  count as a change. `update` and `--watch` write it again.
- `@require` and `@resource` with a relative path:
  - VM resolves them against the install URL, and fetches what it
    wasn't handed.
  - It refuses a `file://` one, by its default `blacklistNet` setting,
    which also holds in a person's own browser.
  - So a local script is installed from
    `https://sm-dev.invalid/<its path>`, a name that never resolves,
    and sm-dev hands over each file's contents (`require` and `cache`)
    by the URL it resolves to there.
  - Its update checks are turned off, since VM can't fetch it.

## The run's scripts

### Loading

- `start <script>...` and `load` install each script with
  `ParseScript`.
- `update` and `--watch` install it again by its `id`, so it stays
  the same script even if its `@name` changed, then reload the tabs.
- `scripts` lists them with their E-ids (see [Ids](#ids)).

### A script that's already there

- VM has one script per name and namespace, so loading one replaces a
  script there with the same name and namespace.
- `load` and `start` replace only a script marked as an old run's:
  - an installed script (one not marked as a run's) is refused, naming
    it, and saying to uninstall it first (with `--force`);
  - a live run's script is refused, naming the run. Two runs can't
    share one: both runs' tabs would run whichever was loaded last;
  - an ended run's script, left by one that crashed, is replaced.
- Different scripts in two runs are fine, but every script runs in
  every run's tabs, unlike under SM.

### When the run ends

- The run removes its scripts for good, found by their mark: into
  VM's recycle bin and out again, since VM removes for good only from
  there.
- Not in a `--temp-browser`, whose scripts go away with the browser,
  nor from a browser that has closed.
- A run that crashed leaves its scripts.
  - The next run under VM in that browser removes them as it starts,
    and says so.
  - Meanwhile `script list` marks them `left by run D1, which ended`.

## Scripts on a tab

- `scripts`, `status` and `script show` list the scripts expected on
  each tab, by sm-dev's own matching (as `match` uses) on each enabled
  script's header.
  - `scripts` and `status` list the run's scripts in two lists, under
    `Expected on tab T1 using match rules:` and `Not expected on tab
    T1:`. `script show` says the same for each tab.
  - VM's other scripts expected there are listed after them, under
    `Violentmonkey scripts expected on T1`.
  - The JSON says `expected` and `not-expected` for them, where SM's
    say `running` and `not-running`.
  - It's a prediction: VM's own rules can differ in edge cases, and its
    blacklist and the per-script overrides set in VM's editor aren't
    applied.
  - Under TM, the lists come from TM's own matching instead (see
    [sm-dev-tampermonkey.md](sm-dev-tampermonkey.md#scripts-on-a-tab)).
- What actually ran is possible later (see
  [Future and alternate work](#future-and-alternate-work)).

## `file://` pages

- VM's default blacklist (`file://*/*`) keeps scripts off `file://`
  pages, as a page opened with `open page.html` is.
- In a `--temp-browser`, sm-dev clears that entry, so scripts run on
  local test pages as under SM. Elsewhere it's the person's setting,
  and sm-dev leaves it.
- Saved pages (`--from-saved`) aren't `file://` pages: they're served
  at their real http(s) URLs, so VM's scripts run there either way.

## How stable these calls are

- They aren't a published API. They're the messages VM's own pages
  send its background, found in VM's source (open source, on GitHub).
- They have kept their names across the versions the e2e driver has
  used (2.48.0, 2.49.0), but VM can rename or reshape them in any
  release.
- So sm-dev names the call that failed and the VM version when one
  breaks, and the backend keeps them in one file.
- If they break too often, see
  [Future and alternate work](#future-and-alternate-work).

### What sm-dev assumes about VM

Everything here can change in a VM release without notice. `Checked`
says whether the version check below tries it.

Where VM defines these (links are to v2.49.0, the version tried):

- [`background/index.js`](https://github.com/violentmonkey/violentmonkey/blob/v2.49.0/src/background/index.js): `handleCommandMessage`,
  which dispatches the `{cmd, data}` messages.
- [`background/utils/db.js`](https://github.com/violentmonkey/violentmonkey/blob/v2.49.0/src/background/utils/db.js): the script
  calls (`GetData`, `GetScriptCode`, `ParseScript`, `UpdateScriptInfo`,
  `MarkRemoved`, `RemoveScripts`), how a script's id is given, and
  `fetchResources` for `@require` and `@resource`.
- [`background/utils/options.js`](https://github.com/violentmonkey/violentmonkey/blob/v2.49.0/src/background/utils/options.js):
  `GetAllOptions` and `SetOptions`.
- [`common/options-defaults.js`](https://github.com/violentmonkey/violentmonkey/blob/v2.49.0/src/common/options-defaults.js): the
  option names and defaults, `isApplied` and `blacklist` among them.
- [`common/script.js`](https://github.com/violentmonkey/violentmonkey/blob/v2.49.0/src/common/script.js): the
  `<name>.user.js#<id>` address a script's code runs under.
- [`manifest.yml`](https://github.com/violentmonkey/violentmonkey/blob/v2.49.0/src/manifest.yml): the options page's path.

| Assumption | Used for | If it changes | Checked |
| --- | --- | --- | --- |
| The background answers `{cmd, data}` sent by `chrome.runtime.sendMessage` from VM's own pages, with the call's raw result, and rejects with its error | Every call | Nothing works | Yes |
| The options page is at `options/index.html` (from the manifest's `options_ui`) | The page calls are sent from | Nothing works | Yes |
| `GetData` lists scripts, with `props.id`, `meta.name`, `meta.namespace`, `meta.version`, `meta.match` / `include` / `exclude` / `excludeMatch`, `config.enabled`, `config.removed` and `custom.lastInstallURL` | `script list`, `show`, finding a run's scripts | Listing fails, or shows wrong fields | Yes |
| `props.id` is a number that stays with a script | E-ids | E-ids shift or break | Yes |
| `GetScriptCode` takes an id or a list of ids, and returns the text as installed | `script print`, reading sm-dev's comment | Printing, and telling a run's scripts apart, fail | Yes |
| `ParseScript {code, id?, url?}` installs, or replaces the script with that `id`, or else with the same name and namespace. It returns `isNew` and `where.id` | `install`, `load`, `update`, `refresh` | Installing fails, or adds copies | Yes |
| `ParseScript`'s `require` and `cache` maps supply `@require` and `@resource` contents, by the URL they resolve to; a resource as `<content type>,<base64>` | Scripts with local dependencies | Their dependencies are missing | Yes |
| `blacklistNet` refuses only `file://` dependencies by default, not `https://sm-dev.invalid/` ones | Scripts with local dependencies | Their dependencies are missing | Yes |
| An answer is unwrapped once the options page has loaded | Every call | Calls fail on a wrapped answer | Yes |
| `UpdateScriptInfo {id, config: {enabled}}` turns a script on or off | `script enable`, `disable` | Those fail | Yes |
| `MarkRemoved {id, removed}` moves a script to the recycle bin, and `RemoveScripts [ids]` removes it from there for good | `script uninstall`, the end of a run | Scripts are left behind | Yes |
| `SetOptions` and `GetAllOptions` with the `isApplied` and `blacklist` options | `C0 enable`, `disable`, and `file://` pages in a `--temp-browser` | Those fail | Yes |
| A script's code is named `chrome-extension://<VM id>/<name>.user.js#<id>` in stacks | Logs and errors by script | Lines aren't traced to scripts; nothing else breaks | Yes |
| The extension's name starts with `Violentmonkey`, or it has the store's id | Finding VM in a browser ([sm-dev-managers.md](sm-dev-managers.md)) | VM isn't found | No |

### Checking a VM version

- A quick test (`tests/vm-api/vm-api.spec.ts`) checks that every call
  sm-dev uses still works in the fetched VM, and lists the ones that
  don't.
- Run on demand (`pnpm run test:vm-api`), say when a new VM release
  comes out: `manager fetch` first, then the test.
  - It uses the copy already fetched, and fetches nothing itself.
  - With none fetched, it fails saying to run `manager fetch`.
- It makes each call for real, in a throwaway browser with the fetched
  VM loaded, rather than searching VM's code for the names:
  - so it also catches a call whose data or result changed shape, such
    as a field sm-dev reads that's gone;
  - in order: install a test script with a local `@require`, list it,
    read its code, update it, turn it off and on, load a page where it
    logs a line and check the line's source, the on/off switch and
    the blacklist, then uninstall and remove it.
- A failed call doesn't stop the rest, so one run lists every broken
  call, each with what VM gave instead and the VM version.

## Logs and errors

- VM names each script's code `chrome-extension://<VM id>/<name>.user.js#<id>`,
  in both page and content mode.
  - So a console line's or error's stack names the script, by E-id.
  - Line numbers match the script's own file.
- The `script` log source and `logs [tab] <script>` filter on that.
  VM's own code's lines count as the scripts', as SM's do.
- `event` lines work as now, but VM reports nothing to make a script's
  start or error an event. A script's uncaught error is a `script`
  line instead.
- The `sm` log source has nothing: VM keeps no per-script log.
- Nothing waits for the scripts to start, as under SM: page loads and
  `wait` go by the page alone.

## Commands

### Collections

| Command | Under VM |
| --- | --- |
| `collection list`, `C0 show` | `C0` only, with its script count and whether VM's switch is on |
| `C0 enable`, `C0 disable` | VM's on/off switch (`isApplied`) |
| `C0 refresh` | Refreshes each script with a source, as a container collection's refresh does |
| `rename` | Refused: `C0` has no name of its own |
| `--collection` | Only `C0` |

### Scripts

| Command | Under VM |
| --- | --- |
| `script list` | Every script, with its E-id, version, and whether it's on |
| `script show` | Header fields, enabled, last updated, source, and in a run, the tabs it's expected on |
| `script print` | `GetScriptCode`, without sm-dev's comment |
| `script enable`, `disable` | `UpdateScriptInfo`. VM doesn't turn other copies off, so neither does sm-dev |
| `script refresh` | Re-reads the source (the comment's `file`, or `lastInstallURL`) and installs it by `id` |
| `script install <file\|url>` | `ParseScript`. Replacing one with the same name and namespace is reported as such, and needs `--force` outside a `--temp-browser`, unless an ended run left it |
| `script uninstall` | To VM's recycle bin. Needs `--force` outside a `--temp-browser`, as under SM |
| `script move` | Refused: there's only `C0` |

### Run commands

| Command | Under VM |
| --- | --- |
| `start`, `load`, `update`, `--watch` | See [The run's scripts](#the-runs-scripts) |
| `scripts`, `status` | The run's scripts, and the scripts expected on each tab |
| `scripts <id>`, `script <id>` | Selects one of the run's scripts by its number or E-id |
| `open <id>`, `newtab <id>` | A run's script, or any installed script by its E-id (under SM too): its default page comes from its `@match` |
| `match`, `validate` | sm-dev's own checks, as now |
| `logs`, `wait log` | See [Logs and errors](#logs-and-errors) |
| `values`, `get`, `set`, `--values`, `menu` | Refused (see [Future and alternate work](#future-and-alternate-work)) |
| `eval` in a script, `connect` | Refused |

## Differences from SourceMonkey

| | SourceMonkey | Violentmonkey | Tampermonkey |
| --- | --- | --- | --- |
| Driven by | `ExtensionLink` calls | Messages from its options page | Messages from its dashboard |
| Script ids | `E<n>`, kept 7 days after removal | `E<n>` from VM's id | `E<n>` kept by sm-dev for TM's uuids |
| Collections | Real, `C1`, ... | `C0` only | `C0` only |
| Run's scripts | A test collection, removed at the end | Installed and marked as the run's, removed at the end; never over an installed script | As under VM |
| Run's scripts kept to its tabs | Yes | No | No |
| Scripts on a tab | Reported by the extension | Predicted by sm-dev's matching | Predicted by TM's matching |
| Script logs | `sm` source, and console lines | Console lines, by source URL | Console lines, by source URL |
| `file://` pages | Runs there | Blacklisted by default; cleared in a `--temp-browser` | Needs Chrome's file access, on for an unpacked copy |
| Values, menus | Yes | No | No |

## Code layout

- [`src/harness/violentmonkey.ts`](../src/harness/violentmonkey.ts):
  the calls above, over the hidden options page
  (`openHiddenPage`, in `browser-extensions.ts`).
- [`src/harness/external-manager.ts`](../src/harness/external-manager.ts):
  `ExternalManager`, what sm-dev needs of a manager, and on top of it,
  for any manager but SM:
  - `externalControl`, the `ManagerControl` the `collection` and
    `script` commands call (`manager-commands.ts`), as they call SM's;
  - `ExternalRunScripts`, a run's scripts in the manager;
  - `externalOthers`, the manager's other scripts expected on a tab.
- [`src/harness/script-mark.ts`](../src/harness/script-mark.ts): the
  comment sm-dev adds.
- In a run (`run.ts`), the host traces stack URLs to scripts
  (`ExtensionHost.external`), and expects no reports.
- `unsupportedCommand` (`command-list.ts`) lists SM alone for the
  commands that need it.
- Tests: `tests/harness/violentmonkey.spec.ts` against the fetched VM
  (skipped without one), and the version check.

## Future and alternate work

### What actually ran on a tab

- Sending `PopupShown` to the tab makes VM's content script report the
  ids it injected, per frame, with the frame's menu commands.
  `InitPopup` then returns them, as VM's toolbar popup shows.
- But VM answers only for the tab showing in its window, so sm-dev
  would have to switch to the tab first.
- `menu` could list its commands from the same answer. Firing one
  needs a message to the tab.

### Stored values

- VM's call for one script's values (`GetValueStore`) needs a tab the
  script runs in. Without one, they'd come from `ExportZip`, which
  gives every script's code and values at once, or from VM's own
  storage, which is lower level than the calls above and more likely
  to change.
- `SetValueStores` writes them, and also updates open tabs.
- So `values`, `get`, `set` and `--values` are left out for now.

### Pinning a known-good VM version

- The Chrome Web Store's update service gives only the newest version.
- VM's GitHub releases have zips of each version (Chrome MV3 builds),
  though they're its beta builds, ahead of the store.
- So `manager fetch` could take a pinned release, or a snapshot sm-dev
  keeps, rather than the store's newest.

### Driving VM's pages instead of its messages

- If the messages change too often, sm-dev could read and click VM's
  dashboard instead, as the e2e suite does for TM.
- It's not clear that's better: VM's pages can change too, and
  reading pages is slower and more fragile than calling the messages
  they send.

## Open questions

- None now.
