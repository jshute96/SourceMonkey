/* SourceMonkey injected wrapper — static prelude.
 *
 * Loaded as its own {code} entry in each script's `js[]` registration
 * (the build minifies this file into the `WRAPPER_PRELUDE` constant
 * in dist/generated-wrappers.js; the injector splices it in via
 * `{code: WRAPPER_PRELUDE}`). NOT loaded via `{file}` — chrome.userScripts
 * resolves `{file}` entries asynchronously in MAIN world (likely
 * via <script src=> under the hood), so subsequent entries would see
 * `self.__smRun` undefined. See docs/injection-modes.md.
 *
 * Per-script layout:
 *
 *   js[0]  — config call {code}. Calls
 *            `(self.__smPrelude||(self.__smCfgQueue=self.__smCfgQueue||[]).push)(cfg)`
 *            (effectively) to either init the script now, or queue the
 *            config for whenever the prelude runs next.
 *   js[1]  — THIS source, inlined as {code}. On its FIRST execution
 *            per world it installs helpers and drains the queue;
 *            subsequent executions (the prelude {code} entry appears
 *            in every script's js[]) short-circuit because the
 *            helpers are already in place — but they still see and
 *            pick up any config that the preceding js[0] just pushed
 *            onto the queue, because the queue lives on globalThis.
 *   js[2]  — the whole user program: every @require concatenated ahead
 *                of the script's own body, all wrapped in
 *                `__smRun("id",function(__smE){<gm bindings>return(()=>{
 *                 <user source>\n})();})`, so it runs only after the
 *                matcher + check-pending + @run-at gates resolve.
 *                Concatenation is what gives requires and the body one
 *                shared scope, nested inside the bindings' scope so
 *                its declarations shadow ours. A granted page-world
 *                script's runs inside `with` over its sandbox `window`
 *                instead (see makeSandbox). Trailing
 *                `//# sourceURL=sourcemonkey://<id>/<name>.user.js`,
 *                plus an inline source map when requires are present so
 *                devtools still splits them into separate files.
 *   js[3]  — parse-failure sentinel: `self.__smSealed("<id>")`. Its own
 *                script, so it parses and runs even when js[2] didn't.
 *                Everything the user wrote is one script now, so a
 *                syntax error anywhere in it would otherwise be
 *                completely silent — __smRun is never reached.
 *
 * Cross-entry coordination. Every js[] entry runs in the same
 * execution world and shares `self` / `globalThis`. Helpers live on
 * `self.__smPrelude`; per-script state lives under
 * `self.__smPrelude.scripts[scriptId]`. Pending configs live on
 * `self.__smCfgQueue` until the prelude drains them.
 *
 * Build rules. Same as the other wrapper-* files:
 *   - Only block comments. No `//` sequences in strings.
 *   - The build minifies this file to a single physical line and
 *     emits it as the WRAPPER_PRELUDE export in
 *     dist/generated-wrappers.js. (See scripts/build.mjs.)
 *
 * No per-script values are baked into this file. The whole point of
 * the split is that this file is byte-identical for every script
 * registered.
 */
