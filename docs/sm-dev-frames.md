# sm-dev and frames

How `sm-dev` shows a tab's iframes (frames, below) and which scripts
run in each. For how scripts run in frames, see
[frames.md](frames.md). The code is in `src/harness/frames.ts`, with
the output in `console-commands.ts`.

## Frame ids

- **The top frame uses its tab's id** (`T1`). It has no `F` id.
- **Each iframe gets an `F` id** (`F3`), numbered across the whole run
  like tab ids, and never reused.
  - Unique across tabs, so an id alone names one frame.
  - `T1.F3` is accepted too, and is an error if F3 isn't in T1.
- **An id belongs to the frame, not its document.** An iframe that
  reloads or navigates keeps its id.
  - A frame the page removes and adds again is a new frame, with a new
    id. So is each frame of a page the top frame navigates to.
- Frames nest; a frame's parent is a tab id or another `F` id.

## Where the data comes from

- **The frame list is Playwright's** (`mainFrame().childFrames()`,
  down the tree), for every manager.
  - It covers frames in processes of their own, which the page's own
    CDP frame tree leaves out.
  - Playwright keeps one `Frame` per frame across its navigations,
    which is what an id is given to (`FrameIds`).
- **Which scripts run in a frame**, under SourceMonkey, comes from the
  extension's reports, which carry the reporting document's
  `documentId`.
  - sm-dev asks the worker for the tab's frames
    (`chrome.webNavigation.getAllFrames`): each frame's `frameId`,
    parent, URL and live `documentId`. That's a Chrome API every
    SourceMonkey with frame support has, so no protocol version gates
    it.
  - Nothing names a Playwright frame and an extension frame alike, so
    the two trees are matched by shape and URL (`matchFrameTrees`).
    Siblings with one URL keep their earlier matches.
  - A frame's scripts are those whose last report from its live
    document is a start. A document that's gone (the frame navigated,
    or was removed) no longer counts.
  - The list is read again before each command that shows frames
    (`loadFrames`), and when an iframe's event arrives, to name its
    frame.
    - That lookup is in the tab's event queue, so it runs only for
      events that are recorded. A document that matches no frame
      after a second try isn't looked for again: its events go out
      with the tab's id alone.
    - When the listing fails (the worker restarting), the last one
      stands, rather than every frame showing no scripts.
    - A frame matched before keeps its match while its URL is between
      two (mid-navigation).
  - An extension before protocol 2.1 reports nothing from frames.
    sm-dev lists the frames with no scripts, and says to update it.
- **Other managers (`--manager tm|vm`)** report nothing per script, so
  each frame's scripts are predicted from its URL, as for the top
  frame, leaving out `@noframes` scripts.
- `about:blank` and `srcdoc` frames are listed like any other: they're
  frames on the page, even though no script runs in them.

## Status and scripts output

A tab line counts its iframes. A script running anywhere but only the
top frame lists where:

```
Tabs:
* T1: http://localhost:8765/frames/frames.html (+3 frames)
   * 1: SourceMonkey example: frames: every frame (T1, F1, F2, F3)
     2: SourceMonkey example: frames: Frame B only (F2)
     3: SourceMonkey example: frames: top frame only
```

- Every frame counts in `(+N frames)`, ad frames included. `frames`
  shows what they are.
- A script is listed under a tab when it runs in any of its frames.
- The frame list is left out for a script in the top frame only. When
  the script runs in the top frame and in iframes, it includes the tab
  id.

The activity line under each script in `status` and `scripts`:

- `Active`: in the current tab's top frame only.
- `Active on T1 (T1, F1, F3), T2, T3 (F7)`: running anywhere else too,
  each tab with the same frame list.
- `Not active on T1. Active on T2, T3 (F7).`: not in the current tab.
- `Not active`: nowhere.

### `--frames`

`status` and `tabs` take `--frames`, which prints each tab's frame tree
(as `frames` does) in place of its script lines. JSON always includes
the frames, so it ignores the flag.

## `frames [tab|frame|all]`

Shows a tab's frame tree, with the scripts running in each frame, and
for each frame:

- `(hidden)` when its `<iframe>` isn't visible: no size, or hidden by
  CSS. Ad and tracking frames often are.
- `[frameId=...]`: its CDP frame id, which CDP calls that act on a
  frame take (`Page.navigate`, `Page.createIsolatedWorld`), and which a
  context's `auxData.frameId` names.
