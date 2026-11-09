# Userscripts

Userscripts kept in this repo, by directory. The tables below are
generated from [`script_manifest.json`](script_manifest.json), which
lists every script here, so SourceMonkey can load them all as one
collection. Each table's category is the script's directory.

- Loading the whole collection also installs the debugging helpers,
  which run on all sites, and the broken bad examples. To load only
  some, use the manifests of their own in `examples/` and
  `bad-examples/`, each a separate collection.
- Regenerate the tables with the `userscript-collections` skill's
  `update_readme.py` (see [Updating the tables](#updating-the-tables)).

## `greasyfork/`

Userscripts for Greasy Fork pages.

- `show-test-results.user.js` shows the results of testing each script
  with SourceMonkey. See the
  [GreasyFork corpus README](../greasyfork-testing/README.md#on-greasy-fork-pages).
- `prefill-forms-from-hash.user.js` fills the posting forms from URL
  parameters. The
  [publish-on-GreasyFork](../skills/publish-on-GreasyFork/SKILL.md)
  skill builds those URLs.
- Install them from their GitHub Pages URLs, such as
  [`show-test-results.user.js`](https://jshute96.github.io/SourceMonkey/userscripts/greasyfork/show-test-results.user.js)
  and
  [`prefill-forms-from-hash.user.js`](https://jshute96.github.io/SourceMonkey/userscripts/greasyfork/prefill-forms-from-hash.user.js).

<!-- update_readme.py category=greasyfork -->
| Site | Script | Doc | Description |
| :---: | --- | --- | --- |
| <img src="site-icons/greasyfork.org_script_versions_new.png" width="16" height="16" alt=""> | [Greasy Fork: Fill post/update/import forms from URL parameters](greasyfork/prefill-forms-from-hash.user.js) | [doc](greasyfork/prefill-forms-from-hash.md) | Fills Greasy Fork's new script, new version, and import script forms from URL parameters, so they can be opened pre-filled. |
| <img src="site-icons/greasyfork.org.png" width="16" height="16" alt=""> | [Greasy Fork: Show SourceMonkey's userscript test results](greasyfork/show-test-results.user.js) | [doc](greasyfork/show-test-results.md) | On Greasy Fork script pages, for scripts that have been tested with SourceMonkey, show the test results |

## `debugging/`

Helpers for manual testing. They aren't installed or kept enabled by
default; enable them when needed.

<!-- update_readme.py category=debugging -->
| Script | Doc | Description |
| --- | --- | --- |
| [Navigate without clicking (test helper)](debugging/no-click-nav.user.js) | [doc](debugging/no-click-nav.md) | Hovering a link 2s follows it, hovering Back goes back; Alt-C (hovered link), Alt-B (back) and Alt-L (asks for a URL) navigate after 3s |

## `examples/`

Interactive example pages, each with the userscripts that drive it and
a Playwright spec. They demonstrate the `GM_*` APIs and metadata
headers, and their specs compare SourceMonkey, Tampermonkey and
Violentmonkey. See the [examples README](examples/README.md).

<!-- update_readme.py category=examples -->
| Site | Script | Description |
| :---: | --- | --- |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: dialogs: dialog boxes](examples/dialogs/dialogs.user.js) | Click buttons to open each kind of dialog box: alert, confirm, prompt, Leave site, file choosers, pickers and a connection prompt. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: frames: every frame](examples/frames/every-frame.user.js) | Runs in the page and each of its frames, sharing a counter across them. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: frames: Frame B only](examples/frames/frame-b-only.user.js) | Matches only Frame B, so it runs on a page it doesn't match. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: frames: top frame only](examples/frames/top-only.user.js) | Matches the page and its frames, but @noframes keeps it to the top frame. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: gm-clipboard: GM_setClipboard](examples/gm-clipboard/gm-clipboard.user.js) | Copy a text value to the system clipboard. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: gm-dom: GM_addStyle / GM_addElement](examples/gm-dom/gm-dom.user.js) | Inject styles and elements into the page via DOM helpers. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: gm-download: GM_download](examples/gm-download/gm-download.user.js) | Click buttons to download files with various GM_download call shapes. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: gm-info: GM_info](examples/gm-info/gm-info.user.js) | Hand GM_info to the page, which renders it. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: gm-log: GM_log](examples/gm-log/gm-log.user.js) | Demonstrate GM_log against several arg shapes. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: gm-menu: GM_registerMenuCommand](examples/gm-menu/gm-menu.user.js) | Register and unregister entries in the toolbar action's right-click menu. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: gm-notification: GM_notification](examples/gm-notification/gm-notification.user.js) | Click buttons to fire various GM_notification call shapes. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: gm-open-in-tab: GM_openInTab](examples/gm-open-in-tab/gm-open-in-tab.user.js) | Open new tabs via every GM_openInTab call shape. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: gm-resource: GM_getResourceText / GM_getResourceURL](examples/gm-resource/gm-resource.user.js) | Read prefetched @resource files as text and as URLs. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: gm-return-values: GM_ vs GM. return values](examples/gm-return-values/gm-return-values.user.js) | Call the GM_ and GM. forms of some APIs and show what each returns. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: gm-storage: GM storage](examples/gm-storage/gm-storage.user.js) | Set/get/delete/list per-script GM storage values via a form, one key or many at once. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: gm-tab: GM_getTab / GM_saveTab / GM_getTabs](examples/gm-tab/gm-tab.user.js) | Count this page's loads per tab and list every tab's object with the per-tab APIs. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: gm-value-listeners: GM value-change listeners](examples/gm-value-listeners/gm-value-listeners.user.js) | Register/remove GM_addValueChangeListener callbacks. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: gm-xmlhttp: GM_xmlhttpRequest](examples/gm-xmlhttp/gm-xmlhttp.user.js) | Issue cross-origin HTTP requests via GM_xmlhttpRequest. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: headers-include-regex: /i flag](examples/headers-include-regex/regex-flag-i.user.js) | A regex @include with an i flag after it. This doesn't match. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: headers-include-regex: @exclude with /i flag](examples/headers-include-regex/exclude-flag-i.user.js) | @match names this page, and so does an @exclude regex with an i flag after it. This matches. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: headers-include-regex: escaped slashes](examples/headers-include-regex/regex-escaped.user.js) | A regex @include with escaped slashes (\/). This matches. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: headers-include-regex: unescaped slashes](examples/headers-include-regex/regex-slashes.user.js) | A regex @include with unescaped slashes inside it. This matches. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: headers-include-regex: uppercase glob](examples/headers-include-regex/glob-case.user.js) | An uppercase glob @include, on a lowercase URL. This matches. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: headers-include-regex: uppercase regex](examples/headers-include-regex/regex-case.user.js) | An uppercase regex @include, on a lowercase URL. This matches. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: headers-inject-into: @inject-into content](examples/headers-inject-into/content.user.js) | Runs in an isolated USER_SCRIPT world; can't see page globals. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: headers-inject-into: @inject-into page](examples/headers-inject-into/page.user.js) | Runs in the page's MAIN world; can see page globals. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: headers-match-hash: @exclude of the hash](examples/headers-match-hash/exclude-hash.user.js) | @match names the page, and @exclude *#part names it with #part. This matches except with #part.* |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: headers-match-hash: @include with the hash](examples/headers-match-hash/include-hash.user.js) | @include names the page with #part. This matches with #part only.* |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: headers-match-hash: @include without the hash](examples/headers-match-hash/include-exact.user.js) | @include names the page without a hash. This matches with no hash only.* |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: headers-match-hash: @match plus a regex @include](examples/headers-match-hash/match-regex.user.js) | @match names the page without a hash, plus a regex @include that matches nothing. This matches, with any hash or none. |
|  | [SourceMonkey example: headers-match-hash: @match with the hash](examples/headers-match-hash/match-hash.user.js) | @match names the page with #part. This doesn't match.* |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: headers-match-hash: @match without the hash](examples/headers-match-hash/match-exact.user.js) | @match names the page without a hash. This matches, with any hash or none. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: headers-run-at: @run-at document-end](examples/headers-run-at/end.user.js) | Demonstrates @run-at document-end (after DOMContentLoaded). |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: headers-run-at: @run-at document-idle](examples/headers-run-at/idle.user.js) | Demonstrates @run-at document-idle (default; once readyState is complete, just before load). |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: headers-run-at: @run-at document-start](examples/headers-run-at/start.user.js) | Demonstrates @run-at document-start (runs before DOM parses). |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: require-scope: @require in the content (USER_SCRIPT) world](examples/require-scope/content-world.user.js) | The same @require'd library reaches an isolated-world script, alongside its GM_* bindings. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: require-scope: @require in the page (MAIN) world](examples/require-scope/page-world.user.js) | A @require'd library's top-level class/const/function reach a MAIN-world script. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: require-scope: relative @require paths](examples/require-scope/relative/relative-require.user.js) | Loads two @require libraries by relative path, in order. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: resource-missing: a @resource that doesn't load](examples/resource-missing/resource-missing.user.js) | Declares a @resource whose URL doesn't exist, and shows what the script gets when it asks for it. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: run-at-context-menu: @run-at context-menu](examples/run-at-context-menu/run-at-context-menu.user.js) | Runs only when asked: each run adds a line to the page. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: unsafe-window: unsafeWindow](examples/unsafe-window/unsafe-window.user.js) | Reads and writes the page's real window through unsafeWindow, while still using GM storage. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: unsafe-window: unsafeWindow outside the page](examples/unsafe-window/isolated.user.js) | The other corner: @inject-into content keeps the script out of the page, so unsafeWindow is not the page's window. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: unsafe-window: unsafeWindow with no grant](examples/unsafe-window/ungranted.user.js) | Uses unsafeWindow without granting it, the way many real scripts do, and reports what the manager hands over. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: use-strict: 'use strict' with a @require (own-after-lib)](examples/use-strict/with-require/own-after-lib.user.js) | Reports whether the script runs in strict mode when it has a @require. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: use-strict: 'use strict' with a @require (strict-lib)](examples/use-strict/with-require/strict-lib.user.js) | Reports whether the script runs in strict mode when it has a @require. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: use-strict: top-level 'use strict' in the content (USER_SCRIPT) world](examples/use-strict/strict-content.user.js) | Reports whether a 'use strict' at the very top of the script puts it in strict mode. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: use-strict: top-level 'use strict' in the page world](examples/use-strict/strict-page.user.js) | Reports whether a 'use strict' at the very top of the script puts it in strict mode. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: window-close-focus: window.close / window.focus](examples/window-close-focus/window-close-focus.user.js) | Close the current tab and raise the browser window through the manager's window.* grants. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: window-onurlchange: window.onurlchange](examples/window-onurlchange/window-onurlchange.user.js) | Watch SPA navigations (pushState / replaceState / hash / back) through the urlchange event. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: xmlhttp-connect: GM_xmlhttpRequest with @connect *](examples/xmlhttp-connect/connect-any.user.js) | Declares @connect *, so requests to any site go without asking. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: xmlhttp-connect: GM_xmlhttpRequest with @connect example.com](examples/xmlhttp-connect/connect-example-com.user.js) | Declares @connect example.com, so requests there go without asking, and SourceMonkey asks before the others. |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [SourceMonkey example: xmlhttp-connect: GM_xmlhttpRequest with no @connect lines](examples/xmlhttp-connect/connect-none.user.js) | Declares no @connect lines, so SourceMonkey asks before each request to another site. |

