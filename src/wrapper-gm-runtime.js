/* SourceMonkey GM_* shared runtime. Registered once per page per
   execution world at document_start, ahead of every userscript — in
   USER_SCRIPT world, in MAIN world, or both, depending on which worlds
   have a script granting a runtime-backed API (see buildGmRuntimeSpecs
   in src/extension/injector.ts). One source, two transports; see the transport
   section below.

   Per-script wrappers compile in `const GM_X = function(...) { ... }`
   for every API the script @grants. Two delegation modes:
     - SYNC API bodies call into methods on `window.__SM_GM__` defined
       here. The runtime is shared across all userscripts in this
       document and world (each world is one realm per document), so
       per-script state lives in keyed sub-objects.
     - ASYNC API bodies route through `__SM_GM__.sendAsync`, which
       reaches the SW directly in USER_SCRIPT world and via
       wrapper-bridge.js in MAIN.

   Build rules match userscript-prelude.js — block comments only, no
   `//` sequences in strings, the build minifies to one physical line.
   See scripts/build.mjs's minifyForInjection for the exact rules.

   Shim cache. See docs/GM-API-strategy.md "Recommendation: a tiny
   'shim cache', not a full vault". We capture a small set of native
   references at runtime-init time so a sibling userscript that
   monkey-patches builtins later can't break our GM_* impls. In
   USER_SCRIPT world that is the whole threat, since the page can't
   reach in. In MAIN world the page CAN — but this runs at
   document_start, before any page script, so the captures are still
   pristine natives. What the cache does not (and cannot) buy in MAIN
   is protection from a page that calls `window.__SM_GM__` itself; see
   the transport section's trust note. */
