# Raw CDP alongside a run

sm-dev drives tabs over CDP (Chrome DevTools Protocol), but it doesn't
own the connection: the browser's debugging port takes other clients at
the same time. Use it for what sm-dev has no command for, on the same
tab, while the run goes on.

- Protocol reference: https://chromedevtools.github.io/devtools-protocol/
- The port: 9233 by default, or the `--cdp` / `$SM_DEV_CDP` sm-dev
  uses. A `--temp-browser` run picks a random one. `status` shows it on
  its `Run:` line (`browser 127.0.0.1:9233`).
- The tab: the `targetId` in `tabs` or `status`. Never pick a tab by
  URL.
- Afterwards, `$R wait` lets the page settle, and `$R eval` or
  `$R logs` shows the effect in sm-dev's terms.

## The helper: `scripts/cdp.mjs`

One connection, one or more calls, each result printed as JSON:

```sh
CDP="node .claude/skills/SourceMonkey-dev/scripts/cdp.mjs"   # this skill's directory
T=$($R tabs | grep -o 'targetId=[0-9A-F]*' | head -1)    # the first tab listed

$CDP $T Runtime.evaluate '{"expression": "document.title", "returnByValue": true}'
$CDP --cdp 9300 $T Page.reload                           # another port
$CDP browser Browser.getVersion                          # browser-level domains
```

- The target is a `targetId` (whole, 6+ characters, or pasted as
  `targetId=...`), or `browser` for `Browser.*` and `Target.*`.
- Several calls in one line run in order on one connection:
  `$CDP $T Method1 '{...}' Method2 '{...}'`. It stops at the first that
  fails.
- Results go to stdout. Errors go to stderr, one line each, with exit
  code 1, so `W=$($CDP ...)` captures only a result.
- Each call gets 10 seconds. One that never answers (a navigating
  `Runtime.evaluate`, a page stopped on a dialog) fails with a message.
- **Session state ends when it exits.** `Emulation.*` overrides,
  enabled domains and event subscriptions last only as long as the
  connection. For those, hold a connection open in your own script
  (below), and clear what you set before it exits.
- It can't listen for events. For that, write a script.

## Your own script

Node 22+ has a built-in `WebSocket`, so a script needs no dependencies:

```js
const port = 9233, targetId = process.argv[2];
const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(tabs.find((t) => t.id === targetId).webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const waiting = new Map();
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.id) waiting.get(m.id)?.(m); else console.log('event', m.method, JSON.stringify(m.params));
};
const send = (method, params = {}) => new Promise((r) => {
  waiting.set(++id, r); ws.send(JSON.stringify({ id, method, params }));
});
```

- `GET /json/version` gives the browser-level socket
  (`webSocketDebuggerUrl`).
- Or use Playwright: `chromium.connectOverCDP('http://127.0.0.1:9233')`,
  then find the page whose `Target.getTargetInfo` (from
  `context.newCDPSession(page)`) has the `targetId`. Connect with
  `noDefaults: true`, or Playwright changes the person's browser
  (focus emulation, color scheme, downloads).
- A `Runtime.evaluate` that navigates the page never gets its reply
  (the document is gone). Use `Page.navigate`, or `$R open`.

## Recipes

### Back and forward

No CDP needed:

```sh
$R eval 'history.back()' -- wait
```

Or by history entry: `Page.getNavigationHistory` lists `entries` with
ids and the `currentIndex`, then
`Page.navigateToHistoryEntry '{"entryId": N}'`.

### Where an element is

Input events take viewport coordinates in CSS pixels. Get them from the
page:

```sh
$R eval '(r => [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)])(document.querySelector(".target").getBoundingClientRect())'
```

The element must be on screen: `$R eval 'document.querySelector(".target").scrollIntoView({block: "center"})'`
first.

### Mouse wheel

Real wheel input, which the page sees differently from a synthetic
`WheelEvent` (targeting, default scrolling, passive listeners):

```sh
$CDP $T Input.dispatchMouseEvent '{"type": "mouseWheel", "x": 400, "y": 300, "deltaX": 0, "deltaY": 600}'
$R wait -- eval scrollY
```

- Pinch zoom on a trackpad arrives as a wheel event with `ctrlKey`: add
  `"modifiers": 2`.

### Right-click, middle-click, modifier clicks

A click is a press and a release at the same point:

```sh
$CDP $T \
  Input.dispatchMouseEvent '{"type": "mousePressed", "x": 50, "y": 50, "button": "right", "clickCount": 1}' \
  Input.dispatchMouseEvent '{"type": "mouseReleased", "x": 50, "y": 50, "button": "right", "clickCount": 1}'
```

- `button`: `left`, `middle`, `right`, `back`, `forward`.
- `modifiers` is a bitmask: Alt 1, Ctrl 2, Meta (Cmd) 4, Shift 8. So
  Shift-click is `"modifiers": 8` on both events; Ctrl-Shift is 10.
- Double-click: a press/release with `clickCount: 1`, then another with
  `clickCount: 2`.
