# sm-dev under Tampermonkey

Status: built.

Tampermonkey (TM) has the same features as Violentmonkey (VM) in
[sm-dev-violentmonkey.md](sm-dev-violentmonkey.md): a run's
scripts installed and removed, `C0`, the `collection` and `script`
commands, E-ids, expected scripts on a tab, and logs by script.
This doc covers only where TM differs.

## How sm-dev talks to Tampermonkey

- TM's dashboard (`options.html`) sends its background
  `{method, ...}` messages through `chrome.runtime.sendMessage`, and
  TM answers them only from its own pages.
- So sm-dev drives TM as it drives VM: a hidden target at
  `chrome-extension://<id>/options.html`, with `Runtime.evaluate`
  sending the same messages the dashboard sends.
  - No reading or clicking the dashboard. The e2e driver
    (`tests/fixtures/tampermonkey-driver.mjs`) scrapes it today, and
    could move to these calls later.
- Tried against TM 5.5.1, the version `manager fetch` gives.
- A message TM doesn't know gets an empty answer (`undefined`), not
  an error. So each call checks its answer has the fields it reads,
  and a missing one becomes an error naming the call and TM's version.
- Calls made while TM is still starting are held until it's ready, so
  they need no waiting of their own.

### The calls

| Need | TM message | Notes |
| --- | --- | --- |
| List scripts, with their code, which `script print` reads too | `loadTree {referrer: "options.scripts.userscripts", complete: true}` | `items[]` with a `uuid`: `name`, `namespace`, `version`, `matches`, `includes`, `excludes`, `enabled`, `fileURL`, `downloadURL`, `code`, and `requires[]` / `resources[]` with each one's URL. The other items (no `uuid`) are dashboard entries |
| Install | `saveScript {uuid: "new", new_script: true, code, reload: false}` | Returns `{uuid, installed}`. Always adds a script, even with the same name and namespace as one there |
| Replace | `saveScript {uuid, code, reload: false}` | Keeps the uuid, its settings, and its cached `@require` files |
| Supply a `@require` or `@resource` | `saveExternal {uuid, url, code, mimetype}` | Stored as if fetched from `url`. A `@resource`'s `code` is its bytes, one character each |
| Enable, disable | `modifyScriptOptions {uuid, enabled, reload: false}` | |
| Uninstall | `saveScript {uuid, code: null}` | To TM's trash |
| Remove for good | `purgeScripts {uuids}` | Whether or not it's in the trash |
| Read settings | `loadTree {referrer: "options"}` | `options`: `enabled`, `editor_easySave` |
| All scripts on or off | `setOption {name: "enabled", value}` | TM's own switch, which leaves the extension on |
| Which scripts match a URL | `determineScriptsToRun {url}` | `scripts`: uuids. By TM's own matching, but regardless of whether each script is on |
| A script's stored values | `loadTree {referrer: "options.scripts.userscripts.storage", uuid}` | `items[0]`. Not used yet (see [Future work](#future-work)) |

- `reload: false` keeps TM from reloading the active tab after a save,
  as its `autoReload` setting would. It also keeps the answer to the
  result, rather than the whole script list the dashboard redraws
  from.
- One listing of every script, code included, is reused for up to one
  second, so a command that reads the list, the texts and the count
  reads TM once.
  Any call that changes something drops it.

## Saving without a prompt

- A save goes through without asking only while TM's `editor_easySave`
  setting is on, as it is by default.
- With it off, TM opens its install page for each save, and the save
  waits for someone to confirm.
- So sm-dev reads the setting first, and refuses with what to change
  (Tampermonkey's "Easy save" setting) when it's off.

## Ids

- TM's ids are uuids. sm-dev gives each one an `E<n>`, kept in a file
  in sm-dev's cache (`~/.cache/sm-dev/tampermonkey-ids.json`).
  - A uuid is unique across browsers, so one file serves every
    browser.
  - A number stays with its uuid for 7 days after sm-dev last saw it,
    as SM keeps its numbers after a removal.
  - `SM_DEV_TM_IDS` moves the file, as the tests do, so their scripts'
    numbers stay out of the person's own.
- Otherwise, the same as under VM: run numbers, `C0`, names.

## Where scripts come from

- The same trailing comment marks a script's file, and a run's
  scripts, as under VM.
- TM saves no URL with a script saved from the dashboard, so it has no
  base for a relative `@require` or `@resource`.
- So sm-dev rewrites each relative or `file://` one in the header to
  `https://sm-dev.invalid/<its path>`, then hands over each file's
  contents with `saveExternal`.
  - Each line rewritten is kept as it was, in a comment at the end,
    before sm-dev's mark, so no line moves:
    `// sm-dev was: 5 // @require     lib.js`, by the line's index.
  - sm-dev puts them back as it reads the text, so `script print`,
    `refresh` and the mark see the script as it was.
  - TM uses what it was handed rather than fetching, so the host that
    never resolves never matters.
- A script from a URL has its relative dependencies rewritten to the
  URLs they resolve to from there, which TM fetches itself.

## The run's scripts

- As under VM: installed and marked, never over an installed script,
  replaced by an ended run's, and removed for good when the run ends.
- One difference: TM keeps any number of scripts with the same name
  and namespace, where VM keeps one.
  - sm-dev still treats a same-named script as the one to replace or
    refuse, as under VM, so `load` acts the same under both.
  - It replaces by uuid, never adding a second copy.

## Scripts on a tab

- TM's other scripts expected on a tab come from
  `determineScriptsToRun`: TM's own matching, including the overrides
  set in its editor.
  - sm-dev drops the ones turned off, and all of them while TM's
    switch is off, since TM's answer doesn't.
- The run's own scripts go by sm-dev's matching, as under VM. They're
  installed fresh, so no editor overrides apply to them, and the
  commands that list them don't wait on a call.
- The headings and JSON stay as under VM (`Expected on tab T1 using
  match rules`, `expected`): it's still a prediction of what runs, not
  a report of what ran.

## `file://` pages

- TM runs scripts on `file://` pages only with Chrome's "Allow access
  to file URLs" on for it.
- That's on for a copy loaded unpacked, as in a `--temp-browser`, and
  off by default for one from the Chrome Web Store.
- sm-dev leaves it as it is.

## Logs and errors

- TM runs each script's code under
  `chrome-extension://<TM id>/userscript.html?name=<name>.user.js&id=<uuid>`.
  - So a console line's or error's stack names the script, by its
    uuid, and through it its E-id.
  - TM's own warnings about a script, such as a `@require` it couldn't
    load, carry that URL too, so they count as the script's.
- A script's uncaught error is an uncaught exception (`Uncaught (in
  promise)`) from that URL: a `script` line, as under VM.
- Line numbers are shifted:
  - TM wraps the code in one line of its own, and puts the script's
    `@require` files before it, joined by newlines.
  - So a script's line `n` shows as `n + 1 + <newlines in its joined
    @require files>`.
  - sm-dev maps the run's scripts' stack lines back, whose
    `@require` files it handed over: to the script's line, or to the
    `@require` file's own (`file:///.../lib.js:2:27`).
  - Frames on TM's own line (`:1:`), and other scripts' lines, show as
    TM numbers them.

