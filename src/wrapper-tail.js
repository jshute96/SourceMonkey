/* SourceMonkey injected wrapper — tail fragment. See wrapper-head.js for
   the build / placeholder conventions.

   The two closing braces match the inner `try {` opened just before
   the body and the outer `function (__smDecision) {` callback opened
   by __smAwaitDecision in the head. */
    } catch (__smErr) {
      var __smMsg = (__smErr && __smErr.message) ? __smErr.message : String(__smErr);
      try { console.error("[SourceMonkey] script", __smName, "threw:", __smErr); } catch (_e) {}
      __smSend({ type: "sm:error", id: __smId, name: __smName, loadedAt: __smLoadedAt, url: location.href, message: __smMsg });
    }
  });
})();
