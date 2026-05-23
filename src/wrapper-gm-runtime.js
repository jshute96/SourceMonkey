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
  var stores = {};  /* scriptId -> { cache, pending, debounceTimer, hardTimer, ready } */
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
    };
    stores[scriptId] = s;
    return s;
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
    /* Sync API: returns undefined, queues the write. */
    set: function (scriptId, key, value) {
      var s = ensureStore(scriptId);
      s.cache[key] = value;
      s.pending.push({ key: key, value: value });
      scheduleFlush(scriptId);
    },
    del: function (scriptId, key) {
      var s = ensureStore(scriptId);
      delete s.cache[key];
      s.pending.push({ key: key, value: DELETED_SENTINEL });
      scheduleFlush(scriptId);
    },
    list: function (scriptId) {
      var s = stores[scriptId];
      if (!s || !s.ready) return [];
      return _ObjectKeys(s.cache);
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
