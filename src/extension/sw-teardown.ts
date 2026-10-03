// Keep service-worker (SW) teardown noise out of chrome://extensions.
//
// When Chrome destroys the extension's SW — on every reload of the
// unpacked extension, and on idle termination — any `chrome.*` call
// still in flight rejects with `Error: No SW`. The SW's startup path
// fires many fire-and-forget storage reads (`void ensureLoaded()`
// and friends in background.ts), so a reload that lands while they're
// pending produces one unhandled rejection each, and Chrome lists
// every one under the extension's Errors panel as if SourceMonkey had
// crashed. Nothing is wrong: a dead SW has no work left to do.
//
// One handler here recognizes that rejection and marks it handled,
// rather than a try/catch at every call site. Every other rejection
// still surfaces as before.

// Exact match on purpose: the string is Chrome's own (the extension
// API binding's "worker is gone" rejection), it carries nothing else,
// and a looser match could swallow a real failure that happened to
// mention it. Accepts any object with a `message` rather than only
// `Error` instances — the reason is created by the API bindings, not
// necessarily by this realm's `Error`.
export function isSwTeardownError(err: unknown): boolean {
  const message = typeof err === 'string'
    ? err
    : (err as { message?: unknown } | null)?.message;
  return message === 'No SW';
}

export function installSwTeardownHandler(): void {
  self.addEventListener('unhandledrejection', (event) => {
    if (!isSwTeardownError(event.reason)) return;
    event.preventDefault();
    // Stays in the SW's own DevTools console only (console.info is not
    // forwarded to the Errors panel; .warn/.error are).
    console.info('[SourceMonkey] ignoring a chrome.* call that was cut off by service-worker shutdown');
  });
}
