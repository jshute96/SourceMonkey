# Scripts in iframes

How userscripts run in a page's iframes (frames, below), and how the
toolbar, popup, Log and GM APIs treat a script running in several
documents of one tab.

## The model

As in Tampermonkey and Violentmonkey:

- **Every frame is matched on its own URL.** The top page doesn't have
  to match. A script for `https://player.example/*` runs in that
  player's iframe on any site.
- **Each matching frame gets its own run** of the script, with its own
  globals and its own `@run-at` timing, relative to that frame's
  document.
- **`@noframes`** keeps a script to the top frame.
- **Frames nest to any depth**, and all depths are treated alike.
- **Shared across a script's frames:** its stored values (with
  value-change listeners firing across frames), and the tab's popup
  row and menu.

## Registration

- A script registers with `allFrames: true` unless it has `@noframes`.
- The helpers it needs (the GM runtime, the MAIN-world bridge) always
  register with `allFrames: true`, on the same pattern union as before.
  - A helper in a frame where only `@noframes` scripts match is unused
    there. Scoping helpers per frame flag would mean tracking a second
    pattern union for the sake of an idle helper.
- **Frames with no URL of their own** (`about:blank`, `srcdoc`,
  `blob:`, `data:`) get no injection: `chrome.userScripts` has no
  `matchOriginAsFallback`. A script in the parent can still reach a
  same-origin one through `iframe.contentDocument`.
- **Manual scripts** (`@run-at context-menu`) still run in the top frame
  only. Choosing among several matching frames would add confusion for
  little use.

## Telling a frame from a page

- A message's `frameId` alone doesn't say: Chrome numbers a prerendered
  page's top frame like an iframe.
- So `src/extension/frame-info.ts` looks up a document with a frame id
  other than 0 (`chrome.webNavigation.getFrame`). It walks up through
  its parents to the page's document, and caches the answer by
  document id.
- It also says whether the document is still in the tab, for reports
  that may arrive late.

## Status: badge and popup

Status stays per tab, kept on the top document's state
(`TabMatchState` in `src/extension/tab-status.ts`).

- **One row and one count per script**, however many frames it runs in.
- **Runs in frames** are kept apart from the top document's own reports,
  in `frameRuns`: per script, per frame document.
  - A frame's report never makes a document entry of its own in the
    tab's history. That history is for the top document's navigations.
- **The row's status is the worst** of the script's runs: its top-frame
  status and each frame's.
  - Order, worst first: Error / Rejected, Updated (reload), Missing,
    Unexpected, Untracked, Not loaded, Warning, Running.
  - Warning is kept per script for the tab, not per run: a warning
    logged from any of its documents turns its Running into Warning.
- **Missing applies to the top frame only.** What runs in frames is
  never predicted: iframes load late, or are added by the page. So a
  frame-only script can't be Missing, and a script expected in the top
  frame that ran only in a frame is still Missing.
- **Unexpected applies to the top frame only.** A run in a frame is
  matched on the frame's URL, so it is never unexpected.
- **Updated (reload)**: a script whose code changed is flagged when any
  of its runs is from the older code.
  - Marked per frame run, so a frame that loads again with the new code
    isn't.

### Active in frames

- A script that runs in frames but neither matched nor ran in the top
  frame is listed in its own popup section, **Active in frames**, below
  Enabled.
- A script running in both is listed once, under Enabled.

### When a frame's run ends

- A frame navigating to another document, or being removed, ends its
  runs. The worker drops a run whose document isn't one of the tab's
  live frames (`chrome.webNavigation.getAllFrames`):
  - when any frame of the tab commits a navigation;
  - when the popup is built.
- Removing an iframe sends no event, so the badge can count a run whose
  frame is gone until one of those happens.
- A top-frame navigation starts a new state, with no frame runs.

## Script Log

- A run in a frame says so, and names the page:
  `Started in an iframe at <frame URL> on <page URL>`.
- **One row per page** for a script's frames, counting them, rather
  than a row per frame. A page of 20 matching ad frames would otherwise
  fill the script's Log in a few loads.
  - `Started 3 times in iframes on <page URL>, latest at <frame URL>`.
  - Errors fold by their message: frames failing alike make one row,
    with a line `In iframes 3 times on <page URL>, latest at <frame
    URL>`; different failures get a row each.
  - "Did not run in this iframe" rows fold the same way.
  - Built on the Log's folded entries (see
    [script-log.md](script-log.md#folded-entries)).
- A report from a frame no longer in the tab (an async error from the
  previous page's frames, arriving after the tab moved on) is dropped,
  from the Log as well as the badge.
- A frame's rows name the page the frame is in, not the one the tab
  shows by the time they're written.

## Header warnings

- A script's header warnings (`startupLogs`: an unknown `@grant`, ...)
  go to the page console once per page, not once per frame: all a
  tab's frames share one DevTools console.
  - The top frame's copy prints them.
  - A frame's copy prints them only when its decision
    (`sm:check-pending`) says so: the first frame to ask, for a script
    that doesn't match the page's URL.
  - Not for a frame the script skips (a `.tld` rule's `no-match`).

## Menu commands

- Kept per document: each frame's commands are its own, and a click
  fires the command in the document that registered it.
- The popup merges a tab's documents under each script's row: the top
  frame's commands first, then each frame's.
- Each entry also records the page (top document) it belongs to. A
  top-frame navigation drops every entry from an earlier page, frames
  included.
- A tab's registrations and removals are handled in the order they
  came, as a frame's first looks up its page.
- A script registering the same command in several frames shows it
  once per frame, with nothing to tell them apart.
- A frame's commands go when its document does (the same pruning as
  frame runs).

## GM APIs

- **Value broadcasts** reach the writer's sibling frames, as they do
  other tabs.
  - The worker keeps, per script and tab, the documents running it
    (from their starts, writes and resyncs). The writer's tab gets the
    update in each of those but the writer's.
  - Nothing extra when the writer is the only one, the usual case.
  - In memory only: after a worker restart a sibling may miss updates
    until it writes or resyncs, as with a lost broadcast.
- **GM_xmlhttpRequest** and URL-change events already reply to the
  sending document only.
- **Tab-scoped APIs** (`GM_openInTab`, `GM_notification`, ...) stay per
  tab: a frame's call acts for its tab.
- **`@grant window.close`** overrides `close` in the top frame only, as
  TM does: a frame's `window.close()` stays the page's no-op, and the
  worker refuses a close sent from a frame.
- **The MAIN-world bridge** refuses to act for a `@noframes` script in
  a frame.
  - Reports it relays (started, threw) are taken only for a MAIN-world
    script, and not for a `@noframes` one from a frame.

## Reload fast path

- Only the top frame's scripts get it. After an edit and a reload, a
  frame may run the copy registered before the edit, and show Updated.
- A frame-only script never gets it, so an edit may take a second
  reload.

## sm-dev

- A run reports a script in a frame as `started in an iframe on <frame
  URL>` (`frame` on the report).
- A menu command records its document, and fires there.
- Reading a script's state and evaluating in its world still reach the
  top frame only.
- A run keeps a frame's menu commands after the frame has gone.
- Protocol 2.1 adds frame events and the document on a menu fire. An
  older extension fires the first matching command.
