// The "Allow User Scripts" probe and the text that explains it being
// off, shared by the collections page's banner and the popup's bar.
//
// The toggle lives on `chrome://extensions`. While it's off nothing
// injects, though matching still works (the badge counts scripts).
// Pages ask here, since Chrome tells them nothing when it changes:
// turning it on or off changes `chrome.userScripts` in open pages at
// once, with no event.

import { extensionDetailsLink } from './file-access.js';
import { USER_SCRIPTS_OFF_HEADING } from './popup-view.js';

export { USER_SCRIPTS_OFF_HEADING };

export type UserScriptsState = { usable: true } | { usable: false; error?: string };

// Whether chrome.userScripts is callable. The namespace's presence only
// confirms the permission is in the manifest; the toggle still has to be
// on before a call works.
//
// Returns the raw error message so a page can show anything that isn't
// the routine "toggle is off" case. Asks for no scripts by id, so the
// call returns none: the popup probes on every redraw.
export async function probeUserScriptsApi(): Promise<UserScriptsState> {
  // Deliberately NOT recased to a message of ours. This value shares a
  // slot with Chrome's verbatim `err.message` below and renders as
  // `Chrome reported: <it>`, so it is written to read as Chrome's own
  // report rather than as SourceMonkey's sentence — the API-flavoured
  // wording is the point. See docs/diagnostics.md#wording.
  if (!chrome.userScripts) return { usable: false, error: 'chrome.userScripts is not available' };
  try {
    await chrome.userScripts.getScripts({ ids: [] });
    return { usable: true };
  } catch (err) {
    return { usable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// The fix, as a line of the page's own: "Open extension settings and
// enable "Allow User Scripts" for SourceMonkey."
export function userScriptsFixLine(tag: 'p' | 'span'): HTMLElement {
  const line = document.createElement(tag);
  const toggle = document.createElement('code');
  toggle.textContent = 'Allow User Scripts';
  line.append(
    'Open ',
    extensionDetailsLink('extension settings'),
    ' and enable "',
    toggle,
    '" for SourceMonkey.',
  );
  return line;
}
