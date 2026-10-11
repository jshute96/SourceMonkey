// ==UserScript==
// @name        SourceMonkey example: gm-info: GM_info
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     2.1.2
// @description Hand GM_info to the page, which renders it.
// @author      SourceMonkey examples
// @copyright   2026, SourceMonkey examples
// @license     MIT
// @homepageURL https://github.com/jshute96/SourceMonkey
// @supportURL  https://github.com/jshute96/SourceMonkey/issues
// @icon        ./icon.svg
// @match       *://*/*gm-info/gm-info.html
// @match       file:///*/gm-info/gm-info.html
// @include     *://*/gm-info/gm-info.html?include=*
// @exclude     *://*/gm-info/gm-info.html?exclude=*
// @exclude-match *://*/*gm-info/gm-info.html?exclude-match=*
// @require     ./lib.js
// @resource    note ./resource.txt
// @connect     example.com
// @noframes
// @run-at      document-end
// @grant       GM_info
// @grant       GM_getResourceText
// ==/UserScript==

// The header above fills in most tags, including ones that do
// nothing here, so the page can show how each manager reports them
// back through GM_info:
//   - the `?include=` / `?exclude=` patterns never match this page;
//   - `@exclude-match` is a VM-only tag (SM and TM don't parse it);
//   - `lib.js` / `resource.txt` / `icon.svg` are stubs next to this
//     file; `@grant GM_getResourceText` is only there so managers
//     that skip unused resources still fetch the @resource.
//     TODO: switch these to absolute raw-GitHub URLs once the repo is
//     public — TM/VM can't fetch the relative refs when the script is
//     installed by hand (see TODO.md, "Cross-manager coverage").
//
// The body is deliberately minimal: it only hands its GM_info to the
// page. All formatting lives in gm-info.html, so it can change
// without re-installing this script in every manager, and copies
// running under different managers never fight over the DOM.
(function () {
  'use strict';

  const dumps = document.getElementById('dumps');
  if (!dumps) return;

  // GM_info is technically available without an explicit @grant in TM
  // and SM, but listing it under @grant here makes the dependency
  // visible to a reader.
  const info = (typeof GM_info !== 'undefined') ? GM_info : null;

  // A DOM node rather than a CustomEvent: event `detail` objects don't
  // cross the isolated-world boundary in TM/VM, but text in the shared
  // DOM does. The page watches #dumps and renders whatever lands here.
  const node = document.createElement('script');
  node.type = 'application/json';
  node.className = 'gm-info-dump';
  node.textContent = JSON.stringify(info);
  dumps.append(node);
})();
