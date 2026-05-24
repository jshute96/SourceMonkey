// Per-script `GM_*` / `GM.*` binding emitter.
//
// The injector calls `emitGmBindings` once per script at wrapper-build
// time. The returned source string is concatenated into the wrapper
// between the head and the matcher block (inside the outer IIFE, so
// the bindings are visible to BOTH the baked-in body AND the
// run-new swap-eval branch). When no APIs are granted (or the script
// is `@grant none`), `emitGmBindings` returns the empty string.
//
// Topology recap:
//   - SYNC API bodies delegate to `window.__SM_GM__.<method>(...)`,
//     defined by src/wrapper-gm-runtime.js (a separately-registered
//     USER_SCRIPT-world script). The runtime is shared across all
//     userscripts in the document.
//   - ASYNC API bodies route through `window.__SM_GM__.sendAsync(...)`
//     which wraps chrome.runtime.sendMessage so a sibling userscript
//     reassigning chrome.runtime can't break us.
//   - GM_info is purely compile-time — the script's metadata is
//     baked into the wrapper as a literal object.
//   - The `GM` object (GM4 alias namespace) is built up alongside.
//
// Phase 2 contract. Every body except GM_info throws "not implemented
// yet" via `__SM_GM__.notImplemented(...)` (sync) or a rejected promise
// from `sendAsync` plus a thrown "not implemented" wrap (async). Later
// phases swap the bodies for real handlers. The compile-in shape — the
// set of bindings created and the call-site call shape — stays stable
// so e2e tests written against Phase 2 keep passing.

import type { GmApiSpec } from './gm-api-catalog.js';
import { findApi, GM_APIS } from './gm-api-catalog.js';

// Minimal info we bake into GM_info. Keep this stable — exposed to
// every userscript. Mirrors the relevant subset of TM/VM's GM_info
// fields. Additional fields can be added without churning callers.
export interface GmInfoInput {
  scriptId: string;
  name: string;
  version?: string;
  namespace?: string;
  description?: string;
  matches: readonly string[];
  includes: readonly string[];
  excludes: readonly string[];
  grants: readonly string[];
  runAt?: string;
  // Raw `// ==UserScript== ... // ==/UserScript==` block text. Many
  // scripts re-parse this to read metadata our parser doesn't expose,
  // so passing it through verbatim matches TM/VM behavior.
  scriptMetaStr: string;
  // Filled in from chrome.runtime.getManifest().version at the SW;
  // for Phase 2 we pass a placeholder.
  scriptHandlerVersion: string;
  // Pre-loaded storage values for this script. Baked into the wrapper
  // as a literal so the page-side cache is populated synchronously,
  // before any user code can call `GM_getValue`. Loaded at register
  // time from chrome.storage.local. Empty object when the script
  // hasn't written any values yet (or doesn't @grant storage APIs).
  initialValues: Record<string, unknown>;
}

// The compile-in result. `js` is the literal source to splice into the
// wrapper; `granted` is the resolved set of GM_x names (for logging
// + the e2e permission test surface). When `js === ''` no bindings
// were emitted (either ungranted or all unknown).
export interface GmBindingEmit {
  js: string;
  granted: readonly string[];
}

// JSON-encode but inside a JavaScript source context: the standard
// `JSON.stringify` output is valid JS source for any value our caller
// would pass in (primitives, arrays of strings, nested objects of
// primitives). We add one safety wrap — the `</script>` sequence
// breaks out of an inline <script> if the wrapper is ever serialized
// into one; we don't currently do that (chrome.userScripts takes raw
// code), but the extra escape is cheap insurance.
function jsLit(value: unknown): string {
  return JSON.stringify(value).replace(/<\/script>/gi, '<\\/script>');
}

