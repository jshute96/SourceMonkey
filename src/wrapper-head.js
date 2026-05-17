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
     "__VM_MATCHER_BLOCK__" — empty, OR the matcher fragment (which
                              itself contains a "__VM_MATCHING__"
                              placeholder for the matching object). */
(function () {
  "use strict";
  var __vmName = "__VM_NAME__";
  var __vmId = "__VM_ID__";
  var __vmSend = function (payload) {
    try {
      var p = chrome.runtime.sendMessage(payload);
      if (p && typeof p.catch === "function") p.catch(function () {});
    } catch (_e) {}
  };
  "__VM_MATCHER_BLOCK__";
  try { console.log("[VibeMonkey] script", __vmName, "running on", location.href); } catch (_e) {}
  __vmSend({ type: "vm:start", id: __vmId, url: location.href });
  try {
