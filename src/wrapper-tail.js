/* VibeMonkey injected wrapper — tail fragment. See wrapper-head.js for
   the build / placeholder conventions.

   The two closing braces match the inner `try {` opened just before
   the body and the outer `function (__vmDecision) {` callback opened
   by __vmAwaitDecision in the head. */
    } catch (__vmErr) {
      var __vmMsg = (__vmErr && __vmErr.message) ? __vmErr.message : String(__vmErr);
      try { console.error("[VibeMonkey] script", __vmName, "threw:", __vmErr); } catch (_e) {}
      __vmSend({ type: "vm:error", id: __vmId, name: __vmName, loadedAt: __vmLoadedAt, url: location.href, message: __vmMsg });
    }
  });
})();
