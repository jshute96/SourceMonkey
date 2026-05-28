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
 * Per-script layout (separate-entries mode):
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
 *   js[2..N-1] — one entry per @require, wrapped in
 *                `if(__smActive("id")){try{<body>}catch(e){__smErr("id",e)}}`
 *                with a trailing `//# sourceURL=<require URL>` so each
 *                require shows up as its own file in devtools with
 *                original line numbers.
 *   js[N]  — main body, wrapped in
 *                `__smRun("id",function(){<gm bindings on same line>
 *                 <body line 1>\n<body line 2>...\n})`
 *                so the body runs only after the matcher + check-pending
 *                + @run-at gates resolve. Trailing
 *                `//# sourceURL=sourcemonkey://<id>/<name>.user.js`.
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
        try { console.error("[SourceMonkey] prelude init threw for", q[i] && q[i].id, e); } catch (_e) {}
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
   *                  matching?, needsGmValues, startupLogs?, requireUrls?}
   *                  passed in by the per-script config blob.
   *   matched      : did the in-page matcher accept this URL? Sync;
   *                  set during initScript. require entries gate on
   *                  this via __smActive.
   *   decision     : null|run|run-new|skip — settled by check-pending.
   *   runAtFired   : true once the @run-at lifecycle event happened.
   *   pendingRun   : the main-body fn passed to __smRun, queued until
   *                  (matched && decision !== 'skip' && runAtFired).
   *   loadedAtRun  : loadedAt to attribute sm:start / sm:error to;
   *                  bumps when decision === 'run-new'.
   */
  function makeEntry(cfg) {
    return {
      cfg: cfg,
      matched: true,
      decision: null,
      runAtFired: false,
      pendingRun: null,
      loadedAtRun: cfg.loadedAt,
      asyncListenersInstalled: false,
    };
  }

  /* ---------- telemetry transport ---------- */

  /* Dual transport: chrome.runtime.sendMessage in USER_SCRIPT world,
     window.postMessage bridge in MAIN world. The bridge listener
     lives in wrapper-bridge.js (registered separately). */
  function send(payload) {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
        var p = chrome.runtime.sendMessage(payload);
        if (p && typeof p.catch === "function") p.catch(function () {});
        return;
      }
    } catch (_e) {}
    try {
      window.postMessage({ __sm: "sourcemonkey-bridge", payload: payload }, "*");
    } catch (_e2) {}
  }

  /* Round-trip sm:check-pending and hand the SW's decision (or a 2s
     safety-timeout fallback) to cb. Same dual transport as `send`. */
  function awaitDecision(entry, cb) {
    var cfg = entry.cfg;
    var done = false;
    var finish = function (decision) {
      if (done) return;
      done = true;
      try { cb(decision); } catch (_e) {}
    };
    var cleanup = function () {};
    var safetyTimer = setTimeout(function () { seal({ action: "run" }); }, 2000);
    var seal = function (decision) {
      try { clearTimeout(safetyTimer); } catch (_e) {}
      try { cleanup(); } catch (_e2) {}
      finish(decision);
    };
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
        var p = chrome.runtime.sendMessage({
          type: "sm:check-pending",
          id: cfg.id,
          name: cfg.name,
          loadedAt: cfg.loadedAt,
          url: location.href,
          needsValues: !!cfg.needsGmValues
        });
        if (p && typeof p.then === "function") {
          p.then(
            function (reply) { seal(reply && typeof reply === "object" ? reply : { action: "run" }); },
            function () { seal({ action: "run" }); }
          );
        } else {
          seal({ action: "run" });
        }
        return;
      }
      /* MAIN world: bridge request/reply protocol with a requestId
         nonce so concurrent userscripts each get their own reply. */
      var requestId = "sm-" + Math.random().toString(36).slice(2) + "-" + Date.now();
      var listener = function (ev) {
        try {
          if (!ev || ev.source !== window) return;
          var d = ev.data;
          if (!d || d.__sm !== "sourcemonkey-bridge-reply") return;
          if (d.requestId !== requestId) return;
          seal(d.reply && typeof d.reply === "object" ? d.reply : { action: "run" });
        } catch (_e) {}
      };
      window.addEventListener("message", listener, true);
      cleanup = function () { try { window.removeEventListener("message", listener, true); } catch (_e) {} };
      window.postMessage({
        __sm: "sourcemonkey-bridge",
        requestId: requestId,
        payload: {
          type: "sm:check-pending",
          id: cfg.id,
          name: cfg.name,
          loadedAt: cfg.loadedAt,
          url: location.href,
          needsValues: !!cfg.needsGmValues
        }
      }, "*");
    } catch (_e3) { seal({ action: "run" }); }
  }

  /* Async-error attribution. Each script has its own sourceUrl marker
     (sourcemonkey://<id>/<name>.user.js) AND a list of require URLs.
     The injector appends `//# sourceURL=...` to every per-entry blob,
     so stack frames from this script's code reference one of those
     markers. The listener filters by ANY marker for THIS script. */
  var __smReported = (typeof WeakSet === "function") ? new WeakSet() : null;
  function stackHitsScript(err, entry) {
    try {
      var stack = err && typeof err === "object" && err.stack;
      if (typeof stack !== "string") return false;
      if (stack.indexOf(entry.cfg.sourceUrl) !== -1) return true;
      var reqs = entry.cfg.requireUrls;
      if (reqs) {
        for (var i = 0; i < reqs.length; i++) {
          if (stack.indexOf(reqs[i]) !== -1) return true;
        }
      }
    } catch (_e) {}
    return false;
  }
  function filenameHitsScript(filename, entry) {
    try {
      if (typeof filename !== "string") return false;
      if (filename.indexOf(entry.cfg.sourceUrl) !== -1) return true;
      var reqs = entry.cfg.requireUrls;
      if (reqs) {
        for (var i = 0; i < reqs.length; i++) {
          if (filename.indexOf(reqs[i]) !== -1) return true;
        }
      }
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

  /* @run-at gating. Each script's entry drives its own deferral; the
     prelude calls back into runMain when the lifecycle event fires. */
  function waitForRunAt(declared, cb) {
    if (declared === "document-start") { cb(); return; }
    if (declared === "document-body") {
      if (document.body) { cb(); return; }
      var obs;
      try {
        obs = new MutationObserver(function () {
          if (document.body) {
            try { obs.disconnect(); } catch (_eo) {}
            cb();
          }
        });
        obs.observe(document.documentElement, { childList: true });
      } catch (_e) { cb(); }
      return;
    }
    if (declared === "document-end") {
      if (document.readyState !== "loading") { cb(); return; }
      document.addEventListener("DOMContentLoaded", function () { cb(); }, { once: true });
      return;
    }
    /* document-idle (default). */
    if (document.readyState === "complete") { cb(); return; }
    window.addEventListener("load", function () { cb(); }, { once: true });
  }

  /* ---------- matcher (regex-aware URL recheck) ---------- */

  /* Mirrors the algorithm in src/url-match.ts. Inlined here so a
     regex-using script doesn't need a separate matcher entry; the
     prelude is on every script's js[] and the algorithm is tiny.
     The matcher block is only consulted when cfg.matching is
     present — pure @match / glob scripts skip it. */
  function escRx(s) { return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"); }
  function globRx(g) { return new RegExp("^" + escRx(g).replace(/\*/g, ".*") + "$"); }
  function includeMatch(pat, url) {
    if (pat.length >= 2 && pat.charAt(0) === "/" && pat.charAt(pat.length - 1) === "/") {
      try { return new RegExp(pat.slice(1, -1)).test(url); } catch (_e) { return false; }
    }
    try { return globRx(pat).test(url); } catch (_e) { return false; }
  }
  function matchPattern(pat, url) {
    if (pat === "<all_urls>") return /^(https?|file|ftp):/i.test(url);
    var parts = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/i.exec(pat);
    if (!parts) return false;
    var scheme = parts[1], host = parts[2], path = parts[3];
    var u; try { u = new URL(url); } catch (_e) { return false; }
    if (scheme === "*") {
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    } else if (u.protocol !== scheme.toLowerCase() + ":") return false;
    if (host === "*") {
      /* any host */
    } else if (host.indexOf("*.") === 0) {
      var suffix = host.slice(2).toLowerCase();
      var h = u.hostname.toLowerCase();
      if (h !== suffix && h.slice(-(suffix.length + 1)) !== "." + suffix) return false;
    } else if (host === "") {
      if (u.hostname !== "") return false;
    } else if (u.hostname.toLowerCase() !== host.toLowerCase()) return false;
    var tail = u.pathname + u.search + u.hash;
    try { return globRx(path).test(tail); } catch (_e) { return false; }
  }
  function matchScript(url, m) {
    for (var i = 0; i < m.excludes.length; i++) if (includeMatch(m.excludes[i], url)) return false;
    for (var j = 0; j < m.matches.length; j++) if (matchPattern(m.matches[j], url)) return true;
    for (var k = 0; k < m.includes.length; k++) if (includeMatch(m.includes[k], url)) return true;
    return false;
  }

  /* ---------- startup logs (page-console diagnostics) ---------- */

  /* Fire the script's startupLogs to the page console exactly once on
     activation. Same try/catch wrap as the old wrapper splice — pages
     that clobber console can't break us. */
  function emitStartupLogs(cfg) {
    var logs = cfg.startupLogs;
    if (!logs || !logs.length) return;
    var allowed = { log: 1, info: 1, warn: 1, error: 1 };
    for (var i = 0; i < logs.length; i++) {
      var l = logs[i];
      var level = (l && l.level && allowed[l.level]) ? l.level : "warn";
      try { console[level]("[SourceMonkey] " + cfg.name + ": " + l.message); } catch (_e) {}
    }
  }

  /* ---------- per-script init ---------- */

  function initScript(cfg) {
    if (!cfg || !cfg.id) return;
    if (scripts[cfg.id]) return scripts[cfg.id];
    var entry = makeEntry(cfg);
    scripts[cfg.id] = entry;
    /* Matcher check first — if we don't match, mark inactive so
       __smActive returns false (and queued require entries skip) and
       drop any __smRun call as a no-op. Async listeners aren't
       installed either: this URL isn't ours. */
    if (cfg.matching) {
      entry.matched = matchScript(location.href, cfg.matching);
      if (!entry.matched) return entry;
    }
    /* Async listeners up early so a synchronous throw inside a require
       entry (which runs BEFORE the main body's deferred callback) is
       still attributed correctly through the window error listener. */
    installAsyncListeners(entry);
    emitStartupLogs(cfg);
    awaitDecision(entry, function (decision) {
      entry.decision = decision || { action: "run" };
      if (entry.decision.action === "skip") {
        send({
          type: "sm:abandoned",
          id: cfg.id,
          name: cfg.name,
          loadedAt: cfg.loadedAt,
          url: location.href,
          reason: entry.decision.reason || "skip"
        });
        entry.pendingRun = null;
        return;
      }
      waitForRunAt(cfg.runAt, function () {
        entry.runAtFired = true;
        flushPending(entry);
      });
    });
    return entry;
  }

  function flushPending(entry) {
    if (!entry.runAtFired || !entry.decision) return;
    if (entry.decision.action === "skip") return;
    var fn = entry.pendingRun;
    entry.pendingRun = null;
    if (typeof fn !== "function") return;
    runMain(entry, fn);
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
         here. To compensate, `buildSwapEvalBody` (in src/injector.ts)
         prepends the script's GM bindings to `decision.body`, and the
         single (0,eval) call runs the bindings + body in one
         environment so the body's GM_* references resolve. Storage
         bindings are NOT included; the SW refuses run-new for storage
         scripts upstream. See docs/injection-modes.md. */
      var newLoadedAt = typeof decision.loadedAt === "number" ? decision.loadedAt : cfg.loadedAt;
      var evalRefused = false;
      var evalErr = null;
      try {
        (0, eval)(decision.body + "\n//# sourceURL=" + cfg.sourceUrl);
      } catch (ex) {
        evalErr = ex;
        var exMsg = (ex && ex.message) ? String(ex.message) : String(ex);
        if (exMsg.indexOf("unsafe-eval") !== -1 || exMsg.indexOf("Content Security Policy") !== -1) {
          evalRefused = true;
        }
      }
      if (evalRefused) {
        try { console.info("[SourceMonkey] swap blocked by page CSP for", cfg.name, "— running prior version"); } catch (_e0) {}
        /* fall through to default baked-body path */
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
          try { console.error("[SourceMonkey] swapped script", cfg.name, "threw:", evalErr); } catch (_e2) {}
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
         wrapMainBodyEntry emits `function(__smE){...}` and pulls
         __smDecision / __smName / __smId / __smLoadedAt / __smSend out
         of __smE so gm-bindings.ts's prelude (which references those
         names) works unchanged. */
      fn(entry);
    } catch (err) {
      var emsg = (err && err.message) ? err.message : String(err);
      var estack = (err && typeof err.stack === "string") ? err.stack : "";
      try { console.error("[SourceMonkey] script", cfg.name, "threw:", err); } catch (_e) {}
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

  /* Synchronous "is this script's matcher live for this URL?" check.
     require entries gate on this so non-matching scripts skip the
     require's body. Returns false BEFORE the script's config blob
     has been processed (defensive — shouldn't happen because the
     config blob is in js[0] before any require entry). */
  self.__smActive = function (scriptId) {
    var entry = scripts[scriptId];
    if (!entry) return false;
    return entry.matched;
  };

  /* Queue the main body for execution. Called once per script by the
     final per-script {code} entry. The body is wrapped in a function
     so the prelude can defer it until decision + @run-at resolve. */
  self.__smRun = function (scriptId, fn) {
    var entry = scripts[scriptId];
    if (!entry || !entry.matched) return;
    entry.pendingRun = fn;
    flushPending(entry);
  };

  /* Synchronous error reporter for require entries. A SyntaxError or
     top-level throw inside a require body propagates through the
     `try/catch` the injector emits around the require, and __smErr
     surfaces it through the usual sm:error channel so the badge and
     log reflect it. */
  self.__smErr = function (scriptId, err) {
    var entry = scripts[scriptId];
    if (!entry) return;
    var msg = (err && err.message) ? String(err.message) : String(err);
    var stack = (err && typeof err.stack === "string") ? err.stack : "";
    try { console.error("[SourceMonkey] script", entry.cfg.name, "threw in @require:", err); } catch (_e) {}
    send({
      type: "sm:error",
      id: entry.cfg.id,
      name: entry.cfg.name,
      loadedAt: entry.loadedAtRun,
      url: location.href,
      message: msg,
      stack: stack
    });
  };

  /* The shared namespace. .init() lets a per-script config blob that
     runs AFTER the prelude is already loaded (i.e. the 2nd+ script in
     the same world) initialize directly without going through the
     queue. */
  self.__smPrelude = {
    scripts: scripts,
    init: initScript,
    send: send,
  };

  /* Drain any configs the FIRST script's config blob (which ran
     before this prelude entry) pushed onto the queue. */
  drainQueue(initScript);
})();