(function () {
  "use strict";
  if (typeof window === "undefined") return;
  if (window.__SM_GM__) return;

  var _Promise = Promise;
  var _Error = Error;
  var _now = Date.now.bind(Date);
  var _JSONStringify = JSON.stringify;
  var _ObjectKeys = Object.keys;
  var _isArray = Array.isArray;
  /* Captured for the stored-value codec below. `_objToString` is how
     it brand-checks Date / RegExp / Map / Set: `instanceof` misses a
     value that came from another realm (an <iframe>'s `Date`), and a
     userscript can reassign the globals. */
  var _objToString = Object.prototype.toString;
  var _Date = Date;
  var _DateGetTime = Date.prototype.getTime;
  var _RegExp = RegExp;
  var _Map = (typeof Map === "function") ? Map : null;
  var _MapForEach = _Map ? Map.prototype.forEach : null;
  var _Set = (typeof Set === "function") ? Set : null;
  var _SetForEach = _Set ? Set.prototype.forEach : null;
  var _BigInt = (typeof BigInt === "function") ? BigInt : null;
  var _Uint8Array = (typeof Uint8Array === "function") ? Uint8Array : null;
  var _DataViewCtor = (typeof DataView === "function") ? DataView : null;
  var _fromCharCode = String.fromCharCode;
  var _btoa = (typeof btoa === "function") ? btoa : null;
  var _atob = (typeof atob === "function") ? atob : null;
  var _ObjectGetPrototypeOf = Object.getPrototypeOf;
  /* Native accessors off the prototypes, used by the codec BOTH to
     read a value and to brand-check it: each one throws a TypeError
     when called on something that lacks the internal slot, which is
     the only reliable test — `Object.prototype.toString` reports
     whatever `Symbol.toStringTag` says. */
  var _RegExpSourceGet = null;
  var _RegExpFlagsGet = null;
  var _ArrayBufferByteLengthGet = null;
  var _DataViewByteLengthGet = null;
  var _TypedArrayLengthGet = null;
  (function () {
    function getter(obj, name) {
      var d = Object.getOwnPropertyDescriptor(obj, name);
      return (d && typeof d.get === "function") ? d.get : null;
    }
    try {
      _RegExpSourceGet = getter(RegExp.prototype, "source");
      _RegExpFlagsGet = getter(RegExp.prototype, "flags");
    } catch (_reE) {}
    try {
      _ArrayBufferByteLengthGet = getter(ArrayBuffer.prototype, "byteLength");
      _DataViewByteLengthGet = getter(DataView.prototype, "byteLength");
      /* %TypedArray%.prototype is the shared prototype ABOVE
         Uint8Array.prototype; its `length` getter accepts any typed
         array and rejects everything else. */
      _TypedArrayLengthGet = getter(_ObjectGetPrototypeOf(Uint8Array.prototype), "length");
    } catch (_binE) {}
  })();
  /* Constructor tables for the codec's brand-keyed revival. Built from
     the globals at init time for the same reason as the other shim
     captures, and `typeof`-guarded per name so a browser missing one
     (Float16Array is recent) just doesn't offer that entry. */
  var TYPED_ARRAYS = {};
  var ERROR_TYPES = {};
  (function () {
    var i;
    var taNames = [
      "Int8Array", "Uint8Array", "Uint8ClampedArray",
      "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
      "Float16Array", "Float32Array", "Float64Array",
      "BigInt64Array", "BigUint64Array",
    ];
    for (i = 0; i < taNames.length; i++) {
      try {
        if (typeof window[taNames[i]] === "function") TYPED_ARRAYS[taNames[i]] = window[taNames[i]];
      } catch (_taE) {}
    }
    /* AggregateError is left out on purpose: its constructor takes
       (errors, message), so reviving one through the shared
       `new C(message)` path would throw. It comes back as an Error
       carrying the name instead. */
    var errNames = [
      "Error", "EvalError", "RangeError", "ReferenceError",
      "SyntaxError", "TypeError", "URIError",
    ];
    for (i = 0; i < errNames.length; i++) {
      try {
        if (typeof window[errNames[i]] === "function") ERROR_TYPES[errNames[i]] = window[errNames[i]];
      } catch (_erE) {}
    }
  })();
  var _ObjectCreate = Object.create;
  /* Captured for the window.onurlchange surface, which defines an
     accessor on the world's own `window`. */
  var _ObjectDefineProperty = Object.defineProperty;
  var _hasOwn = Object.prototype.hasOwnProperty;
  /* DOM-shim cache. Captured at runtime-init time so a sibling
     userscript that later reassigns `document.createElement` (or any
     of the others) can't break the addStyle / addElement helpers. */
  var _docCreateElement = null;
  var _Node_appendChild = null;
  var _Element_setAttribute = null;
  try {
    _docCreateElement = document.createElement.bind(document);
    _Node_appendChild = Node.prototype.appendChild;
    _Element_setAttribute = Element.prototype.setAttribute;
  } catch (_domE) {}
  /* Capture navigator.clipboard.writeText now so the clipboard
     helper can't be subverted by a sibling userscript reassigning
     navigator.clipboard. May be null on older browsers / contexts
     without the API; the helper falls back to a rejected Promise. */
  var _clipboardWriteText = null;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      _clipboardWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
    }
  } catch (_clE) {}
  /* Capture Blob + URL.createObjectURL for GM_getResourceURL. Same
     reasoning as the other shim caches — a sibling userscript that
     reassigns Blob or URL after we init can't subvert the blob URL
     we hand back. */
  var _Blob = (typeof Blob === "function") ? Blob : null;
  var _URL_createObjectURL = null;
  try {
    if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      _URL_createObjectURL = URL.createObjectURL.bind(URL);
    }
  } catch (_urlE) {}
  /* Capture chrome.runtime.sendMessage now so an ASYNC API body still
     reaches a sane reference even if a sibling userscript reassigns
     window.chrome or chrome.runtime later.

     Keyed on `chrome.runtime.id`, not on `sendMessage` existing: a web
     page listed in some installed extension's `externally_connectable`
     gets a partial `chrome.runtime` in MAIN world — `sendMessage` and
     `connect`, nothing else — for talking to THAT extension. Taking it
     for our own channel would throw "must specify an Extension ID" on
     every call and leave no `onMessage` to hear replies on. `id` is a
     string only in a real extension context (our USER_SCRIPT world). */
  var _extensionId = null;
  try { _extensionId = chrome.runtime.id; } catch (_idE) {}
  var _sendMessage = null;
  try {
    if (typeof _extensionId === "string" && typeof chrome.runtime.sendMessage === "function") {
      _sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    }
  } catch (_e) {}

  /* ---------- transport ----------

     This one runtime source is registered in BOTH execution worlds
     (see buildGmRuntimeSpecs in src/extension/injector.ts). Everything above and
     below this block is world-agnostic; only the two primitives here
     differ:

       transportSend(payload) -> Promise<reply>
         USER_SCRIPT: chrome.runtime.sendMessage, straight to the SW.
         MAIN:        a DOM CustomEvent on `document` that
                      wrapper-bridge.js (USER_SCRIPT world, same
                      document) hears and forwards, keyed on a per-call
                      requestId nonce so concurrent calls don't cross
                      replies. The reply comes back as a postMessage.
                      An event, not a postMessage, because every
                      world's listeners run in the DISPATCHING task:
                      the bridge's sendMessage happens before we
                      return, so a write issued while the document is
                      tearing down still leaves. See wrapper-bridge.js.

       onPush(handler)  — SW-originated messages we didn't ask for
                          (value-update broadcasts, XHR events, tab /
                          notification / menu callbacks).
         USER_SCRIPT: chrome.runtime.onMessage, filtered to messages
                      from our own SW.
         MAIN:        the bridge re-posts those same messages into the
                      page with a push marker; we read them here.

     Why MAIN world needs this at all: `@grant unsafeWindow` forces a
     script into MAIN (only there is `window` the page's window), and
     such scripts routinely also @grant storage / XHR / menus. Without
     a MAIN transport, fixing unsafeWindow would break everything else
     they use.

     Trust: in MAIN world the page can both READ our messages and
     FORGE both directions. That is inherent — the page shares the realm
     with the script and with this runtime. The SW-side gate is what
     bounds the damage: it honors bridge-relayed, script-scoped requests
     only for scripts that actually run in MAIN world on the sending
     page. See docs/injection.md#gm_-in-main-world. */
  var BRIDGE_REPLY_MARKER = "sourcemonkey-bridge-reply";
  var BRIDGE_PUSH_MARKER = "sourcemonkey-bridge-push";
  var BRIDGE_SYNC_MARKER = "sourcemonkey-bridge-sync";
  /* How long a MAIN-world request waits for the bridge before we give
     up and reject. The bridge always replies (even when the SW call
     fails), so hitting this means the bridge never registered — a
     rejected Promise is what each caller's own error path expects. */
  var BRIDGE_TIMEOUT_MS = 30000;
  var _bridgePending = null;   /* requestId -> {resolve, timer} */
  var _bridgeSeq = 1;
  var _pushHandlers = [];

  function dispatchPush(msg) {
    for (var i = 0; i < _pushHandlers.length; i++) {
      try { _pushHandlers[i](msg); } catch (_phE) {}
    }
  }

  /* One window listener serves both the reply and push paths in MAIN
     world, so a page with many in-flight GM calls doesn't accumulate
     listeners. Installed only in MAIN — in USER_SCRIPT world we have
     the real chrome.runtime channels. */
  function installBridgeListener() {
    var pending = _ObjectCreate(null);
    try {
      window.addEventListener("message", function (ev) {
        try {
          if (!ev || ev.source !== window) return;
          var d = ev.data;
          if (!d) return;
          if (d.__sm === BRIDGE_PUSH_MARKER) {
            if (d.payload && typeof d.payload === "object") dispatchPush(d.payload);
            return;
          }
          if (d.__sm !== BRIDGE_REPLY_MARKER) return;
          if (typeof d.requestId !== "string") return;
          var entry = pending[d.requestId];
          if (!entry) return;
          delete pending[d.requestId];
          try { clearTimeout(entry.timer); } catch (_tE) {}
          entry.resolve(d.reply);
        } catch (_e) {}
      }, true);
    } catch (_lE) {
      /* No listener means no reply can ever arrive. Leave
         _bridgePending null so bridgeSend rejects immediately instead
         of parking every call for the full timeout. */
      return;
    }
    _bridgePending = pending;
  }
  if (!_sendMessage) installBridgeListener();

  /* The page -> SW leg in MAIN world. Both natives are captured at
     init — this runs at document_start, before any page script — so a
     page that later replaces CustomEvent or document.dispatchEvent
     can't silently swallow our traffic.

     `detail` carries {requestId, payload} as a JSON string: event
     details don't cross realms as objects, and JSON costs us nothing
     the wire didn't already — chrome.runtime.sendMessage
     JSON-serializes on the far side of the bridge regardless, so a
     value that survives JSON.stringify here is exactly a value the SW
     could have received. `requestId` is left off entirely (JSON drops
     `undefined`) for fire-and-forget sends, which is what the bridge
     reads to pick its path. */
  var _CustomEvent = null;
  var _dispatchEvent = null;
  try { _CustomEvent = CustomEvent; } catch (_ceE) {}
  try {
    if (document && typeof document.dispatchEvent === "function") {
      _dispatchEvent = document.dispatchEvent.bind(document);
    }
  } catch (_deE) {}
  function bridgeDispatch(payload, requestId) {
    if (!_CustomEvent || !_dispatchEvent) {
      throw new _Error("[SourceMonkey] GM bridge unavailable");
    }
    var detail;
    try {
      detail = _JSONStringify({ requestId: requestId, payload: payload });
    } catch (_jE) {
      /* Circular structures, BigInt, a getter that throws. The raw V8
         text ("Converting circular structure to JSON --> ...") ends up
         in a userscript's onerror or rejected promise, so say what the
         caller can act on instead. The USER_SCRIPT-world path fails on
         the same values one step later, inside
         chrome.runtime.sendMessage, so this is not a MAIN-world-only
         restriction — just the only place we get to word it. */
      throw new _Error("[SourceMonkey] This call carries a value SourceMonkey cannot send. "
        + "Pass data that survives JSON: no circular references, functions, or BigInt");
    }
    _dispatchEvent(new _CustomEvent(BRIDGE_SYNC_MARKER, { detail: detail }));
  }

  function bridgeSend(payload) {
    if (!_bridgePending) {
      return _Promise.reject(new _Error("[SourceMonkey] GM bridge unavailable"));
    }
    var requestId = "gm-" + (_bridgeSeq++) + "-" + Math.random().toString(36).slice(2, 10);
    return new _Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete _bridgePending[requestId];
        reject(new _Error("[SourceMonkey] GM bridge timed out after " + BRIDGE_TIMEOUT_MS + "ms"));
      }, BRIDGE_TIMEOUT_MS);
      _bridgePending[requestId] = { resolve: resolve, timer: timer };
      /* Registered before dispatching: the bridge's listener runs
         inside this dispatch, so by the time it can post a reply the
         entry it will be matched against already exists. */
      try {
        bridgeDispatch(payload, requestId);
      } catch (e) {
        delete _bridgePending[requestId];
        try { clearTimeout(timer); } catch (_tE2) {}
        reject(e);
      }
    });
  }

  /* Fire-and-forget send that completes before this call returns —
     what `chrome.runtime.sendMessage` already does in USER_SCRIPT
     world, and what the DOM-event dispatch does in MAIN. The one
     caller is the teardown flush, where the reply would never be
     read and a later task may never come. */
  function transportSendNow(payload) {
    if (_sendMessage) {
      var p = _sendMessage(payload);
      if (p && typeof p.catch === "function") p.catch(function () {});
      return;
    }
    try { bridgeDispatch(payload); } catch (_snE) {}
  }

  /* The single send primitive every subsystem uses. */
  function transportSend(payload) {
    if (_sendMessage) {
      try {
        var p = _sendMessage(payload);
        if (p && typeof p.then === "function") return p;
        return _Promise.resolve(p);
      } catch (e) {
        return _Promise.reject(e);
      }
    }
    return bridgeSend(payload);
  }

  /* Register a handler for SW-originated pushes. */
  function onPush(handler) {
    _pushHandlers.push(handler);
  }
  if (_sendMessage) {
    /* Sender filter. A naive listener would happily process a forged
       push from another userscript inside the same extension —
       chrome.runtime.sendMessage from one USER_SCRIPT world fires
       onMessage in every other context (incl. other tabs). We require:
         - sender.id === chrome.runtime.id  (our extension only)
         - sender.tab is undefined          (came from the SW, not a tab)
       The combination ensures only the SW's own messages reach us. */
    try {
      if (chrome.runtime.onMessage && typeof chrome.runtime.onMessage.addListener === "function") {
        chrome.runtime.onMessage.addListener(function (msg, sender /*, sendResponse */) {
          if (!sender || sender.id !== _extensionId || sender.tab) return;
          if (!msg || typeof msg !== "object") return;
          dispatchPush(msg);
        });
      }
    } catch (_pE) {}
  }

  /* ---------- Storage subsystem ----------

     Per-script in-page cache + batched async writes. Reads go to the
     cache (sync); writes update the cache locally and queue a batched
     `sm:gm-batch-write` message to the SW. The cache is seeded by
     the wrapper's prelude calling `storage.init(scriptId, snapshot)`,
     where `snapshot` came in on the sm:check-pending reply from the
     SW. See docs/GM-APIs-storage.md.

     Batched write shape:
       - Debounce 150ms after each write.
       - Force-flush at 1s of debounce.
       - Force-flush on `pagehide` so bfcache eviction doesn't lose
         in-flight writes.

     Per-script: one cache object, one debounce timer, one pending
     writes queue. The runtime is shared across scripts in the same
     document, so we key by scriptId. */
  var stores = {};  /* scriptId -> { cache, pending, debounceTimer, hardTimer, ready, listeners, nextListenerId } */
  var DEBOUNCE_MS = 150;
  var HARD_DEADLINE_MS = 1000;
  /* Deletion sentinel — paired with the SW-side gm-values.ts
     DELETED_SENTINEL. Compared by reference. */
  var DELETED_SENTINEL = {};

  /* ---------- Stored-value codec ----------

     Everything a value passes through on its way to disk serializes
     JSON-style: chrome.runtime.sendMessage on the hop to the worker,
     then chrome.storage.local itself. JSON silently rewrites values a
     userscript is entitled to store — a Date reads back as an ISO
     string, NaN and Infinity as null, a Map as {} — and the script
     has no way to notice. TM and VM both tag the stored form to get
     around this; so do we, under two rules:

       - A value JSON already round-trips exactly is stored RAW,
         unchanged from what older builds wrote. That is what makes
         this backwards compatible: for such values the new encoder
         emits the identical bytes, so old rows and new rows are the
         same thing.
       - Anything else is wrapped in one envelope object,
         `{ __smv__: 1, v: <node> }`. `decodeValue` hands back
         anything WITHOUT that own marker untouched, so a row written
         before this existed decodes to itself.

     Inside the envelope every node is a `[tag, ...payload]` array;
     the full tag grammar is tabulated in
     docs/GM-APIs-storage.md#node-tags. Tags therefore live in array
     position 0, never in an object key,
     so a userscript object with a key called `__smv__` (or `$`, or
     any other name we might have picked) can't be mistaken for one.
     The remaining ambiguity — a RAW value that itself contains the
     `__smv__` marker — is closed from the other side: such a value
     is deliberately treated as not-plain and wrapped.

     Binary values (typed arrays, ArrayBuffer, DataView) carry their
     bytes as base64 — JSON has no better option, and the ~33% growth
     beats the ~4x of an array of decimal numbers.

     Deliberately NOT represented:
       - Class instances keep their own enumerable properties but
         lose their prototype. Nothing else is possible: the class
         isn't reachable from here at decode time. Structured clone
         has the same limit.
       - Blob / File would need an async read, and GM_setValue is
         synchronous.
       - Object identity is not preserved — two references to one
         object decode as two objects, and two typed arrays over one
         ArrayBuffer decode over two buffers. Circular references,
         which are the case where that actually breaks a value
         rather than just copying it twice, throw instead. */
  var VALUE_ENVELOPE = "__smv__";
  var VALUE_FORMAT = 1;

  /* Returned by encodeNode for a value JSON would drop entirely
     (function / symbol). The callers reproduce JSON's own handling:
     omit the property, or write null into an array slot. */
  var OMIT = {};

  /* Returned by encodeBranded when the value isn't one of the types
     it handles (or turned out not to really be one). */
  var MISS = {};

  /* Base64 for the binary branches. `apply` is chunked because one
     call with a very large argument list overflows the argument
     stack — 32k elements is the usual safe ceiling. */
  var B64_CHUNK = 0x8000;

  function bytesToBase64(bytes) {
    var parts = [];
    for (var i = 0; i < bytes.length; i += B64_CHUNK) {
      parts.push(_fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK)));
    }
    return _btoa(parts.join(""));
  }

  function base64ToBytes(b64) {
    var bin = _atob(b64);
    var out = new _Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* True when the binary branches can run at all. Everything they
     need is standard in a page, but the codec falls back to the
     generic object walk rather than throwing if something is
     missing. */
  var canEncodeBinary = !!(
    _btoa && _atob && _Uint8Array &&
    _ArrayBufferByteLengthGet && _DataViewByteLengthGet && _TypedArrayLengthGet
  );

  /* Encode one of the types we tag by brand, or MISS if `value`
     isn't one. Split out from encodeNode so the caller can treat a
     throw here as "not actually that type" — see the call site.
     Sets `state.plain` on a hit; the caller undoes that on a miss. */
  function encodeBranded(value, seen, state) {
    var brand = _objToString.call(value);
    if (brand === "[object Date]") {
      state.plain = false;
      var ms = _DateGetTime.call(value);
      /* An Invalid Date's time is NaN, which JSON can't carry —
         send the marker string and rebuild it on the way back. */
      return ["d", ms === ms ? ms : "nan"];
    }
    if (brand === "[object RegExp]" && _RegExpSourceGet && _RegExpFlagsGet) {
      /* These throw for anything that only claims to be a RegExp. */
      var reSource = _RegExpSourceGet.call(value);
      var reFlags = _RegExpFlagsGet.call(value);
      state.plain = false;
      return ["re", String(reSource), String(reFlags)];
    }
    if (canEncodeBinary && brand === "[object ArrayBuffer]") {
      /* `new Uint8Array(notABuffer)` quietly yields an EMPTY array
         rather than throwing, so the impostor has to be rejected
         before we read any bytes. */
      _ArrayBufferByteLengthGet.call(value);
      state.plain = false;
      return ["ab", bytesToBase64(new _Uint8Array(value))];
    }
    if (canEncodeBinary && brand === "[object DataView]") {
      _DataViewByteLengthGet.call(value);
      state.plain = false;
      return ["dv", bytesToBase64(new _Uint8Array(value.buffer, value.byteOffset, value.byteLength))];
    }
    if (canEncodeBinary) {
      /* "[object Uint8Array]" -> "Uint8Array". A non-typed-array
         wearing that tag fails on `.buffer` and the caller falls
         through to the object walk. */
      var taName = brand.slice(8, brand.length - 1);
      if (_hasOwn.call(TYPED_ARRAYS, taName)) {
        _TypedArrayLengthGet.call(value);
        state.plain = false;
        return ["ta", taName, bytesToBase64(new _Uint8Array(value.buffer, value.byteOffset, value.byteLength))];
      }
    }
    /* Error has no internal slot to probe, and reading `.name` /
       `.message` off an impostor succeeds. The prototype is the
       cheap discriminator that still works cross-realm: a real Error
       (from any realm) inherits from an Error.prototype, never
       straight from Object.prototype, which is what a
       `{[Symbol.toStringTag]: "Error"}` literal has. */
    if (brand === "[object Error]" && _ObjectGetPrototypeOf(value) !== Object.prototype) {
      state.plain = false;
      /* `message` and `stack` are non-enumerable own properties, so
         Object.keys picks up only what the script attached itself
         (`err.code = 42`) — worth carrying, and cheap. */
      var errExtra = [];
      var errKeys = _ObjectKeys(value);
      for (var e = 0; e < errKeys.length; e++) {
        var en = encodeNode(value[errKeys[e]], seen, state);
        if (en !== OMIT) errExtra.push([errKeys[e], en]);
      }
      return [
        "err",
        String(value.name),
        String(value.message),
        value.stack === undefined ? null : String(value.stack),
        errExtra,
      ];
    }
    if (_Map && brand === "[object Map]") {
      state.plain = false;
      var mEntries = [];
      _MapForEach.call(value, function (mv, mk) {
        var kn = encodeNode(mk, seen, state);
        var vn = encodeNode(mv, seen, state);
        /* A Map key or value JSON would drop still has to occupy
           its slot — dropping the entry would change the size. */
        mEntries.push([kn === OMIT ? ["u"] : kn, vn === OMIT ? ["u"] : vn]);
      });
      return ["m", mEntries];
    }
    if (_Set && brand === "[object Set]") {
      state.plain = false;
      var sItems = [];
      _SetForEach.call(value, function (sv) {
        var sn = encodeNode(sv, seen, state);
        sItems.push(sn === OMIT ? ["u"] : sn);
      });
      return ["s", sItems];
    }

    return MISS;
  }

  /* Walk `value`, building its node form and recording in
     `state.plain` whether the raw value would have survived JSON
     unchanged. `seen` is the ancestor chain, for cycle detection —
     an array rather than a Set because it is only ever a few deep
     and `indexOf` avoids depending on Set being unmolested. */
  function encodeNode(value, seen, state) {
    var t = typeof value;
    if (value === null) return ["p", null];
    if (t === "string" || t === "boolean") return ["p", value];
    if (t === "number") {
      /* NaN and the infinities all JSON to null; -0 JSONs to 0. */
      if (value !== value) { state.plain = false; return ["nan"]; }
      if (value === Infinity) { state.plain = false; return ["inf"]; }
      if (value === -Infinity) { state.plain = false; return ["-inf"]; }
      if (value === 0 && 1 / value === -Infinity) { state.plain = false; return ["-0"]; }
      return ["p", value];
    }
    if (t === "undefined") { state.plain = false; return ["u"]; }
    if (t === "bigint") { state.plain = false; return ["big", String(value)]; }
    if (t === "function" || t === "symbol") return OMIT;
    if (t !== "object") return OMIT;

    for (var d = 0; d < seen.length; d++) {
      if (seen[d] === value) {
        throw new _Error("[SourceMonkey] GM_setValue: a stored value cannot contain a circular reference");
      }
    }
    seen.push(value);
    try {
      if (_isArray(value)) {
        var arr = [];
        for (var i = 0; i < value.length; i++) {
          var an = encodeNode(value[i], seen, state);
          /* JSON writes null for an unserializable array slot. */
          arr.push(an === OMIT ? ["p", null] : an);
        }
        return ["a", arr];
      }

      /* Brand checks read `Symbol.toStringTag`, which any object can
         set: `{[Symbol.toStringTag]: "Map"}` reports "[object Map]"
         without being one, and a Proxy over a real Map refuses the
         internal slot its forEach needs. So a branded encoder is
         allowed to FAIL — a throw drops through to the generic object
         walk below, which is what such a value got before the codec
         existed. `state.plain` rolls back with it, so a branch that
         got halfway can't leave the value wrapped for no reason. */
      var plainBefore = state.plain;
      var branded;
      try {
        branded = encodeBranded(value, seen, state);
      } catch (_brE) {
        branded = MISS;
      }
      if (branded !== MISS) return branded;
      state.plain = plainBefore;

      /* `toJSON` before the generic object walk, because that is the
         order JSON.stringify uses and some userscripts rely on it.
         Date defines one too, which is why the brand checks come
         first. Reading the property can throw on a Proxy; let that
         surface the same way JSON.stringify would. */
      var toJson = value.toJSON;
      if (typeof toJson === "function") {
        var replaced = encodeNode(toJson.call(value), seen, state);
        return replaced === OMIT ? ["u"] : replaced;
      }

      var keys = _ObjectKeys(value);
      var entries = [];
      for (var k = 0; k < keys.length; k++) {
        var pn = encodeNode(value[keys[k]], seen, state);
        if (pn === OMIT) continue; /* JSON omits the property */
        /* A raw value carrying our marker would decode as an
           envelope, so force it through the wrapped path. */
        if (keys[k] === VALUE_ENVELOPE) state.plain = false;
        entries.push([keys[k], pn]);
      }
      return ["o", entries];
    } finally {
      seen.pop();
    }
  }

  /* Public encoder: the raw value when JSON already round-trips it
     (the common case, and the backwards-compatible one), otherwise
     the envelope. */
  function encodeValue(value) {
    var state = { plain: true };
    var node = encodeNode(value, [], state);
    if (node === OMIT) { state.plain = false; node = ["u"]; }
    if (state.plain) return value;
    var env = {};
    env[VALUE_ENVELOPE] = VALUE_FORMAT;
    env.v = node;
    return env;
  }

  /* Assign a decoded property. A stored own `__proto__` key would
     otherwise set the decoded object's PROTOTYPE instead of becoming
     a property of it — and an own `__proto__` key is reachable in
     practice, since that is exactly what `JSON.parse` produces. */
  function setDecoded(obj, key, value) {
    if (key === "__proto__") {
      _ObjectDefineProperty(obj, key, {
        value: value, writable: true, enumerable: true, configurable: true,
      });
    } else {
      obj[key] = value;
    }
  }

  function decodeNode(n) {
    if (!_isArray(n)) return undefined;
    var i;
    switch (n[0]) {
      case "p": return n[1];
      case "u": return undefined;
      case "nan": return NaN;
      case "inf": return Infinity;
      case "-inf": return -Infinity;
      case "-0": return -0;
      case "big": return _BigInt ? _BigInt(n[1]) : n[1];
      case "d": return new _Date(typeof n[1] === "number" ? n[1] : NaN);
      case "re": return new _RegExp(n[1], n[2]);
      case "ab": return base64ToBytes(n[1]).buffer;
      case "dv": return new _DataViewCtor(base64ToBytes(n[1]).buffer);
      case "ta": {
        var bytes = base64ToBytes(n[2]);
        /* An unknown constructor name means this row was written by a
           build (or browser) that had a typed array this one doesn't.
           Hand back the raw bytes rather than nothing. */
        if (!_hasOwn.call(TYPED_ARRAYS, n[1])) return bytes;
        return new TYPED_ARRAYS[n[1]](bytes.buffer);
      }
      case "err": {
        var Ctor = _hasOwn.call(ERROR_TYPES, n[1]) ? ERROR_TYPES[n[1]] : _Error;
        var err = new Ctor(n[2]);
        /* A subclass name (or AggregateError) has no constructor in
           the table; preserve the name on a plain Error instead. */
        if (err.name !== n[1]) err.name = n[1];
        if (n[3] !== null && n[3] !== undefined) {
          try { err.stack = n[3]; } catch (_stE) {}
        }
        var extra = n[4];
        if (_isArray(extra)) {
          for (i = 0; i < extra.length; i++) setDecoded(err, extra[i][0], decodeNode(extra[i][1]));
        }
        return err;
      }
      case "a": {
        var arr = [];
        for (i = 0; i < n[1].length; i++) arr.push(decodeNode(n[1][i]));
        return arr;
      }
      case "o": {
        var obj = {};
        for (i = 0; i < n[1].length; i++) setDecoded(obj, n[1][i][0], decodeNode(n[1][i][1]));
        return obj;
      }
      case "m": {
        var m = new _Map();
        for (i = 0; i < n[1].length; i++) m.set(decodeNode(n[1][i][0]), decodeNode(n[1][i][1]));
        return m;
      }
      case "s": {
        var st = new _Set();
        for (i = 0; i < n[1].length; i++) st.add(decodeNode(n[1][i]));
        return st;
      }
      default: return undefined;
    }
  }

  /* Public decoder. Anything that isn't one of our envelopes is
     already the value: that covers every row written before the
     codec existed AND every plain value written since. An envelope
     stamped with a format we don't know comes back as-is too — a
     downgrade should hand the script something inspectable rather
     than throw inside its GM_getValue. */
  function decodeValue(value) {
    if (!value || typeof value !== "object" || _isArray(value)) return value;
    if (!_hasOwn.call(value, VALUE_ENVELOPE)) return value;
    if (value[VALUE_ENVELOPE] !== VALUE_FORMAT) return value;
    try {
      return decodeNode(value.v);
    } catch (e) {
      try { console.info("[SourceMonkey] stored value could not be decoded:", e); } catch (_dE) {}
      /* Same reasoning as the unknown-format branch above: hand the
         script something it can inspect. Returning undefined would
         also defeat the caller's GM_getValue default, because the
         key IS present. */
      return value;
    }
  }

  function ensureStore(scriptId) {
    var s = stores[scriptId];
    if (s) return s;
    s = {
      cache: {},
      pending: [],     /* array of {key, value} or {key, value: DELETED_SENTINEL} */
      debounceTimer: null,
      hardTimer: null,
      ready: false,
      listeners: null,        /* lazily { listenerId: {key, callback} } */
      nextListenerId: 1,
      resyncInFlight: false,  /* one outstanding sm:gm-resync at a time */
      lastResyncAt: 0,
      /* Monotonic change counter + the counter value at each key's
         last change, local write or applied broadcast alike. Lets a
         resync reply tell "this key has moved since I asked" from
         "this key is unchanged" — see applyResyncSnapshot. */
      writeSeq: 0,
      writeSeqByKey: _ObjectCreate(null),
    };
    stores[scriptId] = s;
    return s;
  }

  /* Fire value-change listeners for one (scriptId, key) transition.
     Matches TM/VM signature: callback(key, oldValue, newValue, remote).
     `remote=true` means the change came from another tab via the SW
     broadcast; `false` means a local GM_setValue / GM_deleteValue.

     Listener throws are swallowed (we log them) so one buggy listener
     can't stop sibling listeners from firing. We iterate a copy of
     the listener-id list so a listener that calls
     removeValueChangeListener during dispatch doesn't disturb the
     iteration. */
  function fireListeners(scriptId, key, oldValue, newValue, remote) {
    var s = stores[scriptId];
    if (!s || !s.listeners) return;
    var ids = _ObjectKeys(s.listeners);
    for (var i = 0; i < ids.length; i++) {
      var L = s.listeners[ids[i]];
      if (!L || L.key !== key) continue;
      try {
        L.callback(key, oldValue, newValue, remote);
      } catch (e) {
        try { console.info("[SourceMonkey] value-change listener threw:", e); } catch (_lE) {}
      }
    }
  }

  function scheduleFlush(scriptId) {
    var s = stores[scriptId];
    if (!s) return;
    if (s.debounceTimer != null) clearTimeout(s.debounceTimer);
    s.debounceTimer = setTimeout(function () { flushStore(scriptId, "debounce"); }, DEBOUNCE_MS);
    if (s.hardTimer == null) {
      s.hardTimer = setTimeout(function () { flushStore(scriptId, "hard"); }, HARD_DEADLINE_MS);
    }
  }

  /* Flush the pending writes for one script. Sends a single
     sm:gm-batch-write to the SW. We don't await the reply — failures
     surface as console warnings rather than throwing into a sync
     caller's frame. */
  function flushStore(scriptId, reason) {
    var s = stores[scriptId];
    if (!s || s.pending.length === 0) {
      if (s) {
        if (s.debounceTimer != null) { clearTimeout(s.debounceTimer); s.debounceTimer = null; }
        if (s.hardTimer != null) { clearTimeout(s.hardTimer); s.hardTimer = null; }
      }
      return;
    }
    var batch = s.pending;
    s.pending = [];
    if (s.debounceTimer != null) { clearTimeout(s.debounceTimer); s.debounceTimer = null; }
    if (s.hardTimer != null) { clearTimeout(s.hardTimer); s.hardTimer = null; }
    /* Wire format: each entry is {key, value}. value === DELETED_SENTINEL
       (compared by reference on this side) marks a delete. We encode
       deletes as {key, deleted: true} for the SW because the wire is
       JSON and the sentinel can't survive the wire.

       `value` is already in codec wire form — `storage.set` encoded
       it — so nothing here has to know about tagged types. The SW
       and chrome.storage.local both treat it as opaque JSON. */
    var wireWrites = [];
    for (var i = 0; i < batch.length; i++) {
      var w = batch[i];
      if (w.value === DELETED_SENTINEL) {
        wireWrites.push({ key: w.key, deleted: true });
      } else {
        wireWrites.push({ key: w.key, value: w.value });
      }
    }
    try {
      var msg = { type: "sm:gm-batch-write", scriptId: scriptId, writes: wireWrites };
      if (reason === "pagehide") {
        /* The document is going away; there is no later task to
           await a reply in, so skip the request/reply path. */
        transportSendNow(msg);
        return;
      }
      var p = transportSend(msg);
      if (p && typeof p.then === "function") {
        p.then(function (reply) {
          /* A resolved promise isn't proof the write landed. The SW
             answers {ok:true}; the MAIN-world bridge answers with a
             generic fallback when the SW call failed, and the SW
             answers {ok:false} when the bridge gate refused. Both
             resolve, so check the payload or lose writes in silence. */
          if (reply && reply.ok === true) return;
          try { console.info("[SourceMonkey] storage flush not confirmed", scriptId, reply && reply.error); } catch (_e0) {}
        }, function (err) {
          try { console.info("[SourceMonkey] storage flush rejected", scriptId, err && err.message); } catch (_e) {}
        });
      }
    } catch (e) {
      try { console.info("[SourceMonkey] storage flush threw", scriptId, e && e.message); } catch (_e2) {}
    }
  }

  /* Force-flush every script's pending writes — wired into pagehide
     so a bfcache eviction or tab close doesn't lose buffered writes.
     Synchronous from the caller's perspective: we issue the
     sendMessage and don't await the reply. Chrome holds the message
     channel open across pagehide for long enough to deliver it. */
  function flushAll() {
    var keys = _ObjectKeys(stores);
    for (var i = 0; i < keys.length; i++) flushStore(keys[i], "pagehide");
  }
  /* These flushes go over `transportSendNow`, which drops the reply
     rather than parking a Promise a dying document will never settle.
     Delivery itself is synchronous in both worlds — see the transport
     section — so the write leaves before this handler returns. */
  try {
    window.addEventListener("pagehide", flushAll, { capture: true });
    /* visibilitychange → hidden is a softer signal that also tends to
       precede tab close; flushing here gives one more shot at
       delivery before bfcache. */
    window.addEventListener("visibilitychange", function () {
      if (!document) return;
      if (document.visibilityState === "hidden") flushAll();
      /* Coming back into view is a free moment to re-check the cache
         against the worker, in case a broadcast was lost while this
         tab sat in the background. See resyncListeningStores. */
      else resyncListeningStores();
    }, { capture: true });
  } catch (_evErr) {}

  /* Cross-tab broadcast handler. The SW sends a sm:gm-value-update
     message to every tab running the script after a write batch
     applies (excluding the originator). We apply the diff locally
     so subsequent GM_getValue reads in this tab see the change
     without a re-register.

     The listener is shared across all scripts in the document
     (USER_SCRIPT world has one realm per document), so we dispatch
     by the message's scriptId rather than per-script.

     Also fires value-change listeners for each write so cross-tab
     observers see remote updates. */
  function applyRemoteUpdate(scriptId, writes) {
    var s = stores[scriptId];
    if (!s || !s.ready) return;
    if (!writes || !writes.length) return;
    for (var i = 0; i < writes.length; i++) {
      var w = writes[i];
      var oldValue = _hasOwn.call(s.cache, w.key) ? s.cache[w.key] : undefined;
      /* Counted like a local write: a resync reply that predates
         this broadcast must not roll it back. */
      s.writeSeqByKey[w.key] = ++s.writeSeq;
      if (w.deleted) {
        delete s.cache[w.key];
        fireListeners(scriptId, w.key, oldValue, undefined, true);
      } else {
        var newValue = decodeValue(w.value);
        s.cache[w.key] = newValue;
        fireListeners(scriptId, w.key, oldValue, newValue, true);
      }
    }
  }
  /* ---------- Resync: recovering from a lost broadcast ----------

     A broadcast is the ONLY thing that refreshes a live document's
     cache, and GM_getValue is a pure cache read — so a document that
     misses one is stale for the rest of its life, with no way to
     notice. (It happened: a service-worker restart between the tabs
     loading and the write emptied the worker's openers table and the
     receiving tab never heard. See issue #19.)

     The way back is to ask the worker for the whole map and diff it
     against the cache. Triggered by:
       - the worker's `sm:gm-resync-hint` after it starts, which is
         when its delivery state was just rebuilt from disk;
       - this document becoming visible again.
     Only scripts with a live value-change listener answer — for
     everyone else the cache is only observable through their own
     writes, and answering costs the worker a storage read. */
  var RESYNC_MIN_INTERVAL_MS = 5000;

  function hasValueListeners(s) {
    return !!(s && s.listeners && _ObjectKeys(s.listeners).length > 0);
  }

  /* Structural compare, so a resync that returns the same object
     value as the cache already holds doesn't fire listeners: the
     snapshot arrives freshly deserialized, so `===` would report
     every object-valued key as changed on every resync.

     Both sides are passed in WIRE form (what the codec would store),
     not as live values. That is what makes the comparison exact for
     the tagged types: two different Maps both serialize to `{}` as
     raw values, but to distinct envelopes once encoded.

     Key-order sensitive, because it compares serializations. A
     value that round-trips through storage keeps its order, so
     that only shows up for a script that mutates the object it
     stored (rather than storing a new one) — such a script gets
     one spurious remote=true fire on the next resync, and its
     cache was already wrong for that key. */
  function sameStoredValue(a, b) {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== "object" || typeof b !== "object") return false;
    try { return _JSONStringify(a) === _JSONStringify(b); } catch (_sE) { return false; }
  }

  /* Apply a snapshot the worker answered a `sm:gm-resync` with.
     `writeSeqAt` is the store's change counter as of the moment we
     SENT that request — a reply can only speak for writes the
     worker had already seen by then. Ways a key can be newer than
     the reply, all of which we leave alone:

       - it is still in `s.pending` (never flushed, so the worker
         has not seen it at all);
       - it was written after the request went out, flushed while
         the reply was in flight, and so has left `s.pending`
         again;
       - a broadcast for it landed while the reply was in flight.
     The counter catches the last two.

     A key written and flushed BEFORE the request needs nothing:
     messages from one document reach the worker in order, and the
     worker parks a write in its in-flight overlay before awaiting
     storage, so the snapshot already includes it. */
  function applyResyncSnapshot(scriptId, values, writeSeqAt) {
    var s = stores[scriptId];
    if (!s || !s.ready || !values) return;
    var pendingKeys = _ObjectCreate(null);
    for (var p = 0; p < s.pending.length; p++) pendingKeys[s.pending[p].key] = true;
    var written = s.writeSeqByKey;
    var stale = function (key) {
      return !!pendingKeys[key] || (_hasOwn.call(written, key) && written[key] > writeSeqAt);
    };
    var inSnapshot = _ObjectCreate(null);
    var keys = _ObjectKeys(values);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      inSnapshot[k] = true;
      if (stale(k)) continue;
      var had = _hasOwn.call(s.cache, k);
      var oldValue = had ? s.cache[k] : undefined;
      /* `values[k]` is already wire form; encode the cached side to
         match rather than decoding the snapshot for every key.
         Encoding can throw — GM_getValue hands back the live cached
         object, so a script is free to make it circular — and a
         throw escaping here would abandon every remaining key AND
         the deleted-key sweep below. An uncomparable cached value
         counts as changed. */
      var comparable = false;
      var encodedOld = null;
      if (had) {
        try {
          encodedOld = encodeValue(oldValue);
          comparable = true;
        } catch (_cmpE) {}
      }
      if (comparable && sameStoredValue(encodedOld, values[k])) continue;
      var fresh = decodeValue(values[k]);
      s.cache[k] = fresh;
      fireListeners(scriptId, k, oldValue, fresh, true);
    }
    /* Anything the cache still holds that the worker doesn't was
       deleted by another tab in a broadcast we didn't get. */
    var cached = _ObjectKeys(s.cache);
    for (var j = 0; j < cached.length; j++) {
      var ck = cached[j];
      if (inSnapshot[ck] || stale(ck)) continue;
      var prev = s.cache[ck];
      delete s.cache[ck];
      fireListeners(scriptId, ck, prev, undefined, true);
    }
  }

  function requestResync(scriptId) {
    var s = stores[scriptId];
    if (!s || !s.ready || s.resyncInFlight) return;
    var now = _now();
    /* Stamped on the attempt, not on success: a worker that is
       failing to answer shouldn't get asked once per visibility
       change. */
    if (s.lastResyncAt && (now - s.lastResyncAt) < RESYNC_MIN_INTERVAL_MS) return;
    s.lastResyncAt = now;
    s.resyncInFlight = true;
    /* Captured BEFORE the send — see applyResyncSnapshot. */
    var writeSeqAt = s.writeSeq;
    var done = function () { s.resyncInFlight = false; };
    /* Over whichever transport this world has — a MAIN-world store
       resyncs through the bridge like every other SW call. */
    transportSend({ type: "sm:gm-resync", scriptId: scriptId }).then(function (reply) {
      done();
      if (reply && reply.ok && reply.values) applyResyncSnapshot(scriptId, reply.values, writeSeqAt);
    }, done);
  }

  function resyncListeningStores() {
    var ids = _ObjectKeys(stores);
    for (var i = 0; i < ids.length; i++) {
      if (hasValueListeners(stores[ids[i]])) requestResync(ids[i]);
    }
  }

  /* The SW's own messages, over whichever transport this world has —
     `chrome.runtime.onMessage` in USER_SCRIPT, the bridge's re-post in
     MAIN. `onPush` applies the sender filter for us; see the transport
     section at the top of this file. */
  onPush(function (msg) {
    if (msg.type === "sm:gm-resync-hint") { resyncListeningStores(); return; }
    if (msg.type !== "sm:gm-value-update") return;
    if (typeof msg.scriptId !== "string") return;
    if (!msg.writes || typeof msg.writes.length !== "number") return;
    applyRemoteUpdate(msg.scriptId, msg.writes);
  });

  var storage = {
    /* Called from the GM prelude spliced into the main-body wrap
       function (which only fires after the prelude's awaitDecision
       + waitForRunAt gates, by which point the GM runtime is
       guaranteed installed) with the scriptId and the SW-attached
       initial-value snapshot from the sm:check-pending reply. Populates the
       per-script cache and flags it as ready. Also called by the
       prelude itself ahead of a reload-fast-path swap eval, which
       doesn't run the wrap function. Calling init twice for the same
       scriptId is idempotent — the second call replaces the cache —
       and one path reaches it in normal operation: a swap primed the
       cache, page CSP then refused the eval, and the baked-in body
       runs its own init. */
    init: function (scriptId, values) {
      var s = ensureStore(scriptId);
      /* Defensive copy so the userscript can't mutate the values
         object the SW handed us. Use Object.create(null) so a user
         that has clobbered Object.prototype can't shadow our cached
         keys via inherited properties. */
      var copy = _ObjectCreate(null);
      var keys = _ObjectKeys(values || {});
      /* The snapshot is in wire form (see the stored-value codec):
         values that needed tagging arrive as envelopes and are
         revived here, so the cache always holds what the userscript
         stored. Rows written before the codec existed are plain and
         pass through decodeValue unchanged. */
      for (var i = 0; i < keys.length; i++) copy[keys[i]] = decodeValue(values[keys[i]]);
      s.cache = copy;
      s.ready = true;
    },
    get: function (scriptId, key, defaultValue) {
      var s = stores[scriptId];
      if (!s || !s.ready) return defaultValue;
      /* Use the captured _hasOwn so a sibling userscript that
         reassigned Object.prototype.hasOwnProperty can't make every
         get return the default. */
      if (_hasOwn.call(s.cache, key)) return s.cache[key];
      return defaultValue;
    },
    /* Sync API: returns undefined, queues the write. Fires
       value-change listeners synchronously with remote=false. */
    set: function (scriptId, key, value) {
      var s = ensureStore(scriptId);
      /* Encode BEFORE touching the cache, so a value we can't store
         (a circular reference) throws at the GM_setValue call site
         with nothing half-applied, rather than being swallowed by
         the async flush.

         Note what this does NOT fix: a JSON-clean value encodes to
         ITSELF, so the pending write still holds the live object and
         a later mutation of it does reach disk, exactly as before.
         Only a tagged value (Date, Map, binary, ...) is snapshotted
         here. Mutating the object you stored was already unsupported
         — see sameStoredValue — and which of the two behaviours you
         get now depends on the value's type. */
      var encoded = encodeValue(value);
      var oldValue = _hasOwn.call(s.cache, key) ? s.cache[key] : undefined;
      s.cache[key] = value;
      s.writeSeqByKey[key] = ++s.writeSeq;
      s.pending.push({ key: key, value: encoded });
      scheduleFlush(scriptId);
      fireListeners(scriptId, key, oldValue, value, false);
    },
    del: function (scriptId, key) {
      var s = ensureStore(scriptId);
      var oldValue = _hasOwn.call(s.cache, key) ? s.cache[key] : undefined;
      delete s.cache[key];
      s.writeSeqByKey[key] = ++s.writeSeq;
      s.pending.push({ key: key, value: DELETED_SENTINEL });
      scheduleFlush(scriptId);
      fireListeners(scriptId, key, oldValue, undefined, false);
    },
    list: function (scriptId) {
      var s = stores[scriptId];
      if (!s || !s.ready) return [];
      return _ObjectKeys(s.cache);
    },
    /* GM_addValueChangeListener(key, callback) — register a per-key
       listener. Returns a listener-id the caller can pass to
       removeValueChangeListener. The id is stable across the
       lifetime of the document.

       Listeners fire on:
         - Local GM_setValue / GM_deleteValue (remote=false), AFTER
           the cache has been updated and the write queued.
         - Remote sm:gm-value-update broadcasts (remote=true).
       Pre-flight loads (storage.init) do NOT fire listeners — the
       cache hasn't observably changed from the page's perspective. */
    addValueChangeListener: function (scriptId, key, callback) {
      if (typeof callback !== "function") {
        throw new _Error("[SourceMonkey] GM_addValueChangeListener: callback must be a function");
      }
      var s = ensureStore(scriptId);
      if (!s.listeners) s.listeners = _ObjectCreate(null);
      var id = String(s.nextListenerId++);
      s.listeners[id] = { key: String(key), callback: callback };
      return id;
    },
    /* Codec access, for tests and for anything that needs to reason
       about the stored form of a value without going through a
       write. Not part of the GM_* API surface. */
    encodeValue: encodeValue,
    decodeValue: decodeValue,
    removeValueChangeListener: function (scriptId, listenerId) {
      var s = stores[scriptId];
      if (!s || !s.listeners) return;
      var key = String(listenerId);
      if (_hasOwn.call(s.listeners, key)) delete s.listeners[key];
    },
  };

  /* ---------- DOM injection (GM_addStyle / GM_addElement) ----------

     In USER_SCRIPT world the page CSP doesn't govern what a script
     inserts: styles apply regardless, and <script> elements are
     checked against the world CSP instead (see ensureWorldConfigured
     in injector.ts). So a script on a strict-CSP page like
     github.com / google.com can still inject styles and scripts that
     the page itself couldn't.

     In MAIN world there is no exemption: the page's CSP applies to
     what the script inserts, so a strict `style-src` accepts the
     <style> element and silently ignores its rules. TM and VM have
     the same limitation in page context. We can't work around it
     here, but we can say so: a <style> whose `.sheet` is still null
     after it's in the document was blocked, and that is reported
     once per script as a warning in its Log (see `reportBlockedStyle`).

     Both helpers return the created element so userscripts can hold a
     reference and tweak it later. */
  /* Lookup a parent fallback. `document.head` doesn't exist before
     document-start completes parsing; for very-early runAt we fall
     back to `document.documentElement` (always present by the time
     a userScript can run). Used by `GM_addStyle`, which always
     wants <head>. */
  function defaultParent() { return document.head || document.documentElement; }

  /* Tag-aware default parent for GM_addElement. Matches VM: tags
     that semantically live in <head> (SCRIPT, STYLE, LINK, META,
     TITLE, BASE) go there; anything else lands in <body>. TITLE and
     BASE are head-only per the HTML spec; including them matches
     VM's list. Falls back through head / documentElement when body
     doesn't exist yet (very-early runAt). Caller passes tagName
     as-is; uppercased here so callers using lower/mixed case still
     hit the right bucket.

     TM diverges here: it appends to <head> regardless of tag, so a
     no-parent GM_addElement('p', ...) lands in <head> under TM. We
     follow VM's tag-aware rule because it's more useful for non-head
     tags and matches what most callers expect; cross-manager tests
     don't pin the parent for non-head tags. See
     docs/cross-manager-test-results.md. */
  function defaultParentFor(tagName) {
    var u = String(tagName).toUpperCase();
    if (
      u === "SCRIPT" || u === "STYLE" || u === "LINK" ||
      u === "META"   || u === "TITLE" || u === "BASE"
    ) {
      return document.head || document.documentElement;
    }
    return document.body || document.head || document.documentElement;
  }

  /* Apply one attribute. Boolean false means "omit the attribute"
     (matches TM): writing `setAttribute('disabled', 'false')` would
     leave a button still disabled — that's not what callers expect.
     true serializes as the empty string per HTML spec. */
  function applyAttr(el, name, value) {
    if (value === false) return; /* boolean-attr: omit */
    var stringValue = (value === true) ? "" : String(value);
    if (_Element_setAttribute) {
      _Element_setAttribute.call(el, name, stringValue);
    } else {
      el.setAttribute(name, stringValue);
    }
  }

  /* Once per script per document: a page with a strict CSP blocks
     every style the script adds, and one line says it. */
  var blockedStyleReported = {};
  function reportBlockedStyle(scriptId, api) {
    if (blockedStyleReported[scriptId]) return;
    blockedStyleReported[scriptId] = true;
    /* Same wording the SW puts in the Log (`cspBlockedStyleMessage` in
       background.ts); the SW words its own line rather than trusting
       a page-reachable string. */
    var text = "The page's Content Security Policy blocked the style " + api +
      " added, so its rules don't apply. A script running in the page (unsafeWindow," +
      " @inject-into page, or @grant none) gets no CSP exemption; only an isolated script does.";
    try { console.info("[SourceMonkey:" + scriptId + "] " + text); } catch (_e) {}
    transportSend({ type: "sm:gm-dom-blocked", scriptId: scriptId, api: api }).catch(function () {});
  }
  /* A <style> that is in the document but has no sheet was refused by
     CSP: the parser builds the sheet synchronously on insertion, so a
     null `.sheet` on a connected element is the block itself, not a
     timing gap (an empty <style> gets an empty sheet, not null). A
     non-CSS `type` also yields no sheet, with no CSP involved, so that
     one is left alone. */
  function styleWasBlocked(el) {
    try {
      if (el.type && !/^text\/css$/i.test(el.type)) return false;
      return el.isConnected === true && el.sheet === null;
    } catch (_e) { return false; }
  }

  var dom = {
    /* GM_addStyle(css): create <style>, set its textContent, attach
       to (document.head || document.documentElement). Returns the
       style element. */
    addStyle: function (scriptId, css) {
      var el = _docCreateElement ? _docCreateElement("style") : document.createElement("style");
      el.textContent = String(css == null ? "" : css);
      var parent = defaultParent();
      if (parent) {
        if (_Node_appendChild) _Node_appendChild.call(parent, el);
        else parent.appendChild(el);
        if (styleWasBlocked(el)) reportBlockedStyle(scriptId, "GM_addStyle");
      }
      return el;
    },
    /* GM_addElement: two signatures (both call shapes match TM/VM;
       the no-parent default-parent rule matches VM — TM always
       appends to <head>, see defaultParentFor above):
         GM_addElement(tagName, attrs?) -> appends to head for
           script/style/link/meta/title/base, otherwise to body
         GM_addElement(parent, tagName, attrs?) -> appends to parent

       attrs is a plain object of attribute names → string values.
       `textContent` is a recognized pseudo-attribute (TM convention).
       `innerHTML` is deliberately NOT recognized — callers can set it
       on the returned element themselves; auto-parsing HTML through
       the GM API would defeat the CSP-exempt-but-still-sanitized
       story.

       The two-arg form decides between tag-string and parent-node by
       checking arg1 for a `.nodeType` — DOM nodes have one, strings
       don't. `typeof === "object"` keeps strings (which have `.length`
       and look array-ish to a sloppy check) out of the parent branch. */
    addElement: function (scriptId, arg1, arg2, arg3) {
      var parent, tagName, attrs;
      if (arg1 && typeof arg1 === "object" && typeof arg1.nodeType === "number") {
        parent = arg1; tagName = arg2; attrs = arg3;
      } else {
        parent = null; tagName = arg1; attrs = arg2;
      }
      if (tagName == null || (typeof tagName === "string" && tagName.trim() === "")) {
        throw new _Error("[SourceMonkey] GM_addElement: tag name is required");
      }
      if (!parent) parent = defaultParentFor(tagName);
      var el = _docCreateElement ? _docCreateElement(String(tagName)) : document.createElement(String(tagName));
      if (attrs && typeof attrs === "object") {
        var keys = _ObjectKeys(attrs);
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          if (k === "textContent") {
            el.textContent = String(attrs[k] == null ? "" : attrs[k]);
          } else {
            try { applyAttr(el, k, attrs[k]); } catch (_e) {}
          }
        }
      }
      if (parent) {
        if (_Node_appendChild) _Node_appendChild.call(parent, el);
        else parent.appendChild(el);
        if (String(tagName).toUpperCase() === "STYLE" && styleWasBlocked(el)) {
          reportBlockedStyle(scriptId, "GM_addElement");
        }
      }
      return el;
    },
  };

  /* ---------- @resource lookups (GM_getResourceText / GM_getResourceURL) ----------

     Per-script cache of declared `@resource` entries, baked into the
     wrapper as `{name: {b64, ct}}` and primed via `resource.init` in
     the prelude (see gm-bindings.ts). Both reads are lazy:
       - getText decodes base64 → UTF-8 on first call, caches the
         decoded string per name.
       - getUrl decodes base64 → Blob → blob: URL on first call,
         caches the URL per name. Subsequent calls return the same
         URL (matches TM — userscripts that compare `===` between two
         GM_getResourceURL calls get the same value).
     The blob: URL is alive for the document's lifetime; we don't
     URL.revokeObjectURL on bfcache since the wrapper runtime itself
     stays around. */
  var resourceBoxes = {};  /* scriptId -> { byName, textCache, urlCache } */
  function ensureResourceBox(scriptId) {
    var b = resourceBoxes[scriptId];
    if (b) return b;
    b = {
      byName: _ObjectCreate(null),
      textCache: _ObjectCreate(null),
      urlCache: _ObjectCreate(null),
    };
    resourceBoxes[scriptId] = b;
    return b;
  }
  /* Shared base64 → Uint8Array decoder. The XHR subsystem has its own
     copy at the bottom of the file; we duplicate the small helper
     here so the @resource path doesn't depend on a function declared
     later (which would be hoisted in JS but is harder to read). */
  function _resDecodeBase64(b64) {
    var binary = atob(b64);
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  var resource = {
    /* Called from the wrapper's prelude with the scriptId and the
       resource map { name: { b64, ct } } baked into the wrapper at
       register time. Defensive copy so the userscript can't mutate
       the literal we baked in. Calling init twice for the same
       scriptId (a hot-reload bridge, a debugging surface, …) is
       idempotent: the second call REPLACES the box. Stale entries
       from a prior init don't leak, and the lazy text/url caches
       are reset alongside. */
    init: function (scriptId, items) {
      var b = ensureResourceBox(scriptId);
      b.byName = _ObjectCreate(null);
      b.textCache = _ObjectCreate(null);
      b.urlCache = _ObjectCreate(null);
      if (!items || typeof items !== "object") return;
      var keys = _ObjectKeys(items);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var v = items[k];
        if (v && typeof v === "object") {
          b.byName[k] = { b64: String(v.b64 || ""), ct: String(v.ct || "") };
        }
      }
    },
    /* GM_getResourceText(name): return the resource body as a UTF-8
       string. Returns undefined when the name isn't declared. Decode
       is non-fatal — a binary resource asked for as text returns
       mojibake, matching TM/VM rather than throwing. */
    getText: function (scriptId, name) {
      var b = resourceBoxes[scriptId];
      if (!b) return undefined;
      var key = String(name);
      if (_hasOwn.call(b.textCache, key)) return b.textCache[key];
      if (!_hasOwn.call(b.byName, key)) return undefined;
      var bytes = _resDecodeBase64(b.byName[key].b64);
      var text;
      try {
        text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      } catch (_de) {
        text = "";
      }
      b.textCache[key] = text;
      return text;
    },
    /* GM_getResourceURL(name): mint (and cache) a blob: URL for the
       resource bytes, with the stored Content-Type as the blob MIME.
       Empty CT falls back to application/octet-stream so the browser
       has *something* to dispatch on (matches VM). Returns undefined
       when the name isn't declared. */
    getUrl: function (scriptId, name) {
      var b = resourceBoxes[scriptId];
      if (!b) return undefined;
      var key = String(name);
      if (_hasOwn.call(b.urlCache, key)) return b.urlCache[key];
      if (!_hasOwn.call(b.byName, key)) return undefined;
      if (!_Blob || !_URL_createObjectURL) return undefined;
      var entry = b.byName[key];
      var bytes = _resDecodeBase64(entry.b64);
      var mime = entry.ct || "application/octet-stream";
      var blob;
      try { blob = new _Blob([bytes], { type: mime }); }
      catch (_be) { return undefined; }
      var url;
      try { url = _URL_createObjectURL(blob); }
      catch (_ue) { return undefined; }
      b.urlCache[key] = url;
      return url;
    },
  };

  /* ---------- GM_xmlhttpRequest ----------

     Per-script state: an `activeRequests` map keyed by request id,
     holding the user's onload/onerror/etc. callbacks. The runtime
     registers an `onPush` handler that routes `sm:gm-xhr-event`
     messages back to the originating request. */
  var activeRequests = _ObjectCreate(null);
  var _xhrNextId = 1;

  /* Decode the SW's base64 binary payload into raw bytes (Uint8Array).
     Used for blob/arraybuffer/document responseTypes. */
  function decodeBase64(b64) {
    var binary = atob(b64);
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /* Materialize the binary payload into the user-visible shape for the
     requested responseType. Mutates `response` in place — adds a
     real `response` field of the right type. */
  function rebuildBinary(response, requestedType) {
    if (typeof response.responseBase64 !== "string") return;
    var bytes = decodeBase64(response.responseBase64);
    var mime = response.responseMimeType || "";
    if (requestedType === "arraybuffer") {
      response.response = bytes.buffer;
    } else if (requestedType === "blob") {
      response.response = new Blob([bytes], { type: mime });
    } else if (requestedType === "document") {
      /* Parse as text, then DOMParser. Fallback MIME for parsing
         when the server didn't send one. */
      var text = "";
      try {
        text = new TextDecoder("utf-8").decode(bytes);
      } catch (_de) {
        text = String.fromCharCode.apply(null, bytes);
      }
      var parseType = mime.indexOf("xml") !== -1 ? "application/xml" : "text/html";
      try {
        response.response = new DOMParser().parseFromString(text, parseType);
      } catch (_pe) {
        response.response = null;
      }
      /* Surface the underlying text so userscripts can read it. */
      response.responseText = text;
    }
  }

  function dispatchXhrEvent(id, event) {
    var entry = activeRequests[id];
    if (!entry) return;
    /* Free the slot first so callbacks that re-issue another XHR
       don't leak the previous entry. Every kind in GmXhrEvent is
       terminal — load, error, timeout, abort all settle the
       request and free the slot here. */
    delete activeRequests[id];
    if (entry.ttlTimer) {
      try { clearTimeout(entry.ttlTimer); } catch (_te) {}
    }
    if (event.kind === "load" && entry.responseType) {
      rebuildBinary(event.response, entry.responseType);
    }
    /* Every terminal event leaves the request DONE, so the object each
       callback sees carries `readyState: 4` (scripts gate on it, e.g.
       `if (r.readyState === 4)`). Non-load events have no response, so
       they get the empty fields of a failed XMLHttpRequest (`status: 0`,
       empty text) as TM/VM do: a shared handler that reads
       `r.responseText` after checking readyState must not crash. A load
       with no response object (never sent today) falls back to the
       same empty shape rather than throwing before any callback. */
    var payload;
    if (event.kind === "load" && event.response && typeof event.response === "object") {
      payload = event.response;
      payload.readyState = 4;
    } else {
      payload = emptyXhrResponse(entry);
      if (event.kind === "error") payload.error = event.message;
    }
    var cb;
    if (event.kind === "load") cb = entry.onload;
    else if (event.kind === "error") cb = entry.onerror;
    else if (event.kind === "timeout") cb = entry.ontimeout;
    else if (event.kind === "abort") cb = entry.onabort;
    /* `onreadystatechange` fires before the terminal callback, the
       order XMLHttpRequest (and so Tampermonkey/Violentmonkey) uses:
       readystatechange(4), then load/error/timeout/abort. Only the
       final state is reported; the worker sends one event per request,
       so states 1-3 never reach the page. */
    callXhrCallback(entry.onreadystatechange, payload);
    callXhrCallback(cb, payload);
  }

  function emptyXhrResponse(entry) {
    return {
      readyState: 4,
      status: 0,
      statusText: "",
      responseText: "",
      response: null,
      responseHeaders: "",
      finalUrl: entry.url,
    };
  }

  function callXhrCallback(cb, payload) {
    if (typeof cb !== "function") return;
    try {
      cb(payload);
    } catch (e) {
      try { console.info("[SourceMonkey] XHR callback threw:", e); } catch (_e) {}
    }
  }

  /* Hard cap on how long we hold a per-request entry without hearing
     back from the SW. Without this, an SW crash (or any non-response)
     leaks the entry forever and the userscript never sees a terminal
     event. We synthesize an `error` after the cap so the script's
     onerror has a shot at handling it. Per-request, refreshed when
     the entry is created. */
  var XHR_PAGE_SIDE_TTL_MS = 5 * 60 * 1000; /* 5 minutes */
  onPush(function (msg) {
    if (msg.type !== "sm:gm-xhr-event") return;
    if (typeof msg.id !== "string" || !msg.event) return;
    dispatchXhrEvent(msg.id, msg.event);
  });

  /* A URL argument as a string. Scripts pass `URL` objects too (and
     VM converts any non-string `url` with String()), so an object with
     a string `href` is taken as its href. Not one with a `url` of its
     own: that's GM_download's details object. Anything else is left
     as it is, for the caller's "url required" check. */
  function urlArg(v) {
    return v !== null && typeof v === "object" && typeof v.href === "string" && !("url" in v) ? v.href : v;
  }

  var xhr = {
    /* GM_xmlhttpRequest(details) — kicks off the request, returns
       `{abort}` immediately. The user's onload/onerror/ontimeout/
       onabort/onreadystatechange callbacks come from `details` and
       are stored locally (callbacks aren't serializable across the
       bridge). */
    start: function (scriptId, details) {
      if (!details || typeof details !== "object") {
        throw new _Error("[SourceMonkey] GM_xmlhttpRequest: details object required");
      }
      var url = urlArg(details.url);
      if (typeof url !== "string" || !url) {
        throw new _Error("[SourceMonkey] GM_xmlhttpRequest: url required");
      }
      var id = "xhr-" + (_xhrNextId++) + "-" + Math.random().toString(36).slice(2, 10);
      var entry = {
        onload: details.onload,
        onerror: details.onerror,
        ontimeout: details.ontimeout,
        onabort: details.onabort,
        onreadystatechange: details.onreadystatechange,
        url: url,
        responseType: typeof details.responseType === "string" ? details.responseType : "",
        ttlTimer: null,
      };
      activeRequests[id] = entry;
      entry.ttlTimer = setTimeout(function () {
        /* TTL elapsed without a terminal event. Synthesize an error
           so the userscript at least sees a settled state instead of
           silently dangling. */
        /* Minutes, not the raw millisecond count — a six-digit number
           is not something a reader can weigh. "gave up on", not
           "dropped": this only stops the page waiting, the SW-side
           fetch is never aborted and may still complete. */
        dispatchXhrEvent(id, {
          kind: "error",
          message: "[SourceMonkey] GM_xmlhttpRequest: no response from the extension after "
            + (XHR_PAGE_SIDE_TTL_MS / 60000) + " minutes, so this request was given up on",
        });
      }, XHR_PAGE_SIDE_TTL_MS);
      /* Build the serializable request payload — strip callbacks
         and other non-cloneable fields. */
      var request = {
        method: typeof details.method === "string" ? details.method : "GET",
        url: url,
        headers: (details.headers && typeof details.headers === "object") ? details.headers : undefined,
        data: details.data,
        timeout: typeof details.timeout === "number" ? details.timeout : undefined,
        responseType: typeof details.responseType === "string" ? details.responseType : undefined,
        /* Truthy, not `=== true`: TM/VM both treat `anonymous` as a
           truthy flag, and a privacy opt-out has to fail toward
           omitting credentials — reading `anonymous: 1` as "send my
           cookies anyway" is the wrong direction to get it wrong. */
        anonymous: details.anonymous ? true : undefined,
      };
      api.sendAsync({
        type: "sm:gm-xhr-start",
        id: id,
        scriptId: scriptId,
        request: request,
      }).then(function (reply) {
        /* Anything but an explicit ack is a refusal — the SW's bridge
           gate replies `{ok:false, error}`, and the bridge's own
           fallback when the SW is unreachable carries no `ok` at all.
           Settle now rather than letting the TTL above do it. */
        if (reply && reply.ok === true) return;
        var why = (reply && reply.error) || "SourceMonkey did not accept the request";
        dispatchXhrEvent(id, { kind: "error", message: "[SourceMonkey] GM_xmlhttpRequest: " + why });
      }, function (err) {
        /* The send itself failed (chrome.runtime not available).
           Synthesize an error event for the caller. */
        dispatchXhrEvent(id, { kind: "error", message: String(err && err.message || err) });
      });
      return {
        abort: function () {
          if (!activeRequests[id]) return;
          api.sendAsync({ type: "sm:gm-xhr-abort", id: id }).catch(function () {});
          /* Local abort event — match TM/VM, which fire `onabort`
             immediately on the caller's side rather than waiting
             for an SW round-trip. */
          dispatchXhrEvent(id, { kind: "abort" });
        },
      };
    },
  };

  /* ---------- GM_log ----------

     Page-side console wrapper that ALSO fans the call out to the SW
     so it lands on the script's Log tab in the collections-page viewer.
     Two channels:
       1. console.log to the page DevTools — unchanged, with a
          "[SourceMonkey:<scriptId>]" prefix for grep-ability. The
          original args are passed through (not stringified) so
          DevTools formatters (%c, %o, object inspectors) still work.
       2. sm:gm-log to the SW (fire-and-forget). The args have to be
          stringified at the page boundary because
          chrome.runtime.sendMessage can only carry
          structured-cloneable data and the Log tab is text-only
          anyway.

     We capture scriptId from the binding rather than calling back to
     the SW for the script's @name on every log line. Return value is
     `undefined` to match TM/VM's GM_log signature. */
  var _consoleLog = null;
  try {
    if (typeof console !== "undefined" && typeof console.log === "function") {
      _consoleLog = console.log.bind(console);
    }
  } catch (_clogE) {}
  /* Best-effort text rendering of one argument. Strings pass through.
     null / undefined render as their literal. Primitives use String().
     Objects try JSON.stringify (with a try/catch for cycles). On any
     failure fall back to String() which yields something like
     "[object Object]" — better than dropping the entry entirely. */
  var _renderArg = function (v) {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    var t = typeof v;
    if (t === "string") return v;
    if (t === "number" || t === "boolean" || t === "bigint") return String(v);
    /* Functions: JSON.stringify returns the literal value `undefined`
       (not a string, not a throw) for functions, which would coerce
       to "undefined" via Array.join and look like the script logged
       nothing. Handle explicitly so the user sees something useful. */
    if (t === "function") return "[Function: " + (v.name || "anonymous") + "]";
    if (v instanceof Error) {
      var stack = "";
      try { stack = v.stack ? "\n" + v.stack : ""; } catch (_eS) {}
      return String(v.message || v) + stack;
    }
    try { return JSON.stringify(v); } catch (_eJ) {}
    try { return String(v); } catch (_eS2) { return "[unserializable]"; }
  };
  var _renderArgs = function (args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) parts.push(_renderArg(args[i]));
    return parts.join(" ");
  };
  var log = {
    write: function (scriptId, args) {
      /* Page-console fan-out (preserve formatter args). */
      if (_consoleLog) {
        var arr = ["[SourceMonkey:" + scriptId + "]"];
        for (var i = 0; i < args.length; i++) arr.push(args[i]);
        try { _consoleLog.apply(null, arr); } catch (_e) {}
      }
      /* SW fan-out (text-only). __SM_GM__.sendAsync is the
         chrome.runtime.sendMessage / bridge-event helper the
         async APIs use; here we fire-and-forget so the script's GM_log
         call stays sync. */
      try {
        var text = _renderArgs(args);
        if (window.__SM_GM__ && typeof window.__SM_GM__.sendAsync === "function") {
          var p = window.__SM_GM__.sendAsync({ type: "sm:gm-log", scriptId: scriptId, message: text });
          if (p && typeof p.catch === "function") p.catch(function () {});
        }
      } catch (_eS) {}
    },
  };

  /* ---------- GM_openInTab ----------

     Open a URL in a new tab via the SW (chrome.tabs.create). Returns
     a control object with:
       - close()    — request the tab be closed
       - closed     — boolean, true once the SW reports the tab closed
       - onclose    — callback fired when the SW reports the tab closed

     The SW assigns the chrome.tabs ID asynchronously, but the script
     wants a control handle synchronously. We use a per-call request
     id (tab-<n>-<rand>); the SW echoes it back on creation and on
     close, and we route by it locally. */
  var openTabs = _ObjectCreate(null);  /* requestId -> control entry */
  var _tabNextId = 1;
  var tab = {
    open: function (scriptId, url, options) {
      url = urlArg(url);
      if (typeof url !== "string" || !url) {
        throw new _Error("[SourceMonkey] GM_openInTab: url required");
      }
      /* TM accepts a boolean `loadInBackground` shortcut OR an
         options object {active, insert, setParent, loadInBackground}.
         A `true` boolean means "background" (i.e. active:false). */
      var active = true;
      var insert = false;
      if (typeof options === "boolean") {
        active = !options;
      } else if (options && typeof options === "object") {
        if (typeof options.active === "boolean") active = options.active;
        else if (typeof options.loadInBackground === "boolean") active = !options.loadInBackground;
        if (typeof options.insert === "boolean") insert = options.insert;
      }
      var requestId = "tab-" + (_tabNextId++) + "-" + Math.random().toString(36).slice(2, 10);
      var entry = {
        closed: false,
        onclose: null,
        tabId: null,
      };
      openTabs[requestId] = entry;
      var control = {
        get closed() { return entry.closed; },
        set onclose(cb) { entry.onclose = (typeof cb === "function") ? cb : null; },
        get onclose() { return entry.onclose; },
        close: function () {
          if (entry.closed) return;
          api.sendAsync({
            type: "sm:gm-tab-close",
            requestId: requestId,
          }).catch(function () {});
        },
      };
      api.sendAsync({
        type: "sm:gm-tab-open",
        scriptId: scriptId,
        requestId: requestId,
        url: url,
        active: active,
        insert: insert,
      }).then(function (reply) {
        if (reply && reply.ok && typeof reply.tabId === "number") {
          entry.tabId = reply.tabId;
        } else {
          /* SW couldn't create the tab, refused to, or was never
             reached (the bridge's fallback reply carries no `ok`) —
             surface the reason so a userscript debugging an
             unexpected fast-close has a signal, then synthesize the
             close so onclose fires. */
          var why = (reply && reply.error) || "SourceMonkey did not accept the request";
          try { console.info("[SourceMonkey] GM_openInTab failed:", why); } catch (_e) {}
          dispatchTabClose(requestId);
        }
      }, function (err) {
        try { console.info("[SourceMonkey] GM_openInTab send failed:", err && err.message || err); } catch (_e) {}
        dispatchTabClose(requestId);
      });
      return control;
    },
  };
  function dispatchTabClose(requestId) {
    var entry = openTabs[requestId];
    if (!entry || entry.closed) return;
    entry.closed = true;
    delete openTabs[requestId];
    var cb = entry.onclose;
    if (typeof cb === "function") {
      try { cb(); } catch (e) {
        try { console.info("[SourceMonkey] GM_openInTab onclose threw:", e); } catch (_e) {}
      }
    }
  }

  /* ---------- GM_notification ----------

     Per-call: page-side request id (notif-<n>-<rand>) keyed to the
     user's onclick / ondone callbacks. SW dispatches chrome.notifications
     events back via chrome.runtime.sendMessage.

     Two signatures (matches TM):
       GM_notification(details, ondone?)
         details = { text, title, image, onclick, ondone, timeout, silent, tag }
       GM_notification(text, title?, image?, onclick?)  -- legacy positional

     We normalize to a single details payload + per-call callbacks. */
  var openNotifications = _ObjectCreate(null);  /* requestId -> {onclick, ondone} */
  var _notifNextId = 1;
  var notification = {
    show: function (scriptId, args) {
      var details = null;
      var onclick = null;
      var ondone = null;
      if (args[0] && typeof args[0] === "object") {
        /* details shape — always taken when first arg is an object,
           regardless of how many positional follow it. A second arg,
           if it's a function, is treated as `ondone` (TM's
           shorthand). Anything else after the details object is
           ignored to avoid a 2-arg `(details, "extra")` call
           falling through to the legacy positional branch and
           stringifying the details object as the notification
           text. */
        var d = args[0];
        details = {
          text: d.text != null ? String(d.text) : "",
          title: d.title != null ? String(d.title) : "",
          image: d.image != null ? String(d.image) : "",
          timeout: typeof d.timeout === "number" ? d.timeout : 0,
          silent: !!d.silent,
          tag: d.tag != null ? String(d.tag) : "",
        };
        if (typeof d.onclick === "function") onclick = d.onclick;
        if (typeof d.ondone === "function") ondone = d.ondone;
        if (typeof args[1] === "function") ondone = args[1];
      } else {
        /* legacy positional (text, title?, image?, onclick?) */
        details = {
          text: args[0] != null ? String(args[0]) : "",
          title: args[1] != null ? String(args[1]) : "",
          image: args[2] != null ? String(args[2]) : "",
          timeout: 0,
          silent: false,
          tag: "",
        };
        if (typeof args[3] === "function") onclick = args[3];
      }
      if (!details.text) {
        return _Promise.reject(new _Error("[SourceMonkey] GM_notification: `text` is required"));
      }
      var requestId = "notif-" + (_notifNextId++) + "-" + Math.random().toString(36).slice(2, 10);
      openNotifications[requestId] = { onclick: onclick, ondone: ondone };
      return api.sendAsync({
        type: "sm:gm-notification-show",
        scriptId: scriptId,
        requestId: requestId,
        details: details,
      }).then(function (reply) {
        if (!reply || !reply.ok) {
          delete openNotifications[requestId];
          throw new _Error("[SourceMonkey] GM_notification: " + ((reply && reply.error) || "show failed"));
        }
        return reply.notificationId;
      }, function (err) {
        delete openNotifications[requestId];
        throw err;
      });
    },
  };
  function dispatchNotificationEvent(requestId, event) {
    var entry = openNotifications[requestId];
    if (!entry) return;
    /* `clicked` events are NOT terminal — the user may click then the
       notification auto-closes; we want ondone to fire too. Only
       `closed` (chrome's "ondone" surrogate) frees the slot. */
    if (event === "clicked") {
      var cb = entry.onclick;
      if (typeof cb === "function") {
        try { cb(); } catch (e) {
          try { console.info("[SourceMonkey] GM_notification onclick threw:", e); } catch (_e) {}
        }
      }
    } else if (event === "closed") {
      delete openNotifications[requestId];
      var cb2 = entry.ondone;
      if (typeof cb2 === "function") {
        try { cb2(); } catch (e) {
          try { console.info("[SourceMonkey] GM_notification ondone threw:", e); } catch (_e) {}
        }
      }
    }
  }

  /* ---------- GM_download ----------

     Two call shapes (TM):
       GM_download(details)   details = { url, name, headers, saveAs,
                                          timeout, onload, onerror,
                                          onprogress, ontimeout }
       GM_download(url, name)
     Returns `{abort}` synchronously — TM's documented return.

     Two transports, chosen by URL scheme:
       - http(s) -> the SW's chrome.downloads wrapper (real download
         manager entry: Save-As, progress, resume, danger prompts).
       - blob: / data: -> an in-page `<a download>` click. A page-minted
         blob URL isn't resolvable from the extension's context and a
         data: URL of arbitrary size has no business crossing the
         message boundary. Popular media-downloader scripts pass
         `URL.createObjectURL(...)` here, so this path matters. It's
         also exactly what such a script would do without any @grant,
         so it grants no new capability.

     Callbacks stay page-side (not serializable) keyed by a per-call
     request id, same as GM_xmlhttpRequest. */
  var activeDownloads = _ObjectCreate(null);
  var _downloadNextId = 1;
  /* Delay before the anchor path synthesizes its `load` event. The
     click starts the transfer synchronously, but scripts commonly
     call URL.revokeObjectURL(...) from onload — revoking in the same
     task as the click has been known to race the download manager's
     grab of the blob. A short delay costs nothing perceptible and
     keeps that pattern working. */
  var ANCHOR_LOAD_DELAY_MS = 250;

  /* TM's `details` normalized into one shape, plus the per-call
     callbacks. Throws (synchronously, like GM_xmlhttpRequest) when
     there's no URL to download. */
  function normalizeDownloadArgs(detailsOrUrl, name) {
    var d = null;
    detailsOrUrl = urlArg(detailsOrUrl);
    if (typeof detailsOrUrl === "string") {
      d = { url: detailsOrUrl, name: name };
    } else if (detailsOrUrl && typeof detailsOrUrl === "object") {
      d = detailsOrUrl;
    } else {
      throw new _Error("[SourceMonkey] GM_download: details object or url required");
    }
    var url = urlArg(d.url);
    if (typeof url !== "string" || !url) {
      throw new _Error("[SourceMonkey] GM_download: url required");
    }
    return {
      /* Resolve against the document like TM does, so a relative
         `GM_download("/files/a.zip", ...)` works. Resolving also
         normalizes the scheme's case and strips stray whitespace, which
         is what the transport check below keys off. An unparseable URL
         falls through unchanged and is refused SW-side. */
      url: resolveDownloadUrl(url),
      name: d.name != null ? String(d.name) : "",
      headers: plainHeaders(d.headers),
      saveAs: !!d.saveAs,
      timeout: typeof d.timeout === "number" ? d.timeout : 0,
      onload: typeof d.onload === "function" ? d.onload : null,
      onerror: typeof d.onerror === "function" ? d.onerror : null,
      ontimeout: typeof d.ontimeout === "function" ? d.ontimeout : null,
      onprogress: typeof d.onprogress === "function" ? d.onprogress : null,
      /* Not part of TM's documented surface — a SourceMonkey extension
         so abort() can be observed the same way GM_xmlhttpRequest
         reports it. Scripts written for TM don't set it and get the
         documented onerror(download_canceled) instead. */
      onabort: typeof d.onabort === "function" ? d.onabort : null,
    };
  }

  function resolveDownloadUrl(url) {
    try {
      return new URL(url, location.href).href;
    } catch (_re) {
      return url;
    }
  }

  /* Flatten the caller's headers into a plain {string: string} map.
     Anything else (functions, DOM nodes, symbols as values) would make
     chrome.runtime.sendMessage throw "could not be cloned" and the
     script would be told the API isn't supported when the real problem
     is its own `details`. */
  function plainHeaders(headers) {
    if (!headers || typeof headers !== "object") return undefined;
    var out = null;
    var keys = _ObjectKeys(headers);
    for (var i = 0; i < keys.length; i++) {
      var v = headers[keys[i]];
      if (typeof v === "function" || (v !== null && typeof v === "object")) continue;
      if (!out) out = {};
      out[keys[i]] = String(v);
    }
    return out || undefined;
  }

  /* blob: and data: go through the page. Compares against the parsed
     scheme (not a string prefix) so `DATA:` / a leading-space URL isn't
     misrouted to the SW, which would refuse it. */
  function isInPageDownloadUrl(url) {
    var scheme = "";
    try { scheme = new URL(url).protocol; } catch (_pe) { return false; }
    return scheme === "blob:" || scheme === "data:";
  }

  /* blob: / data: transport. Appends a hidden anchor, clicks it, and
     removes it. Returns null on success or an error message string.
     Falls back to the live DOM methods when the shim cache came up
     empty (it can, on exotic hosts) rather than throwing an unhelpful
     "_docCreateElement is not a function" at the script. */
  function downloadViaAnchor(url, name) {
    try {
      var a = _docCreateElement ? _docCreateElement("a") : document.createElement("a");
      a.href = url;
      /* An empty `download` still forces a download (rather than a
         navigation); the browser derives the name itself. */
      a.download = name || "";
      a.style.display = "none";
      var parent = document.body || document.documentElement;
      if (!parent) return "no document to append the download anchor to";
      if (_Node_appendChild) _Node_appendChild.call(parent, a);
      else parent.appendChild(a);
      try { a.click(); } finally {
        try { parent.removeChild(a); } catch (_re2) {}
      }
      return null;
    } catch (e) {
      return String((e && e.message) || e);
    }
  }

  var download = {
    start: function (scriptId, detailsOrUrl, name) {
      var d = normalizeDownloadArgs(detailsOrUrl, name);
      var requestId = "dl-" + (_downloadNextId++) + "-" + Math.random().toString(36).slice(2, 10);
      var inPage = isInPageDownloadUrl(d.url);
      activeDownloads[requestId] = {
        onload: d.onload,
        onerror: d.onerror,
        ontimeout: d.ontimeout,
        onprogress: d.onprogress,
        onabort: d.onabort,
        /* "page" downloads have nothing to cancel in the SW. */
        transport: inPage ? "page" : "sw",
      };
      if (inPage) {
        var failure = downloadViaAnchor(d.url, d.name);
        if (failure !== null) {
          /* Deferred, not inline: firing onerror during the
             GM_download(...) call would run the handler before the
             caller has the control object, breaking the common
             `var ctl = GM_download({onerror: function () { ctl.abort(); }})`
             shape. Every other path here settles asynchronously. */
          setTimeout(function () {
            dispatchDownloadEvent(requestId, {
              kind: "error",
              error: "not_succeeded",
              details: { message: failure },
            });
          }, 0);
        } else {
          setTimeout(function () {
            /* The anchor path has no completion signal — the browser
               owns the transfer from the click on. We report `load`
               once the click has been handed off. Documented
               deviation; see docs/supported-GM-APIs.md. */
            dispatchDownloadEvent(requestId, {
              kind: "load",
              downloadId: -1,
              filename: d.name,
              finalUrl: d.url,
              totalBytes: 0,
            });
          }, ANCHOR_LOAD_DELAY_MS);
        }
      } else {
        api.sendAsync({
          type: "sm:gm-download-start",
          scriptId: scriptId,
          requestId: requestId,
          url: d.url,
          name: d.name,
          headers: d.headers,
          saveAs: d.saveAs,
          timeout: d.timeout,
          wantsProgress: !!d.onprogress,
        }).then(function (reply) {
          /* Refused by the SW's bridge gate, or never reached it (the
             bridge's fallback reply carries no `ok`). Settle now. */
          if (reply && reply.ok === true) return;
          dispatchDownloadEvent(requestId, {
            kind: "error",
            error: "not_supported",
            details: { message: (reply && reply.error) || "SourceMonkey did not accept the request" },
          });
        }, function (err) {
          /* Couldn't even reach the SW. TM calls that `not_supported`. */
          dispatchDownloadEvent(requestId, {
            kind: "error",
            error: "not_supported",
            details: { message: String((err && err.message) || err) },
          });
        });
      }
      return {
        abort: function () {
          var entry = activeDownloads[requestId];
          if (!entry) return;
          if (entry.transport === "sw") {
            api.sendAsync({ type: "sm:gm-download-abort", requestId: requestId }).catch(function () {});
          }
          /* Settle locally right away — matches GM_xmlhttpRequest's
             abort, which doesn't wait for the SW round-trip. */
          dispatchDownloadEvent(requestId, {
            kind: "error",
            error: "download_canceled",
            details: { current: "USER_CANCELED" },
          });
        },
      };
    },
  };

  function dispatchDownloadEvent(requestId, event) {
    var entry = activeDownloads[requestId];
    if (!entry) return;
    /* Progress is the one non-terminal event — keep the entry. */
    if (event.kind === "progress") {
      if (typeof entry.onprogress !== "function") return;
      try {
        entry.onprogress({
          lengthComputable: !!event.lengthComputable,
          loaded: event.loaded,
          total: event.total,
        });
      } catch (e) {
        try { console.info("[SourceMonkey] GM_download onprogress threw:", e); } catch (_e) {}
      }
      return;
    }
    /* Free the slot before invoking the callback so a handler that
       immediately starts another download can't collide with it. */
    delete activeDownloads[requestId];
    var cb = null;
    var arg = null;
    if (event.kind === "load") {
      cb = entry.onload;
      arg = {
        downloadId: event.downloadId,
        filename: event.filename,
        finalUrl: event.finalUrl,
        totalBytes: event.totalBytes,
      };
    } else if (event.kind === "timeout") {
      cb = entry.ontimeout;
      arg = {};
    } else if (event.kind === "error") {
      arg = { error: event.error, details: event.details || {} };
      /* A script-initiated abort prefers `onabort` when the caller
         supplied one; otherwise it lands on onerror as TM documents. */
      cb = (event.error === "download_canceled" && typeof entry.onabort === "function")
        ? entry.onabort
        : entry.onerror;
    }
    if (typeof cb !== "function") return;
    try {
      cb(arg);
    } catch (e) {
      try { console.info("[SourceMonkey] GM_download callback threw:", e); } catch (_e) {}
    }
  }

  /* ---------- GM_registerMenuCommand / GM_unregisterMenuCommand ----------

     `__SM_GM__` is a singleton per document — every userscript on the
     page shares this runtime. So the callback table MUST be keyed by
     (scriptId, commandId), not commandId alone: two scripts using the
     same explicit `{id: 'foo'}` (the documented TM/VM update-in-place
     idiom) would otherwise clobber each other's callbacks.

     SW side mirrors per (tabId, scriptId, commandId) and includes the
     scriptId in every sm:gm-menu-fire message; dispatchMenuFire below
     uses it to select the right script's callback.

     IDs: callers can pass an `options.id` to lock a stable id (TM/VM
     treat this as an update). Otherwise we mint `mc-<n>-<rand>` so
     two scripts can't accidentally collide. Returns the commandId. */
  var menuCommandsByScript = _ObjectCreate(null);  /* scriptId -> { commandId -> callback } */
  var _menuNextId = 1;
  function ensureMenuScript(scriptId) {
    var bucket = menuCommandsByScript[scriptId];
    if (bucket) return bucket;
    bucket = _ObjectCreate(null);
    menuCommandsByScript[scriptId] = bucket;
    return bucket;
  }
  var menu = {
    register: function (scriptId, name, callback, accessKeyOrOpts) {
      if (typeof callback !== "function") {
        throw new _Error("[SourceMonkey] GM_registerMenuCommand: callback must be a function");
      }
      var commandId;
      if (accessKeyOrOpts && typeof accessKeyOrOpts === "object" && accessKeyOrOpts.id != null) {
        commandId = String(accessKeyOrOpts.id);
      } else {
        commandId = "mc-" + (_menuNextId++) + "-" + Math.random().toString(36).slice(2, 10);
      }
      ensureMenuScript(scriptId)[commandId] = callback;
      var label = String(name == null ? "" : name);
      api.sendAsync({
        type: "sm:gm-menu-register",
        scriptId: scriptId,
        commandId: commandId,
        name: label,
      }).catch(function (err) {
        try { console.info("[SourceMonkey] GM_registerMenuCommand send failed:", err && err.message || err); } catch (_e) {}
      });
      return commandId;
    },
    unregister: function (scriptId, commandId) {
      var key = String(commandId);
      var bucket = menuCommandsByScript[scriptId];
      if (bucket && _hasOwn.call(bucket, key)) delete bucket[key];
      api.sendAsync({
        type: "sm:gm-menu-unregister",
        scriptId: scriptId,
        commandId: key,
      }).catch(function (err) {
        try { console.info("[SourceMonkey] GM_unregisterMenuCommand send failed:", err && err.message || err); } catch (_e) {}
      });
    },
  };
  function dispatchMenuFire(scriptId, commandId) {
    var bucket = menuCommandsByScript[scriptId];
    if (!bucket) return;
    var cb = bucket[commandId];
    if (typeof cb !== "function") return;
    try {
      cb();
    } catch (e) {
      try { console.info("[SourceMonkey] GM_registerMenuCommand callback threw:", e); } catch (_e) {}
    }
  }

  /* ---------- window.onurlchange ----------

     Tampermonkey's contract for `@grant window.onurlchange`:
       - `window.onurlchange === null` is the documented feature test,
         so the property must be ABSENT (undefined) when no script on
         this document granted it, and `null` once one has.
       - `window.addEventListener("urlchange", fn)` fires on SPA URL
         changes; the handler receives an object carrying `.url`.

     Three deliberate design choices, all explained at length in
     docs/GM-APIs.md#windowonurlchange:

     1. The signal comes from the SERVICE WORKER
        (chrome.webNavigation.onHistoryStateUpdated +
        onReferenceFragmentUpdated → an `sm:url-change` message).
        USER_SCRIPT world does not share `window.history` with the
        page, so patching pushState here would never observe the
        page's own calls. Those two webNavigation events are ALSO
        exactly what TM feeds its own urlchange from, so sourcing them
        the same way is what makes our firing rules match TM's:
        nothing on initial load, nothing on a cross-document
        navigation, one event per history update — including
        same-URL replaceState, which TM does NOT suppress.

     2. We keep our own listener table and patch `addEventListener`
        rather than dispatching a real DOM CustomEvent at `window`. A
        dispatched event on the shared window is visible to — and
        forgeable by — the page's own MAIN-world code, which would let
        a hostile page feed userscripts fabricated URLs. TM likewise
        dispatches no real event, so `document.addEventListener
        ("urlchange", …)` is dead in both.

     3. The `window.onurlchange = fn` slot takes a slot in the SAME
        list as addEventListener (TM's setter literally calls its
        sandbox add/removeEventListener), so dispatch order is true
        registration order across both forms.

     No de-duplication anywhere: every reported history update
     dispatches, matching TM. */
  var urlChangeEnabled = false;   /* some script here granted the API */
  var urlChangePatched = false;   /* the addEventListener patch is in */
  /* Registration-ordered listener list, shared by addEventListener and
     the onurlchange slot. */
  var urlChangeHandlers = [];
  /* The raw value last assigned to window.onurlchange, so the getter
     round-trips what was set (TM stores it unconditionally too). Only
     a function is ever CALLED. */
  var urlChangeOnProp = null;
  /* The slot's entry in urlChangeHandlers. Registered once, on first
     assignment, and never removed.
     Why a trampoline instead of adding the user's function directly:
     the two registration forms would otherwise alias each other. With
     `addEventListener('urlchange', f)` already in the list,
     `onurlchange = f; onurlchange = null` would splice out the
     addEventListener registration the script never revoked; and
     `removeEventListener('urlchange', f)` would stop a slot handler
     while the getter kept returning it. The indirection also pins the
     slot's dispatch position at first assignment, the way a DOM `onx`
     attribute keeps its position across re-assignment. */
  var urlChangeSlotTrampoline = null;
  var _origAddEventListener = null;
  var _origRemoveEventListener = null;

  function addUrlChangeHandler(fn) {
    if (typeof fn !== "function") return;
    if (urlChangeHandlers.indexOf(fn) !== -1) return;  /* DOM-like dedupe */
    urlChangeHandlers.push(fn);
  }
  function removeUrlChangeHandler(fn) {
    var at = urlChangeHandlers.indexOf(fn);
    if (at !== -1) urlChangeHandlers.splice(at, 1);
  }

  /* The object handed to `urlchange` listeners. TM passes a
     null-prototype plain object whose ONLY own property is `url` — not
     an Event, no `type`, no `oldURL`. Matched exactly so a script that
     does `Object.keys(info)` or `info instanceof Object` behaves the
     same here. */
  function makeUrlChangeInfo(url) {
    var info = _ObjectCreate(null);
    info.url = url;
    return info;
  }

  /* A handler that throws is logged and does not stop its siblings
     (same contract as the value-change listeners). We iterate a copy so
     a handler that unregisters itself mid-dispatch doesn't disturb the
     walk. Handlers are called with no `this` — TM does the same, so
     scripts can't come to depend on one. */
  function dispatchUrlChange(url) {
    if (urlChangeHandlers.length === 0) return;
    var handlers = urlChangeHandlers.slice();
    var info = makeUrlChangeInfo(url);
    for (var i = 0; i < handlers.length; i++) {
      var fn = handlers[i];
      try {
        fn(info);
      } catch (e) {
        try { console.info("[SourceMonkey] urlchange listener threw:", e); } catch (_le) {}
      }
    }
  }

  /* Entry point for the SW's sm:url-change message. `url` is the URL
     webNavigation reported for THIS frame; we replay it verbatim
     rather than reading location.href, so a burst of history updates
     produces one event each with its own URL (TM's behavior). */
  function noteUrlChanged(url) {
    if (!urlChangeEnabled) return;
    if (typeof url !== "string" || url === "") return;
    dispatchUrlChange(url);
  }

  /* Exact string match only. This runs on EVERY addEventListener call
     in the world once installed, so it must not coerce: `String(type)`
     throws on a Symbol and would invoke a caller-supplied `toString`
     an extra time. A `new String("urlchange")` object therefore falls
     through to the native method, which registers it for a DOM type we
     never dispatch — inert, and the caller was already off-contract. */
  function isUrlChangeType(type) {
    return type === "urlchange";
  }

  /* Define the `window.onurlchange` accessor. Starts as `null` — that
     IS the documented feature test (`window.onurlchange === null`).
     The setter records the raw value and makes sure the slot's
     trampoline is in the handler list; `= null` leaves the trampoline
     in place but idle, so clearing the slot never disturbs anyone
     else's registration. A non-function is stored (the getter
     round-trips it) but never called; TM warns in the same situation.

     Re-checked rather than one-shot: `configurable: true` means a
     sibling userscript can `delete window.onurlchange`, and the next
     script to grant the API should restore it rather than leaving the
     feature test lying for the rest of the document. */
  function ensureUrlChangeProperty() {
    if (_hasOwn.call(window, "onurlchange")) return;
    try {
      _ObjectDefineProperty(window, "onurlchange", {
        get: function () { return urlChangeOnProp; },
        set: function (v) {
          urlChangeOnProp = (v === undefined) ? null : v;
          if (typeof v === "function") {
            if (!urlChangeSlotTrampoline) {
              urlChangeSlotTrampoline = function (info) {
                if (typeof urlChangeOnProp === "function") urlChangeOnProp(info);
              };
            }
            addUrlChangeHandler(urlChangeSlotTrampoline);
          } else if (v !== null && v !== undefined) {
            try { console.info("[SourceMonkey] window.onurlchange must be a function; ignoring", typeof v); } catch (_we) {}
          }
        },
        configurable: true,
        enumerable: true,
      });
    } catch (_pe) {}
  }

  /* Intercept the synthetic "urlchange" type; everything else is
     forwarded to the captured originals unchanged. `this` is
     normalized because a userscript can detach the method
     (`var add = window.addEventListener; add(...)`), and the real
     EventTarget method throws on an undefined receiver.

     Capture happens HERE rather than at runtime-init time on purpose:
     a sibling userscript that legitimately wrapped addEventListener
     before us stays in the chain, instead of being silently bypassed.
     The other shim-cache entries capture early because their job is to
     resist tampering; this one's job is to be a well-behaved link in a
     chain. Applied at most once per SUCCESSFUL run — re-running after
     one would capture our own patch as the "original" and recurse
     forever.

     Returns whether the interception is in place. The flag is set only
     after both assignments land, and a partial failure is rolled back,
     so a throw leaves the world exactly as we found it and the next
     enable() gets a clean retry. The caller uses the answer to decide
     whether to expose the surface at all — an accessor without the
     patch would report "supported" while addEventListener silently
     registered a DOM type nothing dispatches. */
  function ensureUrlChangePatch() {
    if (urlChangePatched) return true;
    var origAdd = null;
    var origRemove = null;
    try {
      origAdd = window.addEventListener;
      origRemove = window.removeEventListener;
      window.addEventListener = function (type, listener) {
        if (isUrlChangeType(type)) {
          addUrlChangeHandler(listener);
          return undefined;
        }
        return _origAddEventListener.apply(this == null ? window : this, arguments);
      };
      window.removeEventListener = function (type, listener) {
        if (isUrlChangeType(type)) {
          removeUrlChangeHandler(listener);
          return undefined;
        }
        return _origRemoveEventListener.apply(this == null ? window : this, arguments);
      };
      _origAddEventListener = origAdd;
      _origRemoveEventListener = origRemove;
      urlChangePatched = true;
      return true;
    } catch (_ae) {
      /* Put back whatever we managed to overwrite, so the retry
         captures the real originals rather than a half-installed
         patch whose `_orig*` never got set. */
      try { window.addEventListener = origAdd; } catch (_r1) {}
      try { window.removeEventListener = origRemove; } catch (_r2) {}
      return false;
    }
  }

  /* Installed lazily, on the first granted script's enable() call.
     Doing it unconditionally would break the feature test for
     UNGRANTED scripts: `window.onurlchange` has to stay undefined on
     documents where nothing asked for it. Idempotent — a second script
     granting the API (or a re-registration inside the same document)
     reuses the surface that's already there.

     Patch first, and expose nothing if it failed: a script that can't
     receive events through either registration form is better off
     seeing `window.onurlchange === undefined` — the documented
     "unsupported" answer — than a feature test that lies. */
  function installUrlChange() {
    if (!ensureUrlChangePatch()) return;
    urlChangeEnabled = true;
    ensureUrlChangeProperty();
  }

  var urlchange = {
    /* Called from the compile-in bindings of every script that granted
       `window.onurlchange`, ahead of the script body.

       The scriptId is accepted and ignored. It's passed for the same
       reason every other subsystem entry point takes one — uniform
       call shape, and a readable call site in the emitted wrapper —
       but there is nothing per-script to key: the surface it installs
       lives on the world's single shared `window`. Per-script gating
       would need per-script worlds; see the caveat in
       docs/GM-APIs.md#windowonurlchange. */
    enable: function (_scriptId) {
      installUrlChange();
    },
  };

  /* ---------- window.close / window.focus ----------

     Tampermonkey's contract for `@grant window.close` / `@grant
     window.focus`: the script calls the ordinary `window.close()` /
     `window.focus()` and it actually works, where the page's own call
     is a no-op. Chrome refuses `window.close()` for a tab the script
     didn't open with `window.open`, and it ignores `window.focus()`
     for a background tab. The extension is not bound by either rule,
     so the grant REPLACES the method on this world's `window` with one
     that asks the SW to do it (`chrome.tabs.remove` /
     `chrome.windows.update`).

     Notes:
       - The replacement lives on the USER_SCRIPT world's `window`, so
         the page's own `window.close` is untouched. Sibling scripts in
         this world do see it — the same per-document grant caveat as
         window.onurlchange; see docs/GM-APIs.md.
       - The call returns `undefined` synchronously, as TM's does. The
         SW round-trip is fire-and-forget: nothing useful can be
         reported to a caller whose tab is about to disappear, and a
         failure is logged (page console + the script's Log tab, from
         the SW side).
       - Arguments are ignored — neither method takes any. */
  var windowControlInstalled = _ObjectCreate(null);

  /* Replace one method. Idempotent per name: a second granting script
     (or a re-registration inside the same document) reuses the
     override that's already there.

     A failure to install is swallowed — the script keeps the page's
     native method, which is the same thing it would have without the
     grant. There is no feature test to keep honest here (unlike
     window.onurlchange, `window.close` exists either way), so
     degrading quietly is the whole story. */
  function installWindowControl(scriptId, method) {
    if (windowControlInstalled[method]) return;
    var msgType = (method === "close") ? "sm:gm-window-close" : "sm:gm-window-focus";
    var replacement = function () {
      try {
        var p = api.sendAsync({ type: msgType, scriptId: scriptId });
        if (p && typeof p.then === "function") {
          p.then(function (reply) {
            if (reply && reply.ok) return;
            var why = (reply && reply.error) ? reply.error : "SourceMonkey sent no reply";
            try { console.info("[SourceMonkey] window." + method + ":", why); } catch (_le) {}
          }, function (err) {
            try { console.info("[SourceMonkey] window." + method + " send failed:", (err && err.message) || err); } catch (_le2) {}
          });
        }
      } catch (e) {
        try { console.info("[SourceMonkey] window." + method + " failed:", e); } catch (_le3) {}
      }
      return undefined;
    };
    try {
      _ObjectDefineProperty(window, method, {
        value: replacement,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      windowControlInstalled[method] = true;
    } catch (_de) {
      /* Some engines report the Window method as non-configurable.
         A plain assignment still lands when it's merely writable. */
      try {
        window[method] = replacement;
        windowControlInstalled[method] = true;
      } catch (_ae2) {}
    }
  }

  var windowControl = {
    /* Called from the compile-in bindings of every script that granted
       `window.close` / `window.focus`, ahead of the script body.
       `method` is the bare name ("close" / "focus"). The scriptId is
       used only to attribute SW-side failures to a script in its Log
       tab — the override itself is world-wide, not per-script, so the
       FIRST granting script's id is the one every later failure is
       filed under. Same per-document grant scope as window.onurlchange
       (docs/GM-APIs.md); exact attribution needs per-script worlds. */
    enable: function (scriptId, method) {
      if (method !== "close" && method !== "focus") return;
      installWindowControl(scriptId, method);
    },
  };

  /* Wire the SW-originated tab-close, notification-event, menu-fire,
     download-event, and url-change messages into the same push channel
     as value-update and xhr. */
  onPush(function (msg) {
    if (msg.type === "sm:gm-tab-closed" && typeof msg.requestId === "string") {
      dispatchTabClose(msg.requestId);
    } else if (msg.type === "sm:gm-notification-event" && typeof msg.requestId === "string" && typeof msg.event === "string") {
      dispatchNotificationEvent(msg.requestId, msg.event);
    } else if (msg.type === "sm:gm-menu-fire" && typeof msg.scriptId === "string" && typeof msg.commandId === "string") {
      dispatchMenuFire(msg.scriptId, msg.commandId);
    } else if (msg.type === "sm:gm-download-event" && typeof msg.requestId === "string" && msg.event) {
      dispatchDownloadEvent(msg.requestId, msg.event);
    } else if (msg.type === "sm:url-change" && typeof msg.url === "string") {
      noteUrlChanged(msg.url);
    }
  });

  var api = {
    /* Placeholder for sync APIs still not wired. */
    notImplemented: function (name) {
      throw new _Error("[SourceMonkey] " + name + " is not implemented yet");
    },
    /* Exposed for compile-in async bindings to route through. Returns
       a Promise that resolves with the SW's reply (or rejects if the
       transport is unavailable). Picks chrome.runtime.sendMessage or
       the DOM-event bridge depending on the world — see the
       transport section at the top of this file. */
    sendAsync: function (payload) {
      return transportSend(payload);
    },
    storage: storage,
    dom: dom,
    resource: resource,
    xhr: xhr,
    log: log,
    tab: tab,
    notification: notification,
    download: download,
    menu: menu,
    urlchange: urlchange,
    windowControl: windowControl,
    clipboard: {
      /* GM_setClipboard(text, type?). Returns the Promise from
         navigator.clipboard.writeText so callers can `await` it. TM's
         signature is fire-and-forget undefined; we hand back the
         Promise so a caller that wants to wait for completion can.
         Same is true of the GM4 GM.setClipboard alias.

         The `type` arg is not honored today — navigator.clipboard's
         writeText is text/plain only. A future phase can route
         text/html through navigator.clipboard.write({ data: new
         ClipboardItem(...) }). */
      write: function (text /*, type */) {
        if (!_clipboardWriteText) {
          return _Promise.reject(new _Error("[SourceMonkey] navigator.clipboard.writeText unavailable"));
        }
        try {
          return _clipboardWriteText(String(text == null ? "" : text));
        } catch (e) {
          return _Promise.reject(e);
        }
      },
    },
  };

  /* Object.defineProperty with writable:false + configurable:false so
     neither a sibling userscript nor (in MAIN world) the page can
     replace the runtime out from under other scripts after init.
     We don't try to HIDE the global: in USER_SCRIPT world the page
     can't see it anyway, and in MAIN world there is nowhere to hide it
     — separate chrome.userScripts registrations can only hand each
     other references through a shared global, and any secret baked
     into MAIN-world source is readable by the page. Bounding what a
     page can do with it is the SW-side gate's job instead. */
  try {
    Object.defineProperty(window, "__SM_GM__", {
      value: api,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  } catch (_e2) {
    /* If something already pinned the slot, fall back to a plain
       assignment so we still expose the API. */
    window.__SM_GM__ = api;
  }
})();