## How stable these calls are

- Not a published API: they're the messages TM's dashboard sends, and
  can change in any TM release.
- Each failure names the call and TM's version, and the calls stay in
  one file (`src/harness/tampermonkey.ts`).
- A version check (`tests/tm-api/tm-api.spec.ts`, `pnpm run
  test:tm-api`) tries each call against the fetched TM, as the VM one
  does.

### What sm-dev assumes about TM

`Checked` says whether the version check tries it.

| Assumption | Used for | If it changes | Checked |
| --- | --- | --- | --- |
| The background answers `{method, ...}` from TM's own pages, and the dashboard is at `options.html` | Every call | Nothing works | Yes |
| `loadTree` with the referrers above gives the fields listed | Listing, printing, finding a run's scripts | Listing fails, or shows wrong fields | Yes |
| `saveScript` installs with `new_script`, replaces by `uuid`, and moves to the trash with `code: null` | `install`, `load`, `update`, `refresh`, `uninstall` | Installing fails, or adds copies | Yes |
| `editor_easySave` lets a save through without TM's install page | Every save | Saves wait on a page no one sees | Its default only |
| `saveExternal` stores a dependency by its URL, and TM uses it rather than fetching | Scripts with local dependencies | Their dependencies are missing | Yes |
| `modifyScriptOptions {uuid, enabled}` and `setOption {name: "enabled"}` | `enable`, `disable`, `C0 enable`, `C0 disable` | Those fail | Yes |
| `purgeScripts {uuids}` removes for good | The end of a run | Scripts are left behind | Yes |
| `determineScriptsToRun {url}` gives the uuids TM matches | TM's other scripts on a tab | The lists are wrong | Yes |
| A script's code runs under `userscript.html?name=...&id=<uuid>`, after one line of TM's and its `@require` files | Logs and errors by script, and their line numbers | Lines aren't traced to scripts, or have wrong line numbers | Yes |

## Differences from Violentmonkey

| | Violentmonkey | Tampermonkey |
| --- | --- | --- |
| Script ids | `E<n>` from VM's numeric id | `E<n>` kept by sm-dev, from TM's uuid |
| Same name and namespace | One script | Any number; sm-dev keeps to one |
| Local `@require` | Given with the install | Header rewritten to `sm-dev.invalid`, then given with `saveExternal` |
| Other scripts on a tab | sm-dev's matching | TM's matching |
| `file://` pages | Blacklisted by default; cleared in a `--temp-browser` | Need Chrome's file access, on for an unpacked copy |
| Script line numbers | As in the file | Shifted; corrected for the run's scripts |

## Code layout

- [`src/harness/tampermonkey.ts`](../src/harness/tampermonkey.ts):
  the calls above, as an `ExternalManager` beside `violentmonkey.ts`,
  with the `@require` rewrite and the stack line mapping.
- [`src/harness/tm-ids.ts`](../src/harness/tm-ids.ts): the uuid to
  `E<n>` file.
- `ExternalManager`'s optional parts are TM's: `matching`, and
  `noteRequires` with `remapStack`. The rest is shared with VM
  (`external-manager.ts`, `run.ts`, the commands).
- Tests: `tests/harness/tampermonkey.spec.ts` against the fetched TM
  (skipped without one), the version check, and
  `tests/unit/harness/tampermonkey.test.mjs`.

## Future work

- **Values:** reading works without a tab (`options.scripts.userscripts.storage`),
  but TM takes a write (`saveStorageKey`) only from a page in a tab,
  which the hidden page isn't. So `values`, `get`, `set` and
  `--values` wait, as under VM.
- **Menus:** `execMenuCmd` runs a menu command on the active tab only.
- **The e2e driver:** `tampermonkey-driver.mjs` could use these calls
  instead of reading the dashboard.
