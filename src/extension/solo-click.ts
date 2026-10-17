// What an enable checkbox says, and the Ctrl/Cmd-click that opts it out
// of turning a script's other copies off. Shared by every surface with
// an enable checkbox: the viewer, the collections page, the toolbar
// popup. See docs/script-enablement.md.

import { ENABLE_TITLE } from '../script-display.js';

// What every enable checkbox says, and the tail it adds when clicking
// it would sweep other copies. Shared so every surface says exactly the
// same thing: the hint is the only part of them that varies.
//
// Deliberately short, and deliberately fixed. Naming the copy would
// repeat the Collection and Location cells an inch to the right, and
// swapping to "Disable" when checked would make one control read two
// ways for no gain.
//
// The hint names ONE key — the one this machine has. The handler
// accepts either, but only one is usable here (on a Mac ctrl-click opens
// the context menu, so Cmd is the one that works), and a message
// offering both would be telling half its readers about a gesture their
// keyboard doesn't have. The docs say "Ctrl/Cmd" because
// they describe every platform at once; the app knows which one it is
// running on.
const SOLO_HINT = ` (${isApplePlatform() ? 'Cmd' : 'Ctrl'}-click for multi-enable)`;

// Resolved once, at module load — the platform can't change under us.
// `userAgentData` is the supported spelling and is present in every
// Chrome that can run this extension; `platform` is the fallback for a
// non-Chrome host and for the tests' DOM stubs.
function isApplePlatform(): boolean {
  const data = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
  if (data?.platform) return data.platform === 'macOS';
  return /mac|iphone|ipad/i.test(navigator.platform || '');
}

// Wording for an enable checkbox, hint included only when clicking it
// would sweep other copies.
export function enableTitle(sweepsOthers: boolean): string {
  return sweepsOthers ? `${ENABLE_TITLE}${SOLO_HINT}` : ENABLE_TITLE;
}

// Wire a checkbox so its `change` handler can find out whether the
// click that produced it carried the exclusive-opt-out modifier.
// Returns a consume-once reader.
//
// Read from `click`, not `change`: `change` carries no modifier state.
// Keyboard activation (space) fires a click too, so nothing is lost —
// and `ctrlKey` is simply false there, which is the right default.
// `metaKey` covers Cmd-click on a Mac, where ctrl-click is the context
// menu. Consumed on read, so a later `change` that arrives without a
// click in front of it can't inherit a modifier pressed once.
export function watchSoloModifier(box: HTMLInputElement): () => boolean {
  let solo = false;
  box.addEventListener('click', (ev: MouseEvent) => {
    solo = ev.ctrlKey || ev.metaKey;
  });
  return () => {
    const was = solo;
    solo = false;
    return was;
  };
}
