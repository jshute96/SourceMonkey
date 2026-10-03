// Makes a native `<select>` open its list on the mouse *release*
// rather than the press, so the click that opens it cannot also pick
// out of it.
//
// The hazard is the browser's own popup placement. Chrome usually
// draws the list below the closed control, but when it doesn't fit
// there — near the bottom of the screen, a short window, a long list —
// it shifts the list up over the control, which puts an entry directly
// under the pointer that just pressed. Chrome's press-drag-release
// support (hold the button, slide down the list, release on an entry)
// then treats the release of that same click as a pick: the dropdown
// appears to open, choose at random, and close, with the list never
// seen.
//
// Why the page has to handle it: the popup is a browser widget, not
// DOM. We can't place it, we can't see it, no event says it opened,
// and the gesture has no opt-out.
//
// So the press is cancelled and the list is opened from the `click`
// that follows, by which time no button is held:
//
//   - `mousedown` is `preventDefault`ed, which is what stops Chrome
//     opening the popup (and, as a side effect, the focus the press
//     would have given — so focus is set by hand);
//   - the `click` that press produced calls `showPicker()`, the same
//     list, opened with the mouse already up. Wherever Chrome draws
//     it, nothing is committed until the user presses on an entry
//     deliberately.
//
// What it costs: press-drag-release no longer picks — the gesture that
// causes the bug. Press, release, click the entry still does, as does
// every keyboard path, which never goes near this code.
//
// The alternative — letting the stray pick happen and undoing it — was
// worse in practice: the list is torn down and re-opened under the
// cursor, which reads as a flash over the whole popup on every click.

import { dlog } from '../debug-log.js';
import { describeError } from '../script-build.js';

// Open `select`'s list on release instead of on press.
export function guardSelectOpeningClick(select: HTMLSelectElement): void {
  // Nothing to take over with, so the native press-to-open has to
  // stand, bug and all — a cancelled press with no replacement is a
  // dead control. `showPicker` has been in Chrome since 121, well
  // below the extension's floor, so this covers only a future context
  // that withholds it.
  if (typeof select.showPicker !== 'function') return;

  // Cleared if `showPicker` ever refuses, which hands the control back
  // to the browser's own press-to-open rather than leaving a dropdown
  // that cannot be opened at all. The click that discovered the
  // refusal is spent — its press was already cancelled — so that one
  // opens nothing and the next one opens natively.
  let takeover = true;

  // A press of ours is waiting for its release. This, rather than any
  // property of the click, is what says the list should open: a click
  // the guard didn't cancel a press for must not open a picker, and
  // there are several — the keyboard's Enter / Space, a click
  // forwarded by the `for=` label beside the install dropdown, a
  // `select.click()` from any future code, a press that began on
  // something else and released here.
  let openFromPress = false;

  select.addEventListener('mousedown', (event) => {
    // Only the button that opens the popup. Anything else is left to
    // the browser, context menu included.
    if (!takeover || event.button !== 0) return;
    event.preventDefault();
    openFromPress = true;
    // The cancelled press took the focus it would have given with it.
    // Without scrolling: the control is under the pointer, so it is on
    // screen already, and a press never scrolls.
    select.focus({ preventScroll: true });
  });

  select.addEventListener('click', () => {
    // Cleared on every click, ours or not: the flag is about one
    // press, and a click that isn't its release must not leave it
    // armed for a later one.
    const ours = openFromPress;
    openFromPress = false;
    if (!takeover || !ours) return;
    try {
      select.showPicker();
    } catch (err) {
      takeover = false;
      dlog(`[SourceMonkey] could not open the collection list: ${describeError(err)}`);
    }
  });
}
