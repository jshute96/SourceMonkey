# Userscripts

Userscripts kept in this repo, by directory:

- [`examples/`](examples/): Interactive example pages, each with
  the userscripts that drive it and a Playwright spec. They demonstrate
  the `GM_*` APIs and metadata headers, and their specs compare
  SourceMonkey, Tampermonkey and Violentmonkey.
- [`bad-examples/`](bad-examples/): Deliberately broken userscripts
  (bad headers, syntax errors, failing `@require`s), plus a few that
  only warn. SourceMonkey's e2e and CLI tests check the errors reported
  for each.
- [`greasyfork/`](greasyfork/): Userscripts for Greasy Fork pages.
  - [`show-test-results.user.js`](https://jshute96.github.io/SourceMonkey/userscripts/greasyfork/show-test-results.user.js):
    On Greasy Fork script pages and listings, shows the results of testing
    each script with SourceMonkey. See the
    [GreasyFork corpus README](../greasyfork-testing/README.md#on-greasy-fork-pages).
  - [`prefill-forms-from-hash.user.js`](https://jshute96.github.io/SourceMonkey/userscripts/greasyfork/prefill-forms-from-hash.user.js):
    Fills Greasy Fork's new script, new version and import forms from
    parameters in the URL hash. The
    [publish-on-GreasyFork](../skills/publish-on-GreasyFork/SKILL.md) skill
    builds those URLs. See its [doc](greasyfork/prefill-forms-from-hash.md).
- [`debugging/`](debugging/): Helpers for manual testing. They aren't
  installed or kept enabled by default; enable them when needed.
  - [`no-click-nav.user.js`](debugging/no-click-nav.user.js): Navigates
    without clicking, so you can watch the toolbar popup while the page
    changes underneath it. Navigation shows a countdown at the bottom
    right.
    - Hover a link for 2s to follow it, or hover the Back button for 2s
      to go back.
    - Alt-C follows the hovered link, Alt-B goes back, and Alt-L asks
      for a URL to open, each after 3s. Keys don't reach the page while
      the popup has focus, so use them before opening it.
