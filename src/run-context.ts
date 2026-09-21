// Which JS context this module is running in.
//
// The extension's modules are shared: `script-store.ts`, `script-log.ts`
// and the fetch helpers all run in the service worker AND in the
// extension pages. A few of them have to behave differently in a page —
// not as a capability check, but because the worker is the single owner
// of something (an http read that must not leak a preload hint, a
// session-storage key whose read-modify-writes are serialized by one
// per-script queue). Those hop to the worker; see `http-read.ts` and
// `script-log.ts`.
//
// `document` is the test: the service worker has none, every extension
// page does. Not `window` — the worker has a global `self` that some
// bundlers alias.
//
// Caveat for a future caller: the sandboxed parse page
// (`parse-sandbox.html`) has a `document` too, but runs at an opaque
// origin with no `chrome.runtime` — so it would answer true here and
// then have nothing to hop to. Nothing that hops is loaded there today.
export function isPageContext(): boolean {
  return typeof document !== 'undefined';
}