## `bad-examples/`

Deliberately broken userscripts (bad headers, syntax errors, failing
`@require`s), plus a few that only warn. SourceMonkey's e2e and CLI
tests check the errors reported for each. See the
[bad-examples README](bad-examples/README.md).

<!-- update_readme.py category=bad-examples -->
| Site | Script | Description |
| :---: | --- | --- |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [Blank Lines](bad-examples/blank-lines.user.js) | Blank lines and bare // lines inside the metadata block, which are ignored |
|  | [empty-header.user.js](bad-examples/empty-header.user.js) |  |
|  | [empty.user.js](bad-examples/empty.user.js) |  |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [Invalid Header Fields](bad-examples/invalid-header-fields.user.js) | Unknown and oddly named @tags, which don't make the script invalid |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [Invalid Match](bad-examples/invalid-match.user.js) | A @match Chrome refuses, which is dropped while the script runs on its other @match |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [Leading Text](bad-examples/leading-text.user.js) | Code and comments above the metadata block, which is still found |
|  | [Malformed Field](bad-examples/malformed-field.user.js) | A @match written with = instead of a space, so the script has no @match and is invalid |
|  | [Missing Require](bad-examples/missing-require.user.js) | A @require of a file that doesn't exist, so the script is invalid |
|  | [no-header.user.js](bad-examples/no-header.user.js) |  |
|  | [Require Collision](bad-examples/require-collision.user.js) | Two @require libraries that each parse alone but declare the same const, so the joined script is invalid |
|  | [Stray Closing Brace](bad-examples/stray-brace.user.js) | A stray closing brace with code after it, located by the syntax check |
|  | [Stray Closing Brace At End](bad-examples/stray-brace-at-end.user.js) | A stray closing brace as the last thing in the file, located by the syntax check |
|  | [Syntax Error In Body](bad-examples/syntax-error-body.user.js) | A syntax error in the script body, reported at the line an editor shows |
|  | [Syntax Error In Require](bad-examples/syntax-error-require.user.js) | A syntax error in a @require library, reported in the library rather than the script |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [Throwing Require](bad-examples/throwing-require.user.js) | A @require library that throws when it runs; the script installs fine and fails at run time |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [Two Headers (first)](bad-examples/two-headers.user.js) | Two metadata blocks; the first is used and the second is treated as code |
|  | [Unclosed Header](bad-examples/unclosed-header.user.js) |  |
| <img src="site-icons/icon-jshute96.github.io_SourceMonkey_src_icons_icon-48.png" width="16" height="16" alt=""> | [Unknown Grant](bad-examples/unknown-grant.user.js) | @grant of APIs that don't exist, which are dropped with a warning |
|  | [Unparsable Require](bad-examples/unparsable-require.user.js) | A @require library with an unterminated comment, so the script is invalid |
|  | [Unusable Match](bad-examples/unusable-match.user.js) | Its only @match is one Chrome refuses, so it could never run and is invalid |

## Updating the tables

From the repo root, after adding, removing or renaming a script:

```sh
SKILL=skills/userscript-collections/scripts
# This directory's manifest: add new scripts, drop removed ones.
# Then set each new entry's "category" to its directory.
pnpm sm-dev manifest --dir userscripts userscripts --prune
# The examples' and bad-examples' own manifests.
pnpm sm-dev manifest userscripts/examples --prune
pnpm sm-dev manifest userscripts/bad-examples --prune
# Icons for new scripts, then the tables.
$SKILL/update_site_icons.py --root userscripts userscripts/<dir>/<script>.user.js
for root in userscripts userscripts/examples userscripts/bad-examples; do
  $SKILL/update_readme.py --root $root
done
```

`tests/unit/userscripts-collection.test.mjs` checks the manifests and
tables are up to date.
