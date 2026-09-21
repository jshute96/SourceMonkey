// ==UserScript==
// @name        SourceMonkey example: unsafeWindow with no grant
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.0
// @description Uses unsafeWindow without granting it, the way many real scripts do, and reports what the manager hands over.
// @match       *://*/unsafe-window/unsafe-window.html
// @match       file:///*/unsafe-window/unsafe-window.html
// @run-at      document-end
// @grant       GM_setValue
// @grant       GM_getValue
// ==/UserScript==

(function () {
  'use strict';

  // No `@grant unsafeWindow` anywhere above — on purpose. Tampermonkey
  // and Violentmonkey both expose the name with no grant line, so real
  // scripts use it undeclared: 112 of the GreasyFork top 2000 do.
  //
  // This script asks what each manager actually hands over, which is
  // also what SourceMonkey's own behaviour is derived from: it scans the
  // body for the reference and treats the script as though it had
  // granted it (MAIN world plus the binding).
  //
  // Everything here is guarded with `typeof`, because a manager that
  // keys the name off the grant leaves it undeclared — and a bare
  // reference to an undeclared name is a ReferenceError that would stop
  // the script before it could report anything.
  const SCRIPT = 'ungranted.user.js';

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

  const defined = typeof unsafeWindow !== 'undefined';
  const uw = defined ? unsafeWindow : null;

  logStep(
    'ungranted-defined',
    'use unsafeWindow with no @grant line for it',
    "typeof unsafeWindow, from a script granting only GM_getValue / GM_setValue",
    `typeof unsafeWindow = ${typeof unsafeWindow}`,
    defined
      ? 'this manager does not key the name off the grant line'
      : 'this manager gives the name only to scripts that grant it, so a '
        + 'script written elsewhere would throw a ReferenceError here',
  );

  const app = defined ? uw.__PAGE_APP__ : undefined;
  logStep(
    'ungranted-read',
    "read a variable the page defined, through the ungranted unsafeWindow",
    'unsafeWindow.__PAGE_APP__',
    `unsafeWindow.__PAGE_APP__ = ${JSON.stringify(app && { name: app.name, version: app.version })}`,
    app
      ? 'the ungranted reference reached the page, so the manager honoured it'
      : "nothing came back: this script is not running in the page's realm",
  );

  // Storage has to survive whatever the manager did about the world.
  // Under SourceMonkey the reference moved this script into the page,
  // where GM_* rides the bridge instead of a direct channel.
  const visits = GM_getValue('ungrantedVisits', 0);
  GM_setValue('ungrantedVisits', visits + 1);
  logStep(
    'ungranted-gm',
    'use GM storage from the same script',
    "GM_getValue('ungrantedVisits'), then GM_setValue to bump it",
    `GM_getValue('ungrantedVisits') = ${visits}, now set to ${visits + 1}`,
    'the grants keep working wherever the unsafeWindow reference put this script',
  );
})();
