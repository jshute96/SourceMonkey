/* VibeMonkey injected wrapper — tail fragment. See wrapper-head.js for
   the build / placeholder conventions. */
  } catch (__vmErr) {
    var __vmMsg = (__vmErr && __vmErr.message) ? __vmErr.message : String(__vmErr);
    try { console.error("[VibeMonkey] script", __vmName, "threw:", __vmErr); } catch (_e) {}
    __vmSend({ type: "vm:error", id: __vmId, url: location.href, message: __vmMsg });
  }
})();
