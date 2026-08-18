/* SourceMonkey USER_SCRIPT-world bridge.

   MAIN-world userscript wrappers can't call chrome.runtime.sendMessage
   (chrome.runtime is undefined in MAIN). To still get sm:* telemetry
   AND to let the reload-fast-path's sm:check-pending round-trip work
   from MAIN, the MAIN wrapper falls back to window.postMessage; this
   bridge runs in USER_SCRIPT world on the same page, listens for
   those messages, and forwards them to the SW.

   Three flavors of traffic:
     - Fire-and-forget reports (sm:start / sm:error / sm:swapped /
       sm:abandoned). The bridge calls chrome.runtime.sendMessage and
       silently swallows the returned promise.
     - Request/reply, used by sm:check-pending and by every GM_* call
       the MAIN-world copy of wrapper-gm-runtime.js makes. The sender
       attaches a requestId; the bridge forwards to the SW, awaits the
       reply, and posts it back as a "sourcemonkey-bridge-reply"
       message keyed on the same requestId. The sender's listener
       matches on requestId and resolves its awaiter. The presence of
       `requestId` — not the payload type — is what selects this path.
     - SW-originated pushes (sm:gm-value-update, sm:gm-xhr-event,
       sm:gm-tab-closed, sm:gm-notification-event, sm:gm-menu-fire).
       Those arrive on chrome.runtime.onMessage, which MAIN world
       can't listen on, so we re-post them into the page as
       "sourcemonkey-bridge-push" for the MAIN runtime to dispatch.

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
     - forge a script-scoped request (`sm:check-pending` with
       `needsValues:true`, or any `sm:gm-*` call) carrying another
       script's id, to read that script's GM_setValue snapshot back out
       of the reply or to act as it. This is bounded, not open: every
       message the bridge forwards is stamped `__viaBridge:true` (see
       `stamp` below), and the SW honors a `__viaBridge` script-scoped
       request ONLY for a script that runs in MAIN world on the sending
       page (see `bridgeMayActAs` in background.ts). Such a script's
       GM surface is reachable from the page anyway — its
       `window.__SM_GM__` is a global in the page's own realm — so the
       gate hands out nothing the page couldn't already take, while
       still refusing every USER_SCRIPT-world script and every
       MAIN-world script that doesn't match this page.
       The stamp is trustworthy because the page CANNOT call
       chrome.runtime.sendMessage itself (no chrome.runtime in MAIN
       world), so the only way a page-influenced message reaches the SW
       is through here — and we set the marker last, ignoring any
       page-supplied copy. USER_SCRIPT-world scripts talk to the SW over
       their own direct chrome.runtime path (never this bridge), so they
       carry no `__viaBridge` and are never gated.
     - forge a `sourcemonkey-bridge-push` into MAIN world, faking an
       XHR load / menu fire / value update for a MAIN-world script.
       Same footing: the page shares the realm with that script and can
       already call its callbacks directly.
   None grant script execution or SW privilege beyond what the page
   already has. */
