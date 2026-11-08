// A tab whose isolated (USER_SCRIPT) world can't message the extension,
// though SourceMonkey turns messaging on (`configureWorld` in
// injector.ts). Seen in tabs that were open while the unpacked extension
// was removed and loaded again: reloading such a tab, or duplicating it,
// still had no messaging, while a new tab at the same URL did. Why
// Chrome keeps it per tab is unknown. A page that merely loaded before
// messaging was turned back on is fixed by a reload.
//
// The bridge (src/wrapper-bridge.js) answers requests and says what it
// couldn't report with these, and the service worker uses them for
// scripts that never started there (`userWorldCanMessage`). The bridge
// gets them swapped in (`withTabMessagingTexts`).

// What is wrong, and the fix.
export const TAB_NO_MESSAGING =
  'SourceMonkey\'s isolated world in this tab has no messaging (chrome.runtime.sendMessage is missing)';
export const TAB_NO_MESSAGING_FIX = 'Reload the page, or if that doesn\'t help, open the URL in a new tab.';

// A script's decision request, answered by the bridge.
export const TAB_CANNOT_MESSAGE =
  `${TAB_NO_MESSAGING}, so the script couldn't ask whether to run. ${TAB_NO_MESSAGING_FIX}`;

// A script that never reported, in its Log (as a transient error). The
// worker can't tell whether it ran: one that didn't need to ask runs,
// and only its report is lost.
export const TAB_NO_STATUS =
  `SourceMonkey can't get script status: ${TAB_NO_MESSAGING.replace(/^SourceMonkey's/, 'its')}. ${TAB_NO_MESSAGING_FIX}`;

// The page-level notice, in the popup's banner and the toolbar tooltip,
// once the worker finds the tab can't message it (`noMessaging` on the
// tab state). The script rows keep their own statuses.
export const TAB_NO_MESSAGING_HEADING = 'SourceMonkey can\'t reach this tab\'s scripts.';
export const TAB_NO_MESSAGING_DETAIL = `The page's isolated world has no messaging. ${TAB_NO_MESSAGING_FIX}`;

// The bridge's source with these texts in place of its stand-ins
// (`"__SM_NO_MESSAGING__"` and the like), as JavaScript strings.
export function withTabMessagingTexts(code: string): string {
  const texts: [string, string][] = [
    ['__SM_NO_MESSAGING__', TAB_NO_MESSAGING],
    ['__SM_NO_MESSAGING_FIX__', TAB_NO_MESSAGING_FIX],
    ['__SM_CANNOT_MESSAGE__', TAB_CANNOT_MESSAGE],
  ];
  let out = code;
  for (const [stand, text] of texts) {
    const quoted = JSON.stringify(stand);
    if (!out.includes(quoted)) throw new Error(`Internal error: The bridge has no ${stand} stand-in`);
    out = out.split(quoted).join(JSON.stringify(text));
  }
  return out;
}
