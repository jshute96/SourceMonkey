/* VibeMonkey USER_SCRIPT-world bridge.

   MAIN-world userscript wrappers can't call chrome.runtime.sendMessage
   (chrome.runtime is undefined in MAIN). To still get vm:start /
   vm:error telemetry from those scripts, the MAIN wrapper falls back
   to window.postMessage; this bridge runs in USER_SCRIPT world on the
   same page, listens for those messages, and forwards them to the SW.

   Build rules match wrapper-head.js — only /* block * / comments,
   strings must not start a line with //, the build minifies to one
   physical line.

   Trust model. postMessage is observable by the page, so the page
   can both read our vm:* events and forge them. We require
   event.source === window (no cross-frame relay), data.__vm ===
   MARKER, and a small allowlist of payload types. That's enough to
   keep cross-origin frames out; it does NOT stop the host page from
   sending fakes. Active attacks the page can mount once the bridge
   is in place:
     - forge `vm:start` to flip a script's badge from MISSING to OK,
     - forge `vm:error` with an attacker-chosen `message`, which the
       SW logs via console.error,
     - drive a small amount of chrome.storage.session write
       amplification per fake report.
   None grant script execution or SW privilege. If we ever need a
   real boundary, inject a per-document nonce shared between the
   MAIN wrapper and the bridge spec and require it on incoming
   messages. */
(function () {
  "use strict";
  var MARKER = "vibemonkey-bridge";
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) return;
  window.addEventListener("message", function (ev) {
    try {
      if (!ev || ev.source !== window) return;
      var data = ev.data;
      if (!data || data.__vm !== MARKER) return;
      var payload = data.payload;
      if (!payload || typeof payload !== "object") return;
      if (payload.type !== "vm:start" && payload.type !== "vm:error") return;
      var p = chrome.runtime.sendMessage(payload);
      if (p && typeof p.catch === "function") p.catch(function () {});
    } catch (_e) {}
  }, true);
})();
