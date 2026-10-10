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
  - It covers cross-origin frames, which the page's own CDP frame tree
    leaves out.
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

Shows a tab's frame tree, with the scripts running in each frame:

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

- A script's start, skip or error in an iframe, and a menu command it
  registers, name the frame where the tab id goes: `[T1.F3] [event]
  ...` in the stream, `T1.F3` in `logs`, and `frame` in the JSON line.
  - These are the extension's events that carry the reporting
    document, which is how the frame is found.
  - In the stream, a T1 frame's lines are prefixed too, where T1's own
    aren't.
- Other lines from an iframe have only the tab id, so a line without a
  frame isn't necessarily the top frame's:
  - console lines and page errors: Playwright's console messages don't
    say which frame logged them;
  - other `GM_*` events (requests, values, downloads, ...): the
    extension sends them without the document;
  - a report whose frame couldn't be matched.

## JSON

Types are in [sm-dev-json.md](sm-dev-json.md).

- A tab gets `frames`, each after its parent, absent for none:

  ```json
  "frames": [
    { "id": "F1", "parent": "T1", "url": "http://localhost:8765/frames/frame-a.html", "scripts": ["1"] },
    { "id": "F2", "parent": "T1", "url": "http://127.0.0.1:8765/frames/frame-b.html", "scripts": ["1", "2"] },
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

## Later

- `--frame <id>` on `eval` and the script-state commands, reaching the
  frame's script world. Cross-origin frames need a CDP session on the
  frame's own target.
- `--frame <id>` on `click`, `fill`, `hover`, `wait` and `snapshot`,
  for selectors (CSS, `text=`) inside a frame.
  - A snapshot ref already names its frame, so it needs no `--frame`.
    A ref with a `--frame` it isn't in is an error.
- A frame navigation's line: `T1.F3 [event] Loaded <frame URL>`.
- Console lines and page errors naming their frame, through the CDP
  execution context they came from.
- Other `GM_*` events naming their frame: the extension would send the
  sender's document with them (a protocol minor).
