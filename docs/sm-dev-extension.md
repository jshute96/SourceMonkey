# sm-dev and the extension

Design for how `sm-dev` works with the real SourceMonkey extension. The
two backends:

- **Harness** (the default): sm-dev injects the scripts itself, with a
  Node stand-in for the extension (`HarnessHost`).
- **Extension** (`--extension`): the scripts are pushed into the real
  SourceMonkey, into a test collection of the run's own, and the
  extension runs them.

Status: being built. Done: the shared commands, tab claims (in both
kinds of run), the event stream, SourceMonkey-managed scripts (E1,
...), and the toolbar marker. User-facing behavior is in
[harness-guide.md](harness-guide.md#the-extension-backend).

## Goals

- **Every run command works in extension runs**: page commands
  (`snapshot`, `click`, `eval`, `wait`, `tabs`, `newtab`, ...),
  `status`, and the script commands (`get`, `set`, `menu`, `load`,
  `update`).
- **Only one controller per tab.** In a harness run, the extension's
  scripts stay out of the run's tabs. In an extension run, only the
  run's scripts run in them.
- **Output as it happens** in extension runs, as in harness runs: Log
  entries, script starts and errors, tabs a script opens.

## Order of work

1. Shared commands: one command layer for both backends, so extension
   runs take the page commands and `status`.
2. Tab claims, for both kinds of run.
3. The event stream from the extension.
4. Script state: `get`/`set`/`values`, `menu`, and the extension's
   other scripts (E1, E2, ...).
5. `load` and `update` in extension runs.

## Shared commands

- One implementation of each command (`console-commands.ts`,
  `page-commands.ts`, `wait.ts`).
- Commands that only use Chrome, CDP or sm-dev are the same in both
  backends:
  - `snapshot`, `click`, `type`, `hover`, `screenshot`, `savehtml`;
  - `cdp`, `tabs`, `closetab`, `accept`, `dismiss`;
  - `wait <time>`, `wait selector`, `wait log`.
- The rest go through the run's host and each tab's attachment, which
  an extension run replaces (below): waiting for scripts to start or a
  page to settle, the world `eval` runs in, values, menus, and pushing
  scripts for `load`, `update` and `--watch`.
- So the command code is unchanged; an extension run is a harness run
  with a different host and watch-only attachments.

### Extension runs add nothing the page can see

- The harness's `PageAttachment` exists to run scripts: the `GM_*`
  bridge, the tab badge, the start reports. In extension runs the
  extension does all of that, so tabs are attached watch-only
  (`AttachOptions.watchOnly` in inject.ts):
  - no bindings, no bridge, no runtime, no badge;
  - only the activity tracker `wait` reads, in an isolated world CDP
    creates, which neither the page nor the extension's scripts can
    see;
  - `inject` only records the script, so the waits and reports know
    what to expect.
- `eval --script` runs in the extension's user-script world: the tab's
  execution context whose origin is the extension's.
- The host is an `ExtensionHost` (extension-host.ts): it turns the
  extension's events into the bridge messages a harness page sends,
  and the harness host's own code records them. Values and menu clicks
  go to the extension.

## The extension's API

- The extension's service worker (SW) exposes `self.SourceMonkey`,
  first added for the e2e tests. sm-dev calls it over CDP with
  Playwright's `worker.evaluate` (`ExtensionLink` in
  `src/harness/extension-link.ts`).
