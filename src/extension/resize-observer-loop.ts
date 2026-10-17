// Keeps Chrome's "ResizeObserver loop completed with undelivered
// notifications" out of chrome://extensions/?errors.
//
// Chrome raises it when a ResizeObserver callback resizes something it
// watches again within the same frame. The notification isn't lost: it
// is delivered on the next frame, so it is harmless. Web pages don't log
// it, but on an extension page it lands in the Errors panel, which makes
// SourceMonkey look broken.
//
// Canceling the window `error` event stops Chrome from reporting it. The
// text is Chrome's own, so matching on it is the only way to tell it
// apart.

const LOOP_MESSAGE = 'ResizeObserver loop';

export function ignoreResizeObserverLoopErrors(): void {
  window.addEventListener('error', (ev: ErrorEvent) => {
    if (ev.message?.startsWith(LOOP_MESSAGE)) ev.preventDefault();
  });
}
