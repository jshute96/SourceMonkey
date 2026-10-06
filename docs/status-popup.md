# Active scripts popup

The panel that drops down from the toolbar icon: what's running on this
page, toggles for it, and the scripts' own menu commands. It replaced
the script list in the icon's right-click menu, which could only show
plain-text rows and was capped at six top-level items.

- Page: `src/popup.html` + `src/extension/popup.ts`.
- View: `src/extension/popup-view.ts` (pure), built in the service
  worker by `popupViewForTab` in `src/extension/background.ts`.

## Toolbar clicks

- **Single click** opens the popup.
- **Double click** opens the collections page.
- **Right click** adds one item to Chrome's menu, `Open Collections
  page (double-click)`: the double click's action, worded as a hint
  that the double click exists.
  - Recreated whenever the worker starts: re-enabling the extension
    fires no `onInstalled`.

### Telling the two apart

A Chrome popup set with `default_popup` opens on the first click, and
`chrome.action.onClicked` never fires, so a second click can't be seen.
So no popup is set (`handleActionClick` in background.ts):

- A click waits 250ms (the value SeeWhatISee tuned by hand) for a
  second one, in the same window.
- A second click in that window opens the collections page.
- Otherwise: `setPopup({tabId, popup})`, `chrome.action.openPopup()`,
  then `setPopup({tabId, popup: ''})`, so the next click reaches
  `onClicked` again.
- Cost: the popup appears ~250ms after the click.
- `openPopup` needs the window focused. When it refuses (focus moved
  during the wait), nothing opens; the SW console says why.
- The rejected alternative: keep `default_popup`, and treat the popup
  closing within ~300ms of opening as a double click. No delay, but the
  popup flashes before the collections page opens.

## Layout

Fixed width (~380px). Chrome caps popups at 800×600, so height grows
with content up to a cap, then the script area scrolls.

- A 1px border in the header bar's brown: Chrome draws the popup with
  no frame, so it would have no edge over a white page.
  - Drawn on a fixed overlay at the viewport's edges, not as the body's
    border, which Chrome's sizing could clip on the right and bottom.

From top to bottom:

- **Header bar**, the same brown bar as the other pages
  (`.page-header`): icon, `SourceMonkey | Active scripts`.
  - Icon and product name open the collections page, as on other pages.
  - An **Open** button on the right does the same, more visibly.
  - A **⋯ menu** in the corner for page-wide actions (below).
- **Banner slot** (only when something applies):
  - Purple **reload banner**, matching the purple badge, with a Reload
    button. Wording by cause:
    - `Reload required: Enabled scripts changed` (enables and disables
      since load)
    - `Reload required: Scripts enabled` (only enables)
    - `Reload required: Scripts disabled` (only disables)
    - `Reload required: Scripts updated`
    - `Reload required: Some scripts haven't run on this page yet` (the
      page changed its URL in place; see Reload to run below)
    - `Reload required: Some scripts are missing`, `… Unexpected scripts
      are running`, or `… Some scripts are missing or unexpected`, when
      nothing above applies.
      - A reload may well settle these. They're common after the
        extension restarted under an open page, which loses what the
        worker knew about it, so a script enabled since then reads as
        Missing rather than Reload to run.
    - The first that applies wins, in that order.
  - Cyan **sm-dev banner**, `Page under sm-dev control`, replacing the
    menu's row of that name.
  - Both can show at once, stacked, though rarely: sm-dev reloads its
    tabs itself when its own scripts change.
    - `Scripts updated`: an installed script the run let in changed
      outside the run (say, a collection refresh).
    - `Scripts disabled`: one the run let in was unticked.
    - Enabling never counts there: the run decides what loads in its
      tab, so a reload wouldn't run the newly enabled script.
