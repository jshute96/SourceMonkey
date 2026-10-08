// The `sm:*` message types injected scripts send the service worker.
// Its own module so the harness can name them without loading the
// injector.

// Keep these in sync with the strings the prelude sends.
export const SM_START_MSG = 'sm:start';
export const SM_ERROR_MSG = 'sm:error';
// Reload fast-path: the prelude asks the SW whether to run its baked-in
// body, abandon, or swap in a fresher user-code body the SW will hand
// back. sm:swapped / sm:abandoned are the follow-up reports for the
// swap / skip branches. See docs/injection.md#reload-fast-path.
export const SM_CHECK_PENDING_MSG = 'sm:check-pending';
export const SM_SWAPPED_MSG = 'sm:swapped';
export const SM_ABANDONED_MSG = 'sm:abandoned';
// Not sent by injected scripts: the worker's report to sm-dev that a
// manual script (`@run-at context-menu`) matches a new document, where
// it waits to be run rather than starting. See docs/manual-scripts.md.
export const SM_MANUAL_MSG = 'sm:manual';
// GM_log capture: the page-side runtime sends one of these for every
// GM_log() call so the SW can append it to the script's Log tab.
export const SM_GM_LOG_MSG = 'sm:gm-log';
// The runtime saw the page's CSP refuse a style a script added
// (MAIN world only — the isolated world is exempt). One warning per
// script per document, in the script's Log.
export const SM_GM_DOM_BLOCKED_MSG = 'sm:gm-dom-blocked';
// The page reporting that it just came to the front, so the SW can
// check this tab's local scripts for edits. Chrome's own focus events
// miss the case that matters most — see
// docs/updates.md#focus-triggered-refresh.
export const SM_FOCUS_MSG = 'sm:focus';
