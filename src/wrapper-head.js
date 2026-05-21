/* SourceMonkey injected wrapper — head fragment. Concatenated with the
   user script body and the tail at registration time.

   IMPORTANT: scripts/build.mjs collapses this file to a single line so
   it can be placed before the body without shifting line numbers in
   stack traces. Only /* block * / comments are allowed in here, and
   strings must not contain "//" sequences. The build's minifier is
   intentionally simple — it strips block comments, drops lines that
   start with //, then collapses all whitespace runs to single spaces.

   Placeholders the injector substitutes at registration time:
     "__SM_NAME__"          — JSON-encoded script @name
     "__SM_ID__"            — JSON-encoded stored script UUID
     "__SM_LOADED_AT__"     — StoredScript.loadedAt at registration,
                              echoed in sm:start so the SW can detect
                              wrappers running outdated content.
     "__SM_SOURCE_URL__"    — JSON-encoded sourceURL string that the
                              injector also appends to the body as a
                              `# sourceURL=` directive. Used as the
                              attribution marker by the window error
                              listeners below.
     "__SM_MATCHER_BLOCK__" — empty, OR the matcher fragment (which
                              itself contains a "__SM_MATCHING__"
                              placeholder for the matching object).

   Structure. The wrapper opens an outer IIFE, sets up shared helpers
   ( __smSend, async error attribution, the optional matcher), then
   calls __smAwaitDecision which round-trips a sm:check-pending message
   to the SW. The decision callback chooses one of three paths:
     - 'skip'    — SW says don't run anything (file gone / disabled).
                   Wrapper exits after sending sm:abandoned.
     - 'run-new' — SW shipped a fresher user-code body. Wrapper sends
                   sm:swapped, then evals the new body inside the
                   existing wrapper helpers (same __smSourceUrl, so
                   async error attribution still works).
     - 'run'     — default. The baked-in body that lives between this
                   file and wrapper-tail.js runs as before.
   For the common case (no reload-fast-path active) the SW replies
   {action:"run"} immediately, so the await resolves in a microtask
   and the baked-in body executes promptly. */
