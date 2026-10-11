// ==UserScript==
// @name        SourceMonkey example: unsafe-window: unsafeWindow outside the page
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.1.4
// @description The other corner: @inject-into content keeps the script out of the page, so unsafeWindow is not the page's window.
// @match       *://*/*unsafe-window/unsafe-window.html
// @match       file:///*/unsafe-window/unsafe-window.html
// @run-at      document-end
// @inject-into content
// @grant       unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  // Same entry format as unsafe-window.user.js, and the same reason
  // for it: both scripts write into one #log list in no fixed order,
  // so each entry names its script and says what it asked for as well
  // as what came back.
  const SCRIPT = 'isolated.user.js';

  function logEntry(key, lines) {
    const list = document.getElementById('log');
    if (!list) return;
    const li = document.createElement('li');
    li.dataset.script = key;
    li.textContent = lines.join('\n');
    list.appendChild(li);
  }

  function logStep(key, title, tried, got, means) {
    logEntry(key, [
      `[${SCRIPT}] ${title}`,
      `    tried   ${tried}`,
      `    got     ${got}`,
      `    means   ${means}`,
    ]);
  }

  // `@inject-into content` is an explicit request to run isolated from
  // main page content, and it wins over the unsafeWindow grant. There is
  // nothing the manager can do about that: property access on
  // unsafeWindow is synchronous, and Chrome offers no synchronous
  // channel from an isolated script into the page's own JavaScript. So
  // the binding still exists, but it can only be this script's own
  // window.
  //
  // SourceMonkey flags the combination with a parse-time warning
  // (visible in the script's Log tab and the page console) so the
  // mismatch isn't silent. Other managers differ, which is exactly what
  // this variant is here to compare.
  logEntry('isolated-mode', [
    `[${SCRIPT}] @inject-into content, plus @grant unsafeWindow.`,
    '    @inject-into content makes this script run isolated from main page',
    '    content, and that wins over the grant. Everything below is what a',
    '    script sees from there.',
  ]);

  // The `means` lines below are derived from what actually came back,
  // not written for the expected answer. Managers disagree about this
  // script: Tampermonkey has no `@inject-into` (its equivalent is
  // `@sandbox`), so it honours the grant and runs this in the page,
  // where the reads succeed. A hard-coded "reads as undefined" would
  // then be a log that contradicts the line above it.
  const pageApp = unsafeWindow.__PAGE_APP__;
  logStep(
    'isolated-read',
    'read the same variable the page defined',
    'unsafeWindow.__PAGE_APP__',
    `unsafeWindow.__PAGE_APP__ = ${JSON.stringify(pageApp && { name: pageApp.name, version: pageApp.version })}`,
    pageApp
      ? 'this manager reached the page anyway, so it ignored @inject-into '
        + 'content and honoured the grant instead'
      : "an isolated script cannot see main page content, so the page's "
        + 'variables read as undefined. This is the failure the grant exists to avoid',
  );

  const sameWindow = unsafeWindow === window;
  logStep(
    'isolated-identity',
    "compare unsafeWindow with this script's own window",
    'unsafeWindow === window',
    `unsafeWindow === window: ${sameWindow}`,
    sameWindow
      ? 'there is one window object here. On its own that says nothing '
        + 'about whether the page was reached, since an isolated script '
        + "gets the same answer for its own window; the read above is "
        + 'what tells you'
      : 'the two differ, so this manager wrapped window rather than '
        + 'handing over the raw one. Which window it wrapped is what the '
        + 'read above tells you, not this line',
  );
})();
