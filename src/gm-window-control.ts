// SW-side driver for `@grant window.close` and `@grant window.focus`.
//
// Why the service worker is involved: both methods exist in the page
// already, and both are hobbled there.
//
//   - `window.close()` is refused for any tab the script didn't open
//     itself with `window.open` ("Scripts may close only the windows
//     that were opened by them").
//   - `window.focus()` on a background tab does nothing; nothing in a
//     page can select another tab or raise the OS window.
//
// An extension is not bound by either rule, so the granted call is
// routed here and re-issued as `chrome.tabs.remove` /
// `chrome.tabs.update` + `chrome.windows.update`. That is also how TM
// implements the same two grants — the page-side override is a thin
// shim over the extension's own tab/window control.
//
// Wire protocol (page → SW, `chrome.runtime.sendMessage`):
//   `{ type: 'sm:gm-window-close' | 'sm:gm-window-focus', scriptId }`
//   → `{ ok: true }` or `{ ok: false, error }`.
//
// The target is never named in the payload: it is always the sender's
// own tab. A script can only close/focus the tab it is running in, so
// there is nothing to spoof — unlike GM_openInTab, whose URL comes
// from the page.

export const SM_WINDOW_CLOSE_MSG = 'sm:gm-window-close';
export const SM_WINDOW_FOCUS_MSG = 'sm:gm-window-focus';

export interface WindowControlResult {
  ok: boolean;
  error?: string;
}

function reason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Capitalized because it lands after a `: ` — see the error-message
  // rules in CLAUDE.md.
  return msg === '' ? 'The browser gave no reason' : msg;
}

// The last tab standing is not closable. Chrome would allow it — and
// take the whole browser down with it, since closing the final tab
// quits. Handing a userscript the ability to quit the browser is a
// different order of capability from closing a tab, so it is refused.
// TM 5.5.0 refuses it the same way (`fp` in its `background.js`:
// `tabs.query({windowType:'normal'})`, then "refused to close last
// tab!" when one or fewer come back).
export const LAST_TAB_NOT_CLOSABLE = 'The last open tab cannot be closed';
// A frame asking to close the tab it is embedded in. Refused for the
// reason the browser refuses a frame's own `window.close()`.
export const SUB_FRAME_CLOSE_REFUSED = 'A frame cannot close the tab that contains it';

// `window.close()` → close the sender's tab.
//
// Nothing is reported back on success: the document that asked is gone
// by then. The tab count is read across every normal window, not just
// the sender's, so closing the last tab of one window while another is
// open still works.
export async function closeGmWindow(tabId: number): Promise<WindowControlResult> {
  try {
    const tabs = await chrome.tabs.query({ windowType: 'normal' });
    if (tabs.length <= 1) {
      return { ok: false, error: LAST_TAB_NOT_CLOSABLE };
    }
    await chrome.tabs.remove(tabId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `This tab could not be closed: ${reason(err)}` };
  }
}

// `window.focus()` → bring the sender's tab to the front: select it
// within its window, and raise (and un-minimize) that window.
//
// Both halves are needed for the call to mean anything. Raising alone
// is invisible in the common single-window case — the window is
// already frontmost and the user is simply looking at another tab —
// and selecting alone leaves the tab hidden behind another window.
//
// A minimized window has to be restored explicitly — `focused: true`
// alone leaves it minimized — so the current state is read first.
// `chrome.windows.update` rejects `{ focused: true, state:
// 'minimized' }`, which is why the two are never combined.
//
// This is step-for-step what TM 5.5.0 does (`focusTab` in its
// `background.js`): `tabs.update({active:true})`, then `windows.get`,
// then `windows.update({focused:true, state})` with `state` set to
// `'normal'` only for a minimized window.
//
// Whether the window actually comes forward is ultimately the OS
// window manager's call: several Linux WMs answer a programmatic
// raise by flashing the taskbar entry instead. Nothing an extension
// can do about that, and Chrome reports no error for it.
export async function focusGmWindow(tabId: number, windowId: number): Promise<WindowControlResult> {
  if (!chrome.windows) {
    return { ok: false, error: 'Window focus is not available in this browser' };
  }
  try {
    await chrome.tabs.update(tabId, { active: true });
    let minimized = false;
    try {
      const win = await chrome.windows.get(windowId);
      minimized = win.state === 'minimized';
    } catch {
      // Non-fatal: worst case we skip the un-minimize and the plain
      // `focused: true` below still runs.
    }
    await chrome.windows.update(
      windowId,
      minimized ? { focused: true, state: 'normal' } : { focused: true },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `This tab could not be focused: ${reason(err)}` };
  }
}
