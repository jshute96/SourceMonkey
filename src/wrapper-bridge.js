/* SourceMonkey USER_SCRIPT-world bridge.

   MAIN-world userscript wrappers can't call chrome.runtime.sendMessage
   (chrome.runtime is undefined in MAIN). To still get sm:* telemetry
   AND to let the reload-fast-path's sm:check-pending round-trip work
   from MAIN, the MAIN wrapper falls back to window.postMessage; this
   bridge runs in USER_SCRIPT world on the same page, listens for
   those messages, and forwards them to the SW.

   Two flavors of forwarded message:
     - Fire-and-forget reports (sm:start / sm:error / sm:swapped /
       sm:abandoned). The bridge calls chrome.runtime.sendMessage and
       silently swallows the returned promise.
     - Request/reply for sm:check-pending. The MAIN wrapper attaches
       a requestId; the bridge forwards to the SW, awaits the reply,
       and posts it back as a "sourcemonkey-bridge-reply" message keyed
       on the same requestId. The MAIN wrapper's listener matches on
       requestId and resolves its awaiter.

   Build rules match wrapper-head.js — only /* block * / comments,
   strings must not start a line with //, the build minifies to one
   physical line.

   Trust model. postMessage is observable by the page, so the page
   can both read our sm:* events and forge them. We require
   event.source === window (no cross-frame relay), data.__sm ===
   MARKER, and a small allowlist of payload types. That's enough to
   keep cross-origin frames out; it does NOT stop the host page from
   sending fakes. Active attacks the page can mount once the bridge
   is in place:
     - forge `sm:start` to flip a script's badge from MISSING to OK,
     - forge `sm:error` with an attacker-chosen `message`, which the
       SW logs via console.error,
     - drive a small amount of chrome.storage.session write
       amplification per fake report,
     - forge a `sourcemonkey-bridge-reply` with a known requestId to
       hand a MAIN wrapper an attacker-supplied body to eval. The
       page already runs arbitrary code in MAIN world, so this is no
       privilege gain — the cost is attribution (errors blamed on our
       script's sourceURL) and a one-navigation delay for the real
       update.
   None grant script execution or SW privilege beyond what the page
   already has. If we ever need a real boundary, inject a per-document
   nonce shared between the MAIN wrapper and the bridge spec and
   require it on incoming messages. */
(function () {
  "use strict";
  var MARKER = "sourcemonkey-bridge";
  var REPLY_MARKER = "sourcemonkey-bridge-reply";
  var ALLOWED = ["sm:start", "sm:error", "sm:swapped", "sm:abandoned", "sm:check-pending"];
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) return;
  window.addEventListener("message", function (ev) {
    try {
      if (!ev || ev.source !== window) return;
      var data = ev.data;
      if (!data || data.__sm !== MARKER) return;
      var payload = data.payload;
      if (!payload || typeof payload !== "object") return;
      if (ALLOWED.indexOf(payload.type) === -1) return;
      if (payload.type === "sm:check-pending") {
        /* Request/reply path. The MAIN wrapper expects a postMessage
           back with the matching requestId. We always reply, even on
           SW failure, so the wrapper's awaiter resolves quickly
           rather than running out its 6s safety timeout. */
        var requestId = data.requestId;
        if (typeof requestId !== "string") return;
        var post = function (reply) {
          try {
            window.postMessage({ __sm: REPLY_MARKER, requestId: requestId, reply: reply || { action: "run" } }, "*");
          } catch (_e1) {}
        };
        try {
          var pr = chrome.runtime.sendMessage(payload);
          if (pr && typeof pr.then === "function") {
            pr.then(post, function () { post({ action: "run" }); });
          } else {
            post({ action: "run" });
          }
        } catch (_e2) { post({ action: "run" }); }
        return;
      }
      /* Fire-and-forget for the report types. */
      var p = chrome.runtime.sendMessage(payload);
      if (p && typeof p.catch === "function") p.catch(function () {});
    } catch (_e) {}
  }, true);
})();