- `[targetId=...]` too, for one Chrome runs in a process of its own: one
  from another site than its parent (another registrable domain, so
  not `explorer.apis.google.com` in `developers.google.com`), and none
  on `file://` pages. That's the CDP target a raw CDP client attaches to
  (`Target.attachToTarget`), as a tab's `targetId` is. It's the same id
  as its `frameId`; both are shown so each is there to copy.
  - A frame without one is part of the target of its nearest ancestor
    that has one: the tab's, or a frame from another site.
- The tab's own line has both too: a page's top frame's frame id is its
  target id.

These details cost a call per frame, so only the trees show them
(`frames`, `tabs --frames`, `status --frames`), and the JSON.


```
T1: http://localhost:8765/frames/frames.html
    Scripts: 1, 3
  F1: http://localhost:8765/frames/frame-a.html
      Scripts: 1
  F2: http://127.0.0.1:8765/frames/frame-b.html
      Scripts: 1, 2
    F3: http://127.0.0.1:8765/frames/frame-nested.html
        Scripts: 1
```

- `frames all` shows every tab.
- Given a frame (`F3`, or `T1.F3`), shows that frame and the frames
  under it.
- Under another manager, `Scripts:` is `Expected:`, as `status`
  predicts there.

## `match --frames`

- For a tab's page, `match` also checks each of its iframes, by the
  frame's own URL, indented as in `frames`.
- `@noframes` keeps a script out of every frame, shown as
  `Kept out by: @noframes` above the rules that matched.
- The frames don't count toward `match`'s exit code: a script isn't
  expected in every frame.
- It needs a run, which has the tabs. Without one, `--frames` is an
  error.
- In JSON, each of a result's `pages` gets `frames`, with the page's
  match fields, and `noframes` for a script `@noframes` kept out.

## Menu commands

- A command an iframe registered names its frame: `M3: Toggle (F2)`.
  In JSON, the command's `frame`.
  - The list is SourceMonkey's: one menu per script per tab, holding
    each frame's commands (see [frames.md](frames.md#menu-commands)).
    sm-dev only adds the label.
- A command whose frame document is gone is left out, by the same live
  documents as the frame's scripts. The extension sends nothing when a
  frame goes.

## Reloading on `update`

- `update`, `load` and a `--watch` save reload a tab where a changed
  script started in any frame since the page loaded, or where its
  rules match the page.
  - A frame whose script started there and that has since gone still
    counts: one reload too many beats a missed one.

## Log lines

- A line from an iframe names the frame where the tab id goes:
  `[T1.F3] [event] ...` in the stream, `T1.F3` in `logs`, and `frame`
  in the JSON line.
  - In the stream, a T1 frame's lines are prefixed too, where T1's own
    aren't.