- What sm-dev uses:
  - the run's scripts: `writeRunScript` (see
    [Test collections](#test-collections)), `getScriptLog`;
  - values and menus: `getGmValues`, `writeGmValues`,
    `fireActionContextMenuItem`;
  - claims: `claimTab`, `renewRun`, `releaseRun`, `setTabScriptsOff`
    (below). `releaseRun` also removes the run's test collection.
  - SourceMonkey-managed scripts: `scriptsOnTab(tabId)`, the rows the
    toolbar badge shows for a tab, with each one's collection;
  - tabs: `tabDocument(tabId)`, which document a tab shows, to tell
    which page an opened tab is.
- Scripts are named by the extension's script id, a UUID kept stable
  across refreshes ([script-identity.md](script-identity.md)).
  - A re-push of the same file in a run keeps the script's id and
    its stored values.
  - A script deleted in the browser and pushed again gets a new id.

### Version skew

- The extension and sm-dev can come from different builds: sm-dev from
  a repo's install, the extension from the person's browser.
- An extension run checks for the API calls it needs (`typeof
  self.SourceMonkey.x`) as it starts. An older extension is refused
  with a message saying to update it, or to use `--temp-browser`, which
  loads sm-dev's own copy (`EXTENSION_TOO_OLD`).
- A harness run's claims only keep the extension's scripts out, so an
  older extension can be passed by: the run says once that its scripts
  may also run in the run's tabs.

## Tab claims

A claim tells the extension what to run in a tab sm-dev controls:

- **Harness runs** claim with *nothing*: the extension runs none of its
  scripts there.
- **Extension runs** claim with *the run's scripts*, the ones in its
  test collection: the extension runs only those there.
  - That is the right default: the usual case is a copy of a script
    also installed in a collection, and both would run in the same tab
    otherwise.
  - To test a script alongside installed ones, push those with the run
    too.

### How the extension honours a claim

- SourceMonkey wrappers ask the SW `sm:check-pending` before running
  their script's body, and honour a `skip` answer. That is how "Reload
  page with no userscripts" works (`background.ts`).
- A claim is a per-tab rule the check-pending handler consults first:
  `skip` unless the script is one of the claiming run's own.
- A run's script is skipped in every other tab, unclaimed or claimed
  by another run, so it runs only in its own run's tabs.
  - The handler tells by the script's location, which names its run
    (`scratch:///<run>/<path>`).
  - The toolbar badge leaves it out of those other tabs entirely, so
    it shows as neither missing nor not loaded there.
- Chrome still injects the wrappers; only their bodies are skipped.

#### Making every wrapper ask

A `document-start` wrapper normally skips the check where the answer
can only be `run` (see
[injection.md](injection.md#skipping-the-check-at-document-start)).
A claim can `skip` on any navigation, so the SW turns that off:

- While any claim is live, the SW re-registers every script with a
  `mustAsk` flag that makes its wrapper ask.
- `claimTab` and `renewRun` resolve only once that is in place, so the
  run's first page is covered.
- A release, or a lapsed lease (on a timer), turns it back off.
- Until the SW has loaded the claims after a restart, registrations
  are built as asking.
- Scratch scripts always carry `mustAsk`.

What that costs:

- Registrations are global, so the person's other tabs ask too while a
  run is active. Their `document-start` scripts may run after the
  page's first inline scripts there.
- In an sm-dev `--extension` run, a `document-start` script may also
  run after those page scripts, where the extension alone would run it
  first.

### Naming the tab

sm-dev knows a tab by its CDP target id; the extension knows it by its
`chrome.tabs` id. Neither can see the other's. The claim step names it:

- sm-dev first loads a small page of the extension's in the tab
  (`sm-dev.html`), as it already opens the collections page to wake
  the SW.
- It reads the tab's id there with `chrome.tabs.getCurrent()`, which
  only an extension page can call, and claims the tab through the API
  (`claimTab`).
- Only then does it load the run's page. The claim is in place before
  the first document the scripts could run in.
- sm-dev keeps the tab id, which also names the tab in the extension's
  events and per-tab calls.
- The page leaves a Back history entry. A tab with no page to load
  goes on to `about:blank`.

### Which tabs get claimed

- T1, `newtab` tabs, and a reused tab from an earlier run: sm-dev
  opens them, so it claims them as above.
- Tabs a claimed page opens (`window.open`, `target=_blank` links):
  the SW claims them itself, from
  `webNavigation.onCreatedNavigationTarget`, whose `sourceTabId` is the
  claimed tab. They get the opener's claim.
  - That event comes before the new tab's first commit. The claim waits
    on the stored claims loading, and `sm:check-pending` waits behind
    it, so the new tab's scripts see it.
- Tabs a script in a claimed tab opens with `GM_openInTab`, in an
  extension run: the extension opens the tab blank, claims it, and only
  then loads the URL.
- Tabs the harness's own `GM_openInTab` opens: the harness opens them
  blank, claims them as above, then loads the URL
  (`AttachOptions.claimOpenedTab` in inject.ts).
- A harness run claims only when the browser has SourceMonkey installed
  and enabled, with or without scripts. It doesn't subscribe to the
  extension's events.
- Both bridges hear a page-world script's messages, so each leaves the
  other's scripts alone:
  - the harness's ignores messages about scripts it never injected
    (SourceMonkey-managed ones), whose `run` would beat the extension's
    `skip`;
  - the extension applies a claim only to its own scripts, so a harness
    page-world script still hears `run` from it.
- A harness run's failed claim is said, and the run goes on: the tab
  may then also run SourceMonkey's scripts.
- Tabs the person opens: never claimed, in any browser, a
  `--temp-browser` included (another sm-dev can connect to its port
  too). They run whatever the extension has, as in normal browsing.
  - To bring one under the run, open it with `newtab` instead.
  - Possible later: an action-menu row, "Put this tab under sm-dev
    control".

### Lifetime

- A claim is per tab, not per document: it lasts across reloads and
  navigations in that tab.
- It ends when:
  - sm-dev releases it, as the run ends or a tab is closed in the run;
  - the tab closes (`tabs.onRemoved`);
  - its lease runs out.
- **Lease**: a killed sm-dev can't release its claims, and the person's
  tab would then quietly run no scripts. So each claim carries the
  run's id and an expiry, about 30 seconds, which the run renews about
  every 10 seconds. The handler treats an expired claim as gone.
- A connected browser's tabs stay open after the run. Released, they
  run the extension's scripts again on their next load.

### Surviving the SW stopping

- Chrome stops an idle SW (after about 30 seconds) and starts a new one
  for the next event. "Reload with no userscripts" keeps its marker in
  memory, which is fine for its few milliseconds; claims last minutes.
- So claims are kept in `chrome.storage.session` too: kept while the
  browser runs, cleared when it closes.
  - The SW loads them as it starts. `handleCheckPending` awaits that
    load before answering, so a restarted SW can't answer `run` for a
    claimed tab.
  - Renewals write through to storage.

### Failure modes

- **The wrapper's 2-second timeout runs the script.** If the SW can't
  answer `sm:check-pending` in time, the prelude runs the body anyway
  (`userscript-prelude.js`). A claimed tab can then run an extension
  script. This is rare (a SW starting takes well under a second). The
  run doesn't say when it happens yet (see TODO.md).
- **A MAIN-world script** asks through the page bridge, which also ends
  at the SW, so the same rule covers it.
- **An older SourceMonkey** without the claim calls: see
  [Version skew](#version-skew).
- **Claims lost**: an extension reload clears session storage, and a
  claim runs out if the worker was stopped past its lease.
  - Each renewal lists the run's tabs, and the extension claims again
    any that are still open and lost their claim.
  - It says how many, and the run prints that when a worker restart
    caused it.
- **Several runs in one browser**: see below.
- **A run with no scripts** claims its tabs too, with nothing in its
  test collection yet, so a later `load` runs only its own scripts
  there. Tabs the person opens by hand aren't claimed, and run
  SourceMonkey-managed scripts as usual.

### Several runs in one browser

Two sm-dev runs can share a browser: two shells on the shared browser,
or a second run pointed at a `--temp-browser`'s port.

- **Claims**: each tab has at most one claim, naming its run.
  - A run claims only tabs it opens, so two live runs never claim the
    same tab. A run takes over a tab only from a run that has ended
    (`openRunTab`), whose claim was released or has expired.
  - Leases are per run: one run's renewals and release touch only its
    own claims.
  - Mixed backends work: a harness run's tabs skip every extension
    script, the other run's scripts included.
- **Scripts**: each run has its own test collection, so two runs
  pushing the same file each get their own copy.
- **Event stream**: each run subscribes under its own id. The SW writes
  each event once, and every subscribed run hears it and keeps the ones
  about its tabs and scripts.

## Test collections

An extension run's scripts go into a collection of the run's own, its
test collection, which holds exactly the scripts the run pushed.

### Naming

- The run's id in the extension is sm-dev's run id with a random tail,
  such as `D2-a3f9` (`linkRunId` in extension-link.ts), since sm-dev
  reuses run ids once a run ends. Its claims carry the same id.
- The collection is `container:sm-dev:<id>`, shown on the collections
  page as `sm-dev test collection (run D2-a3f9)`, with an `sm-dev` type
  bubble in place of `scripts`.
- Its scripts' locations are `scratch:///<id>/<path>`, where `<path>`
  is the file's path as given to `start` or `load`, relative or
  absolute (`scratch:///D2-a3f9/../sites/x.com/x.user.js`). Their text
  is a storage row ([storage.md](storage.md#container-collections)).
- `status` shows the id on its `Backend:` line, to find the collection
  in the extension.

### Contents

- The first push creates it, so a run with no scripts has none.
- One script per file path, so two files of the same name in
  different folders are two scripts. A re-push replaces it in place,
  keeping its id and stored values; a new push that doesn't parse is
  reported and not kept.
- Each run starts with empty stored values, since its collection is
  new.

### Removal

- **The run ends**: `releaseRun` removes the collection, its scripts
  and their stored values.
- **The run crashed, or lost its browser connection**: each run has a
  lease of its own, renewed with its claims. The worker removes a
  collection 5 minutes after its run's lease ran out
  (`RUN_GRACE_MS`), in case the run was only stalled.
  - Checked as the worker starts, and every minute by a
    `chrome.alarms` alarm while any test collection exists.
  - A sweep more than 3 minutes after the last one means the computer
    slept or the browser stalled, sm-dev with it. It removes nothing,
    and every lease starts its 5 minutes again.
  - A collection whose run has no lease on record (the browser
    restarted since) gets its 5 minutes from when the worker finds
    it.
- Only its run changes a test collection. Otherwise it behaves like a
  `scripts` collection.
  - The extension's pages offer no move into or out of one, no install
    into one, and no rename; the store refuses the moves and installs
    (`SM_DEV_COLLECTION_LOCKED`).
  - Removing its scripts, or the whole collection, by hand still
    works.

## The event stream

- Extension runs used to poll each pushed script's Log every 500ms.
  That was slow to show things, and missed what isn't in a Log, like
  tabs a script opens.
- Instead, the SW pushes events to sm-dev, over its console:
  - While a run is subscribed (`renewRun`, a lease like the claims),
    the SW writes each event as `console.debug('sm-dev-event', json)`.
    Without a subscriber it writes nothing.
  - Playwright reports the worker's console to the run
    (`worker.on('console')`), over the run's own connection.
  - Not a CDP binding in the worker: Playwright opens no CDP session on
    a worker, and the console needs none.
- Events:
  - Log entries, which replace the polling;
  - a script started, errored, or was skipped on a tab;
  - a menu command registered or removed;
  - a value changed;
  - a tab opened by a script (`GM_openInTab`), with its opener.
- Commands then work as in harness runs: output arrives as it happens,
  and `wait`, `open` and `reload` wait on "started" events.

### Ordering events against navigations

- A tab's events come over the worker's connection, its navigations
  over the page's, and nothing orders the two.
- A report handled before its document's navigation would be stamped
  before that document began, so `open`, `reload` and `wait` wouldn't
  count it; a menu command would be cleared by the navigation after.
- So `ExtensionHost` handles each tab's events in order, and one from
  a new document (a new `documentId`) waits, up to a few seconds, for
  the attachment to enter a document after the last one.
- Log entries that only repeat a report (started, threw, skipped) are
  marked `fromReport` by the extension and not printed twice.

### When the SW restarts

- A new SW has no subscriptions. sm-dev watches for the new worker
  (Playwright's `serviceworker` event), listens to it, and subscribes
  again.
- Events in the gap are lost, and the run says so. To do: read each
  script's Log once after a restart, to catch up on its entries (see
  TODO.md).

### Tabs a script opens, in extension runs

- The extension opens `GM_openInTab` tabs with `chrome.tabs.create`, so
  Playwright reports no popup for them. The event carries the new tab's
  `chrome.tabs` id and its opener's.
- The opener is a claimed tab, so sm-dev knows it. Which Playwright
  page is the new tab is matched by document (`adoptOpened` in run.ts):
  - the worker reads the tab's top-frame URL and
    `performance.timeOrigin` (`tabDocument`, with
    `chrome.scripting.executeScript` in the page's world);
  - sm-dev reads the same from each page not yet accounted for, and
    takes the one that agrees. The time origin is the document's start
    to the microsecond, so two pages don't share it.
  - Both are read again until they agree, since the tab may be
    navigating (a redirect). Nothing is added to the page.
  - A tab that can't be matched (a page extensions can't script, such
    as `chrome://`) is said, not guessed: its claim still holds, but
    its output isn't shown.
- The new tab's events wait until it's set up (`expectTab`), and then
  print under it.
- CDP's `TargetInfo.openerId` is not set for a tab `chrome.tabs.create`
  opens, so it can't settle this.
- The same events adopt `window.open` and link tabs in extension runs,
  in place of Playwright's `popup` event, since they carry the tab id.

## What runs where

Without `--extension`, sm-dev injects its scripts itself; with
`--extension`, it pushes them into a test collection of the run's own
in SourceMonkey.

Terms used below:

- **sm-dev's tabs**: the tabs an sm-dev run opened (T1, `newtab`), and
  the tabs that sm-dev's tabs open.
- **Your tabs**: every other tab in the browser.
- **SourceMonkey-managed scripts**: the scripts installed in
  SourceMonkey's collections, not via sm-dev.

### Which scripts run in sm-dev's tabs

| Browser | sm-dev without `--extension` | sm-dev with `--extension` |
|---|---|---|
| No SourceMonkey | sm-dev's scripts | refused: not installed |
| SourceMonkey turned off | sm-dev's scripts | refused: turned off |
| SourceMonkey on | sm-dev's scripts only | sm-dev's scripts only |

- `--temp-browser` with `--extension` installs SourceMonkey in the
  temporary browser, so sm-dev with both flags is in the "SourceMonkey
  on" row.
- Your tabs run SourceMonkey-managed scripts if SourceMonkey is on,
  and nothing otherwise. sm-dev's scripts never run in your tabs,
  with or without `--extension`.
- With `--extension`, a run's scripts run only in that run's
  tabs: not in your tabs, and not in another sm-dev run's tabs.

### What shows for sm-dev's tabs, with SourceMonkey on

| | sm-dev without `--extension` | sm-dev with `--extension` |
|---|---|---|
| Toolbar icon | cyan **T** | cyan **T** |
| Tooltip and menu | `Page under sm-dev control` | `Page under sm-dev control` |
| Badge rows | managed scripts that match: `NOT LOADED` | sm-dev's scripts: their status<br>managed scripts that match: `NOT LOADED` |
| Badge count and color | `0`, grey | sm-dev's scripts, colored by their status |
| sm-dev `status` | sm-dev's scripts | `Backend:` line<br>sm-dev's scripts<br>managed scripts on the tab as E1, ... |

- Without SourceMonkey, or with SourceMonkey off, there is no
  SourceMonkey toolbar icon, and `status` lists sm-dev's scripts. The
  first line of `status` names the browser's state: `no extension` or
  `SourceMonkey disabled`.

### Notes

- The tables above also hold for an sm-dev run started with no
  scripts: sm-dev's tabs are claimed all the same, so scripts added
  later with `load` run alone in sm-dev's tabs.
- SourceMonkey's badge lists only scripts installed in SourceMonkey.
  Without `--extension`, sm-dev's scripts aren't in the badge, though
  the reports of sm-dev's page-world scripts reach SourceMonkey's
  bridge.
- With `--extension`, the run's test collection is removed as the run
  ends, so its scripts run nowhere after.
- After an sm-dev run ends, sm-dev's tabs keep the scripts and
  toolbar state described above until each tab's next load, which
  runs SourceMonkey-managed scripts again.

## `status` and `scripts`

- In extension runs only, a line says where the figures come from:
  `Backend: SourceMonkey extension, test collection D2-a3f9`. Harness
  runs, the default, show none.
  - Before the first push, there is no test collection yet, and the
    line says so: `Backend: SourceMonkey extension, run D2-a3f9, with
    no test collection until a script is pushed`.
- The run's scripts keep their numbers (1, 2, ...), in push order, the
  same ones `get`, `set` and `menu` use.
  - Not yet: a script deleted or turned off in the browser keeps its
    number, and its row says `Removed from the extension` or `Disabled
    in the extension`, read live from the extension.
- **SourceMonkey-managed scripts on the tab**: a separate list, shown
  only when there are any.
  - The extension's other scripts that match the current tab, as its
    toolbar badge lists them, named E1, E2, ... in the order sm-dev
    first sees them, kept for the run.
  - The run's claim keeps them out of its tabs, so their status there
    is "Kept out of the run's tabs".
  - `values E1` shows one's values; `scripts E1` picks it for `get`
    and `set`, and it's marked `*` in the list. `set` on one needs
    `--force` after the key outside a `--temp-browser`, since it changes
    the person's real data: `set key --force <json>`.
  - `menu` and `logs` don't take them: they never run in the run's
    tabs. `load`, `update` and `--watch` don't apply either: the run
    didn't push them.

## The toolbar badge in a claimed tab

- In a tab a harness run claims, the extension's matching scripts are
  shown as **not loaded** (grey), as after "Reload page with no
  userscripts": nothing is wrong, they were told to skip.
- In a tab an extension run claims, the scripts the claim keeps out
  show as not loaded. The badge stays green when the run's scripts ran
  (grey only when nothing did).
- The count is of the scripts the claim let run (`computeBadge` in
  tab-status.ts): `0` in a harness run's tab.
- The action menu's first row says `Page under sm-dev control`
  (disabled, a note). The icon's tooltip says it too, under
  `SourceMonkey` (`titleHead` in tab-status.ts).
- The menu has no "Reload page with no userscripts" row there: which
  scripts run in the tab is the run's choice (`reload --noscript`).
- A cyan **T** drawn in a corner of the icon marks a claimed tab (see
  below). Cyan is used nowhere else in the badge colors.
- All of these follow the document: a page loaded under a claim keeps
  them until the tab's next load, the one after the run ends
  included.
- Chrome's action API gives one badge (text and color) per tab, so the
  marker can't be a second badge.
  - `chrome.action.setIcon({ tabId, imageData })` sets a per-tab icon.
    The SW draws it with `OffscreenCanvas`: the normal icon with the
    marker in the top-left corner, clear of the badge at bottom-right.
  - It's set back on the tab's first page load with no claim. A worker
    that restarted doesn't know which tabs an earlier one marked, so
    it sets each tab's icon back on its first render.