// Build the literal source for GM_info. Baked at compile time — no
// runtime lookup, no SW round-trip. Strict-mode safe (no `with`).
function emitGmInfo(info: GmInfoInput): string {
  // `script.grant` is the canonicalized set we actually emitted
  // bindings for — so `@grant GM.setValue` shows up here as
  // `GM_setValue`, and unknown / typoed names are dropped. This
  // matches VM's behavior (TM exposes the raw declared form). Worth
  // revisiting if real compat reports show up. `matches` / `includes`
  // / `excludes` pass through verbatim.
  const scriptObject = {
    name: info.name,
    version: info.version ?? '',
    namespace: info.namespace ?? '',
    description: info.description ?? '',
    matches: info.matches.slice(),
    includes: info.includes.slice(),
    excludes: info.excludes.slice(),
    grant: info.grants.slice(),
    runAt: info.runAt ?? '',
  };
  const gmInfo = {
    script: scriptObject,
    scriptHandler: 'SourceMonkey',
    version: info.scriptHandlerVersion,
    scriptMetaStr: info.scriptMetaStr,
    uuid: info.scriptId,
  };
  return `const GM_info = Object.freeze(${jsLit(gmInfo)});`;
}

// Build a single GM_x binding statement.
//
// SYNC bodies delegate to __SM_GM__.<subsystem>.<verb>(scriptId, ...args).
// For Phase 2 every sync body delegates to __SM_GM__.notImplemented(name).
//
// ASYNC bodies build a message envelope and route it through
// __SM_GM__.sendAsync; the routing exists in Phase 2 even though the
// SW handler returns "not implemented" for now. This keeps the
// call-site shape stable across phases.
function emitOneBinding(spec: GmApiSpec, scriptId: string): string {
  // unsafeWindow is a passthrough binding, not a function. In
  // USER_SCRIPT world there's no direct page-window access; expose
  // `window` for now (Phase X will handle the real cross-world bridge
  // if it ever lands). This matches "ungated" behavior — calling code
  // gets a usable object — but it does NOT reach the page's globals.
  if (spec.subsystem === 'unsafe-window') {
    return `const unsafeWindow = window;`;
  }
  if (spec.name === 'GM_info') {
    // GM_info is emitted separately by emitGmInfo. Skip here.
    return '';
  }
  // Storage subsystem: route to the page-side cache + batched-write
  // helpers on `__SM_GM__.storage`. The scriptId literal is closed
  // over so the runtime can key per-script state.
  if (spec.subsystem === 'storage') {
    switch (spec.name) {
      case 'GM_getValue':
        return `const GM_getValue = function (key, defaultValue) { return window.__SM_GM__.storage.get(${jsLit(scriptId)}, key, defaultValue); };`;
      case 'GM_setValue':
        return `const GM_setValue = function (key, value) { return window.__SM_GM__.storage.set(${jsLit(scriptId)}, key, value); };`;
      case 'GM_deleteValue':
        return `const GM_deleteValue = function (key) { return window.__SM_GM__.storage.del(${jsLit(scriptId)}, key); };`;
      case 'GM_listValues':
        return `const GM_listValues = function () { return window.__SM_GM__.storage.list(${jsLit(scriptId)}); };`;
    }
  }
  // Storage-listener subsystem: addValueChangeListener / removeValueChangeListener
  // are page-side, no SW round-trip. Listeners fire from local
  // sets + deletes AND from remote broadcasts.
  if (spec.subsystem === 'storage-listener') {
    switch (spec.name) {
      case 'GM_addValueChangeListener':
        return `const GM_addValueChangeListener = function (key, callback) { return window.__SM_GM__.storage.addValueChangeListener(${jsLit(scriptId)}, key, callback); };`;
      case 'GM_removeValueChangeListener':
        return `const GM_removeValueChangeListener = function (listenerId) { return window.__SM_GM__.storage.removeValueChangeListener(${jsLit(scriptId)}, listenerId); };`;
    }
  }
  // DOM subsystem: in-page DOM mutations, no per-script state needed
  // beyond what the bodies pass through. CSP-exempt in USER_SCRIPT
  // world.
  if (spec.subsystem === 'dom') {
    switch (spec.name) {
      case 'GM_addStyle':
        return `const GM_addStyle = function (css) { return window.__SM_GM__.dom.addStyle(css); };`;
      case 'GM_addElement':
        return `const GM_addElement = function (parentOrTag, tagOrAttrs, attrs) { return window.__SM_GM__.dom.addElement(parentOrTag, tagOrAttrs, attrs); };`;
    }
  }
  // Clipboard subsystem: navigator.clipboard.writeText via the
  // page-side runtime. Returns the underlying Promise so callers can
  // await; TM's signature is fire-and-forget undefined and our
  // handing back the Promise is the only behavioral deviation.
  if (spec.subsystem === 'clipboard') {
    switch (spec.name) {
      case 'GM_setClipboard':
        return `const GM_setClipboard = function (text, type) { return window.__SM_GM__.clipboard.write(text, type); };`;
    }
  }
  // XHR subsystem: GM_xmlhttpRequest returns a `{abort}` control
  // object synchronously. The runtime stores the callbacks locally
  // and forwards a serializable request to the SW; the SW ships
  // load/error/timeout/abort events back asynchronously via
  // chrome.tabs.sendMessage. The dispatch routes through
  // chrome.runtime.onMessage in the runtime. See docs/GM-APIs.md.
  if (spec.subsystem === 'xhr') {
    switch (spec.name) {
      case 'GM_xmlhttpRequest':
        return `const GM_xmlhttpRequest = function (details) { return window.__SM_GM__.xhr.start(${jsLit(scriptId)}, details); };`;
    }
  }
  // Log subsystem: GM_log is a thin wrapper over console.log with a
  // per-script prefix. The script name is baked in at compile-in time
  // so calls don't need an SW round-trip or per-call lookup.
  if (spec.subsystem === 'log') {
    switch (spec.name) {
      case 'GM_log':
        return `const GM_log = function () { return window.__SM_GM__.log.write(${jsLit(scriptId)}, arguments); };`;
    }
  }
  // Tab subsystem: GM_openInTab. Returns a `{close, closed, onclose}`
  // control object synchronously. The SW handles chrome.tabs.create
  // and reports close events back to the originating tab.
  if (spec.subsystem === 'tab') {
    switch (spec.name) {
      case 'GM_openInTab':
        return `const GM_openInTab = function (url, options) { return window.__SM_GM__.tab.open(${jsLit(scriptId)}, url, options); };`;
    }
  }
  // Notification subsystem: GM_notification. Returns the SW round-trip
  // Promise (TM/VM hand back undefined; we hand back the Promise so
  // callers that want to wait for the notification to be created can).
  // Callbacks (onclick / ondone) stay on the page side and are dispatched
  // by chrome.runtime.onMessage from the SW.
  if (spec.subsystem === 'notification') {
    switch (spec.name) {
      case 'GM_notification':
        return `const GM_notification = function () { return window.__SM_GM__.notification.show(${jsLit(scriptId)}, arguments); };`;
    }
  }
  if (spec.kind === 'sync') {
    // Phase 2 placeholder for the subsystems we haven't filled in
    // yet (storage-listener, dom, resource, menu, log). Closure
    // captures the literal API name so error messages identify it.
    return `const ${spec.name} = function () { return window.__SM_GM__.notImplemented(${jsLit(spec.name)}); };`;
  }
  // ASYNC body. Build the message envelope at call time so the args
  // travel as a structured array; the SW handler in later phases
  // unpacks them. Phase-2 SW handler returns {ok:false, error:...}
  // and we re-throw on the caller's side.
  //
  // We pass `scriptId` so the SW can validate @grant + @connect per
  // call (`@grant` re-check is cheap insurance against compile-time
  // / live-mismatch; @connect gating uses the script id to look up
  // the stored @connect list).
  return [
    `const ${spec.name} = function () {`,
    `  var args = Array.prototype.slice.call(arguments);`,
    `  return window.__SM_GM__.sendAsync({`,
    `    type: "sm:gm-call",`,
    `    api: ${jsLit(spec.name)},`,
    `    scriptId: ${jsLit(scriptId)},`,
    `    args: args`,
    `  }).then(function (reply) {`,
    `    if (reply && reply.ok) return reply.value;`,
    `    var msg = (reply && reply.error) ? reply.error : ${jsLit(spec.name + ' failed')};`,
    `    throw new Error("[SourceMonkey] " + msg);`,
    `  });`,
    `};`,
  ].join(' ');
}

