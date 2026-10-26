# Run now

Runs a script that normally runs on page load into the page that is
already open, without a reload. Useful when:

- a reload left scripts out ("Reload page with no userscripts", or
  with only / without one script);
- a script was enabled or installed since the page loaded;
- a script was updated, and getting the page back to where it was
  after a reload takes many steps;
- a disabled script is worth trying once, without turning it on.

A manual script (`@run-at context-menu`) has its own "Run this script"
([manual-scripts.md](manual-scripts.md)). Both go through the same
worker operation.

## Where it's offered

- **Popup, script ⋯ menu**, after the reload items and a separator:

  | Row | Item |
  |---|---|
  | `Not loaded`, `Reload to run`, `Missing`, `Reload` (page loaded before SourceMonkey started) | Run now |
  | `Updated` | Rerun updated version now |
  | Disabled (its box or its collection off), not running | Run now |

  - Not on a manual script, an `Invalid` one, or one that's running
    and current.
- **Popup, script ⋯ menu, disabled script**: "Reload page with this
  script" replaces "Reload page with only / without this script",
  which would do nothing for it.
- **Popup, page ⋯ menu**, each only when it applies:
  - "Run newly enabled scripts now": the `Reload to run` rows.
  - "Rerun updated scripts now": the `Updated` rows.
- **sm-dev**: `run-now [T<n>.][script]`
  ([sm-dev-design.md](sm-dev-design.md#run-now)).
- None of the popup items appear in a tab an sm-dev run controls: the
  run decides what runs there (`perScriptReload` in the view).

## Warnings

A run that may not work as expected shows a ⚠ after its menu label,
with a tooltip listing why. sm-dev prints the same reasons as
`Warning:` lines. The strings and `runNowWarnings` are in
`src/extension/popup-view.ts`.

- **Document-start script**: it's run after the page has loaded.
- **Rerun**: a copy already runs in the page. What it did to the page
  (listeners, timers, DOM) stays.
- **Another copy**: another copy of the same script (`@namespace` +
  `@name`) runs in the page.
- **Page loaded before SourceMonkey started**: code from the earlier
  SourceMonkey may still be running in it.

A page-menu item shows every warning any of its scripts has. "Reload
page with this script" shows only the other-copy one, and leaves the
document-start and loaded-before ones out of its Log entries too: its
runs start as each document does.

- The Log entry lists the warnings as sentences after `Run manually on
  <url>.`

## The run

`runScriptNow` in `background.ts`, shared with manual scripts. It
always answers, with `{ ok, rerun, warnings }` or an error.

1. **Checks**, each with its own message (`src/sm-dev-protocol.ts`):
   - installed and `ok`; a manual script must also be on;
   - the tab's page can take scripts;
   - the script's rules match the page or one of its frames
     (`RUN_NOW_NOT_HERE`);
   - the sm-dev claim: a scratch script only in its run's tabs, and in
     a tab a run controls, only that run's scripts. A tab switched to
     `--noscript` still takes one: the run was asked for.
2. **Targets**: each of the tab's documents whose own URL the
   script's rules match (`runTargets`), as a load would pick them:
   - the top frame, or not, by its URL;
   - no iframes for a `@noframes` script, or a manual one;
   - none with no URL of its own (`about:blank`, `srcdoc`).
3. **Builds** the injection as a manual run does
   (`buildManualRunInjections`), with `manualRun.waitRunAt` set for a
   script that runs on load.
4. **In the tab's queue**: re-checks, works out the warnings, and
   counts the run on the page's state (`noteManualRun`) before
   injecting, so its start report finds it.
5. **Log**: an info entry, `Run manually on <url>` or `Rerun manually
   on <url>`, with the warnings.
6. **Retires the running copy** on a rerun (`retireRunningCopy`):
   - drops its menu commands from the worker's list, telling sm-dev;
   - sends `sm:gm-retire-run` to each target document, awaited, so
     each GM runtime holding the old copy drops its commands and value
     listeners before the new run can register its own.
7. **Injects** into each target with `chrome.userScripts.execute`
   (`runInDocument`), as a manual run does: a page-world run under the
   document's own key, with its own bridge and GM runtime.
   - A target Chrome refuses gets an error on the row and in the Log.
     The run is `ok` if any target took it.
   - A target whose frame has a new document by then (or is gone) was
     a race, not an error: it's skipped quietly.

## In the page

- The config's `manualRun` is the decision: no check-pending round
  trip, and the page's reload mode doesn't apply.
- `waitRunAt`: the body still waits for its `@run-at`
  (`startManualRun`). On a loaded page that has passed, so it runs at
  once; one run while the page is still loading waits as on a load.
- Its `sm:start` carries `manualRun: true`.

## Status and badge

- `TabMatchState.manualRuns` counts runs on the page, as for manual
  scripts, and `rerunIds` notes a run over a copy already there.
  - A rerun is a run into a document where a copy reported starting
    (`runsIn`). One whose earlier run never started isn't, and nor is
    a run into a frame the copy isn't in.
- A manual run's start replaces an error (top frame and frames) and
  clears `stale`: it ran the current copy. A later update marks it
  stale again.
- A disabled script run this way reads `Running`, not `Still running`,
  so no reload is asked for.
  - Its `Running` tooltip says `Run manually` or `Rerun manually`.
- Badge count: `Not loaded` scripts count only when no other script
  has a status (see [matching.md](matching.md#badge)).
- After a reload, the usual rules apply again: the runs belong to the
  document.

## The bridge gate

- `bridgeMayActAs` lets a page-world request act for a script that's
  off only in a document it was run in (`manualRanIn`), and only where
  its rules match the sender's URL.
- After a worker restart, a frame's run is found on its page's state.

## Reload page with this script

- A `ReloadMode` of kind `with`: arms the tab as the other reloads do,
  but keeps nothing out, so the reload fast path still applies.
- The new document's state carries the script (`runWith`), so it
  survives a worker restart, and ends with the document.
- Each document of the page gets its own run, as "Run now" runs it,
  when the script's rules match its URL:
  - the page itself, at the reload's commit (`runAfterReload`);
  - each iframe, at its own commit (`runWithInFrame`), for as long as
    the page lasts. An iframe added or navigated later gets it too, as
    it would an enabled script's. Not for a `@noframes` script.
- The top page doesn't have to match: a script for an iframe only
  waits for it.
- Timing: a run waits on the worker's checks and the tab's queue
  before it's injected, so a document-start script may still start
  after the page's first inline scripts.

## Bulk runs

The page menu's items send their scripts in one `sm:popup-run-script`
message. The worker runs them one at a time, by `@run-at` order
(document-start first), then as the popup listed them.
