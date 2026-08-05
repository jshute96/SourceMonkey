/* SourceMonkey GM_* shared runtime. Registered once per page in
   USER_SCRIPT world at document_start, ahead of every userscript.

   Per-script wrappers compile in `const GM_X = function(...) { ... }`
   for every API the script @grants. Two delegation modes:
     - SYNC API bodies call into methods on `window.__SM_GM__` defined
       here. The runtime is shared across all userscripts in this
       document (USER_SCRIPT world is one realm per extension per
       document), so per-script state lives in keyed sub-objects.
     - ASYNC API bodies don't go through here; they send messages
       straight to the SW via chrome.runtime.sendMessage.

   Build rules match userscript-prelude.js — block comments only, no
   `//` sequences in strings, the build minifies to one physical line.
   See scripts/build.mjs's minifyForInjection for the exact rules.

   Shim cache. See docs/GM-API-strategy.md "Recommendation: a tiny
   'shim cache', not a full vault". We capture a small set of native
   references at runtime-init time so a sibling userscript that
   monkey-patches builtins later can't break our GM_* impls. The
   USER_SCRIPT world is isolated from the page so the page itself
   can't reach in; the threat we mitigate here is "userscript A
   stomps on Array.prototype.forEach and userscript B's GM_* call
   then sees the stomped version." */