- The page gets `contextmenu` and `auxclick` events. Chrome's own
  context menu can't be driven over CDP, so its entries (an
  extension's included) can't be picked; fire userscript menu commands
  with `$R menu`.
- A Ctrl- or middle-click on a link opens a tab that the run follows
  (it has an opener), as `T2`.

### Drag

Press, move in steps, release:

```sh
$CDP $T \
  Input.dispatchMouseEvent '{"type": "mousePressed", "x": 100, "y": 100, "button": "left", "clickCount": 1}' \
  Input.dispatchMouseEvent '{"type": "mouseMoved", "x": 150, "y": 100, "button": "left", "buttons": 1}' \
  Input.dispatchMouseEvent '{"type": "mouseMoved", "x": 200, "y": 100, "button": "left", "buttons": 1}' \
  Input.dispatchMouseEvent '{"type": "mouseReleased", "x": 200, "y": 100, "button": "left", "clickCount": 1}'
```

- This drives pointer and mouse listeners (sliders, canvas, most
  custom drag code).
- Native HTML5 drag-and-drop (`draggable`, `dragstart`/`drop`) needs
  `Input.setInterceptDrags` and `Input.dispatchDragEvent` in a script
  that listens for `Input.dragIntercepted`.

### Window size

In a browser with a window (`--open-browser`, or the person's own):

```sh
W=$($CDP browser Browser.getWindowForTarget "{\"targetId\": \"${T#targetId=}\"}" | grep -o '"windowId": [0-9]*' | grep -o '[0-9]*$')
$CDP browser Browser.setWindowBounds "{\"windowId\": $W, \"bounds\": {\"windowState\": \"normal\", \"width\": 900, \"height\": 700}}"
$R wait -- eval '[innerWidth, innerHeight]'
```

- It's a real resize: it lasts, affects the window's other tabs, and
  fires `resize` in the page. Put it back when done.
- A headless browser (`--temp-browser`) ignores it. There, use
  `Emulation.setDeviceMetricsOverride` from a script that keeps its
  connection open, and `Emulation.clearDeviceMetricsOverride` before it
  exits. An override left set confuses later measurements.

### Fullscreen

- Enter it as a person would: `$R key f`, or `$R click` the site's
  button. Both count as a user action, so `requestFullscreen()` is
  allowed.
- Check it:
  `$R eval '[document.fullscreenElement?.outerHTML.slice(0, 200), innerWidth, innerHeight]'`.
  In real fullscreen the size is the screen's.
- Exit with `$R eval document.exitFullscreen()`. `key Escape` reaches
  the page but doesn't exit: Escape leaving fullscreen is a browser
  shortcut, and CDP keys go straight to the page.
- Switching tabs exits fullscreen, as does a `GM_openInTab` with
  `active`.
- **Force it off** when the page won't exit: set the window back to
  normal with `Browser.setWindowBounds` and
  `{"windowState": "normal"}`, as above. This works even when the page
  is stuck.
- **Don't call `Emulation.setFocusEmulationEnabled`.** With it on,
  `requestFullscreen` only fills the tab, and the page lays out at the
  window's size. sm-dev leaves it off.

### Tracing a transition per frame

Screenshots are too slow to catch a flash, a gap or a jump. Record
what's on top at chosen points on every frame, then trigger the
change, then read the record. This is plain `eval`; change `points` to
spots in the image or video:

```sh
$R --stdin <<'EOF'
eval {{
window.smTrace = [];
const points = [[400, 300], [20, 20]];
const t0 = performance.now();
let last = '';
const name = (el) => !el ? 'nothing'
  : el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + [...el.classList].slice(0, 2).map((c) => `.${c}`).join('');
(function frame() {
  const now = (document.fullscreenElement ? 'fullscreen: ' : '') + points.map(([x, y]) => name(document.elementFromPoint(x, y))).join(' | ');
  if (now !== last) window.smTrace.push(`${Math.round(performance.now() - t0)}ms ${now}`);
  last = now;
  if (performance.now() - t0 < 3000) requestAnimationFrame(frame);
  else console.log('[trace] done');
})();
}}
key ArrowRight
wait log '[trace] done' --timeout-seconds 10
eval window.smTrace
EOF
```

- It keeps only the frames where something changed, for 3 seconds.
- Frames don't run in a background tab: trace the visible one
  (`$R focus`).
- To follow an image or video's source, add `el.currentSrc` to `name`.

### Other things worth knowing

- **Dark mode, reduced motion, print**: `Emulation.setEmulatedMedia`
  with `features` (`prefers-color-scheme: dark`). Session-scoped, so
  from a script that stays connected.
- **Network**: `Network.enable` in a script, then
  `Network.requestWillBeSent` / `Network.responseReceived` events;
  `Network.getResponseBody` for a body. The script's own
  `GM_xmlhttpRequest`s don't need this: the run's stream prints each
  one's method, URL and outcome.
- **A background tab's screenshot** renders WebGL canvases (maps)
  blank. Bring it forward first: `$R focus T2`.
- **Closing the last tab quits Chromium on Linux.** Leave one open.