- Where each kind of line's frame comes from:
  - a script's start, skip or error, and its menu commands: the
    reporting document, on the extension's event;
  - `GM_xmlhttpRequest`, `GM_setValue`, `GM_download` and a shown
    `GM_notification`: the sending document, on the event from
    protocol 2.2;
  - console lines and page errors: the JavaScript context they came
    from, over the frame's own session (see
    [Frame sessions](#frame-sessions));
    - a page error is paired with the protocol's copy by its message:
      the copy whose first line ends with it, else one containing it.
      Copies replayed as a session opens are ignored, and an empty
      message isn't paired;
  - a frame's load: Playwright's `framenavigated`.
- A frame's load is a line like a page's: `T1.F3 [event] Loaded <URL>`,
  in `logs` only, not the stream (ad frames load often).
  - Load lines go through the same queue as console lines and errors,
    so what a page logged or threw comes before the next page's load.
  - A change of the frame URL's fragment alone isn't a load.
- A line can still lack its frame: an event from an older extension, a
  document no frame matched, or a console line whose frame's session
  isn't open yet. So a line without a frame isn't necessarily the top
  frame's.

## Frame sessions

`src/harness/frame-sessions.ts`: the DevTools (CDP) sessions that reach
inside a tab's iframes.

- Chrome runs an iframe from another site (another registrable domain)
  in a process of its own (an out-of-process iframe). One from the
  page's site, even another origin of it, shares the page's process. The page's session sees nothing inside it:
  not its execution contexts, console calls or errors.
- So a tab has a session per process: the page's, and one per such
  iframe, opened through Playwright (`newCDPSession(frame)`, which
  refuses a frame that shares its parent's process).
  - New iframes are tried as they attach or navigate, since a
    navigation can move a frame into a process of its own or out of
    one.
- A frame is found in its session's CDP frame tree from the session's
  root (the page, or the iframe the session is for, which is exact),
  then down by URL among its siblings in the same process.
  - A session's tree is read once until a frame attaches, navigates or
    detaches: each console line asks for its frame.
- A frame's session is opened again when the frame navigates, which
  can move it between processes, and closed when it detaches.
- Two users, each with sessions of its own:
  - `ConsoleStacks` (run.ts), for console lines and errors, from the
    tab's start;
  - `PageAttachment` (page-watch.ts), for `eval --frame`, opened on
    the first one.

## Refs in frames

- A snapshot ref names its element wherever it is, iframes included
  (`f2e4`): it works in any command as it is, with no `--frame`.
  - Playwright prefixes a frame's refs with its own frame number,
    which isn't the `F` id.
- `snapshot --frame F2` shows that frame alone. Its refs are the same
  as in a whole-page snapshot, and are noted as that frame's, added to
  the page's earlier refs rather than replacing them
  (`noteRefs`, snapshot.ts).

## `--frame` on `eval` and the page commands

- `eval --frame F2` runs in that iframe, in the same world it would in
  the top frame: the selected script's scope there, a named one's
  (`--script=2`), the scripts' shared world, or the page's (`--page`).
  - The worlds are found among the frame's session's contexts: its
    default one is the page's, and one with the extension's origin
    the scripts'.
  - A frame between documents is looked for again until
    `--timeout-seconds`, as for the top frame.
- `click`, `hover`, `type`, `snapshot`, `screenshot`, `probe` and
  `wait selector` take `--frame` for a selector inside that frame.
  - A ref with `--frame` works when it's in that frame, and is an error
    naming its own frame when it isn't.
  - `screenshot --frame F2` with no selector is the frame as it shows
    on the page: its `<iframe>` element.
  - `--frame T1` (the tab's own id) is the top frame, as with none.
  - A frame can also be named by its CDP id as `frames` shows it,
    `frameId=...` or `targetId=...`, or by the first 6 or more
    characters of one. So can `frames frameId=...`; a tab's target id
    there is its tab.
  - `wait` takes it only with `selector` or `selector-gone`. Settling,
    a delay and the log are the tab's.
- `cdp --frame F2` sends its calls to the target the frame is in: its
  own, if it has one, else its nearest ancestor's that has one (the
  tab's at the top).
  - A target reaches all its frames, so calls that act on a frame name
    it by `frameId`. For a frame without its own target, the command
    says which target the calls went to, and the frame's id.
- What a command says names the frame: `Clicked #play in F2`, `The
  selector .x matches on T1.F2`.

## What `wait` waits for

- Settling (`wait`, and the wait after an action) watches the top
  frame's load state and DOM changes and the top frame's scripts
  starting, but requests from every frame.
- So for something an iframe shows after a click, use
  `wait selector --frame F2 <selector>`.

## JSON

Types are in [sm-dev-json.md](sm-dev-json.md).

- A tab gets `frames`, each after its parent, absent for none:

  ```json
  "frames": [
    { "id": "F1", "parent": "T1", "url": "http://localhost:8765/frames/frame-a.html", "scripts": ["1"] },
    { "id": "F2", "parent": "T1", "url": "http://127.0.0.1:8765/frames/frame-b.html", "scripts": ["1", "2"], "targetId": "C1E043C264F12D216F204784C021C567" },
    { "id": "F3", "parent": "F2", "url": "http://127.0.0.1:8765/frames/frame-nested.html", "scripts": ["1"] }
  ]
  ```

  - The tab's own `scripts` stays the top frame's.
- A script's per-tab entries (`tabs: [{ tab, state }]`) get `frames`,
  left out under the same rule as the text:

  ```json
  "tabs": [
    { "tab": "T1", "state": "running", "frames": ["T1", "F1", "F3"] },
    { "tab": "T2", "state": "running" },
    { "tab": "T3", "state": "running", "frames": ["F7"] }
  ]
  ```

  - `state` is `running` when the script runs in any of the tab's
    frames.