(function () {
  "use strict";
  if (typeof window === "undefined") return;
  if (window.__SM_GM__) return;

  var _Promise = Promise;
  var _Error = Error;
  var _ObjectKeys = Object.keys;
  var _ObjectCreate = Object.create;
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
     window.chrome or chrome.runtime later. We only do this when
     chrome.runtime exists (true for USER_SCRIPT world; falsy in MAIN). */
  var _sendMessage = null;
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
      _sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    }
  } catch (_e) {}

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
       JSON and the sentinel can't survive postMessage. */
    var wireWrites = [];
    for (var i = 0; i < batch.length; i++) {
      var w = batch[i];
      if (w.value === DELETED_SENTINEL) {
        wireWrites.push({ key: w.key, deleted: true });
      } else {
        wireWrites.push({ key: w.key, value: w.value });
      }
    }
    if (!_sendMessage) {
      /* Defensive — should never happen in USER_SCRIPT world. Surface
         to console so the user can spot the lost writes. */
      try { console.info("[SourceMonkey] storage flush dropped: chrome.runtime unavailable", scriptId, reason, wireWrites.length); } catch (_e) {}
      return;
    }
    try {
      var p = _sendMessage({ type: "sm:gm-batch-write", scriptId: scriptId, writes: wireWrites });
      if (p && typeof p.catch === "function") {
        p.catch(function (err) {
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
  try {
    window.addEventListener("pagehide", flushAll, { capture: true });
    /* visibilitychange → hidden is a softer signal that also tends to
       precede tab close; flushing here gives one more shot at
       delivery before bfcache. */
    window.addEventListener("visibilitychange", function () {
      if (document && document.visibilityState === "hidden") flushAll();
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
      if (w.deleted) {
        delete s.cache[w.key];
        fireListeners(scriptId, w.key, oldValue, undefined, true);
      } else {
        s.cache[w.key] = w.value;
        fireListeners(scriptId, w.key, oldValue, w.value, true);
      }
    }
  }
  /* Sender filter. A naive listener would happily process a forged
     `sm:gm-value-update` from another userscript inside the same
     extension — chrome.runtime.sendMessage from one USER_SCRIPT
     world fires onMessage in every other context (incl. other tabs).
     We require:
       - sender.id === chrome.runtime.id  (our extension only)
       - sender.tab is undefined          (came from the SW, not a tab)
     The combination ensures only the SW's broadcast reaches us. */
  var _extensionId = null;
  try { _extensionId = chrome.runtime.id; } catch (_idE) {}
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage && typeof chrome.runtime.onMessage.addListener === "function") {
      chrome.runtime.onMessage.addListener(function (msg, sender /*, sendResponse */) {
        if (!sender || sender.id !== _extensionId || sender.tab) return;
        if (!msg || typeof msg !== "object") return;
        if (msg.type !== "sm:gm-value-update") return;
        if (typeof msg.scriptId !== "string") return;
        if (!msg.writes || typeof msg.writes.length !== "number") return;
        applyRemoteUpdate(msg.scriptId, msg.writes);
      });
    }
  } catch (_lE) {}

  var storage = {
    /* Called from the GM prelude spliced into the main-body wrap
       function (which only fires after the prelude's awaitDecision
       + waitForRunAt gates, by which point the GM runtime is
       guaranteed installed) with the scriptId and the SW-attached
       initial-value snapshot from the sm:check-pending reply. Populates the
       per-script cache and flags it as ready. Calling init twice for
       the same scriptId — shouldn't happen in normal flow — is
       idempotent: the second call replaces the cache. */
    init: function (scriptId, values) {
      var s = ensureStore(scriptId);
      /* Defensive copy so the userscript can't mutate the values
         object the SW handed us. Use Object.create(null) so a user
         that has clobbered Object.prototype can't shadow our cached
         keys via inherited properties. */
      var copy = _ObjectCreate(null);
      var keys = _ObjectKeys(values || {});
      for (var i = 0; i < keys.length; i++) copy[keys[i]] = values[keys[i]];
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
      var oldValue = _hasOwn.call(s.cache, key) ? s.cache[key] : undefined;
      s.cache[key] = value;
      s.pending.push({ key: key, value: value });
      scheduleFlush(scriptId);
      fireListeners(scriptId, key, oldValue, value, false);
    },
    del: function (scriptId, key) {
      var s = ensureStore(scriptId);
      var oldValue = _hasOwn.call(s.cache, key) ? s.cache[key] : undefined;
      delete s.cache[key];
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
    removeValueChangeListener: function (scriptId, listenerId) {
      var s = stores[scriptId];
      if (!s || !s.listeners) return;
      var key = String(listenerId);
      if (_hasOwn.call(s.listeners, key)) delete s.listeners[key];
    },
  };

  /* ---------- DOM injection (GM_addStyle / GM_addElement) ----------

     USER_SCRIPT-world DOM mutations are exempt from page CSP (the
     same dispensation content scripts get), so a script on a strict-
     CSP page like github.com / google.com can still inject styles
     and elements that the page itself couldn't.

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

  var dom = {
    /* GM_addStyle(css): create <style>, set its textContent, attach
       to (document.head || document.documentElement). Returns the
       style element. */
    addStyle: function (css) {
      var el = _docCreateElement ? _docCreateElement("style") : document.createElement("style");
      el.textContent = String(css == null ? "" : css);
      var parent = defaultParent();
      if (parent) {
        if (_Node_appendChild) _Node_appendChild.call(parent, el);
        else parent.appendChild(el);
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
    addElement: function (arg1, arg2, arg3) {
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
     installs a chrome.runtime.onMessage listener that routes
     `sm:gm-xhr-event` messages back to the originating request.

     Same sender filter as the value-update listener so a sibling
     userscript can't forge a load event. */
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
    var cb;
    if (event.kind === "load") cb = entry.onload;
    else if (event.kind === "error") cb = entry.onerror;
    else if (event.kind === "timeout") cb = entry.ontimeout;
    else if (event.kind === "abort") cb = entry.onabort;
    if (typeof cb !== "function") return;
    try {
      if (event.kind === "load") cb(event.response);
      else if (event.kind === "error") cb({ error: event.message });
      else if (event.kind === "timeout") cb({});
      else if (event.kind === "abort") cb({});
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
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage && typeof chrome.runtime.onMessage.addListener === "function") {
      chrome.runtime.onMessage.addListener(function (msg, sender) {
        if (!sender || sender.id !== _extensionId || sender.tab) return;
        if (!msg || typeof msg !== "object" || msg.type !== "sm:gm-xhr-event") return;
        if (typeof msg.id !== "string" || !msg.event) return;
        dispatchXhrEvent(msg.id, msg.event);
      });
    }
  } catch (_xhrE) {}

  var xhr = {
    /* GM_xmlhttpRequest(details) — kicks off the request, returns
       `{abort}` immediately. The user's onload/onerror/ontimeout/
       onabort callbacks come from `details` and are stored locally
       (callbacks aren't serializable across postMessage). */
    start: function (scriptId, details) {
      if (!details || typeof details !== "object") {
        throw new _Error("[SourceMonkey] GM_xmlhttpRequest: details object required");
      }
      if (typeof details.url !== "string" || !details.url) {
        throw new _Error("[SourceMonkey] GM_xmlhttpRequest: url required");
      }
      var id = "xhr-" + (_xhrNextId++) + "-" + Math.random().toString(36).slice(2, 10);
      var entry = {
        onload: details.onload,
        onerror: details.onerror,
        ontimeout: details.ontimeout,
        onabort: details.onabort,
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
        url: details.url,
        headers: (details.headers && typeof details.headers === "object") ? details.headers : undefined,
        data: details.data,
        timeout: typeof details.timeout === "number" ? details.timeout : undefined,
        responseType: typeof details.responseType === "string" ? details.responseType : undefined,
      };
      api.sendAsync({
        type: "sm:gm-xhr-start",
        id: id,
        scriptId: scriptId,
        request: request,
      }).catch(function (err) {
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
     so it lands on the script's Log tab in the sources-page viewer.
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
         chrome.runtime.sendMessage / bridge-postMessage helper the
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
        } else if (reply && reply.error) {
          /* SW couldn't create the tab — surface the error so a
             userscript debugging an unexpected fast-close has a
             signal, then synthesize the close so onclose fires. */
          try { console.info("[SourceMonkey] GM_openInTab failed:", reply.error); } catch (_e) {}
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
    if (typeof detailsOrUrl === "string") {
      d = { url: detailsOrUrl, name: name };
    } else if (detailsOrUrl && typeof detailsOrUrl === "object") {
      d = detailsOrUrl;
    } else {
      throw new _Error("[SourceMonkey] GM_download: details object or url required");
    }
    if (typeof d.url !== "string" || !d.url) {
      throw new _Error("[SourceMonkey] GM_download: url required");
    }
    return {
      url: d.url,
      name: d.name != null ? String(d.name) : "",
      headers: (d.headers && typeof d.headers === "object") ? d.headers : undefined,
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

  function isInPageDownloadUrl(url) {
    return url.slice(0, 5) === "blob:" || url.slice(0, 5) === "data:";
  }

  /* blob: / data: transport. Appends a hidden anchor, clicks it, and
     removes it. Returns null on success or an error message string. */
  function downloadViaAnchor(url, name) {
    try {
      var a = _docCreateElement("a");
      a.href = url;
      /* An empty `download` still forces a download (rather than a
         navigation); the browser derives the name itself. */
      a.download = name || "";
      a.style.display = "none";
      var parent = document.body || document.documentElement;
      if (!parent) return "no document to append the download anchor to";
      _Node_appendChild.call(parent, a);
      try { a.click(); } finally {
        try { parent.removeChild(a); } catch (_re) {}
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
      activeDownloads[requestId] = {
        onload: d.onload,
        onerror: d.onerror,
        ontimeout: d.ontimeout,
        onprogress: d.onprogress,
        onabort: d.onabort,
        /* "page" downloads have nothing to cancel in the SW. */
        transport: isInPageDownloadUrl(d.url) ? "page" : "sw",
        url: d.url,
        name: d.name,
      };
      if (isInPageDownloadUrl(d.url)) {
        var failure = downloadViaAnchor(d.url, d.name);
        if (failure !== null) {
          dispatchDownloadEvent(requestId, {
            kind: "error",
            error: "not_succeeded",
            details: { message: failure },
          });
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
        }).catch(function (err) {
          /* Couldn't even reach the SW (no chrome.runtime — e.g. a
             MAIN-world script). TM calls that `not_supported`. */
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

  /* Wire the SW-originated tab-close, notification-event, and menu-fire
     messages into the same dispatcher we already use for value-update
     and xhr. Sender filter logic identical to the earlier listeners. */
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage && typeof chrome.runtime.onMessage.addListener === "function") {
      chrome.runtime.onMessage.addListener(function (msg, sender) {
        if (!sender || sender.id !== _extensionId || sender.tab) return;
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "sm:gm-tab-closed" && typeof msg.requestId === "string") {
          dispatchTabClose(msg.requestId);
        } else if (msg.type === "sm:gm-notification-event" && typeof msg.requestId === "string" && typeof msg.event === "string") {
          dispatchNotificationEvent(msg.requestId, msg.event);
        } else if (msg.type === "sm:gm-menu-fire" && typeof msg.scriptId === "string" && typeof msg.commandId === "string") {
          dispatchMenuFire(msg.scriptId, msg.commandId);
        } else if (msg.type === "sm:gm-download-event" && typeof msg.requestId === "string" && msg.event) {
          dispatchDownloadEvent(msg.requestId, msg.event);
        }
      });
    }
  } catch (_evE3) {}

  var api = {
    /* Placeholder for sync APIs still not wired. */
    notImplemented: function (name) {
      throw new _Error("[SourceMonkey] " + name + " is not implemented yet");
    },
    /* Exposed for compile-in async bindings to route through. Returns
       a Promise that resolves with the SW's reply (or rejects if
       messaging is unavailable). */
    sendAsync: function (payload) {
      if (!_sendMessage) {
        return _Promise.reject(new _Error("[SourceMonkey] chrome.runtime.sendMessage unavailable"));
      }
      try {
        var p = _sendMessage(payload);
        if (p && typeof p.then === "function") return p;
        return _Promise.resolve(p);
      } catch (e) {
        return _Promise.reject(e);
      }
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

  /* Object.defineProperty with writable:false + configurable:false so a
     sibling userscript can't replace the runtime out from under other
     scripts after init. We accept that the page can't see us (USER_SCRIPT
     world) so we don't need to hide the global. */
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
