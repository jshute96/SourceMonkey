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

   Build rules match wrapper-head.js — block comments only, no `//`
   sequences in strings, the build minifies to one physical line. See
   scripts/build.mjs's minifyForInjection for the exact rules.

   Shim cache. See docs/GM_API_strategy.md "Recommendation: a tiny
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
     `sm:gm-batch-write` message to the SW. Initial values are baked
     into the wrapper at register time (see gm-bindings.ts), so the
     cache is populated before any user code runs.

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
        try { console.error("[SourceMonkey] value-change listener threw:", e); } catch (_lE) {}
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
      try { console.warn("[SourceMonkey] storage flush dropped: chrome.runtime unavailable", scriptId, reason, wireWrites.length); } catch (_e) {}
      return;
    }
    try {
      var p = _sendMessage({ type: "sm:gm-batch-write", scriptId: scriptId, writes: wireWrites });
      if (p && typeof p.catch === "function") {
        p.catch(function (err) {
          try { console.warn("[SourceMonkey] storage flush rejected", scriptId, err && err.message); } catch (_e) {}
        });
      }
    } catch (e) {
      try { console.warn("[SourceMonkey] storage flush threw", scriptId, e && e.message); } catch (_e2) {}
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

     Phase 7 will fire value-change listeners from here too. */
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
    /* Called by the compile-in bindings, top-of-file, with the
       scriptId and the literal initial-value snapshot. Populates the
       per-script cache and flags it as ready. Calling init twice
       (e.g. two compile-in bindings for the same scriptId — shouldn't
       happen) is idempotent: the second call replaces the cache,
       which matches "newest wrapper registration wins". */
    init: function (scriptId, values) {
      var s = ensureStore(scriptId);
      /* Defensive copy so the userscript can't mutate the literal
         that was baked into the wrapper. Use Object.create(null) so
         a user that has clobbered Object.prototype can't shadow our
         cached keys via inherited properties. */
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
     a userScript can run). */
  function defaultParent() { return document.head || document.documentElement; }

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
    /* GM_addElement: two signatures (matches TM/VM):
         GM_addElement(tagName, attrs?) -> appends to head/documentElement
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
      if (!parent) parent = defaultParent();
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

  /* ---------- GM_xmlhttpRequest ----------

     Per-script state: an `activeRequests` map keyed by request id,
     holding the user's onload/onerror/etc. callbacks. The runtime
     installs a chrome.runtime.onMessage listener that routes
     `sm:gm-xhr-event` messages back to the originating request.

     Same sender filter as the value-update listener so a sibling
     userscript can't forge a load event. */
  var activeRequests = _ObjectCreate(null);
  var _xhrNextId = 1;

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
      try { console.error("[SourceMonkey] XHR callback threw:", e); } catch (_e) {}
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
        ttlTimer: null,
      };
      activeRequests[id] = entry;
      entry.ttlTimer = setTimeout(function () {
        /* TTL elapsed without a terminal event. Synthesize an error
           so the userscript at least sees a settled state instead of
           silently dangling. */
        dispatchXhrEvent(id, { kind: "error", message: "[SourceMonkey] XHR timed out waiting for SW response (TTL " + XHR_PAGE_SIDE_TTL_MS + "ms)" });
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

  var api = {
    /* Phase-2 placeholder for the sync subsystems not yet wired
       (storage-listener, resource, menu, log). */
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
    xhr: xhr,
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
