/* SourceMonkey GM_* shared runtime. Registered once per page in
   USER_SCRIPT world at document_start, ahead of every userscript.

   Per-script wrappers compile in `const GM_X = function(...) { ... }`
   for every API the script @grants. Two delegation modes:
     - SYNC API bodies call into methods on `window.__SM_GM__` defined
       here. The runtime is shared across all userscripts in this
       document (USER_SCRIPT world is one realm per extension per
       document), so per-script state lives in keyed sub-objects.
     - ASYNC API bodies don't go through here; they send messages
       straight to the SW via chrome.runtime.sendMessage.

   Build rules match wrapper-head.js — block comments only, no `//`
   sequences in strings, the build minifies to one physical line. See
   scripts/build.mjs's minifyForInjection for the exact rules.

   Shim cache. See docs/GM_API_strategy.md "Recommendation: a tiny
   'shim cache', not a full vault". We capture a small set of native
   references at runtime-init time so a sibling userscript that
   monkey-patches builtins later can't break our GM_* impls. The
   USER_SCRIPT world is isolated from the page so the page itself
   can't reach in; the threat we mitigate here is "userscript A
   stomps on Array.prototype.forEach and userscript B's GM_* call
   then sees the stomped version."

   Phase 2 status. All bodies stub out to throw "not implemented yet".
   Subsequent phases fill in subsystems. */
(function () {
  "use strict";
  if (typeof window === "undefined") return;
  if (window.__SM_GM__) return;

  var _Promise = Promise;
  var _Error = Error;
  /* Capture chrome.runtime.sendMessage now so an ASYNC API body still
     reaches a sane reference even if a sibling userscript reassigns
     window.chrome or chrome.runtime later. We only do this when
     chrome.runtime exists (true for USER_SCRIPT world; falsy in MAIN). */
  var _sendMessage = null;
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
      _sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    }
  } catch (_e) {}

  var api = {
    /* Phase-2 placeholder: every sync GM_* body delegates to this
       until its real handler lands in a later phase. The thrown error
       is deliberately user-visible so a script can't silently misuse
       a stubbed API. */
    notImplemented: function (name) {
      throw new _Error("[SourceMonkey] " + name + " is not implemented yet");
    },
    /* Exposed so per-script wrapper bodies can route async sendMessage
       through the captured reference rather than re-reading
       chrome.runtime each call. Returns a Promise that resolves with
       the SW's reply (or rejects if messaging is unavailable). */
    sendAsync: function (payload) {
      if (!_sendMessage) {
        return _Promise.reject(new _Error("[SourceMonkey] chrome.runtime.sendMessage unavailable"));
      }
      try {
        var p = _sendMessage(payload);
        if (p && typeof p.then === "function") return p;
        return _Promise.resolve(p);
      } catch (e) {
        return _Promise.reject(e);
      }
    },
  };

  /* Object.defineProperty with writable:false + configurable:false so a
     sibling userscript can't replace the runtime out from under other
     scripts after init. We accept that the page can't see us (USER_SCRIPT
     world) so we don't need to hide the global. */
  try {
    Object.defineProperty(window, "__SM_GM__", {
      value: api,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  } catch (_e2) {
    /* If something already pinned the slot, fall back to a plain
       assignment so we still expose the API. */
    window.__SM_GM__ = api;
  }
})();