(function () {
  "use strict";
  var __smName = "__SM_NAME__";
  var __smId = "__SM_ID__";
  var __smLoadedAt = "__SM_LOADED_AT__";
  var __smSourceUrl = "__SM_SOURCE_URL__";
  /* Telemetry transport. In USER_SCRIPT world chrome.runtime.sendMessage
     is exposed (configureWorld({ messaging: true }) was called by the
     injector), so we use it directly. In MAIN world chrome.runtime is
     undefined — we fall back to window.postMessage with the
     "sourcemonkey-bridge" marker. A separate USER_SCRIPT-world bridge
     (see wrapper-bridge.js) listens for those and forwards to the SW.
     postMessage is observable by the page; the activation console.log
     already leaks the script name so this isn't a wider info surface. */
  var __smSend = function (payload) {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
        var p = chrome.runtime.sendMessage(payload);
        if (p && typeof p.catch === "function") p.catch(function () {});
        return;
      }
    } catch (_e) {}
    try {
      window.postMessage({ __sm: "sourcemonkey-bridge", payload: payload }, "*");
    } catch (_e2) {}
  };
  /* Round-trip sm:check-pending and hand the SW's decision (or a safety
     timeout / fallback) to cb. Two transports:
       - USER_SCRIPT world: direct chrome.runtime.sendMessage with the
         returned-promise reply.
       - MAIN world: chrome.runtime is undefined, so we postMessage a
         request to wrapper-bridge.js (which runs in USER_SCRIPT world)
         tagged with a fresh requestId, and await a matching
         "sourcemonkey-bridge-reply" postMessage back from the bridge.
     The SW guards to reply quickly ( <1ms ) for the non-reload-fast-
     path case, so the await is effectively free outside reloads. */
  var __smAwaitDecision = function (cb) {
    var done = false;
    var finish = function (decision) {
      if (done) return;
      done = true;
      try { cb(decision); } catch (_e) {}
    };
    /* cleanup is reassigned to a listener-removal closure on the MAIN
       branch; the USER_SCRIPT branch never installs one so the no-op
       suffices. seal handles BOTH transports: clear timer, remove
       listener if any, then finish. The safety timer also routes
       through seal so it doesn't leak the bridge listener. */
    var cleanup = function () {};
    var safetyTimer = setTimeout(function () { seal({ action: "run" }); }, 6000);
    var seal = function (decision) {
      try { clearTimeout(safetyTimer); } catch (_e) {}
      try { cleanup(); } catch (_e2) {}
      finish(decision);
    };
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
        var p = chrome.runtime.sendMessage({
          type: "sm:check-pending",
          id: __smId,
          name: __smName,
          loadedAt: __smLoadedAt,
          url: location.href
        });
        if (p && typeof p.then === "function") {
          p.then(
            function (reply) { seal(reply && typeof reply === "object" ? reply : { action: "run" }); },
            function () { seal({ action: "run" }); }
          );
        } else {
          seal({ action: "run" });
        }
        return;
      }
      /* MAIN world: bridge request/reply protocol. The requestId nonce
         scopes the reply to THIS wrapper so concurrent userscripts
         each get their own. ev.source === window keeps cross-frame
         postMessages out. */
      var requestId = "sm-" + Math.random().toString(36).slice(2) + "-" + Date.now();
      var listener = function (ev) {
        try {
          if (!ev || ev.source !== window) return;
          var d = ev.data;
          if (!d || d.__sm !== "sourcemonkey-bridge-reply") return;
          if (d.requestId !== requestId) return;
          seal(d.reply && typeof d.reply === "object" ? d.reply : { action: "run" });
        } catch (_e) {}
      };
      window.addEventListener("message", listener, true);
      cleanup = function () { try { window.removeEventListener("message", listener, true); } catch (_e) {} };
      window.postMessage({
        __sm: "sourcemonkey-bridge",
        requestId: requestId,
        payload: {
          type: "sm:check-pending",
          id: __smId,
          name: __smName,
          loadedAt: __smLoadedAt,
          url: location.href
        }
      }, "*");
    } catch (_e3) { seal({ action: "run" }); }
  };
  /* Async-error attribution. Errors thrown synchronously from the body
     are caught by the try/catch in wrapper-tail.js. Anything thrown
     later — from setTimeout, addEventListener callbacks, fetch().then,
     etc. — escapes that catch and surfaces on the page as a window
     "error" or "unhandledrejection" event.

     We install our own listeners, filtered by __smSourceUrl. The
     injector appends "# sourceURL=<__smSourceUrl>" to the body, so
     stack frames originating in this script's code reference that URL.
     Listeners check event.filename / event.error.stack / reason.stack
     for the marker and only report on a match — page errors and
     errors from other userscripts are ignored.

     In MAIN world we share `window` with the page and with other
     MAIN-world scripts; the sourceURL filter is what keeps attribution
     honest. The WeakSet de-dupes in case the same error object reaches
     both "error" and a wrapping page handler. */
  var __smReported = (typeof WeakSet === "function") ? new WeakSet() : null;
  var __smStackHasUs = function (err) {
    try {
      var stack = err && typeof err === "object" && err.stack;
      if (typeof stack === "string" && stack.indexOf(__smSourceUrl) !== -1) return true;
    } catch (_e) {}
    return false;
  };
  var __smReportAsync = function (err, kind, runtimeLoadedAt) {
    try {
      if (err && typeof err === "object" && __smReported) {
        if (__smReported.has(err)) return;
        __smReported.add(err);
      }
    } catch (_e) {}
    var msg;
    try { msg = (err && err.message) ? String(err.message) : String(err); }
    catch (_e2) { msg = "(unstringifiable error)"; }
    var stack = "";
    try { if (err && typeof err.stack === "string") stack = err.stack; } catch (_e4) {}
    /* Native browser logging already prints the error + stack (the
       sourceURL we appended makes the source identifiable). Avoid
       duplicating that — just note the attribution at info level so
       it's clear which SourceMonkey script is being blamed. */
    try { console.info("[SourceMonkey] caught async " + kind + " in", __smName); } catch (_e3) {}
    __smSend({ type: "sm:error", id: __smId, name: __smName, loadedAt: runtimeLoadedAt, url: location.href, message: msg, stack: stack });
  };
  var __smInstallAsyncListeners = function (runtimeLoadedAt) {
    try {
      window.addEventListener("error", function (ev) {
        if (!ev) return;
        var hit = false;
        try {
          if (typeof ev.filename === "string" && ev.filename.indexOf(__smSourceUrl) !== -1) hit = true;
        } catch (_e) {}
        if (!hit && __smStackHasUs(ev.error)) hit = true;
        if (hit) __smReportAsync(ev.error || ev.message || "error", "error", runtimeLoadedAt);
      }, true);
      window.addEventListener("unhandledrejection", function (ev) {
        if (ev && __smStackHasUs(ev.reason)) __smReportAsync(ev.reason, "unhandledrejection", runtimeLoadedAt);
      }, true);
    } catch (_e) {}
  };
  /* The matcher block (when present) checks the current URL against the
     full Tampermonkey @match / @include / @exclude semantics — including
     /regex/ forms the User Scripts API can't express — and `return`s
     out of the outer IIFE on a miss. Runs BEFORE __smAwaitDecision so
     non-matching pages don't bother the SW with a check-in. */
  "__SM_MATCHER_BLOCK__";
  __smAwaitDecision(function (__smDecision) {
    if (__smDecision && __smDecision.action === "skip") {
      /* SW concluded we shouldn't run on this navigation (file removed,
         script disabled mid-refresh, etc.). Tell it explicitly so the
         badge can mark the row instead of waiting for an absent
         sm:start. No body, no listeners, no try/catch. */
      __smSend({ type: "sm:abandoned", id: __smId, name: __smName, loadedAt: __smLoadedAt, url: location.href, reason: (__smDecision && __smDecision.reason) || "skip" });
      return;
    }
    if (__smDecision && __smDecision.action === "run-new" && typeof __smDecision.body === "string") {
      /* SW handed us a fresher user-code body. Try to eval it.

         CSP caveat: MAIN-world wrappers run subject to the page's CSP.
         A page that omits 'unsafe-eval' (GitHub, Google, many strict
         apps) blocks our eval BEFORE the body parses, so we can detect
         that case and fall through to the baked-in body — the user
         sees the prior version this reload, which is exactly the
         pre-fast-path behavior. USER_SCRIPT world has its own CSP
         (configureWorld in injector.ts allows unsafe-eval) so this
         fallback typically only triggers in MAIN.

         Distinguishing "CSP refused to start the eval" from "eval
         started, body ran, body threw" matters because the latter has
         already produced side effects — falling back to the baked-in
         body would double-run. The CSP block throws an EvalError-ish
         with a marker message; we string-match for it. */
      var __smNewLoadedAt = typeof __smDecision.loadedAt === "number" ? __smDecision.loadedAt : __smLoadedAt;
      var __smEvalRefused = false;
      var __smEvalErr = null;
      try {
        /* Tag the new body's stack frames with the same sourceURL the
           listeners are filtering on, so errors thrown from the new
           code still attribute back to this script. Direct eval (not
           the indirect `(0, eval)` form) so the body runs in the
           wrapper's strict-mode scope rather than at global scope —
           that keeps var/function declarations local to the eval,
           matching the baked-body case where they're scoped to this
           callback function instead of polluting window. */
        eval(__smDecision.body + "\n//# sourceURL=" + __smSourceUrl);
      } catch (__smEx) {
        __smEvalErr = __smEx;
        var __smExMsg = (__smEx && __smEx.message) ? String(__smEx.message) : String(__smEx);
        if (__smExMsg.indexOf("unsafe-eval") !== -1 || __smExMsg.indexOf("Content Security Policy") !== -1) {
          __smEvalRefused = true;
        }
      }
      if (__smEvalRefused) {
        /* CSP block. Fall through to the default-run branch below so
           the baked-in body still executes — same behavior as before
           the fast-path existed for this navigation. */
        try { console.info("[SourceMonkey] swap blocked by page CSP for", __smName, "— running prior version"); } catch (_e0) {}
      } else {
        /* eval executed (whether or not the body threw at runtime).
           Send the swap report so the SW updates the badge to the new
           loadedAt; install async error listeners for any future
           attributed errors from the new code; report the runtime
           throw (if any) as sm:error. */
        __smInstallAsyncListeners(__smNewLoadedAt);
        try { console.log("[SourceMonkey] script", __smName, "running on", location.href, "(swapped to newer version)"); } catch (_e) {}
        __smSend({ type: "sm:swapped", id: __smId, name: __smName, fromLoadedAt: __smLoadedAt, loadedAt: __smNewLoadedAt, url: location.href });
        if (__smEvalErr) {
          var __smNewMsg = (__smEvalErr && __smEvalErr.message) ? __smEvalErr.message : String(__smEvalErr);
          var __smNewStack = (__smEvalErr && typeof __smEvalErr.stack === "string") ? __smEvalErr.stack : "";
          try { console.error("[SourceMonkey] swapped script", __smName, "threw:", __smEvalErr); } catch (_e2) {}
          __smSend({ type: "sm:error", id: __smId, name: __smName, loadedAt: __smNewLoadedAt, url: location.href, message: __smNewMsg, stack: __smNewStack });
        }
        return;
      }
    }
    /* Default path: run the baked-in body. Identical to the pre-fast-
       path behavior — listeners + sm:start + try { body } catch. */
    __smInstallAsyncListeners(__smLoadedAt);
    try { console.log("[SourceMonkey] script", __smName, "running on", location.href); } catch (_e) {}
    __smSend({ type: "sm:start", id: __smId, name: __smName, loadedAt: __smLoadedAt, url: location.href });
    try {
