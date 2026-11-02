# Single-page apps: broaden `@match`, gate inside the script

Most modern sites are single-page applications (SPAs). The browser loads
one HTML document; after that the page's own JavaScript swaps content
and calls `history.pushState()` to change the URL. No new document
loads, so a userscript gets one chance to inject: at the first load.

## Why a narrow `@match` fails

- With `@match` only on `/app/activity/*`, a person who starts on
  `/app/home` and then clicks into an activity never gets the script.
  `@match` was checked once, against the first URL.
- Reloading fixes it, which hides the bug during development.

## The fix

1. `@match https://site.com/*`, or the smallest prefix covering every
   page the script *might* care about.
2. Add `@grant window.onurlchange` and listen for `urlchange`, which the
   manager fires on any history change (`pushState`, `replaceState`,
   `popstate`). Violentmonkey doesn't support it, so fall back to the
   Navigation API.
3. Dispatch on `location.pathname`, both at startup and on each change.

```js
// @grant window.onurlchange

const log = (...args) => console.log('[my-script]', ...args);

function onUrlChange() {
  // Dispatch on location.pathname. Handlers must tolerate being
  // called repeatedly on the same URL.
}
// Violentmonkey has no window.onurlchange (it stays undefined, where
// managers that support it set it to null); the Navigation API's
// currententrychange fires on the same history changes.
if (window.onurlchange === null) window.addEventListener('urlchange', onUrlChange);
else if (window.navigation) window.navigation.addEventListener('currententrychange', onUrlChange);
else log('no urlchange event or Navigation API; in-page navigation is not tracked');
onUrlChange(); // initial
```

- The handler fires on *any* history change, including query-string
  rewrites sites use for UI state (an open modal, the selected tab). If
  only the path matters, compare with the previous `location.pathname`
  and return early when it's unchanged.
- Broadening `@match` without this re-dispatch is its own bug: the
  script silently does nothing whenever the tab's first page was
  outside the gate.
- For a manager with neither, the `tampermonkey` plugin skill's
  `references/patterns.md` ("SPA Navigation Handling") shows the older
  fallback: wrapping `history.pushState` / `replaceState` to fire an
  event of your own.
- A script that only acts on key presses or clicks can skip the event:
  check the path in the handler, on each press.

## What this implies for the rest of the script

- **Idempotency is mandatory.** Each change handler checks whether its
  work is already done (an element with our id, a `data-` marker on what
  we rewrote, our own `<style>`). Otherwise state multiplies with each
  in-app navigation.
- **Listeners are global, not per page.** Register them once at startup;
  each one gates on `location.pathname` or on what was clicked.
- **Observers gate too.** When the app tears down and rebuilds the DOM
  on navigation, the observer fires; its callback re-checks the URL
  before acting.
- **`@exclude` doesn't keep a script off a page.** With `@match
  site.com/*` and `@exclude /player/*`, the script loads on `/home`, and
  from there the person can navigate into `/player/123` with it already
  running. The script itself must decide by the current path.
- **One script per site, dispatching by path**, is often simpler than
  several narrow scripts that would each need this.

Cost: the script's startup runs on every page of the site. That's
usually a millisecond of JavaScript and a few listeners.
