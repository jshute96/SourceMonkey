/* SourceMonkey USER_SCRIPT-world bridge.

   MAIN-world userscript wrappers can't call chrome.runtime.sendMessage
   (chrome.runtime is undefined in MAIN). To still get sm:* telemetry
   AND to let the reload-fast-path's sm:check-pending round-trip work
   from MAIN, the MAIN wrapper dispatches a DOM event; this bridge runs
   in USER_SCRIPT world on the same page, listens for it, and forwards
   the payload to the SW.

   Directions and their carriers. Every event but the two bare
   announcements is named with the channel key (SM_KEY, swapped in when
   this file is registered; see src/extension/channel.ts), so the page
   can neither send nor hear them:
     - page -> SW: a CustomEvent named "sourcemonkey-sync-<key>"
       dispatched on `document`, carrying {requestId, payload} as a
       JSON string in `detail` (objects don't cross realms). Event
       dispatch runs every world's listeners in the DISPATCHING task,
       so our chrome.runtime.sendMessage happens before the caller
       returns. That is why this direction is an event and not a
       postMessage: a document in `pagehide` never gets the later task
       a postMessage would be delivered on, so a GM_setValue() before
       `location.href = ...` used to lose the write. It also saves a
       task hop on sm:check-pending, which every MAIN-world script
       waits on at document_start.
     - SW -> page: a CustomEvent on `document` for each reply
       ("sourcemonkey-reply-<key>", {requestId, reply}) and push
       ("sourcemonkey-push-<key>", the message), JSON in `detail`. Not a
       postMessage, which the page can read.
     - bridge -> page, once: a bare "sourcemonkey-bridge-ready"
       CustomEvent on `window` when its listener is in (see Timing,
       below).

   The traffic it carries:
     - Fire-and-forget reports (sm:start / sm:error / sm:swapped /
       sm:abandoned), and the storage flush at teardown. The bridge
       calls chrome.runtime.sendMessage and silently swallows the
       returned promise.
     - Request/reply, used by sm:check-pending and by every GM_* call
       the MAIN-world copy of wrapper-gm-runtime.js makes. The sender
       attaches a requestId; the bridge forwards to the SW, awaits the
       reply, and sends it back as a REPLY_EVENT keyed on the same
       requestId. The sender's listener
       matches on requestId and resolves its awaiter. The presence of
       `requestId` — not the payload type — is what selects this path.
     - SW-originated pushes (the PUSHED and PUSHED_ANY_WORLD lists
       below: value updates, XHR / download / notification / tab
       events, menu fires). Those arrive on chrome.runtime.onMessage, which MAIN world
       can't listen on, so we re-send them into the page as a
       PUSH_EVENT for the MAIN runtime to dispatch.

   Build rules match userscript-prelude.js — only /* block * /
   comments, strings must not start a line with //, the build minifies
   to one physical line.

   Timing vs. MAIN-world preludes. The bridge is a separate
   chrome.userScripts registration from the per-script wrappers and
   the GM runtime; their relative injection order isn't guaranteed by
   the API, and the page -> SW direction is synchronous, so a request
   dispatched before this IIFE ran finds no listener. A sync that
   widens this spec's patterns re-registers it behind the wrappers, so
   this happens, and a `document-start` script on a first load runs
   (reporting its start, making GM_* calls) without waiting for
   anything. So:
     - we cancel every sync event we take (preventDefault), as a
       receipt the sender reads off dispatchEvent's return value;
     - the senders (userscript-prelude.js and the MAIN-world
       wrapper-gm-runtime.js) hold what nobody took;
     - our ready event (READY_MARKER) tells them to send it again.
   We still emit the bridge spec ahead of the wrapper specs (see
   buildBridgeSpec in injector.ts), so usually nothing is held.

   Trust model. The channel key keeps the page out: it can't send our
   events or hear them, since it doesn't know their names. What it can
   still do:
     - send the two bare announcements: READY_MARKER, which makes a
       waiting MAIN-world wrapper or GM runtime send what it holds (what
       is held is held because no bridge took it, so this sends nothing
       new), and MAIN_READY, which only keeps the sandboxed-page fallback
       off.
     - hook the built-ins our MAIN-world code touches after
       document_start (an `Object.prototype` getter, a `toJSON`), which
       a page that targets SourceMonkey specifically could use to see
       some of what passes. The MAIN-world side captures what it can at
       document_start (the event's `detail` getter, JSON, dispatch).
   It can't cancel our sync events either, to make a request look taken
   (the receipt, see Timing above), since it can't name them.
   We still check the payload type against a small allowlist per
   direction, and stamp every relayed message `__viaBridge:true` (see
   `stamp` below), set last so nothing can pre-set it false. The SW
   honors a `__viaBridge` script-scoped request (`sm:check-pending` with
   `needsValues:true`, any `sm:gm-*` call) only for a script that runs
   in MAIN world on the sending page and granted the API being
   exercised (`bridgeMayActAs` in background.ts): a backstop should the
   key ever leak. USER_SCRIPT-world scripts talk to the SW over their
   own direct chrome.runtime path (never this bridge), so they carry no
   `__viaBridge` and are never gated.

   Cross-frame relay isn't a concern on the request side: a DOM event on
   `document` only reaches listeners in that same document, so a frame
   can only ever reach the bridge instance injected into it, already
   scoped to the frame's own URL. */