(function () {
  "use strict";
  if (typeof self === "undefined") return;

  /* Drain any pending config(s) through `init` — used both at the end
     of first-load setup and from the idempotency short-circuit below.
     Always go through whichever `init` was passed in so per-script
     state lands in the table that init closes over (the FIRST
     prelude's scripts{}), not a new local table. */
  function drainQueue(init) {
    var q = self.__smCfgQueue;
    if (!q) return;
    self.__smCfgQueue = null;
    for (var i = 0; i < q.length; i++) {
      try { init(q[i]); } catch (e) {
        try { console.info("[SourceMonkey] prelude init threw for", q[i] && q[i].id, e); } catch (_e) {}
      }
    }
  }

  /* Idempotency. The prelude file is referenced by EVERY script's
     js[], so this IIFE runs once per script in the same world. On the
     2nd+ run, helpers are already installed — but the preceding
     config blob may have pushed a new config onto the queue. Drain
     through the already-installed init so per-script state continues
     to live in the original scripts table, then exit. */
  if (self.__smPrelude && self.__smPrelude.scripts) {
    drainQueue(self.__smPrelude.init);
    return;
  }

  var scripts = {};

  /* ---------- per-script runtime state ----------
   *
   * For each script we maintain:
   *   cfg          : the {id, name, sourceUrl, runAt, loadedAt,
   *                  matching?, needsGmValues, startupLogs?,
   *                  manualRun?} passed in by the per-script config
   *                  blob. A manual script's next run replaces it.
   *   matched      : did the in-page matcher accept this URL? Sync;
   *                  set during initScript.
   *   decision     : null|run|run-new|skip — settled by check-pending,
   *                  or set to run at init by canSkipDecision.
   *   runAtFired   : true once the @run-at lifecycle event happened.
   *   replayLoad   : an idle gate opened before `load` was over, so a
   *                  body held past `load` gets it replayed.
   *   pendingRun   : the main-body fn passed to __smRun, queued until
   *                  (matched && decision !== 'skip' && runAtFired).
   *   runRegistered: did the combined user-program entry parse and
   *                  call __smRun at all? The trailing sentinel entry
   *                  reports a syntax error when it didn't.
   *   loadedAtRun  : loadedAt to attribute sm:start / sm:error to;
   *                  bumps when decision === 'run-new'.
   */
  function makeEntry(cfg) {
    return {
      cfg: cfg,
      matched: true,
      decision: null,
      runAtFired: false,
      replayLoad: false,
      pendingRun: null,
      runRegistered: false,
      loadedAtRun: cfg.loadedAt,
      asyncListenersInstalled: false,
    };
  }

  /* ---------- telemetry transport ---------- */

  /* Dual transport: chrome.runtime.sendMessage in USER_SCRIPT world,
     the DOM-event bridge in MAIN world. The bridge listener lives in
     wrapper-bridge.js (registered separately).

     "Are we in the isolated world?" is `chrome.runtime.id` being a
     string. A web page listed in some extension's
     `externally_connectable` has `chrome.runtime.sendMessage` in MAIN
     world too (for talking to that extension), and calling it without
     an extension id throws — so the presence of `sendMessage` alone is
     the wrong test. Same rule in wrapper-gm-runtime.js. */
  function hasOwnRuntimeChannel() {
    try {
      return typeof chrome !== "undefined" && !!chrome.runtime &&
        typeof chrome.runtime.id === "string" &&
        typeof chrome.runtime.sendMessage === "function";
    } catch (_e) { return false; }
  }
  /* MAIN world's leg of the transport: a CustomEvent on `document`
     carrying {requestId, payload} as JSON in `detail`. All three
     primitives are captured at init — this file runs at
     document_start, before any page script — because `send` also
     carries `sm:error` reports raised arbitrarily late, by which point
     a page could have replaced any of them and silently swallowed the
     report. Same reasoning as the GM runtime's transport section. The bridge runs
     in USER_SCRIPT world on this same document, and event dispatch
     runs every world's listeners in the dispatching task — so its
     chrome.runtime.sendMessage happens before this returns, which a
     postMessage (delivered on a later task) could not promise a
     document that is tearing down. Replies come back the other way, as
     a `sourcemonkey-bridge-reply` postMessage keyed on requestId.
     Returns false if the dispatch could not happen at all; a dropped
     payload (no bridge listening, unallowlisted type) looks the same
     as a delivered one from here. */
  var _CustomEvent = null;
  var _dispatchEvent = null;
  var _stringify = null;
  try { _CustomEvent = CustomEvent; } catch (_ceE) {}
  try { _stringify = JSON.stringify; } catch (_jsE) {}
  try {
    if (document && typeof document.dispatchEvent === "function") {
      _dispatchEvent = document.dispatchEvent.bind(document);
    }
  } catch (_deE) {}
  function bridgeDispatch(payload, requestId) {
    try {
      if (!_CustomEvent || !_dispatchEvent || !_stringify) return false;
      _dispatchEvent(new _CustomEvent("sourcemonkey-bridge-sync", {
        detail: _stringify({ requestId: requestId == null ? undefined : requestId, payload: payload }),
      }));
      return true;
    } catch (_e) { return false; }
  }
  /* Whether this document has an opaque origin, carried on every report
     so the SW can explain a script that never started here: on an
     http(s) page it means a CSP `sandbox` header, which keeps Chrome
     from injecting MAIN-world scripts at all. See
     src/extension/missing-scripts.ts. */
  var OPAQUE_ORIGIN = false;
  try { OPAQUE_ORIGIN = self.origin === "null"; } catch (_oE) {}
  function send(payload) {
    try { payload.opaqueOrigin = OPAQUE_ORIGIN; } catch (_pE) {}
    try {
      if (hasOwnRuntimeChannel()) {
        var p = chrome.runtime.sendMessage(payload);
        if (p && typeof p.catch === "function") p.catch(function () {});
        return;
      }
    } catch (_e) {}
    bridgeDispatch(payload, null);
  }

  /* Is the shared GM runtime installed in THIS world on THIS document?
     Decides whether a hot-swap body that needs it (`needsRuntime` on
     the SW's reply) can run: the runtime is registered only where some
     active script grants a runtime-backed API, so a refresh that ADDS
     the first such grant produces a body whose GM_* bindings have no
     `window.__SM_GM__` to dereference until the next reload
     re-registers it. Asked at the moment the body is about to run (see
     runMain), not at wrapper start: the runtime is its own
     document_start registration and may sit after this wrapper in
     Chrome's order — an updated registration moves to the end — but by
     run time every document_start registration has executed. */
  function hasGmRuntime() {
    try { return !!window.__SM_GM__; } catch (_e) { return false; }
  }

  /* How long a wrapper waits for the SW's decision before giving up.
     An answer normally takes milliseconds, and the slowest one the SW
     means to give (a reload fast-path swap) is bounded at 500ms; this
     leaves a cold or busy SW room to start. */
  var DECISION_TIMEOUT_MS = 10000;
  /* What a missing decision says (`detail`), and the skip it becomes. */
  var NOT_ASKED = "SourceMonkey could not be asked whether to run it";
  function noDecision(detail) { return { action: "skip", reason: "no-decision", detail: detail }; }
  function askFailed(err) { return noDecision("Asking SourceMonkey whether to run it failed: " + ((err && err.message) || String(err))); }
  /* A sentence, ending in one period: Chrome's own messages may already. */
  function sentence(text) { return String(text).replace(/\.+\s*$/, "") + "."; }

  /* Round-trip sm:check-pending and hand the SW's decision to cb. Same
     dual transport as `send`.

     Without an answer the script does NOT run: the decision is what
     keeps a script out of an sm-dev run's tabs (and a run's own scripts
     out of every other tab), honours "Reload page with no userscripts",
     and checks a `.tld` rule exactly. Running anyway would undo each of
     those. The skip carries `reason: "no-decision"` and a `detail`
     saying what went wrong, which the caller reports. */
  function awaitDecision(entry, cb) {
    var cfg = entry.cfg;
    var tld = !!(cfg.matching && hasTldRule(cfg.matching));
    /* Only a decision the SW makes counts; anything else (the bridge's
       `bridgeError`, a reply with no action) is no decision. */
    var decided = function (reply) {
      if (reply && typeof reply === "object" && (reply.action === "run" || reply.action === "run-new" || reply.action === "skip")) return reply;
      if (reply && typeof reply === "object" && typeof reply.bridgeError === "string") return noDecision(reply.bridgeError);
      return noDecision("SourceMonkey's answer whether to run it was unreadable");
    };
    var fallback = noDecision("SourceMonkey did not answer whether to run it within " + (DECISION_TIMEOUT_MS / 1000) + " seconds");
    var done = false;
    var finish = function (decision) {
      if (done) return;
      done = true;
      try { cb(decision); } catch (_e) {}
    };
    var cleanup = function () {};
    var safetyTimer = setTimeout(function () { seal(fallback); }, DECISION_TIMEOUT_MS);
    var seal = function (decision) {
      try { clearTimeout(safetyTimer); } catch (_e) {}
      try { cleanup(); } catch (_e2) {}
      finish(decision);
    };
    try {
      if (hasOwnRuntimeChannel()) {
        var p = chrome.runtime.sendMessage({
          type: "sm:check-pending",
          id: cfg.id,
          name: cfg.name,
          loadedAt: cfg.loadedAt,
          url: location.href,
          needsValues: !!cfg.needsGmValues,
          tld: tld
        });
        if (p && typeof p.then === "function") {
          p.then(
            function (reply) { seal(decided(reply)); },
            function (err) { seal(askFailed(err)); }
          );
        } else {
          seal(noDecision(NOT_ASKED));
        }
        return;
      }
      /* MAIN world: bridge request/reply protocol with a requestId
         nonce so concurrent userscripts each get their own reply. The
         listener goes on before the dispatch, because the bridge's
         sendMessage runs inside it. */
      var requestId = "sm-" + Math.random().toString(36).slice(2) + "-" + Date.now();
      var listener = function (ev) {
        try {
          if (!ev || ev.source !== window) return;
          var d = ev.data;
          if (!d || d.__sm !== "sourcemonkey-bridge-reply") return;
          if (d.requestId !== requestId) return;
          seal(decided(d.reply));
        } catch (_e) {}
      };
      var request = {
        type: "sm:check-pending",
        id: cfg.id,
        name: cfg.name,
        loadedAt: cfg.loadedAt,
        url: location.href,
        needsValues: !!cfg.needsGmValues,
        tld: tld
      };
      /* The bridge can be injected after this wrapper: a sync that
         widens its patterns re-registers it behind the scripts already
         registered. Its request event, sent before the bridge listened,
         is gone, so when the bridge announces itself the request is
         sent again, once. Without this the wrapper would wait out its
         timer and not run, whatever the SW would have decided. */
      var resent = false;
      var onReady = function () {
        if (resent) return;
        resent = true;
        bridgeDispatch(request, requestId);
      };
      window.addEventListener("message", listener, true);
      /* READY_MARKER in wrapper-bridge.js. */
      window.addEventListener("sourcemonkey-bridge-ready", onReady, true);
      cleanup = function () {
        try { window.removeEventListener("message", listener, true); } catch (_e) {}
        try { window.removeEventListener("sourcemonkey-bridge-ready", onReady, true); } catch (_e2) {}
      };
      var dispatched = bridgeDispatch(request, requestId);
      /* Nothing left the page, so no reply is coming. Seal now rather
         than costing this script the full timeout. */
      if (!dispatched) seal(noDecision(NOT_ASKED));
    } catch (_e3) { seal(askFailed(_e3)); }
  }

  /* Async-error attribution. Every piece of a script's code — its
     `@require`s and its own body — ships in one js[] entry carrying a
     single `//# sourceURL=sourcemonkey://<id>/<name>.user.js` marker,
     so one substring test attributes any frame from this script.
     (Before Mode A each require was its own entry with its own URL and
     this had to check a list; see docs/injection-modes.md.) */
  var __smReported = (typeof WeakSet === "function") ? new WeakSet() : null;
  function stackHitsScript(err, entry) {
    try {
      var stack = err && typeof err === "object" && err.stack;
      if (typeof stack !== "string") return false;
      if (stack.indexOf(entry.cfg.sourceUrl) !== -1) return true;
    } catch (_e) {}
    return false;
  }
  function filenameHitsScript(filename, entry) {
    try {
      if (typeof filename !== "string") return false;
      if (filename.indexOf(entry.cfg.sourceUrl) !== -1) return true;
    } catch (_e) {}
    return false;
  }
  function reportAsync(entry, err, kind) {
    /* `entry.loadedAtRun` is read lazily here (not captured at
       listener-install time). The old wrapper re-installed
       listeners on a run-new swap to capture the new loadedAt in
       its closure; the new shape installs listeners exactly once
       in initScript and lets runMain mutate loadedAtRun on the
       entry object, which subsequent async-error reports pick up
       automatically. Same observable behavior, fewer moving parts. */
    try {
      if (err && typeof err === "object" && __smReported) {
        if (__smReported.has(err)) return;
        __smReported.add(err);
      }
    } catch (_e) {}
    var msg;
    try { msg = (err && err.message) ? String(err.message) : String(err); }
    catch (_e2) { msg = "(unstringifiable error)"; }
    var stack = "";
    try { if (err && typeof err.stack === "string") stack = err.stack; } catch (_e4) {}
    try { console.info("[SourceMonkey] caught async " + kind + " in", entry.cfg.name); } catch (_e3) {}
    send({
      type: "sm:error",
      id: entry.cfg.id,
      name: entry.cfg.name,
      loadedAt: entry.loadedAtRun,
      url: location.href,
      message: msg,
      stack: stack
    });
  }
  /* ---------- focus signal ----------

     Chrome tells the service worker about tab switches
     (`tabs.onActivated`) and about focus moving between Chrome
     windows (`windows.onFocusChanged`), but on some platforms and
     window managers — Linux/X11 in particular — it says nothing when
     Chrome regains focus from ANOTHER APPLICATION. That is exactly the
     case the focus-triggered refresh exists for: edit the script in an
     editor, alt-tab back to the browser. So the page reports it
     instead, which works the same everywhere.

     One listener per execution world per document (the prelude IIFE is
     idempotent), installed only once some script has matched this URL
     — a page we run nothing on has nothing to re-check.

     See docs/updates.md#focus-triggered-refresh. */

  /* Floor between signals from one document. The SW-side check is
     rate-limited far harder (10s per script) and is idempotent, so
     this exists only to keep focus churn — clicking in and out of an
     embedded editor, say — from waking the worker each time. Set below
     the SW's interval so it never becomes the binding limit. */
  var FOCUS_SIGNAL_MIN_MS = 5000;
  var lastFocusSignalAt = 0;
  var focusSignalInstalled = false;

  function sendFocusSignal() {
    var now = Date.now();
    if (now - lastFocusSignalAt < FOCUS_SIGNAL_MIN_MS) return;
    lastFocusSignalAt = now;
    send({ type: "sm:focus", url: location.href });
  }

  function installFocusSignal() {
    if (focusSignalInstalled) return;
    focusSignalInstalled = true;
    try {
      /* `focus` is the one that fires when the window comes back from
         another application. `visibilitychange` covers a tab switch —
         redundant with `tabs.onActivated` on the SW side, but the two
         are cheap together and neither alone covers both cases. */
      window.addEventListener("focus", sendFocusSignal);
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) sendFocusSignal();
      });
    } catch (_e) {}
  }

  function installAsyncListeners(entry) {
    if (entry.asyncListenersInstalled) return;
    entry.asyncListenersInstalled = true;
    try {
      window.addEventListener("error", function (ev) {
        if (!ev) return;
        if (filenameHitsScript(ev.filename, entry) || stackHitsScript(ev.error, entry)) {
          reportAsync(entry, ev.error || ev.message || "error", "error");
        }
      }, true);
      window.addEventListener("unhandledrejection", function (ev) {
        if (ev && stackHitsScript(ev.reason, entry)) {
          reportAsync(entry, ev.reason, "unhandledrejection");
        }
      }, true);
    } catch (_e) {}
  }

  /* How long after DOMContentLoaded a document-idle script runs when
     `load` hasn't fired by then. Chrome's own document_idle runs at
     most about 200ms after it. */
  var IDLE_AFTER_DCL_MS = 200;

  /* The page's `load` event once it has fired; null before that, and
     on a page that never fires it. Recorded from the first prelude run
     in this world (document_start) for runWithLoadReplay. */
  var loadEvent = null;
  try {
    window.addEventListener("load", function (e) { loadEvent = e; }, { once: true });
  } catch (_e) {}

  /* Run an idle body that was due before `load` but was held past it
     by the run decision (an async round trip that can lose to `load` on
     a fast page). Old scripts set up in a `window` load listener, which
     would then never fire; in Tampermonkey the body runs just before
     `load`, so it does.
     - For the body's synchronous run only, `window.addEventListener`
       queues `load` listeners instead of adding them, and a
       `window.onload` it sets is noticed afterwards.
     - Each queued listener is then called with the real load event, on
       its own task, so an error in one surfaces as an ordinary uncaught
       error (attributed to the script) and doesn't stop the rest.
     - Only code the body runs synchronously sees the stand-in. In
       USER_SCRIPT world `window` isn't the page's, so the page never
       does; in MAIN world, page code the body triggers synchronously
       (a dispatched event's handler) would have its load listeners
       replayed too.
     - Not covered: a listener added later (after an `await`), and one
       added by a page `<script>` that a USER_SCRIPT-world body
       injects, since that runs in the page's world.
     See docs/injection.md, "`document-idle` and the `load` event". */
  function runWithLoadReplay(run) {
    var w = window;
    var queued = [];
    var ownAdd = Object.getOwnPropertyDescriptor(w, "addEventListener");
    var realAdd = w.addEventListener;
    var onloadBefore = w.onload;
    var patched = false;
    try {
      w.addEventListener = function (type, listener) {
        /* A bare `addEventListener(...)` from strict code has no `this`;
           natively that means the global, so it counts as window. */
        var target = this == null || isSandbox(this) ? w : this;
        if (type === "load" && target === w && listener) {
          queued.push(listener);
          return;
        }
        return realAdd.apply(target, arguments);
      };
      patched = true;
    } catch (_e) {}
    try {
      run();
    } finally {
      if (patched) {
        try {
          if (ownAdd) Object.defineProperty(w, "addEventListener", ownAdd);
          else delete w.addEventListener;
        } catch (_e2) {}
      }
      try {
        if (w.onload !== onloadBefore && typeof w.onload === "function") queued.push(w.onload);
      } catch (_e3) {}
    }
    var ev = loadEvent;
    queued.forEach(function (listener) {
      setTimeout(function () {
        if (typeof listener === "function") listener.call(w, ev);
        else if (listener && typeof listener.handleEvent === "function") listener.handleEvent(ev);
      }, 0);
    });
  }

  /* @run-at gating. Each script's entry drives its own deferral; the
     prelude calls back into runMain when the lifecycle event fires.
     `cb(true)` means an idle gate that opened before `load` was over,
     so a body held past `load` should get it replayed. */
  function waitForRunAt(declared, cb) {
    /* `document-start` waits for <html> to exist; `document-body` for
       <body>. In the extension Chrome injects document_start scripts
       after the root element is created, so the start check passes at
       once. sm-dev injects with CDP's `addScriptToEvaluateOnNewDocument`
       (CDP: the Chrome DevTools Protocol), which runs before the parser
       has made <html>, so both gates may have to wait.
       - The observer is on `document` itself, the only node that
         exists that early. `subtree` lets the body wait see <body>
         land under an <html> that didn't exist when we started.
       - Mutation records are delivered at the microtask checkpoint the
         parser runs before each page <script>, so the start gate opens
         before any page script. Unless `canSkipDecision` lets it run
         straight away, the body also waits for the async
         `sm:check-pending` decision (`flushPending`), so early page
         scripts can run first. */
    if (declared === "document-start") {
      waitForNode(function () { return document.documentElement; }, false, true, cb);
      return;
    }
    if (declared === "document-body") {
      waitForNode(function () { return document.body; }, true, false, cb);
      return;
    }
    if (declared === "document-end") {
      if (document.readyState !== "loading") { cb(); return; }
      document.addEventListener("DOMContentLoaded", function () { cb(); }, { once: true });
      return;
    }
    /* document-idle (default). Runs at the "complete" readystatechange,
       which on a normal page comes just before `load`, in the same task.
       - A body that sets itself up in a `window` load listener (common in
         old scripts) still sees `load` fire, as in Tampermonkey, which
         also runs idle scripts at "complete" before `load` (measured).
       - If the run decision holds the body past `load`, flushPending
         replays `load` to it (runWithLoadReplay).
       - A page that calls `window.stop()` never fires `load` but still
         reaches "complete", so it's covered too. The `load` listener is
         only a backstop.
       - A script injected after the page is already complete runs at
         once, with no replay: `load` was long over, as in any manager.
       A subresource that never finishes (a stalled third-party script)
       holds `load` back forever, so the body also runs IDLE_AFTER_DCL_MS
       after DOMContentLoaded, as Chrome's own document_idle does. */
    if (document.readyState === "complete") { cb(); return; }
    var idleDone = false;
    var idleTimer = null;
    var runIdle = function () {
      if (idleDone) return;
      idleDone = true;
      if (idleTimer !== null) clearTimeout(idleTimer);
      window.removeEventListener("load", runIdle);
      document.removeEventListener("readystatechange", onReadyState);
      document.removeEventListener("DOMContentLoaded", onContentLoaded);
      cb(true);
    };
    var onReadyState = function () {
      if (document.readyState === "complete") runIdle();
    };
    var onContentLoaded = function () {
      if (idleTimer === null) idleTimer = setTimeout(runIdle, IDLE_AFTER_DCL_MS);
    };
    window.addEventListener("load", runIdle);
    document.addEventListener("readystatechange", onReadyState);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", onContentLoaded);
    } else {
      onContentLoaded();
    }
  }

  /* Calls `cb` (at most once) when `get()` returns a node. The wait
     ends at DOMContentLoaded: a document that has no such node by then
     (XML, SVG) never will, and a `subtree` observer left on it would
     wake on every later DOM change. At that point `runAnyway` decides:
     - document-start runs anyway, as it did before it waited at all.
     - document-body quietly gives up, matching Tampermonkey's "runs if
       the body element exists". */
  function waitForNode(get, subtree, runAnyway, cb) {
    if (get()) { cb(); return; }
    var done = false;
    var obs = null;
    var finish = function (run) {
      if (done) return;
      done = true;
      try { if (obs) obs.disconnect(); } catch (_eo) {}
      try { document.removeEventListener("DOMContentLoaded", onEnd, true); } catch (_er) {}
      if (run) cb();
    };
    var onEnd = function () { finish(!!get() || runAnyway); };
    if (document.readyState !== "loading") { onEnd(); return; }
    try {
      obs = new MutationObserver(function () { if (get()) finish(true); });
      obs.observe(document, { childList: true, subtree: subtree });
      document.addEventListener("DOMContentLoaded", onEnd, true);
    } catch (_e) { finish(true); }
  }

  /* ---------- matcher (regex-aware URL recheck) ---------- */

  /* Mirrors the algorithm in src/url-match.ts. Inlined here so a
     script needing the recheck doesn't need a separate matcher entry;
     the prelude is on every script's js[] and the algorithm is tiny.
     The matcher block is only consulted when cfg.matching is present:
     scripts with a regex or `.tld` @include/@exclude/@match, and
     scripts with any glob @include (registered with NO_PAGE_MATCH; see
     injector.ts). A script whose @match patterns carry the whole
     registration skips it. */
  function escRx(s) { return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"); }
  function globRx(g) { return new RegExp("^" + escRx(g).replace(/\*/g, ".*") + "$"); }
  function includeMatch(pat, url) {
    if (pat.length >= 2 && pat.charAt(0) === "/" && pat.charAt(pat.length - 1) === "/") {
      /* Ignoring case, as url-match.ts does. */
      try { return new RegExp(pat.slice(1, -1), "i").test(url); } catch (_e) { return false; }
    }
    try { return includeGlobRx(pat).test(url); } catch (_e) { return false; }
  }
  /* `.tld` hosts ("any public suffix"). Read LOOSELY here, as any one
     or more labels: the exact reading needs the public suffix list,
     which stays out of the page. The service worker applies it in its
     sm:check-pending reply and answers `skip` (reason "no-match") where
     this was too generous. So this side must only ever be wider:
       - a `.tld` @match / @include matches any labels;
       - a `.tld` @exclude is ignored here, since a loose one would
         exclude pages the script should run on.
     tldIndex() mirrors src/url-match.ts; keep the two in lockstep. */
  var TLD_RX = "(?:\\.[a-z0-9-]+)+";
  function tldIndex(pat, globStar) {
    var sep = pat.indexOf("://");
    var start = sep < 0 ? 0 : sep + 3;
    var slash = pat.indexOf("/", start);
    var host = pat.slice(start, slash < 0 ? pat.length : slash).replace(/:(\d+|\*)$/, "");
    if (globStar && host.charAt(host.length - 1) === "*") host = host.slice(0, -1);
    if (host.slice(-4).toLowerCase() !== ".tld") return -1;
    var base = host.slice(0, -4);
    if (base === "" || base === "*") return -1;
    return start + host.length - 4;
  }
  function includeGlobRx(g) {
    var at = tldIndex(g, true);
    if (at < 0) return globRx(g);
    var a = escRx(g.slice(0, at)).replace(/\*/g, ".*");
    var b = escRx(g.slice(at + 4)).replace(/\*/g, ".*");
    return new RegExp("^" + a + TLD_RX + b + "$");
  }
  function hostMatchesTld(patternHost, hostname) {
    var base = patternHost.slice(0, -4).toLowerCase();
    var anySub = base.indexOf("*.") === 0;
    var name = (anySub ? base.slice(2) : base).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("^" + (anySub ? "(?:.+\\.)?" : "") + name + TLD_RX + "$").test(hostname.toLowerCase());
  }
  /* Lenient readings of the two shapes Chrome's parser refuses — an
     omitted scheme and a scheme glob. Mirrors canonicalMatchPatterns()
     in src/url-match.ts; see its header for why. Keep the two in
     lockstep: the SW registers the canonical form, so a wrapper that
     didn't know the rewrite would reject a page Chrome injected it on. */
  var CONCRETE_SCHEMES = ["http", "https", "file", "ftp"];
  function canonicalPatterns(pat) {
    if (pat === "<all_urls>") return [pat];
    var p = pat;
    if (p.indexOf("*//") === 0) p = "*:" + p.slice(1);
    else if (p.indexOf("//") === 0) p = "*:" + p;
    else if (p.indexOf("://") < 0) p = "*://" + p;
    var sep = p.indexOf("://");
    var scheme = p.slice(0, sep).toLowerCase();
    var rest = p.slice(sep);
    if (scheme === "*" || scheme === "") return anyScheme(rest);
    if (scheme.indexOf("*") < 0) return [p];
    var expanded = [];
    for (var i = 0; i < CONCRETE_SCHEMES.length; i++) {
      try {
        if (globRx(scheme).test(CONCRETE_SCHEMES[i])) expanded.push(CONCRETE_SCHEMES[i]);
      } catch (_e) { /* unglobbable scheme — leave the pattern alone */ }
    }
    if (expanded.length === 0) return [pat];
    if (expanded.join() === "http,https") return anyScheme(rest);
    for (var j = 0; j < expanded.length; j++) expanded[j] += rest;
    return expanded;
  }
  /* http-or-https, spelled out beside a numeric port because Chrome's
     parser refuses `*` there. Same reasoning as anyScheme() in
     src/url-match.ts — matching-wise the two spellings are equal, but
     the SW registers this one, so the wrapper reads it too. */
  function anyScheme(rest) {
    var host = rest.slice(3).split("/")[0];
    if (!/:\d+$/.test(host)) return ["*" + rest];
    return ["http" + rest, "https" + rest];
  }
  function matchPattern(pat, url) {
    if (pat === "<all_urls>") return /^(https?|file|ftp):/i.test(url);
    var cands = canonicalPatterns(pat);
    for (var i = 0; i < cands.length; i++) if (matchCanonical(cands[i], url)) return true;
    return false;
  }
  function matchCanonical(pat, url) {
    var parts = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/i.exec(pat);
    if (!parts) return false;
    var scheme = parts[1], host = parts[2], path = parts[3];
    var u; try { u = new URL(url); } catch (_e) { return false; }
    if (scheme === "*") {
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    } else if (u.protocol !== scheme.toLowerCase() + ":") return false;
    /* Split off a trailing `:port` so a port-pinned pattern matches the
       way Chrome's matcher (and src/url-match.ts) does — without this
       the whole `host:port` was compared against u.hostname (no port)
       and a script declaring a port-pinned @match alongside anything
       that makes cfg.matching ship was wrongly rejected in-page even
       though Chrome injected it. A pattern host
       with no port matches any port. Keep this in lockstep with
       url-match.ts. */
    var colon = host.lastIndexOf(":");
    var hasPort = colon > 0 && /^\d+$/.test(host.slice(colon + 1));
    var patternHost = hasPort ? host.slice(0, colon) : host;
    var patternPort = hasPort ? host.slice(colon + 1) : "";
    if (patternHost === "*") {
      /* any host */
    } else if (tldIndex(patternHost) >= 0) {
      if (!hostMatchesTld(patternHost, u.hostname)) return false;
    } else if (patternHost.indexOf("*.") === 0) {
      var suffix = patternHost.slice(2).toLowerCase();
      var h = u.hostname.toLowerCase();
      if (h !== suffix && h.slice(-(suffix.length + 1)) !== "." + suffix) return false;
    } else if (patternHost === "") {
      if (u.hostname !== "") return false;
    } else if (u.hostname.toLowerCase() !== patternHost.toLowerCase()) return false;
    if (patternPort !== "" && u.port !== patternPort) return false;
    /* Not the fragment, as in Chrome's matcher and url-match.ts. */
    var tail = u.pathname + u.search;
    try { return globRx(path).test(tail); } catch (_e) { return false; }
  }
  function hasTldRule(m) {
    var all = m.matches.concat(m.includes, m.excludes);
    for (var i = 0; i < all.length; i++) {
      if (!isRegexPat(all[i]) && all[i] !== "<all_urls>" && tldIndex(all[i], true) >= 0) return true;
    }
    return false;
  }
  function isRegexPat(pat) {
    return pat.length >= 2 && pat.charAt(0) === "/" && pat.charAt(pat.length - 1) === "/";
  }
  function matchScript(url, m) {
    for (var i = 0; i < m.excludes.length; i++) {
      var ex = m.excludes[i];
      /* See the `.tld` note above: the service worker decides these. */
      if (!isRegexPat(ex) && tldIndex(ex, true) >= 0) continue;
      if (includeMatch(ex, url)) return false;
    }
    for (var j = 0; j < m.matches.length; j++) if (matchPattern(m.matches[j], url)) return true;
    for (var k = 0; k < m.includes.length; k++) if (includeMatch(m.includes[k], url)) return true;
    return false;
  }

  /* ---------- startup logs (page-console diagnostics) ---------- */

  /* Whether this document is the tab's top frame. Reading `window.top`
     is allowed across origins, so this doesn't throw in practice. */
  function inTopFrame() {
    try { return window.top === window; } catch (_e) { return false; }
  }

  /* Fire the script's startupLogs to the page console once per page
     (see `initScript`). Same try/catch wrap as the old wrapper splice — pages
     that clobber console can't break us. */
  function emitStartupLogs(cfg) {
    var logs = cfg.startupLogs;
    if (!logs || !logs.length) return;
    for (var i = 0; i < logs.length; i++) {
      var l = logs[i];
      /* Always console.info regardless of l.level: console.warn /
         console.error from an injected script get forwarded into the
         extensions Errors panel and make SourceMonkey look broken. The
         Log tab still carries the real level via the parser mirror. */
      try { console.info("[SourceMonkey] " + cfg.name + ": " + l.message); } catch (_e) {}
    }
  }

  /* ---------- per-script init ---------- */

  function initScript(cfg) {
    if (!cfg || !cfg.id) return;
    if (scripts[cfg.id]) {
      if (cfg.manualRun) return rerunManual(scripts[cfg.id], cfg);
      return scripts[cfg.id];
    }
    var entry = makeEntry(cfg);
    scripts[cfg.id] = entry;
    /* Matcher check first — if we don't match, mark inactive so the
       combined entry's __smRun call is a no-op. Async listeners
       aren't installed either: this URL isn't ours. */
    if (cfg.matching) {
      entry.matched = matchScript(location.href, cfg.matching);
      if (!entry.matched) return entry;
    }
    /* Async listeners up early, before any of the script's code (its
       @requires and body, which run together in the deferred `__smRun`
       callback) can schedule work whose errors they attribute. */
    installAsyncListeners(entry);
    /* Past the matcher, so only a document we actually run on reports
       its focus. Not per-script — the flag inside is module-scoped. */
    installFocusSignal();
    /* Once per page: all its frames share one DevTools console. A
       frame's copy prints them only if the worker says so, with its
       decision (docs/frames.md). */
    if (inTopFrame()) emitStartupLogs(cfg);
    if (cfg.manualRun) {
      startManualRun(entry, cfg);
      return entry;
    }
    /* The two gates run CONCURRENTLY and the body starts at
       max(decision, run-at) — `flushPending` is the join, and it needs
       both `decision` and `runAtFired` regardless of which settled
       first.

       Why not chain them (the older shape awaited the decision and only
       THEN armed the @run-at gate):
       - For everything but `document-start` the wrapper was going to sit
         on a lifecycle event anyway, so on a page that is slower to
         reach that event than the service worker is to answer, the
         decision wait costs the page nothing. That is what lets the
         reload fast-path's window be a real budget instead of a race
         against the wrapper.
       - Arming the gate up front also means it no longer depends on the
         decision callback running at all: a service worker that never
         answers is bounded by `awaitDecision`'s own timeout,
         not by the lifecycle listener never getting installed.

       For `document-start`, once <html> exists (always, in the
       extension) `waitForRunAt` calls back synchronously, so the
       decision is the only gate left. `canSkipDecision` settles it
       here, synchronously, where the answer can only be `run`. */
    waitForRunAt(cfg.runAt, function (dueBeforeLoad) {
      entry.runAtFired = true;
      entry.replayLoad = !!dueBeforeLoad;
      flushPending(entry);
    });
    if (canSkipDecision(cfg)) {
      /* Nothing the SW could answer here is anything but `run`, so
         don't wait for it: see canSkipDecision. */
      entry.decision = { action: "run" };
      return entry;
    }
    awaitDecision(entry, function (decision) {
      entry.decision = decision;
      if (decision && decision.startupLogs === true && !inTopFrame()) emitStartupLogs(cfg);
      if (entry.decision.action === "skip") {
        /* The @run-at gate may already have fired; `flushPending`
           re-checks `skip` so a queued body can't slip through, and
           dropping `pendingRun` here releases the closure either way. */
        if (entry.decision.reason === "no-match") {
          /* The exact `.tld` check said this page isn't the script's:
             the same as our own matcher saying no, so nothing is
             reported. */
          entry.matched = false;
          entry.pendingRun = null;
          return;
        }
        if (entry.decision.reason === "no-decision") {
          /* Said here too: the report below goes the way the question
             did, so it may not get through either. */
          try { console.info("[SourceMonkey] " + cfg.name + ": It did not run. " + sentence(entry.decision.detail)); } catch (_ce) {}
        }
        send({
          type: "sm:abandoned",
          id: cfg.id,
          name: cfg.name,
          loadedAt: cfg.loadedAt,
          url: location.href,
          reason: entry.decision.reason || "skip",
          detail: entry.decision.detail
        });
        entry.pendingRun = null;
        return;
      }
      flushPending(entry);
    });
    return entry;
  }

  /* A manual script (`@run-at context-menu`), injected on request by
     "Run this script" (see docs/manual-scripts.md). The request is the
     decision, so there is no check-pending round trip and no @run-at
     wait: the body runs as soon as the combined entry hands it over.
     The worker sends the GM values snapshot along in the config. */
  function startManualRun(entry, cfg) {
    entry.runAtFired = true;
    entry.decision = { action: "run" };
    if (cfg.manualRun.gmValues) entry.decision.gmValues = cfg.manualRun.gmValues;
  }

  /* Another run of a manual script already run in this document. The
     entry is reused rather than replaced: the async error listeners
     installed for it read `entry.cfg`, so they report for the latest
     run, and a new entry would add a second pair.

     What the last run set up through the GM runtime is retired first,
     so its menu commands and value listeners don't pile up. Whatever
     it did to the page directly (timers, listeners, DOM) stays. */
  function rerunManual(entry, cfg) {
    try {
      if (window.__SM_GM__ && typeof window.__SM_GM__.retireRun === "function") {
        window.__SM_GM__.retireRun(cfg.id);
      }
    } catch (_e) {}
    entry.cfg = cfg;
    entry.matched = cfg.matching ? matchScript(location.href, cfg.matching) : true;
    entry.pendingRun = null;
    entry.runRegistered = false;
    entry.replayLoad = false;
    entry.loadedAtRun = cfg.loadedAt;
    if (entry.matched) {
      installAsyncListeners(entry);
      startManualRun(entry, cfg);
    }
    return entry;
  }

  /* Whether a `document-start` body can run without the check-pending
     round trip. The round trip is async, so an inline page <script>
     early in <head> can run while the wrapper waits, which defeats a
     script that must patch the page before its own code runs.

     Skipping it is safe only where the SW's answer is known to be
     `run`. Every other answer needs something this skips:
     - `run-new` (reload fast path) and the "Reload page with no
       userscripts" `skip` happen only on a reload. That `skip` covers
       the tab's subframes too, and a subframe can't see the top
       page's navigation type, so subframes always ask.
     - the reply carries a GM storage snapshot (`needsGmValues`).
     - a `.tld` rule needs the SW's exact match check.
     - an sm-dev tab claim can `skip` on any navigation, so in a browser
       sm-dev is connected to the wrapper asks, unless the tab vouches
       for the script's run. A scratch script (`cfg.run`) runs only in
       its run's tabs, so it asks unless vouched for, wherever it is.
       See `smDevMarker`.
     Other `@run-at` values wait for a later lifecycle event anyway, so
     the round trip costs them nothing. */
  function canSkipDecision(cfg) {
    if (cfg.runAt !== "document-start") return false;
    if (cfg.needsGmValues) return false;
    if (cfg.matching && hasTldRule(cfg.matching)) return false;
    try {
      if (window.top !== window) return false;
      var nav = performance.getEntriesByType("navigation")[0];
      if (!nav || nav.type === "reload") return false;
    } catch (_e) {
      return false;
    }
    if (typeof cfg.run === "string") return smDevMarker(SM_DEV_VOUCH_PREFIX + cfg.run);
    return !smDevMarker(SM_DEV_PRESENT);
  }

  /* The markers sm-dev puts in a browser it is connected to (see
     docs/sm-dev-design.md#making-wrappers-ask), each a window listener
     that cancels its event. sm-dev adds them through CDP, ahead of
     every script in a new document, so they are in place when the
     wrapper starts, before any page script could fake one. A
     synchronous dispatch reads them from any world. Names match
     `SM_DEV_MARKERS` in src/sm-dev-protocol.ts.
     - SM_DEV_PRESENT: in every page of the browser. sm-dev is connected,
       so any tab may be claimed.
     - SM_DEV_VOUCH_PREFIX + run: in a tab that run claims, while its
       scripts are on. The run's own scripts get `run` there. */
  var SM_DEV_PRESENT = "sourcemonkey-sm-dev";
  var SM_DEV_VOUCH_PREFIX = "sourcemonkey-sm-dev-run:";
  function smDevMarker(type) {
    try {
      var ev = new CustomEvent(type, { cancelable: true });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    } catch (_e) {
      return false;
    }
  }

  function flushPending(entry) {
    if (!entry.runAtFired || !entry.decision) return;
    if (entry.decision.action === "skip") return;
    var fn = entry.pendingRun;
    entry.pendingRun = null;
    if (typeof fn !== "function") return;
    if (entry.replayLoad && loadEvent) {
      runWithLoadReplay(function () { runMain(entry, fn); });
    } else {
      runMain(entry, fn);
    }
  }

  function runMain(entry, fn) {
    var cfg = entry.cfg;
    var decision = entry.decision;
    if (decision.action === "run-new" && typeof decision.body === "string") {
      /* Reload fast-path swap eval. Tag the new body with the script's
         sourceURL so async error attribution still works; fall through
         to the baked-in body on a CSP refusal. The eval runs at
         function-scope of runMain, NOT inside `fn`'s closure — so the
         GM bindings the injector spliced into `fn` are NOT visible
         here. To compensate, `buildSwapEvalBody` (in src/extension/injector.ts)
         prepends the script's GM bindings to `decision.body`, and the
         single (0,eval) call runs the bindings + body in one
         environment so the body's GM_* references resolve. See
         docs/injection.md#wrapper-protocol.

         What the prepended bindings can't carry is the gm prelude's
         `storage.init` — it reads the snapshot off `__smDecision`,
         which an indirect eval's global scope doesn't have. So we run
         the equivalent right here, where the decision object IS in
         scope, whenever the SW says the swapped body grants storage.
         `decision.seedValues` describes the NEW script, so this covers
         a refresh that ADDED the grant; `cfg.needsGmValues` (the
         registered set) deliberately isn't consulted.

         If the snapshot or the runtime is missing we do NOT swap: a
         storage body reading an empty cache would report defaults and
         a read-modify-write would then overwrite the user's real
         values. We fall through to the baked-in body instead, which
         handles its own seeding — for a missing snapshot that means
         the curated hard-abort message; for an init that THREW it
         means the same call throwing again inside the wrap function,
         reported as an ordinary sm:error. Either way the user sees a
         failure rather than a script running on wrong values. */
      var newLoadedAt = typeof decision.loadedAt === "number" ? decision.loadedAt : cfg.loadedAt;
      var evalRefused = false;
      var evalErr = null;
      var swapReady = true;
      if (decision.needsRuntime && !hasGmRuntime()) {
        /* The new body grants a runtime-backed API and this world has
           no runtime — the refresh added the first such grant on this
           page, and the next reload registers it. Run the baked-in
           (previous) body instead. */
        swapReady = false;
        try {
          console.info("[SourceMonkey] " + cfg.name + ": The updated copy needs the GM runtime, which this page does not have yet, so the previous version ran. Reload the page to pick it up.");
        } catch (_smNR) {}
      }
      if (swapReady && decision.seedValues) {
        swapReady = false;
        var swapSnap = decision.gmValues;
        if (swapSnap && typeof swapSnap === "object") {
          try {
            window.__SM_GM__.storage.init(cfg.id, swapSnap);
            swapReady = true;
          } catch (_smSI) {}
        }
        if (!swapReady) {
          try {
            console.info("[SourceMonkey] " + cfg.name + ": Could not load this script's stored GM values for the updated copy, so the previous version ran. Reload the page to retry.");
          } catch (_smSI2) {}
        }
      }
      if (swapReady) {
        try {
          (0, eval)(decision.body + "\n//# sourceURL=" + cfg.sourceUrl);
        } catch (ex) {
          evalErr = ex;
          var exMsg = (ex && ex.message) ? String(ex.message) : String(ex);
          if (exMsg.indexOf("unsafe-eval") !== -1 || exMsg.indexOf("Content Security Policy") !== -1) {
            evalRefused = true;
          }
        }
      }
      if (evalRefused || !swapReady) {
        if (evalRefused) {
          try { console.info("[SourceMonkey] swap blocked by page CSP for " + cfg.name + ", running prior version"); } catch (_e0) {}
        }
        /* Fall through to the default baked-body path. `entry.decision`
           deliberately keeps the run-new object: the registered body's
           gm prelude reads its `gmValues`, so replacing it with a bare
           `{action:"run"}` would make a storage script hard-abort. */
      } else {
        entry.loadedAtRun = newLoadedAt;
        try { console.log("[SourceMonkey] script", cfg.name, "running on", location.href, "(swapped to newer version)"); } catch (_e) {}
        send({
          type: "sm:swapped",
          id: cfg.id,
          name: cfg.name,
          fromLoadedAt: cfg.loadedAt,
          loadedAt: newLoadedAt,
          url: location.href
        });
        if (evalErr) {
          var newMsg = (evalErr && evalErr.message) ? evalErr.message : String(evalErr);
          var newStack = (evalErr && typeof evalErr.stack === "string") ? evalErr.stack : "";
          try { console.info("[SourceMonkey] swapped script", cfg.name, "threw:", evalErr); } catch (_e2) {}
          send({
            type: "sm:error",
            id: cfg.id,
            name: cfg.name,
            loadedAt: newLoadedAt,
            url: location.href,
            message: newMsg,
            stack: newStack
          });
        }
        return;
      }
    }
    /* Default path: run the baked-in main-body callback. */
    try { console.log("[SourceMonkey] script", cfg.name, "running on", location.href); } catch (_e) {}
    send({
      type: "sm:start",
      id: cfg.id,
      name: cfg.name,
      loadedAt: cfg.loadedAt,
      url: location.href
    });
    try {
      /* Pass the entry to the wrap function — the injector's
         wrapCombinedEntry emits `function(__smE){...}` and pulls
         __smDecision / __smName / __smId / __smLoadedAt / __smSend out
         of __smE so gm-bindings.ts's prelude (which references those
         names) works unchanged. */
      fn(entry);
    } catch (err) {
      var emsg = (err && err.message) ? err.message : String(err);
      var estack = (err && typeof err.stack === "string") ? err.stack : "";
      try { console.info("[SourceMonkey] script", cfg.name, "threw:", err); } catch (_e) {}
      send({
        type: "sm:error",
        id: cfg.id,
        name: cfg.name,
        loadedAt: cfg.loadedAt,
        url: location.href,
        message: emsg,
        stack: estack
      });
    }
  }

  /* ---------- public helpers (called by per-script entries) ----------
   *
   * Each helper is keyed by scriptId so multiple scripts in the same
   * world coexist. They live on `self` so per-script entries (which
   * run as their own scripts) can find them. */

  /* Queue the main body for execution. Called once per script by the
     combined user-program {code} entry. The body is wrapped in a
     function so the prelude can defer it until decision + @run-at
     resolve. */
  self.__smRun = function (scriptId, fn) {
    var entry = scripts[scriptId];
    if (!entry) return;
    /* Set BEFORE the matched check: the flag records "the entry
       parsed and ran", which is true regardless of whether this URL
       matched. __smSealed reads it. */
    entry.runRegistered = true;
    if (!entry.matched) return;
    entry.pendingRun = fn;
    flushPending(entry);
  };

  /* Parse-failure sentinel. Emitted as the LAST js[] entry, after the
     combined user-program entry.

     Everything the user wrote — every @require plus the body — is one
     V8 script now, so an unterminated string / comment / template
     anywhere in any require makes the whole entry fail to parse. That
     failure is invisible: __smRun is never reached, so without this
     the script would simply never run, with no error, no log entry
     and no badge. (Under the old separate-entries arrangement the
     broken require died alone and the body still ran.)

     This entry is its own script, so it parses and runs even when the
     one before it didn't. */
  self.__smSealed = function (scriptId) {
    var entry = scripts[scriptId];
    if (!entry || entry.runRegistered) return;
    /* `matched` matters HERE but deliberately not in __smRun. There,
       the flag records "the entry parsed and called us", which is
       true regardless of the URL. Here we're inferring the opposite
       from its absence — and initScript stores the entry BEFORE
       running the matcher, so on a page the script doesn't match the
       entry exists with runRegistered false and nothing wrong. Without
       this check a script registered at <all_urls> and filtered
       in-page would log an error and turn the badge red on every page
       the user visits. */
    if (!entry.matched) return;
    var msg = "Script source failed to parse (a @require or the script body has a syntax error); nothing was run";
    try { console.info("[SourceMonkey]", entry.cfg.name + ":", msg); } catch (_e) {}
    send({
      type: "sm:error",
      id: entry.cfg.id,
      name: entry.cfg.name,
      loadedAt: entry.loadedAtRun,
      url: location.href,
      message: msg
    });
  };

  /* ---------- The sandbox `window` for granted page-world scripts ----------
     A granted script in MAIN world runs its user program inside
     `with (scope)`, with the sandbox as top-level `this`, as
     Tampermonkey and Violentmonkey run theirs. The sandbox is a Proxy
     standing in for `window`:
       - Reads fall through to the page's window, so `window.$` and a
         bare `$` both see the page's jQuery, and `"x" in window`
         answers for the page's properties too.
       - Plain writes (`window.foo = x`, `defineProperty`) stay in the
         sandbox, so a `@require`d library's `window.jQuery = …` doesn't
         replace the page's. A bare `foo` in the script then finds the
         sandbox's copy first.
       - Writes to a setter the page's window has (`onload`,
         `location`, `name`, our `onurlchange`) go through to it.
       - `window`, `self`, `globalThis`, and `top` / `parent` / `frames`
         where they are this window, read as the sandbox.
       - Window methods (`setTimeout`, `addEventListener`, other native
         ones) come back bound to the real window, since a call through
         the sandbox would pass it as `this` and the method would
         throw.
       - The script's own bindings (`GM_info`, granted `GM_*`, `GM`,
         `unsafeWindow`) are on it, so `this.unsafeWindow` and
         `window.GM_setValue` work as they do in TM and VM.
       - Our own `__sm*` globals bypass it, both ways: the eval hook's
         map and `__SM_GM__` must stay on the real window.
     The `with` object is a second, thin Proxy over it (the scope). Its
     `has` claims only the sandbox's own names and `window` / `self` /
     `globalThis`, so any other bare name resolves as it would without
     the sandbox; the sandbox's own `has` answers `in` for everything.
     The sandbox's own properties live on its Proxy target, so the
     Proxy invariants hold for them, non-configurable ones included.
     See docs/injection.md, "The sandbox window". */
  var _Proxy = typeof Proxy === "function" ? Proxy : null;
  var _WeakMap = typeof WeakMap === "function" ? WeakMap : null;
  var _ReflectApply = Reflect.apply;
  var _ReflectConstruct = Reflect.construct;
  var _ReflectDefineProperty = Reflect.defineProperty;
  var _ReflectDeleteProperty = Reflect.deleteProperty;
  var _ReflectGet = Reflect.get;
  var _ReflectSet = Reflect.set;
  var _getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  var _getPrototypeOf = Object.getPrototypeOf;
  var _defineProperty = Object.defineProperty;
  var _ownKeys = Reflect.ownKeys;
  var _fnToString = Function.prototype.toString;
  var _bind = Function.prototype.bind;
  var _hasOwnProp = Object.prototype.hasOwnProperty;
  var _ObjectProto = Object.prototype;
  var _unscopables = Symbol.unscopables;
  var NATIVE_CODE = /\{\s*\[native code\]\s*\}\s*$/;
  /* sandbox -> its scope Proxy. */
  var sandboxes = _WeakMap ? new _WeakMap() : null;
  var boundMethods = _WeakMap ? new _WeakMap() : null;
  /* function -> whether it is native code, so a page function's source
     is stringified once, not on every read. */
  var nativeVerdicts = _WeakMap ? new _WeakMap() : null;

  function isSandbox(v) {
    return !!(sandboxes && v && (typeof v === "object") && sandboxes.has(v));
  }

  /* The window's own methods, bound by name whatever their value: a
     page or another script often wraps `addEventListener` (our
     `onurlchange` support does), and the wrapper ends in the native
     method, which needs the real window as `this`. Tampermonkey binds
     the same list. */
  var WINDOW_METHODS = Object.create(null);
  ("addEventListener alert atob blur btoa cancelAnimationFrame cancelIdleCallback " +
    "captureEvents clearInterval clearTimeout close confirm createImageBitmap " +
    "dispatchEvent fetch find focus getComputedStyle getSelection matchMedia " +
    "moveBy moveTo open postMessage print prompt queueMicrotask releaseEvents " +
    "removeEventListener reportError requestAnimationFrame requestIdleCallback " +
    "resizeBy resizeTo scroll scrollBy scrollTo setInterval setTimeout " +
    "showDirectoryPicker stop structuredClone webkitCancelAnimationFrame " +
    "webkitRequestAnimationFrame").split(" ").forEach(function (n) { WINDOW_METHODS[n] = true; });

  function isNative(fn) {
    var v = nativeVerdicts.get(fn);
    if (v === undefined) {
      try { v = NATIVE_CODE.test(_ReflectApply(_fnToString, fn, [])); } catch (_e) { v = false; }
      nativeVerdicts.set(fn, v);
    }
    return v;
  }

  /* A method of the window, to bind: one of the window's own by name,
     or native code with no `prototype` (constructors have one, methods
     don't). Not `Object.prototype`'s (`hasOwnProperty`, `valueOf`):
     those must see the sandbox as `this`. */
  function isWindowMethod(k, fn) {
    if (typeof fn !== "function") return false;
    if (typeof k === "string" && WINDOW_METHODS[k]) return true;
    if (_hasOwnProp.call(fn, "prototype")) return false;
    if (_hasOwnProp.call(_ObjectProto, k) && _ObjectProto[k] === fn) return false;
    return isNative(fn);
  }

  /* The same bound copy each time, so `removeEventListener(type,
     window.handler)`-style identity checks still hold. It reads as
     native code exactly when the original does, for scripts that check
     `toString` (is `window.close` the browser's, or a replacement?):
     - A native method gets a real bound function, which also keeps
       `new` working (`new window.Proxy(…)`).
     - A replacement (a page's wrapper, our `window.close`) gets a plain
       function calling it with the real window. */
  function boundToWindow(fn) {
    var b = boundMethods.get(fn);
    if (!b) {
      if (isNative(fn)) {
        b = _ReflectApply(_bind, fn, [window]);
      } else {
        b = function () {
          if (new.target !== undefined) return _ReflectConstruct(fn, arguments, new.target === b ? fn : new.target);
          return _ReflectApply(fn, window, arguments);
        };
      }
      boundMethods.set(fn, b);
    }
    return b;
  }

  /* Called for every bare name the script reads, so it avoids
     allocating. */
  function isOurKey(k) {
    return typeof k === "string" && k.charCodeAt(0) === 95
      && (k.lastIndexOf("__sm", 0) === 0 || k === "__SM_GM__");
  }

  /* The page window's descriptor for `k`, own or inherited. */
  function windowDescriptor(k) {
    for (var o = window; o; o = _getPrototypeOf(o)) {
      var d = _getOwnPropertyDescriptor(o, k);
      if (d) return d;
    }
    return null;
  }

  function isWindowAlias(k) {
    return k === "window" || k === "self" || k === "globalThis";
  }

  function makeSandbox(exposed) {
    if (!_Proxy || !sandboxes) return window;
    /* The sandbox's own properties. */
    var own = Object.create(null);
    var proxy;
    var keys = _ownKeys(exposed);
    for (var i = 0; i < keys.length; i++) {
      _defineProperty(own, keys[i], { value: exposed[keys[i]], writable: true, enumerable: false, configurable: true });
    }
    /* The page's value for `k`, as the script should see it. */
    function pageValue(k) {
      var v = window[k];
      if (v === window && (isWindowAlias(k) || k === "top" || k === "parent" || k === "frames")) return proxy;
      if (isWindowMethod(k, v)) return boundToWindow(v);
      return v;
    }
    proxy = new _Proxy(own, {
      has: function (t, k) {
        if (isOurKey(k)) return k in window;
        return k in t || k in window;
      },
      get: function (t, k) {
        if (isOurKey(k)) return window[k];
        if (_hasOwnProp.call(t, k)) {
          var v = _ReflectGet(t, k, proxy);
          /* A script's own replacement of a window method, which
             likely ends in the native one. */
          return typeof k === "string" && WINDOW_METHODS[k] && typeof v === "function" ? boundToWindow(v) : v;
        }
        return pageValue(k);
      },
      set: function (t, k, v) {
        if (isOurKey(k)) { window[k] = v; return true; }
        if (_hasOwnProp.call(t, k)) return _ReflectSet(t, k, v, proxy);
        /* A setter goes through to the page; a read-only property
           (`document`, `undefined`) refuses the write, as the real
           window does. Anything else becomes the sandbox's own. */
        var w = windowDescriptor(k);
        if (w && w.set) { _ReflectApply(w.set, window, [v]); return true; }
        if (w && (w.get || !w.writable)) return false;
        return _ReflectDefineProperty(t, k, { value: v, writable: true, enumerable: true, configurable: true });
      },
      defineProperty: function (t, k, desc) {
        if (isOurKey(k)) return _ReflectDefineProperty(window, k, desc);
        return _ReflectDefineProperty(t, k, desc);
      },
      deleteProperty: function (t, k) {
        if (isOurKey(k)) return _ReflectDeleteProperty(window, k);
        return _ReflectDeleteProperty(t, k);
      },
      getOwnPropertyDescriptor: function (t, k) {
        if (!isOurKey(k) && _hasOwnProp.call(t, k)) return _getOwnPropertyDescriptor(t, k);
        var w = _getOwnPropertyDescriptor(window, k);
        if (!w) return undefined;
        /* Reported configurable: the target lacks it, and a Proxy can
           only report a non-configurable property its target has. */
        w.configurable = true;
        if ("value" in w) w.value = pageValue(k);
        return w;
      },
      ownKeys: function (t) {
        var seen = Object.create(null);
        var out = [];
        var add = function (k) {
          if (typeof k === "symbol") { if (out.indexOf(k) < 0) out.push(k); return; }
          if (seen[k]) return;
          seen[k] = true;
          out.push(k);
        };
        _ownKeys(window).forEach(add);
        _ownKeys(t).forEach(add);
        return out;
      },
      getPrototypeOf: function () { return _getPrototypeOf(window); },
      setPrototypeOf: function () { return false; },
      /* The page's window can't be made non-extensible either. */
      preventExtensions: function () { return false; },
    });
    var scope = new _Proxy(Object.create(null), {
      has: function (_t, k) {
        if (typeof k !== "string" || isOurKey(k)) return false;
        return _hasOwnProp.call(own, k) || isWindowAlias(k);
      },
      get: function (_t, k) {
        if (k === _unscopables) return undefined;
        return proxy[k];
      },
      set: function (_t, k, v) {
        return _ReflectSet(proxy, k, v);
      },
    });
    sandboxes.set(proxy, scope);
    return proxy;
  }

  /* The object a sandbox's user program runs `with`. */
  function scopeOf(sandbox) {
    return (sandboxes && sandboxes.get(sandbox)) || sandbox;
  }

  /* Run the user program with the sandbox as `this`, through the
     `Reflect.apply` captured at document_start, so a page that patched
     `Function.prototype.call` (as some do, for their own reasons)
     doesn't sit in the way. Not a security boundary: a MAIN-world page
     can replace `__smPrelude` itself. */
  function callAs(fn, thisArg) {
    return _ReflectApply(fn, thisArg, []);
  }

  /* The shared namespace. .init() lets a per-script config blob that
     runs AFTER the prelude is already loaded (i.e. the 2nd+ script in
     the same world) initialize directly without going through the
     queue. */
  self.__smPrelude = {
    scripts: scripts,
    init: initScript,
    /* For tests that run the decision's timer themselves. */
    decisionTimeoutMs: DECISION_TIMEOUT_MS,
    send: send,
    sandbox: makeSandbox,
    scopeOf: scopeOf,
    callAs: callAs,
  };

  /* Drain any configs the FIRST script's config blob (which ran
     before this prelude entry) pushed onto the queue. */
  drainQueue(initScript);
})();
