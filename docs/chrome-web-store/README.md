# Chrome Web Store listing files

The text and images uploaded to SourceMonkey's Chrome Web Store
listing, and notes on how they were made.

- `description.txt`: the listing's description. The store shows it as
  plain text, so it uses no markup, just capitalized headings and •
  bullets.
- `promo-tile.png`: the 440x280 small promo tile, rendered from
  `promo-tile.html`.
- `screenshot1.png`, `screenshot2.png`: the listing's screenshots, also
  shown at the top of the main README.

## Promo tile

Render it again after changing `promo-tile.html`:

```sh
node docs/chrome-web-store/render-promo-tile.mjs
```

- The store shows the tile at about 374x237, on a light grey-blue card
  (`#f0f4f9`), with its corners rounded by about 13px at that size
  (about 15px at full size).
- So the dark frame's inner corners are rounded by 8px: about 15px less
  the 8px frame, which keeps the frame an even width round the corners.
  A thin border all the way round doesn't work: the rounding clips it
  at the corners.
- The colors are the extension's header bar colors, from
  `src/styles.css`.

## Screenshots

The store takes screenshots of exactly 1280x800 (or 640x400). These
were captured from a browser started by `sm-dev`, with the whole
window captured, browser toolbar included.

### Sizing the window

`sm-dev` has no command to resize a window, and `window.resizeTo()`
only works on windows a script opened. The window was sized through
the browser's DevTools protocol (CDP) instead:

- `sm-dev --run <name> status` gives the browser's debugging address
  (`connected to owned browser 127.0.0.1:<port>`).
- `http://127.0.0.1:<port>/json/list` lists the tabs. Use a tab you
  opened yourself to measure the page: sm-dev's own `about:blank` tab
  keeps a fixed page size whatever the window's size.
- `Browser.getWindowForTarget` gives that tab's window, and
  `Browser.setWindowBounds` sets its size.

```js
// node resize.mjs <port> <targetId> <width> <height>
const [port, targetId, width, height] = process.argv.slice(2);
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const send = (method, params) => new Promise((resolve) => {
  const i = ++id;
  ws.addEventListener('message', function on(e) {
    const m = JSON.parse(e.data);
    if (m.id === i) { ws.removeEventListener('message', on); resolve(m.result); }
  });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const { windowId } = await send('Browser.getWindowForTarget', { targetId });
await send('Browser.setWindowBounds', { windowId, bounds: { width: +width, height: +height } });
ws.close();
```

### Getting exactly 1280x800

- Window sizes are in CSS pixels, and captures are in screen pixels.
  On a display scaled by 1.36 (`devicePixelRatio`), one unit of window
  size is about 1.36 screen pixels, so some sizes can't be hit exactly.
- `xwininfo` (on X11) gives the window's real size in screen pixels.
  The capture came out about 12px narrower and 11px shorter than that
  (the window's frame).
- The size that worked: window bounds 950x597, an X window of
  1292x812, and a capture of 1280x800. Check the first capture's size
  and adjust by a unit at a time.

### The popup screenshot

The popup covered example.com's text, so the page's text column was
moved to the left of it with a style added to the open page (by CDP's
`Runtime.evaluate` on that tab, which leaves the popup open):

```css
body { margin: 0 0 0 .5em; padding-left: 1em; padding-right: 0; max-width: 24em }
```

Reloading the tab puts the page back as it was.

### Border

The screenshots get a 1-pixel black border, so they stand out on
GitHub's white page. It replaces the outer pixel, so the size stays
1280x800:

```sh
convert screenshot1.png -shave 1x1 -bordercolor black -border 1 screenshot1.png
```