(function () {
  "use strict";
  /* The channel key, swapped in when we register this file. */
  var SM_KEY = "__SM_KEY__";
  /* For a manual run's bridge, the run's script id, swapped in when the
     run is injected; else this stand-in. A run's bridge carries its
     document's own key (`documentKey` in src/extension/channel.ts),
     which its late-loaded page-world code may lose to the page, so it
     relays only that script's requests and pushes. */
  var SM_ONLY = "__SM_ONLY__";
  var ONLY = SM_ONLY === "_" + "_SM_ONLY__" ? null : SM_ONLY;
  /* Whether `id`, a message's script, is one this bridge relays: any,
     but for a manual run's bridge, only the run's. A message that
     names no script (an abort by request id) is let through. */
  function ours(id) {
    return ONLY === null || typeof id !== "string" || id === ONLY;
  }
  /* The script a page -> SW message is about: a GM call names it
     `scriptId` (its `id`, when it has one, is the call's own: an XHR's);
     the wrapper's reports and check-pending name it `id`. */
  function scriptOf(payload) {
    return payload.type.indexOf("sm:gm-") === 0 ? payload.scriptId : payload.id;
  }
  var REPLY_EVENT = "sourcemonkey-reply-" + SM_KEY;
  var PUSH_EVENT = "sourcemonkey-push-" + SM_KEY;
  /* The page -> SW path: see the header. Named "sync" for the property
     it is chosen for — our sendMessage runs inside the dispatch, before
     the caller returns. */
  var SYNC_EVENT = "sourcemonkey-sync-" + SM_KEY;
  /* Fired once our listener is in, for a wrapper that asked too early
     (see Timing, above). userscript-prelude.js names it too. */
  var READY_MARKER = "sourcemonkey-bridge-ready";
  /* GM_addStyle / GM_addElement's insert from MAIN world (`insertNode`
     in wrapper-gm-runtime.js). */
  var INSERT_EVENT = "sourcemonkey-insert-" + SM_KEY;
  /* A MAIN-world prelude saying our scripts run in this document (see
     the fallback at the end). userscript-prelude.js names it too. */
  var MAIN_READY = "sourcemonkey-main-ready";
  /* Payload types we relay page -> SW. Telemetry + the reload
     fast-path handshake, plus the SW-backed half of the GM_* surface
     that the MAIN-world runtime needs. Anything not listed is dropped,
     so a page can't reach message handlers we never meant to expose.

     Adding a message type anywhere on the page side means adding it
     here too. A missing entry is silent in the worst way: the call
     works in USER_SCRIPT world and hangs until its timeout in MAIN. */
  var ALLOWED = [
    "sm:start", "sm:error", "sm:swapped", "sm:abandoned", "sm:check-pending",
    "sm:focus",
    "sm:gm-batch-write",
    "sm:gm-xhr-start", "sm:gm-xhr-abort",
    "sm:gm-tab-open", "sm:gm-tab-close",
    "sm:gm-notification-show",
    "sm:gm-menu-register", "sm:gm-menu-unregister",
    "sm:gm-download-start", "sm:gm-download-abort",
    "sm:gm-window-close", "sm:gm-window-focus",
    "sm:gm-tab-data",
    "sm:gm-resync",
    "sm:gm-log", "sm:gm-dom-blocked",
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
    "sm:gm-value-update", "sm:gm-values-stale", "sm:gm-xhr-event", "sm:gm-tab-closed",
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
  /* Once per document and key. A manual script's run injects the
     bridge again (docs/manual-scripts.md), and a second copy would
     forward every message twice. A run carries its document's own key,
     not the install's (`documentKey` in src/extension/channel.ts), so
     its bridge installs beside a registered one, each on its own
     events. This world's globals are out of the page's reach, so the
     page can't set the flag to keep the bridge out. */
  var installed = "__smBridgeInstalled_" + SM_KEY;
  if (window[installed]) return;
  window[installed] = true;
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
  /* Forward one page-originated payload to the SW. A string
     `requestId` selects the request/reply path — the presence of the
     id, not the payload type, so both sm:check-pending and every GM_*
     call use it; anything else is fire-and-forget.

     We always reply, even on SW failure, so the awaiter settles
     quickly rather than running out its own timeout. A failure is
     `{bridgeError}`: the prelude's check-pending awaiter takes it as no
     decision (and so doesn't run), and GM_* callers treat any reply
     without `ok:true` as a failure, which is the right reading here.
     A payload that isn't on the allowlist gets no reply
     at all — it never reached the SW, and staying silent keeps a page
     from using the bridge as an "is this type relayed?" oracle. */
  function relay(payload, requestId) {
    if (!payload || typeof payload !== "object") return;
    if (ALLOWED.indexOf(payload.type) === -1) return;
    if (!ours(scriptOf(payload))) return;
    if (typeof requestId !== "string") {
      var p = chrome.runtime.sendMessage(stamp(payload));
      if (p && typeof p.catch === "function") p.catch(function () {});
      return;
    }
    var post = function (reply) {
      try {
        toPage(REPLY_EVENT, { requestId: requestId, reply: reply || { bridgeError: "SourceMonkey gave no answer" } });
      } catch (_e1) {}
    };
    var failed = function (err) {
      post({ bridgeError: "Asking SourceMonkey failed: " + ((err && err.message) || String(err)) });
    };
    try {
      var pr = chrome.runtime.sendMessage(stamp(payload));
      if (pr && typeof pr.then === "function") {
        pr.then(post, failed);
      } else {
        post(null);
      }
    } catch (_e2) { failed(_e2); }
  }

  /* Into MAIN world, as an event the page can't hear (see the header).
     Dispatched from this world, whose built-ins the page can't touch. */
  function toPage(type, data) {
    document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(data) }));
  }

  document.addEventListener(SYNC_EVENT, function (ev) {
    try {
      /* The receipt: the sender holds and resends what nobody cancelled
         (see Timing, above). Every event, whatever its type, so the
         receipt says only that the bridge is in, which READY_MARKER
         says anyway. */
      if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
      if (!ev || typeof ev.detail !== "string") return;
      var env = JSON.parse(ev.detail);
      if (!env || typeof env !== "object") return;
      relay(env.payload, env.requestId);
    } catch (_e) {}
  }, true);

  /* GM_addStyle / GM_addElement's insert, for a MAIN-world script.
     Appended from this world, the element is checked against this
     world's CSP instead of the page's, so a strict page CSP doesn't
     drop the style, as in TM. The event's target is the parent and its
     `relatedTarget` the new element; cancelling it tells the runtime
     we did the insert. This world's `appendChild` is out of the page's
     reach, and the event's name carries the channel key, so the page
     can't send it to get the same exemption for an element of its own.

     On `window`, capturing: the first stop of any dispatch in the
     document. */
  var appendChild = null;
  try { appendChild = Node.prototype.appendChild; } catch (_ne) {}
  if (appendChild) window.addEventListener(INSERT_EVENT, function (ev) {
    try {
      var el = ev.relatedTarget;
      /* Composed, so a parent in a shadow root reaches us too; the
         path's first entry is it, where `target` is its host. */
      var parent = ev.composedPath()[0];
      if (!(el instanceof Element) || !(parent instanceof Node)) return;
      appendChild.call(parent, el);
      ev.preventDefault();
      ev.stopImmediatePropagation();
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
            if (!ours(msg.smScript)) return;
          }
          toPage(PUSH_EVENT, msg);
        } catch (_e3) {}
      });
    }
  } catch (_e4) {}
  /* Announce that requests are heard now. A MAIN-world wrapper or GM
     runtime injected before this bridge holds what it sent into
     nothing, and sends it again on this. A page can fire it too, which
     sends nothing new: what is held is held because no bridge took it,
     and stays held while there is none. */
  var mainSeen = false;
  try { window.addEventListener(MAIN_READY, function () { mainSeen = true; }, true); } catch (_e6) {}
  try { window.dispatchEvent(new CustomEvent(READY_MARKER)); } catch (_e5) {}

  /* Fallback for a sandboxed page. A CSP `sandbox` directive (or an
     `<iframe sandbox>`) without `allow-scripts` turns off script in the
     document's own world, and with it every MAIN-world script: Chrome
     injects none there, while this world still runs. So where no
     MAIN-world prelude announces itself (MAIN_READY, now or in answer
     to our ready event above), we ask the SW to run this document's
     MAIN-world scripts here instead, as Violentmonkey falls back to its
     content world.

     - The check waits one task: every document_start registration is
       in by then, so a prelude injected after us has announced too.
     - No announcement also happens on ordinary pages: when Chrome
       hasn't registered a script yet (a sync in progress), and where
       our patterns match but no MAIN-world script runs (a frame where
       all are @noframes, a page one @excludes). The SW finds the
       scripts first, then runs a bare `true` in this document's own
       world (`pageWorldRuns`), and falls back only if it doesn't run.
     - The page can send MAIN_READY too, which only keeps the fallback
       off.
     - A child frame doesn't ask when every MAIN-world script is
       `@noframes`, so a page full of iframes doesn't wake the SW for
       each. */
  /* False when every MAIN-world script is `@noframes` (swapped in at
     registration, `noMainInFrames` in src/extension/injector.ts): in a
     child frame none would run, so there is nothing to ask about. */
  var SM_MAIN_IN_FRAMES = true;
  var mainCanRun = SM_MAIN_IN_FRAMES || window === window.top;
  if (!mainSeen && mainCanRun) {
    setTimeout(function () {
      if (mainSeen) return;
      try {
        var p = chrome.runtime.sendMessage({ type: "sm:main-blocked" });
        if (p && typeof p.catch === "function") p.catch(function () {});
      } catch (_e8) {}
    }, 0);
  }
})();