// Build the GM4 namespace object — `const GM = Object.freeze({ ... })`.
// For each granted API with a `gmDotName`, expose a property on `GM`.
// When `gmDotPromised` is true, wrap the GM_x return value in
// Promise.resolve so the GM4 caller can `await` it uniformly.
function emitGmObject(grantedSpecs: readonly GmApiSpec[]): string {
  const props: string[] = [];
  for (const spec of grantedSpecs) {
    if (!spec.gmDotName) continue;
    if (spec.subsystem === 'unsafe-window') continue;
    if (spec.name === 'GM_info') {
      props.push(`info: GM_info`);
      continue;
    }
    if (spec.gmDotPromised) {
      // The legacy GM_x can be sync (storage reads from cache) or
      // throw (sync stub). Wrap in a Promise so the GM4 alias
      // matches its documented signature unconditionally.
      props.push(
        `${spec.gmDotName}: function () { try { return Promise.resolve(${spec.name}.apply(null, arguments)); } catch (e) { return Promise.reject(e); } }`,
      );
    } else {
      // Pass-through: same call shape, same return.
      props.push(`${spec.gmDotName}: function () { return ${spec.name}.apply(null, arguments); }`);
    }
  }
  if (props.length === 0) return '';
  return `const GM = Object.freeze({ ${props.join(', ')} });`;
}

