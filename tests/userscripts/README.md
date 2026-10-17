# Manual test userscripts

Userscripts that help with manual testing. They aren't typically installed
or kept enabled by default. They're enabled when needed.

- `no-click-nav.user.js`: navigates without clicking, so you can watch
  the toolbar popup while the page changes underneath it. Navigation
  shows a countdown at the bottom right.
  - Hover a link for 2s to follow it, or hover the Back button for 2s
    to go back.
  - Alt-C follows the hovered link, Alt-B goes back, and Alt-L asks
    for a URL to open, each after 3s. Keys don't reach the page while
    the popup has focus, so use them before opening it.