- **Script area**, one scroll region (see [Scrolling](#scrolling)):
  - **Enabled** section.
  - **Disabled** section.
  - Each section groups its scripts under collection headings (see
    [Collection groups](#collection-groups)).

### Page ⋯ menu

- Reload page: a plain reload, every script included.
- Reload page with no userscripts. Not on a page no script matches.
- Every reload leaves the popup open, and it redraws for the new page
  load.
- SourceMonkey options (the Options page).
  - Every "options" item is scoped by what it configures, since
    collections already have their own and scripts may get some
    later.
- Later candidates: Refresh All, disable everything on this site.

## Script rows

Each collection group lists its scripts that match this page, sorted
by shown name (`compareScriptNames`).

- **One row per script identity** (`@namespace` + `@name`, see
  [script-identity.md](script-identity.md)), not per installed copy.
  - Every copy that is active, or still running in this document,
    gets a row; the inactive ones are hidden.
  - With none of those, one copy stands for the script in Disabled:
    one whose own box is ticked (so its collection is off), else the
    first in collection order.
  - Two copies **both enabled** get two rows, each in its own
    collection's group, with a second line: `Version 1.4`.
  - Only copies whose rules match the page count: a disabled copy that
    doesn't match isn't considered.
- Left to right:
  - **Checkbox**: enable / disable that copy, like the collections
    page's (not exclusive: other copies are left alone). Raises the
    reload banner; the row moves to the other section only when the
    popup is next opened (see
    [A layout that stays put](#a-layout-that-stays-put)).
  - **Versions button**: not built. A small stacked-layers glyph,
    when other copies exist, that would open a version picker like the
    viewer's. The list UI needs designing first.
  - **Name**: opens the script page. A long name wraps, as on the
    collections page.
    - No site icon: on one page they'd nearly all be that site's icon.
      A script's own `@icon` might still be worth showing; undecided.
  - **Status pill**: opens the script's Log tab.
  - **⋯ menu** for the script.

### Script ⋯ menu

- Script details (script page).
- Script log (script page, Log tab).
- separator
- Reload page with only this script.
- Reload page without this script.

- The two reloads are per-script versions of the page-wide one, and
  share its mechanism (see
  [matching.md](matching.md#reload-with-no-userscripts)).
- After either, the scripts kept out stay in the Enabled list with
  status `Not loaded`.
- Not in a tab an sm-dev run controls.
- Greyed for a script that isn't active (its box or its collection is
  off): running it alone or keeping it out would do nothing.

### Status pills

Today's statuses (`RowStatus` in `src/extension/tab-status.ts`) as
colored pills, using the badge colors.

- Every pill is the same width, so the column lines up. That caps the
  labels at about "Reload to run".

| Status | Pill | Color | Default tooltip |
|--------|------|-------|-----------------|
| `OK` | Running | Green | Running on this page |
| `ERROR` | Error | Red | The error message |
| `REJECTED` | Rejected | Red | Chrome refused to register this script, so it can't run |
| `RELOAD` | Updated | Purple | The script changed since this page loaded. Reload to run the new version. |
| `MISSING` | Missing | Orange | Expected on this page, but it hasn't started |
| `UNEXPECTED` | Unexpected | Orange | Started on this page, but its rules don't match this page |
| `NOT_LOADED` | Not loaded | Grey | Why it was kept out (below) |

New ones the popup needs, since a toggle now happens in front of the
page it affects:

- **Reload to run** (purple outline): enabled since the page loaded.
  - Read as: active now, not among the scripts that matched when the
    document loaded (`loadMatchIds`), and never reported.
  - So a script installed since the page loaded shows it too.
  - So does one that matches only the URL the page moved to in place
    (pushState): Chrome injects at a document load. Its tooltip says
    so, telling it apart by what matched the load URL (`loadUrl`), and
    its banner reads `Reload required: Some scripts haven't run on this
    page yet`.
  - Not over `Rejected`, which a reload doesn't cure.
  - Not in an sm-dev tab, where the run decides: there it's
    `Not loaded`.
- **Still running** (purple outline, Disabled section): disabled since
  load, by its own box or its collection's, but still running in this
  document.
- Disabled rows otherwise show no pill.

Every pill has a tooltip:

- What the status means, or the specifics where there are some.
  - `Not loaded` names why: the page was reloaded with no userscripts,
    with only one named script, or without this one; or the sm-dev run
    controlling the tab kept it out.
  - `Still running` says whether the script or its collection was
    disabled.
- A last line, `Click to open the script log.`
- The heading's `Collection off` badge gets one too: `This collection
  is disabled, so none of its scripts run`.

### Menu commands

- A script's `GM_registerMenuCommand` items list under its name,
  indented, one clickable row each.
- More than four commands: collapsed by default behind a disclosure row
  (`▸ 6 commands`). Fewer: shown open.
- Commands keep their registration order.

## A layout that stays put

- Each row's place (section, collection group, order) is fixed by the
  first view and kept while the popup is open.
  - A toggle or a reload changes rows in place: a script disabled while
    running stays in Enabled, greyed, as `Still running`.
  - Reopening the popup sorts afresh.
- New rows (a script installed meanwhile) go at the end of their
  group, or in a new group at the end of their section.
- A different URL (the page navigated) is another page: its layout is
  placed afresh, and the worker ignores `keepIds` placed for the old
  URL (`keepUrl`).
- The popup sends the ids it has placed (`keepIds`), so a placed row
  keeps being listed even when the one-row-per-script rule would now
  pick another copy.

## Scrolling

- Header and banners stay put; only the script area scrolls.
- **One scroll region for both sections**, with sticky section headings,
  rather than a scrollbar per section.
  - Two inner scrollbars fight for height: a long Enabled list squeezes
    Disabled to a sliver, or the split needs tuning.
  - Sticky headings keep the "which section am I in" benefit of
    separate regions.

## Collection groups

Within each section, scripts sit under a heading per collection.

- The heading, left to right:
  - **Collection name**: a link to that collection on the collections
    page.
  - Its **type bubble**, as on the collections page.
  - A `Collection off` badge when the collection itself is off.
  - A **⋯ menu**: Collection details, Enable / Disable collection,
    Collection options (the edit dialog).
- A collection that's off puts all its scripts under Disabled.
  - Their rows are greyed, ticked boxes included: the box shows the
    script's own setting, which is kept but has no effect.
  - The box's tooltip adds a second line: `Script will not run because
    its collection is disabled`.
- Groups follow the collections page's order.
- Costs:
  - Breaks the single alphabetical order across collections.
  - A version picker that switches to a copy in another collection
    moves the row to a different group.
- A flat alphabetical list was the alternative (mocked). The collection
  then showed only on a duplicated script's extra line.

## Implementation notes

- **Messages** (`popup-view.ts`), popup → worker, only accepted from
  extension pages:
  - `sm:popup-view` gets the `PopupView` for a tab.
  - `sm:popup-reload` reloads with a `ReloadMode`.
  - `sm:popup-command` runs a menu command.
- **Live updates**:
  - An open popup holds a port named for its tab (`sm-popup:<id>`).
    The worker sends `sm:popup-changed` over it from `renderBadge` and
    on menu-command changes, and only to popups showing that tab.
  - The port drops when the worker idles out; the popup reopens it.
  - The popup also refreshes on writes to the stored scripts and
    collections (`touchesStructuralRows`), not on session writes.
  - Refreshes are debounced, only the latest reply is drawn, and a
    view equal to the one on screen isn't redrawn. A redraw keeps the
    scroll position.
- **Toggles** write storage straight from the page (`setScriptEnabled`,
  `setCollectionEnabled`), as the collections page does.
- **Collection options** opens the collections page at
  `#edit-collection-<id>`, which scrolls to the collection and opens its
  edit dialog.
- **Which tab**: the active tab of the popup's window; `?tab=<id>`
  names one, so e2e tests can open the page in a plain tab.
  - `&close=1` then has it close itself after opening a page, as a
    real popup does.
- **Closing**: a link closes the popup only once its tab is open.
  Closing ends the page, and an open still in flight with it.
- **Empty states**: `No scripts match this page.`, and on a page no
  script can run on (`chrome://`, `about:`): `SourceMonkey can't run
  scripts on this page.`
- **Not listed**: a script deleted since it ran here, and an sm-dev
  run's scratch script outside that run's tabs.
