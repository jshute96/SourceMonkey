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

   Build rules match userscript-prelude.js — only /* block * /
   comments, strings must not start a line with //, the build minifies
   to one physical line.

   Timing vs. MAIN-world preludes. The bridge is a separate
   chrome.userScripts registration from the per-script wrappers;
   their relative injection order isn't guaranteed by the API. The
   MAIN-world prelude's first sm:check-pending posts via
   window.postMessage, which queues to the message task queue —
   delivery happens in a later task. By then the bridge IIFE (also
   document_start) has had time to install its addEventListener. If
   ordering ever shifts, the bridge falls back to "reply with
   {action: run}" via the prelude's own 2s safety timer; nothing
   breaks, scripts just don't get the reload fast-path swap on
   that one navigation.

   Trust model. postMessage is observable by the page, so the page
   can both read our sm:* events and forge them. We require
   event.source === window (no cross-frame relay), data.__sm ===
   MARKER, and a small allowlist of payload types. That's enough to
   keep cross-origin frames out; it does NOT stop the host page from
   sending fakes. Active attacks the page can mount once the bridge
   is in place:
     - forge `sm:start` to flip a script's badge from MISSING to OK,
     - forge `sm:error` with an attacker-chosen `message`, which the
       SW logs via console.info (kept out of chrome://extensions/?errors),
     - drive a small amount of chrome.storage.session write
       amplification per fake report,
     - forge a `sourcemonkey-bridge-reply` with a known requestId to
       hand a MAIN wrapper an attacker-supplied body to eval. The
       page already runs arbitrary code in MAIN world, so this is no
       privilege gain — the cost is attribution (errors blamed on our
       script's sourceURL) and a one-navigation delay for the real
       update.
     - forge `sm:focus`, making the SW re-check this tab's local
       scripts for edits. Bounded by the updater's own 10s-per-script
       interval, reads nothing back to the page, and does the same work
       a navigation on the tab already does.
     - forge `sm:check-pending` with `needsValues:true` and another
       script's `id`. The SW would otherwise attach that script's
       GM_setValue snapshot (`gmValues`) to the reply, which the bridge
       posts back where the page can read it. THIS read leak is closed:
       every message the bridge forwards is stamped `__viaBridge:true`
       (see `stamp` below), and the SW refuses to attach `gmValues` to
       any `__viaBridge` request (see the check-pending handler in
       background.ts). The stamp is trustworthy because the page CANNOT
       call chrome.runtime.sendMessage itself (no chrome.runtime in
       MAIN world), so the only way a page-influenced message reaches
       the SW is through here — and we set the marker last, ignoring any
       page-supplied copy. Legitimate value reads come from USER_SCRIPT-
       world scripts over their own direct chrome.runtime path (never
       this bridge), so they carry no `__viaBridge` and are unaffected.
   None grant script execution or SW privilege beyond what the page
   already has. */
(function () {
  "use strict";
  var MARKER = "sourcemonkey-bridge";
  var REPLY_MARKER = "sourcemonkey-bridge-reply";
  var ALLOWED = ["sm:start", "sm:error", "sm:swapped", "sm:abandoned", "sm:check-pending", "sm:focus"];
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) return;
  /* Copy the page-supplied payload and stamp __viaBridge:true LAST so
     the page can't pre-set it false. The SW treats __viaBridge as
     "this request may be page-forged" and withholds another script's
     gmValues snapshot from the reply. See the file header. We skip
     __proto__ so a page-supplied key can't retarget fwd's prototype
     during the copy. */
  function stamp(payload) {
    var fwd = {};
    for (var k in payload) {
      if (k === "__viaBridge" || k === "__proto__") continue;
      if (Object.prototype.hasOwnProperty.call(payload, k)) fwd[k] = payload[k];
    }
    fwd.__viaBridge = true;
    return fwd;
  }
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
           rather than running out its 2s safety timeout. */
        var requestId = data.requestId;
        if (typeof requestId !== "string") return;
        var post = function (reply) {
          try {
            window.postMessage({ __sm: REPLY_MARKER, requestId: requestId, reply: reply || { action: "run" } }, "*");
          } catch (_e1) {}
        };
        try {
          var pr = chrome.runtime.sendMessage(stamp(payload));
          if (pr && typeof pr.then === "function") {
            pr.then(post, function () { post({ action: "run" }); });
          } else {
            post({ action: "run" });
          }
        } catch (_e2) { post({ action: "run" }); }
        return;
      }
      /* Fire-and-forget for the report types. */
      var p = chrome.runtime.sendMessage(stamp(payload));
      if (p && typeof p.catch === "function") p.catch(function () {});
    } catch (_e) {}
  }, true);
})();
