/* VibeMonkey injected wrapper — head fragment. Concatenated with the
   user script body and the tail at registration time.

   IMPORTANT: scripts/build.mjs collapses this file to a single line so
   it can be placed before the body without shifting line numbers in
   stack traces. Only /* block * / comments are allowed in here, and
   strings must not contain "//" sequences. The build's minifier is
   intentionally simple — it strips block comments, drops lines that
   start with //, then collapses all whitespace runs to single spaces.

   Placeholders the injector substitutes at registration time:
     "__VM_NAME__"          — JSON-encoded script @name
     "__VM_ID__"            — JSON-encoded stored script UUID
     "__VM_SOURCE_URL__"    — JSON-encoded sourceURL string that the
                              injector also appends to the body as a
                              `# sourceURL=` directive. Used as the
                              attribution marker by the window error
                              listeners below.
     "__VM_MATCHER_BLOCK__" — empty, OR the matcher fragment (which
                              itself contains a "__VM_MATCHING__"
                              placeholder for the matching object). */
(function () {
  "use strict";
  var __vmName = "__VM_NAME__";
  var __vmId = "__VM_ID__";
  var __vmSourceUrl = "__VM_SOURCE_URL__";
  /* Telemetry transport. In USER_SCRIPT world chrome.runtime.sendMessage
     is exposed (configureWorld({ messaging: true }) was called by the
     injector), so we use it directly. In MAIN world chrome.runtime is
     undefined — we fall back to window.postMessage with the
     "vibemonkey-bridge" marker. A separate USER_SCRIPT-world bridge
     (see wrapper-bridge.js) listens for those and forwards to the SW.
     postMessage is observable by the page; the activation console.log
     already leaks the script name so this isn't a wider info surface. */
  var __vmSend = function (payload) {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
        var p = chrome.runtime.sendMessage(payload);
        if (p && typeof p.catch === "function") p.catch(function () {});
        return;
      }
    } catch (_e) {}
    try {
      window.postMessage({ __vm: "vibemonkey-bridge", payload: payload }, "*");
    } catch (_e2) {}
  };
  "__VM_MATCHER_BLOCK__";
  /* Async-error attribution. Errors thrown synchronously from the body
     are caught by the try/catch in wrapper-tail.js. Anything thrown
     later — from setTimeout, addEventListener callbacks, fetch().then,
     etc. — escapes that catch and surfaces on the page as a window
     "error" or "unhandledrejection" event.

     We install our own listeners, filtered by __vmSourceUrl. The
     injector appends "# sourceURL=<__vmSourceUrl>" to the body, so
     stack frames originating in this script's code reference that URL.
     Listeners check event.filename / event.error.stack / reason.stack
     for the marker and only report on a match — page errors and
     errors from other userscripts are ignored.

     In MAIN world we share `window` with the page and with other
     MAIN-world scripts; the sourceURL filter is what keeps attribution
     honest. The WeakSet de-dupes in case the same error object reaches
     both "error" and a wrapping page handler. */
  var __vmReported = (typeof WeakSet === "function") ? new WeakSet() : null;
  var __vmStackHasUs = function (err) {
    try {
      var stack = err && typeof err === "object" && err.stack;
      if (typeof stack === "string" && stack.indexOf(__vmSourceUrl) !== -1) return true;
    } catch (_e) {}
    return false;
  };
  var __vmReportAsync = function (err, kind) {
    try {
      if (err && typeof err === "object" && __vmReported) {
        if (__vmReported.has(err)) return;
        __vmReported.add(err);
      }
    } catch (_e) {}
    var msg;
    try { msg = (err && err.message) ? String(err.message) : String(err); }
    catch (_e2) { msg = "(unstringifiable error)"; }
    /* Native browser logging already prints the error + stack (the
       sourceURL we appended makes the source identifiable). Avoid
       duplicating that — just note the attribution at info level so
       it's clear which VibeMonkey script is being blamed. */
    try { console.info("[VibeMonkey] caught async " + kind + " in", __vmName); } catch (_e3) {}
    __vmSend({ type: "vm:error", id: __vmId, name: __vmName, url: location.href, message: msg });
  };
  try {
    window.addEventListener("error", function (ev) {
      if (!ev) return;
      var hit = false;
      try {
        if (typeof ev.filename === "string" && ev.filename.indexOf(__vmSourceUrl) !== -1) hit = true;
      } catch (_e) {}
      if (!hit && __vmStackHasUs(ev.error)) hit = true;
      if (hit) __vmReportAsync(ev.error || ev.message || "error", "error");
    }, true);
    window.addEventListener("unhandledrejection", function (ev) {
      if (ev && __vmStackHasUs(ev.reason)) __vmReportAsync(ev.reason, "unhandledrejection");
    }, true);
  } catch (_e) {}
  try { console.log("[VibeMonkey] script", __vmName, "running on", location.href); } catch (_e) {}
  __vmSend({ type: "vm:start", id: __vmId, name: __vmName, url: location.href });
  try {
