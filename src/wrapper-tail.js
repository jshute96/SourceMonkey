/* SourceMonkey injected wrapper — tail fragment. See wrapper-head.js for
   the build / placeholder conventions.

   The three closing braces match (innermost first):
     - the `try {` opened just before the user body
     - the `function () {` callback passed to __smWaitForRunAt in head
     - the `function (__smDecision) {` callback passed to
       __smAwaitDecision in head
   Then the outer IIFE closes. */
    } catch (__smErr) {
      var __smMsg = (__smErr && __smErr.message) ? __smErr.message : String(__smErr);
      var __smStack = (__smErr && typeof __smErr.stack === "string") ? __smErr.stack : "";
      try { console.error("[SourceMonkey] script", __smName, "threw:", __smErr); } catch (_e) {}
      __smSend({ type: "sm:error", id: __smId, name: __smName, loadedAt: __smLoadedAt, url: location.href, message: __smMsg, stack: __smStack });
    }
    });
  });
})();
