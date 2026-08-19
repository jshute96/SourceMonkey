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
 *                `__smRun("id",function(){<gm bindings on same line>
 *                 <user source>\n})`, so it runs only after the
 *                matcher + check-pending + @run-at gates resolve.
 *                Concatenation is what gives requires and the body one
 *                shared scope. Trailing
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
   *                  matching?, needsGmValues, startupLogs?}
   *                  passed in by the per-script config blob.
   *   matched      : did the in-page matcher accept this URL? Sync;
   *                  set during initScript.
   *   decision     : null|run|run-new|skip — settled by check-pending.
   *   runAtFired   : true once the @run-at lifecycle event happened.
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
      pendingRun: null,
      runRegistered: false,
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
     script needing the recheck doesn't need a separate matcher entry;
     the prelude is on every script's js[] and the algorithm is tiny.
     The matcher block is only consulted when cfg.matching is present:
     scripts with a regex @include/@exclude, and scripts with no
     @match at all (registered <all_urls>). A script whose @match
     patterns carry the whole registration skips it. */
  function escRx(s) { return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"); }
  function globRx(g) { return new RegExp("^" + escRx(g).replace(/\*/g, ".*") + "$"); }
  function includeMatch(pat, url) {
    if (pat.length >= 2 && pat.charAt(0) === "/" && pat.charAt(pat.length - 1) === "/") {
      try { return new RegExp(pat.slice(1, -1)).test(url); } catch (_e) { return false; }
    }
    try { return globRx(pat).test(url); } catch (_e) { return false; }
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
    } else if (patternHost.indexOf("*.") === 0) {
      var suffix = patternHost.slice(2).toLowerCase();
      var h = u.hostname.toLowerCase();
      if (h !== suffix && h.slice(-(suffix.length + 1)) !== "." + suffix) return false;
    } else if (patternHost === "") {
      if (u.hostname !== "") return false;
    } else if (u.hostname.toLowerCase() !== patternHost.toLowerCase()) return false;
    if (patternPort !== "" && u.port !== patternPort) return false;
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
    if (scripts[cfg.id]) return scripts[cfg.id];
    var entry = makeEntry(cfg);
    scripts[cfg.id] = entry;
    /* Matcher check first — if we don't match, mark inactive so the
       combined entry's __smRun call is a no-op. Async listeners
       aren't installed either: this URL isn't ours. */
    if (cfg.matching) {
      entry.matched = matchScript(location.href, cfg.matching);
      if (!entry.matched) return entry;
    }
    /* Async listeners up early so a synchronous throw inside a require
       entry (which runs BEFORE the main body's deferred callback) is
       still attributed correctly through the window error listener. */
    installAsyncListeners(entry);
    emitStartupLogs(cfg);
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
         answers is bounded by `awaitDecision`'s own 2s safety timeout,
         not by the lifecycle listener never getting installed.

       `document-start` is unchanged either way: `waitForRunAt` calls
       back synchronously for it, so the decision is the only gate left
       and the body still runs as early as it safely can. */
    waitForRunAt(cfg.runAt, function () {
      entry.runAtFired = true;
      flushPending(entry);
    });
    awaitDecision(entry, function (decision) {
      entry.decision = decision || { action: "run" };
      if (entry.decision.action === "skip") {
        /* The @run-at gate may already have fired; `flushPending`
           re-checks `skip` so a queued body can't slip through, and
           dropping `pendingRun` here releases the closure either way. */
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
      flushPending(entry);
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
      if (decision.seedValues) {
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
            console.info("[SourceMonkey] " + cfg.name + ": Could not load this script's stored GM values for the updated copy, so the previous version ran — reload the page to retry");
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
          try { console.info("[SourceMonkey] swap blocked by page CSP for", cfg.name, "— running prior version"); } catch (_e0) {}
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
