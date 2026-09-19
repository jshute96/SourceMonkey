// ==UserScript==
// @name        SourceMonkey example: unsafeWindow
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.1.1
// @description Reads and writes the page's real window through unsafeWindow, while still using GM storage.
// @match       *://*/unsafe-window/unsafe-window.html
// @match       file:///*/unsafe-window/unsafe-window.html
// @run-at      document-end
// @grant       unsafeWindow
// @grant       GM_setValue
// @grant       GM_getValue
// ==/UserScript==

(function () {
  'use strict';

  // Two example scripts write into the same #log list, and nothing
  // decides which of them runs first, so every entry names the script
  // it came from. Each entry also states what was attempted and what
  // came back, because "undefined" on its own doesn't say whether the
  // script asked the wrong question or got a real answer.
  //
  // `data-script` is the hook the spec selects entries by; the visible
  // text is for whoever opens the page.
  const SCRIPT = 'unsafe-window.user.js';

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

  logEntry('page-realm', [
    `[${SCRIPT}] @grant unsafeWindow, and no @inject-into line.`,
    "    Managers read that as a request for the page's own JavaScript,",
    '    which is the only place the page\'s variables exist.',
  ]);

  // 1. Read a page-defined global. This is the whole point of the
  //    grant: `window.__PAGE_APP__` is invisible from an isolated
  //    world, so a script that gets this wrong silently sees undefined.
  const app = unsafeWindow.__PAGE_APP__;
  logStep(
    'read',
    'read a variable the page defined',
    'unsafeWindow.__PAGE_APP__',
    `unsafeWindow.__PAGE_APP__ = ${JSON.stringify(app && { name: app.name, version: app.version })}`,
    app
      ? "the page's own object is visible, so this script is running in the page"
      : 'nothing came back, so this script is NOT running in the page',
  );

  // 2. Call a page-defined function.
  const greeting = typeof (app && app.greet) === 'function'
    ? app.greet('userscript')
    : '(the page function is not visible from here)';
  logStep(
    'call',
    'call a function the page defined',
    "unsafeWindow.__PAGE_APP__.greet('userscript')",
    JSON.stringify(greeting),
    "the page's own code ran and returned its answer to this script",
  );

  // 3. Write something the page itself can read back. The page polls
  //    for it and renders it into #pageSees. Checking from the page's
  //    side is the honest test: a write into the wrong realm would
  //    still read back fine from here.
  unsafeWindow.__FROM_SCRIPT__ = 'written-by-userscript';
  logStep(
    'write',
    'write a variable for the page to read back',
    "unsafeWindow.__FROM_SCRIPT__ = 'written-by-userscript'",
    'see "What the page sees" above, which the page fills in itself',
    "if the page sees it, the write landed in the page and not in some other window",
  );

  // 4. Whether the two are the same object is up to the manager, so
  //    the line reports what it found. SourceMonkey meets the grant by
  //    running the script in the page, so they are one object;
  //    Tampermonkey hands out its sandbox's wrapper around the page's
  //    window even on Chrome, so they are not. Both reach the page —
  //    step 1 is what proves that. Scripts that branch on this
  //    comparison need the answer to be honest.
  const sameWindow = unsafeWindow === window;
  logStep(
    'identity',
    "compare unsafeWindow with this script's own window",
    'unsafeWindow === window',
    `unsafeWindow === window: ${sameWindow}`,
    sameWindow
      ? 'this manager met the grant by running the script in the page, so '
        + 'there is only one window object here'
      : "this manager handed out a wrapper around the page's window. The "
        + 'reads above still worked, so the wrapper reaches the page',
  );

  // 5. GM_* still works. Reaching the page realm must not cost the
  //    script its storage — this counter persists across reloads.
  const visits = GM_getValue('visits', 0);
  GM_setValue('visits', visits + 1);
  logStep(
    'gm',
    'use GM storage from a script that runs in the page',
    "GM_getValue('visits'), then GM_setValue to bump it",
    `GM_getValue('visits') = ${visits}, now set to ${visits + 1}`,
    'reaching the page costs the script nothing: reload and this counts up',
  );

  const status = document.getElementById('runStatus');
  if (status) {
    status.classList.add('ran');
    status.textContent = 'Userscripts ran. See the log below.';
  }
})();
