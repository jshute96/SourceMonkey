# Manual scripts (`@run-at context-menu`)

A script with `@run-at context-menu` is a **manual script**: it matches
pages like any other, but never runs on page load. It runs only when
asked, each time it's asked, like a bookmarklet.

- Tampermonkey (Chrome only) runs these from a right-click item on the
  page. SourceMonkey runs them from the toolbar popup instead, and from
  sm-dev's `menu`.
- Unlike Tampermonkey, the script's `@match` / `@include` / `@exclude`
  rules still decide which pages it can run on.
- Example: `tests/examples/run-at-context-menu/`.

## Header and storage

- `isManualScript` (`src/script-build.ts`) is the one test, by the
  header (`isContextMenuRunAt`).
- `validateHeader` accepts the value, and `unsupportedRunAt` gives no
  typo warning for it.
- An older build refused these scripts (`invalid`, with what is now
  `RETIRED_CONTEXT_MENU_UNSUPPORTED`). On extension update the worker
  refreshes those rows (`retiredHeaderProblemIds`):
  - a refresh always refetches an invalid row, and the rebuild loads
    the `@require` / `@resource` files an invalid row never got.

## Never registered

- `isRegistrationCandidate` leaves manual scripts out, so Chrome never
  injects them on load. `isManualRunCandidate` is the same rules for a
  manual one: `ok`, enabled, collection enabled.
- The match index marks them `manual`. `findMatchesForUrl` takes which
  kind it wants:
  - `'load'` (default): what a page is expected to run, so a manual
    script never reads as Missing.
  - `'manual'`: the popup's and sm-dev's candidates to run.
  - `'any'`: the bridge's "could this script be running here?" check.
- Navigation still asks the updater about matching manual scripts, so
  the next run uses a current copy.

## A run

`runManualScript` in `background.ts`, behind the popup's Run item and
the `runManualScript` API sm-dev calls. It always answers: a throw
partway becomes an `Internal error:` result.

1. Checks, each with its own message (`MANUAL_RUN_*` in
   `src/sm-dev-protocol.ts`, which sm-dev prints):
   - installed, manual, `ok`, the script on and its collection on;
   - the tab's page can take scripts, and the script's rules cover it;
   - `manualRunAllowed`: the sm-dev rule for scripts that run on load.
     A run's own scratch scripts only in its tabs, and in a tab a run
     controls, only what it allows.