(function () {
  "use strict";
  var MARKER = "sourcemonkey-bridge";
  var REPLY_MARKER = "sourcemonkey-bridge-reply";
  var PUSH_MARKER = "sourcemonkey-bridge-push";
  /* Payload types we relay page -> SW. Telemetry + the reload
     fast-path handshake, plus the SW-backed half of the GM_* surface
     that the MAIN-world runtime needs. Anything not listed is dropped,
     so a page can't reach message handlers we never meant to expose.

     Adding a message type anywhere on the page side means adding it
     here too. A missing entry is silent in the worst way: the call
     works in USER_SCRIPT world and hangs until its timeout in MAIN. */
  var ALLOWED = [
    "sm:start", "sm:error", "sm:swapped", "sm:abandoned", "sm:check-pending",
    "sm:gm-batch-write",
    "sm:gm-xhr-start", "sm:gm-xhr-abort",
    "sm:gm-tab-open", "sm:gm-tab-close",
    "sm:gm-notification-show",
    "sm:gm-menu-register", "sm:gm-menu-unregister",
    "sm:gm-download-start", "sm:gm-download-abort",
    "sm:gm-window-close", "sm:gm-window-focus",
    "sm:gm-resync",
    "sm:gm-log",
    /* Generic envelope for async APIs that have no dedicated body yet
       (the fall-through in gm-bindings.ts). Unreachable today — every
       async catalog entry has its own message type — and listed so the
       first one that isn't doesn't debug this from scratch. */
    "sm:gm-call"
  ];
  /* Message types we relay SW -> page. These are pushes the SW sends
     unprompted via chrome.tabs.sendMessage; MAIN world has no
     chrome.runtime to receive them on. */
  var PUSHED = [
    "sm:gm-value-update", "sm:gm-xhr-event", "sm:gm-tab-closed",
    "sm:gm-notification-event", "sm:gm-menu-fire",
    "sm:gm-download-event"
  ];
  /* Pushes that carry nothing script-scoped, so there is no reply to
     address and no `smWorld` to gate on. `sm:gm-resync-hint` is a bare
     "ask again" nudge; `sm:url-change` carries only the URL of the very
     document we would be posting into. Relaying these unconditionally
     leaks nothing the page doesn't already have. */
  var PUSHED_ANY_WORLD = ["sm:gm-resync-hint", "sm:url-change"];
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) return;
  /* Copy the page-supplied payload and stamp __viaBridge:true LAST so
     the page can't pre-set it false. The SW treats __viaBridge as
     "this request may be page-forged" and refuses to act on behalf of
     any script that isn't a MAIN-world script running on the sending
     page. See the file header. We skip __proto__ so a page-supplied
     key can't retarget fwd's prototype during the copy. */
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
      var requestId = data.requestId;
      if (typeof requestId === "string") {
        /* Request/reply path — selected by the presence of a
           requestId, so both sm:check-pending and every GM_* call use
           it. The sender expects a postMessage back with the matching
           requestId. We always reply, even on SW failure, so the
           awaiter resolves quickly rather than running out its own
           timeout. The fallback reply is `{action:"run"}` because the
           only caller that acts on the reply's SHAPE is the prelude's
           check-pending awaiter; GM_* callers treat any reply without
           `ok:true` as a failure, which is the right reading here. */
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

  /* SW -> MAIN relay. The SW pushes GM_* events (an XHR settling, a
     cross-tab value update, a menu entry being picked) with
     chrome.tabs.sendMessage, which only USER_SCRIPT world can receive.
     Re-post them into the page so the MAIN-world copy of
     wrapper-gm-runtime.js can dispatch to the userscript's callbacks.

     `smWorld === "MAIN"` is load-bearing, not a hint. Re-posting makes
     the payload readable by the page, and these payloads carry real
     data: a script's stored values on sm:gm-value-update, a
     cross-origin response body on sm:gm-xhr-event. The SW stamps every
     push with the world of the script it's addressed to (`pushWorld`
     in background.ts) precisely so an isolated script's data never
     crosses over just because some unrelated MAIN-world script also
     runs on this page. Unknown ids are stamped USER_SCRIPT, so we fail
     closed.

     Sender filter matches the runtime's own: our extension id, and no
     sender.tab (i.e. it came from the SW, not from another tab's
     content). Type allowlist keeps unrelated internal traffic — the
     sources page's own messages, say — out of the page. */
  var _extensionId = null;
  try { _extensionId = chrome.runtime.id; } catch (_idE) {}
  try {
    if (chrome.runtime.onMessage && typeof chrome.runtime.onMessage.addListener === "function") {
      chrome.runtime.onMessage.addListener(function (msg, sender /*, sendResponse */) {
        try {
          if (!sender || sender.id !== _extensionId || sender.tab) return;
          if (!msg || typeof msg !== "object") return;
          if (PUSHED_ANY_WORLD.indexOf(msg.type) === -1) {
            if (PUSHED.indexOf(msg.type) === -1) return;
            if (msg.smWorld !== "MAIN") return;
          }
          window.postMessage({ __sm: PUSH_MARKER, payload: msg }, "*");
        } catch (_e3) {}
      });
    }
  } catch (_e4) {}
})();