// Public entry point. Build the binding source string for one script.
//
// Behavior:
//   - If `granted` is empty, returns `{ js: '', granted: [] }`.
//   - Otherwise emits GM_info (always), every granted GM_x, and the
//     GM4 `GM` object covering granted APIs with gmDotName.
//   - Granted names not in the catalog (resolveGrants should have
//     filtered these but be defensive) are skipped.
//
// The output is concatenated into the wrapper; the bindings sit
// inside the outer IIFE's scope and are visible to both the baked-in
// body and the run-new swap-eval branch.
export function emitGmBindings(
  granted: readonly string[],
  info: GmInfoInput,
): GmBindingEmit {
  if (granted.length === 0) return { js: '', granted: [] };
  const specs: GmApiSpec[] = [];
  for (const n of granted) {
    const spec = findApi(n);
    if (spec) specs.push(spec);
  }
  if (specs.length === 0) return { js: '', granted: [] };
  // GM_info is always emitted when any binding is emitted — TM/VM
  // both treat it as implicit (no @grant required). This is a useful
  // way for a script to introspect its own metadata even without
  // declaring other grants.
  const parts: string[] = [emitGmInfo(info)];
  // Storage init. When the script has any storage grants, prime the
  // page-side cache with the values we read at register time. The
  // call is emitted whenever a storage grant is present, even when
  // `initialValues` is empty — the runtime marks the cache as
  // "ready" so a later read of an unknown key returns the
  // defaultValue rather than waiting for a phantom load.
  const hasStorageGrant = specs.some((s) => s.subsystem === 'storage');
  if (hasStorageGrant) {
    parts.push(
      `window.__SM_GM__.storage.init(${jsLit(info.scriptId)}, ${jsLit(info.initialValues)});`,
    );
  }
  for (const spec of specs) {
    if (spec.name === 'GM_info') continue;
    const line = emitOneBinding(spec, info.scriptId);
    if (line) parts.push(line);
  }
  // GM_info is part of the GM4 alias namespace too.
  const allSpecsIncludingInfo = [findApi('GM_info')!].concat(
    specs.filter((s) => s.name !== 'GM_info'),
  );
  const gmObject = emitGmObject(allSpecsIncludingInfo);
  if (gmObject) parts.push(gmObject);
  return {
    js: parts.join('\n') + '\n',
    granted: specs.map((s) => s.name),
  };
}

// Re-export so callers building GmInfoInput don't need a separate
// import from the catalog just to enumerate all known names.
export { GM_APIS };
