# Navigate without clicking (test helper)

## Summary

Lets you navigate a tab without clicking in it, for testing what
happens when a page navigates while something a click would change stays
as it is. For example, an open popup or menu, which closes when you
click anywhere on the page.

This can be used for testing SourceMonkey's toolbar popup, to see state
changes when the page navigates, without clicking on the page, which
closes the popup.

A label at the bottom right of every page lists the controls, and shows
a countdown while a navigation is pending.

### Controls

- **Hover a link for 2s** to follow it. Moving off the link cancels.
- **Hover the label's Back button for 2s** to go back. Moving off it
  cancels. Clicking it goes back at once.
- Keys, each acting after 3s (they reach the page only while it has
  focus, not the popup):
  - **Alt-C** follows the hovered link. Moving off the link doesn't
    cancel it.
  - **Alt-B** goes back.
  - **Alt-L** asks for a URL (offering the hovered link, or the
    current page) and opens it. A URL with no scheme gets `http://`.

## Visible changes

- A label fixed at the bottom right of every page, with a Back button.
- Hovering a link starts a countdown to following it.

## Implementation

- Runs on all pages (`*://*/*` and `file:///*`); it doesn't depend on
  any page's DOM.
- The label is a custom element (`sm-no-click-nav`) holding a closed
  shadow root, so page CSS can't restyle it.
  - It sits on the right, clear of Chrome's link-URL bubble at the
    bottom left.
  - It sets CSS `zoom` to undo Chrome's per-site zoom, estimated from
    `outerWidth / innerWidth`.
- One countdown runs at a time, on `setInterval`; starting one replaces
  the last.
  - A hover countdown is cancelled by moving off its target; a key's
    countdown isn't, and hovering doesn't replace it.
- Hovered links come from a capturing `mouseover` listener
  (`closest('a[href]')`).
- On a `pageshow` from the back/forward cache, the label is reset,
  since it would otherwise still show the last countdown.
- Tests: `no-click-nav.spec.ts` serves made-up pages at `example.test`
  and uses Playwright's clock in place of real waits. It reads the
  closed shadow root over CDP (Chrome DevTools Protocol), since
  locators can't reach it.