2. Runs the parse check, since the registration sync never sees it.
3. Builds the injection with `buildManualRunInjections` (injector.ts):
   - the same pieces as a registration (config, prelude, requires plus
     body, seal), from `buildRegistrationSpec`;
   - the config carries `manualRun`, with the GM values snapshot for a
     storage script (what a registered script gets from check-pending);
   - first, our own pieces the page may lack, since they're registered
     only where registered scripts run: the bridge (page-world script)
     and the GM runtime (in the script's world). Both are no-ops where
     present.
4. In the tab's work queue (`inTabQueue`):
   - reads the top frame's current document, and checks the script and
     the URL again, since either may have changed during the steps
     above (`MANUAL_RUN_PAGE_CHANGED` for a page that moved off the
     script's rules);
   - counts the run on that document's state (`noteManualRun`), so the
     run's own `sm:start`, queued behind, finds a manual run rather
     than an unexpected script.
5. Outside the queue, injects with `chrome.userScripts.execute`,
   aimed at that document (`documentIds`): Chrome refuses rather than
   run it on a page that replaced it.
   - Outside, so an `alert()` the run opens doesn't hold up the tab's
     other bookkeeping.
   - A refusal from Chrome becomes the row's error and a Log entry,
     unless the page was replaced meanwhile: that's
     `MANUAL_RUN_PAGE_CHANGED`, told apart by asking for the current
     document rather than by Chrome's wording.
   - A run Chrome refused still counts as a run: it was asked for.
- The page's reload mode doesn't apply: after "Reload page with no
  userscripts" (or with only / without one), Run still runs a manual
  script, since the person asked for it.
- What the script does once it's running is reported as on load: a
  throw is `Error`, with its message, and the next run's outcome
  replaces it.

## The bridge gate

- `bridgeMayActAs` lets a page-world request act for a script only on
  a page that script runs on.
- A manual script runs only where asked, so it also has to have been
  run in the sender's document (`manualRanIn`).
  - Checked in memory first (`manualRunDocs`), then in the tab's state,
    after a worker restart.
- A page-world run is injected long after the page's own code, so a
  hostile page can plant a fake `__SM_GM__` / `__smPrelude` first and
  receive the run's config, values snapshot included.
  - Not withheld: the gate opens for that document at the same moment,
    so the page could ask for the values through the bridge anyway.
  - That's the trust a page-world script has everywhere: the page
    shares its world.

## In the page

- The prelude sees `manualRun` in the config: no check-pending round
  trip and no `@run-at` wait. The request is the decision.
- **Another run in the same document** (`rerunManual`):
  - Reuses the script's prelude entry rather than replacing it. The
    async error listeners read `entry.cfg`, so they report for the
    latest run, and aren't installed twice.
  - First calls the runtime's `retireRun`, which drops what the last
    run set up through it:
    - its menu commands, here and in the worker;
    - its value-change listeners.
  - What the last run did to the page directly (timers, listeners,
    DOM) stays. Nothing can stop that from outside.
- `storage.init` on a store already seeded in this document takes the
  run's fresh snapshot, except for the keys the cache changed since the
  last run started (`writeSeqByKey` past `initSeq`): this document's
  own writes, which the worker may not have had yet, and other tabs'
  broadcasts.

## Status and badge

- `TabMatchState.manualRuns` counts the runs on a document. It belongs
  to the document like the rest of the state: kept across pushState,
  gone on reload.
- `computeBadge`: a manual script that ran is OK (or ERROR), never
  Unexpected, and never stale (each run uses the current copy).
- The badge counts it once it has started, however many runs. Before
  that it's in neither the badge nor the tooltip (`summarizeToolbar`):
  not run is its normal state, and a page can match many.
- `applyScriptReport`: a manual run's start replaces the last run's
  error, unlike a script that runs on load, where an error sticks.

## Popup

- A **Manual** section between Enabled and Disabled, shown only when
  it has rows: manual scripts that are on, or still running here.
  - A manual script that's off goes in Disabled, as any other.
- Row status:
  - `Not run` (grey outline) before its first run here, with the
    tooltip `This script runs only when you choose Run this script`.
  - Then `Running` or `Error`. Running's tooltip says how many runs:
    `Ran 2 times on this page`.
  - `Still running` when turned off after a run.
  - No reload banner for any of these.
- **Run this script** heads the row's commands (`runnable`), bold, and
  never folds behind the commands disclosure.
  - Offered only where a run would go ahead: the worker passes the
    ids `runnableManualScripts` gives, by the run's own rules.
  - In a tab an sm-dev run controls, one the run keeps out shows
    `Not loaded`, as a script kept out of the load does, with no Run.
  - The popup stays open after it, so the new status and the run's
    commands show up as they arrive.
  - A refusal anyway (something changed meanwhile) goes in the
    script's Log.
- The row's menu has no "Reload page with only / without this script":
  no reload runs a manual script.
- See [status-popup.md](status-popup.md).

## sm-dev

- On each navigation in a tab a run controls, the worker reports the
  manual scripts the run could run there (`sm:manual`, protocol 1.6),
  since they won't report starting.
  - Each navigation includes a back/forward restore, where sm-dev has
    forgotten them, and a pushState, where it keeps one report per
    document.
  - sm-dev offers one only while the page's URL still matches its
    rules (`manualScripts`), so not after a pushState away.
  - None in a tab with its scripts off.
  - The run prints `<name> is waiting to be run on <url>, …`.
  - Page loads count it as the script's word, so they don't wait for
    a start.
  - `scripts` and `status` show `Waiting for menu to run it (@run-at
    context-menu)`; `--json` gives the state `manual`.
- `menu` lists `M1: Run this script` first under each such script,
  run or not; `--json` marks it `builtin: 'run'`.
  - Firing it calls `runManualScript`, and prints
    `Ran <name>`.
  - By label, with more than one manual script on the tab, it asks
    for the M number.
- The Playwright fixture: `gm.runScript()`, or
  `gm.fireMenu('Run this script')`.
- Under Tampermonkey or Violentmonkey, `menu` is SourceMonkey-only, so
  sm-dev can't run these there.

## Limits

- Top frame only, unlike scripts that run on load (see
  [frames.md](frames.md)): choosing among matching frames would add
  confusion for little use.
- No right-click item on the page: the popup is where scripts are.
