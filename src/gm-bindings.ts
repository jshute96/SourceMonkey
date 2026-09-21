// Per-script `GM_*` / `GM.*` binding emitter.
//
// The injector calls `emitGmBindings` once per script at wrapper-build
// time. The result is `{ js, prelude, granted }`:
//   - `js` holds the `const GM_X = ...` declarations plus the eager
//     calls that need nothing but `window.__SM_GM__` and baked
//     literals (`urlchange.enable`, `windowControl.enable`,
//     `resource.init`). It is used
//     TWICE: `wrapCombinedEntry` splices it into the main-body wrap
//     function ahead of the body, and `buildSwapEvalBody` prepends it
//     to the run-new swap-eval body. Anything a hot-swapped script
//     needs has to be in here.
//   - `prelude` is spliced into the main-body wrap function only,
//     ahead of the body, and holds the eager calls that reference
//     identifiers only that function has (today: `storage.init`,
//     which reads `__smDecision.gmValues`). The swap path runs its
//     own equivalent from `userscript-prelude.js`. See
//     `GmBindingEmit` below.
//   - Both run after the prelude's awaitDecision + waitForRunAt
//     gates, so the GM runtime is installed by the time either does.
// When no APIs are granted (or the script is `@grant none`),
// `emitGmBindings` returns `{ js: '', prelude: '', granted: [] }`.
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
// Compile-in shape contract: the set of bindings emitted and the
// call-site shape (`__SM_GM__.<method>(...)` sync, `sendAsync` async)
// is stable across phases. Bodies for unimplemented APIs throw "not
// implemented yet" via `__SM_GM__.notImplemented(...)`; phases swap
// in real handlers without changing the call-site shape, so e2e
// tests written against earlier phases keep passing.

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
  // Plain single-value headers TM exposes on `GM_info.script`
  // (`author`, `homepage`, `icon`, `supportURL`, ...). `null` when the
  // header is absent, matching TM.
  passthrough: Record<GmInfoPassthroughTag, string | null>;
  // `@require` refs in declaration order, under VM's key
  // `script.require` (TM spells it `requires`; the header tag wins).
  requires: readonly string[];
  // `@resource` name → declared ref for `GM_info.script.resources`.
  // Both TM and VM expose this list with the ref as written (not the
  // resolved URL), and scripts iterate it to discover what was
  // declared. (TM adds `content`/`meta`, VM's `url` is a blob.)
  resourceList: readonly { name: string; url: string }[];
  // `@connect` hosts.
  connects: readonly string[];
  // `@noframes` present. VM exposes it as `script.noframes`.
  noframes: boolean;
  // Snapshot of `navigator.userAgentData` (brands / mobile / platform),
  // which TM and VM both put on GM_info. Read once by the caller in
  // the SW; `null` where the API is missing (unit tests under Node).
  userAgentData: UserAgentDataSnapshot | null;
  // Raw `// ==UserScript== ... // ==/UserScript==` block text. Many
  // scripts re-parse this to read metadata our parser doesn't expose,
  // so passing it through verbatim matches TM/VM behavior.
  scriptMetaStr: string;
  // Filled in from chrome.runtime.getManifest().version at the SW.
  scriptHandlerVersion: string;
  // Prefetched `@resource` blobs the script declared, keyed by
  // resource name. `b64` is the base64-encoded body; `ct` is the
  // server-reported Content-Type (used as the blob: URL MIME). Baked
  // into the wrapper as a literal so `GM_getResourceText` and
  // `GM_getResourceURL` resolve synchronously without an SW round-
  // trip. Empty object when the script declares no `@resource`.
  resources: Record<string, { b64: string; ct: string }>;
}

// Single-value headers exposed verbatim on `GM_info.script`, under
// the keys TM uses. Shared with the injector so the two sides agree.
export const GM_INFO_PASSTHROUGH_TAGS = [
  'author', 'homepage', 'icon', 'icon64', 'supportURL', 'updateURL',
  'downloadURL', 'copyright', 'license',
] as const;
export type GmInfoPassthroughTag = (typeof GM_INFO_PASSTHROUGH_TAGS)[number];

export interface UserAgentDataSnapshot {
  brands: { brand: string; version: string }[];
  mobile: boolean;
  platform: string;
}

// The compile-in result.
//
//   - `js`       — the lazy const declarations + GM4 alias object,
//                  spliced ahead of the user body. Every dereference
//                  of `window.__SM_GM__` in the declarations lives
//                  inside a function body, so it doesn't fire until
//                  the script body calls a GM_* API. The exceptions
//                  are the trailing eager calls —
//                  `urlchange.enable(scriptId)` for `@grant
//                  window.onurlchange` (so the body's
//                  `window.onurlchange === null` feature test
//                  succeeds), `windowControl.enable(scriptId, …)` for
//                  `@grant window.close` / `window.focus` (so the
//                  overrides are in place before the body calls
//                  them), and `resource.init` — all of which are
//                  self-contained enough to run in the swap eval too.
//   - `prelude`  — eager calls that have to run BEFORE the user body,
//                  AFTER the GM runtime is installed, and that need
//                  identifiers only the wrap function provides
//                  (today: the `storage.init` call that primes the
//                  per-script cache from `__smDecision.gmValues`).
//                  The injector splices this into the main-body wrap
//                  function ahead of the body — by the time that
//                  function fires (after the prelude's awaitDecision
//                  + waitForRunAt gates), the GM runtime spec has had
//                  time to register and run.
//   - `granted`  — the resolved set of GM_x names (for logging + the
//                  e2e permission test surface).
//
// When `js === ''` no bindings were emitted (either ungranted or all
// unknown), and `prelude` is also empty.
export interface GmBindingEmit {
  js: string;
  prelude: string;
  granted: readonly string[];
  // True iff any granted API is in the storage subsystem. Echoed
  // into the wrapper's `__smNeedsGmValues` literal so the SW knows
  // whether to attach a `gmValues` snapshot to the sm:check-pending
  // reply. Same `subsystem === 'storage'` test that drives the
  // prelude's `storage.init` emission — exposed here so the injector
  // doesn't have to re-derive it from the granted-name list.
  needsValues: boolean;
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
  //
  // Key names: where TM and VM disagree (`run-at` vs `runAt`,
  // `connects` vs `connect`) we use whichever matches the header tag.
  const scriptObject = {
    // Passthrough first so the canonical keys below always win.
    ...info.passthrough,
    name: info.name,
    version: info.version ?? '',
    namespace: info.namespace ?? '',
    description: info.description ?? '',
    matches: info.matches.slice(),
    includes: info.includes.slice(),
    excludes: info.excludes.slice(),
    grant: info.grants.slice(),
    'run-at': info.runAt ?? '',
    require: info.requires.slice(),
    resources: info.resourceList.map((r) => ({ name: r.name, url: r.url })),
    connect: info.connects.slice(),
    noframes: info.noframes,
  };
  const gmInfo = {
    script: scriptObject,
    scriptHandler: 'SourceMonkey',
    version: info.scriptHandlerVersion,
    scriptMetaStr: info.scriptMetaStr,
    uuid: info.scriptId,
    // Every SourceMonkey script is re-read from its collection source
    // on refresh, so from the script's point of view it will update.
    scriptWillUpdate: true,
    userAgentData: info.userAgentData,
  };
  return `const GM_info = Object.freeze(${jsLit(gmInfo)});`;
}

// Build a single GM_x binding statement.
//
// SYNC bodies delegate to __SM_GM__.<subsystem>.<verb>(scriptId, ...args).
// Unimplemented sync APIs delegate to __SM_GM__.notImplemented(name).
//
// ASYNC bodies build a message envelope and route it through
// __SM_GM__.sendAsync. The call-site shape is stable across phases —
// landing a new API only changes the SW-side dispatch.
function emitOneBinding(spec: GmApiSpec, scriptId: string): string {
  // unsafeWindow is a passthrough binding, not a function — the same
  // `const unsafeWindow = window;` in both worlds, because what makes
  // it correct is the WORLD, not the binding.
  //
  //   - MAIN world: `window` IS the page's window, so this is the real
  //     thing. `resolveWorld` sends every script that asks for
  //     `unsafeWindow` here for exactly that reason — whether it asked
  //     with a `@grant` line or just by naming it (see
  //     src/unsafe-window-use.ts).
  //   - USER_SCRIPT world: reachable only when the script also declared
  //     `@inject-into content`, i.e. explicitly asked for isolation.
  //     `window` is then the isolated realm's, NOT the page's — matching
  //     Violentmonkey's content mode. `extractStartupLogs` emits a
  //     warning for that combination so it isn't a silent wrong answer.
  //
  // No cross-world proxy is possible: property access on unsafeWindow is
  // synchronous and Chrome exposes no synchronous channel between an
  // isolated world and the page's realm.
  if (spec.subsystem === 'unsafe-window') {
    return `const unsafeWindow = window;`;
  }
  // `window.onurlchange` isn't a callable and isn't a legal binding
  // name — the grant's whole effect is the eager `urlchange.enable`
  // call emitted at the end of `js` (see emitGmBindings).
  if (spec.subsystem === 'url-change') {
    return '';
  }
  // `window.close` / `window.focus` are methods we replace on the
  // world's `window`, not new names — same deal: the grant's effect is
  // the eager `windowControl.enable` call emitted at the end of `js`.
  if (spec.subsystem === 'window-control') {
    return '';
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
        return `const GM_addStyle = function (css) { return window.__SM_GM__.dom.addStyle(${jsLit(scriptId)}, css); };`;
      case 'GM_addElement':
        return `const GM_addElement = function (parentOrTag, tagOrAttrs, attrs) { return window.__SM_GM__.dom.addElement(${jsLit(scriptId)}, parentOrTag, tagOrAttrs, attrs); };`;
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
  // Log subsystem: GM_log writes to the page console with a per-script
  // prefix AND fires a fire-and-forget sm:gm-log to the SW so the call
  // also lands on the script's Log tab. The scriptId is baked in at
  // compile-in time so each call avoids a per-call lookup.
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
  // Download subsystem: GM_download returns a `{abort}` control object
  // synchronously (TM's documented return). Both TM call shapes —
  // `GM_download(details)` and `GM_download(url, name)` — are
  // normalized by the runtime, so the binding just forwards both
  // positional slots.
  if (spec.subsystem === 'download') {
    switch (spec.name) {
      case 'GM_download':
        return `const GM_download = function (detailsOrUrl, name) { return window.__SM_GM__.download.start(${jsLit(scriptId)}, detailsOrUrl, name); };`;
    }
  }
  // Menu subsystem: register/unregister context-menu commands. The
  // runtime stashes the callback locally (callbacks aren't
  // serializable) and sends the SW a `{commandId, name}` envelope so
  // the action context menu can render the entries. Returns the
  // commandId the caller can later pass to GM_unregisterMenuCommand.
  if (spec.subsystem === 'menu') {
    switch (spec.name) {
      case 'GM_registerMenuCommand':
        return `const GM_registerMenuCommand = function (name, callback, accessKeyOrOpts) { return window.__SM_GM__.menu.register(${jsLit(scriptId)}, name, callback, accessKeyOrOpts); };`;
      case 'GM_unregisterMenuCommand':
        return `const GM_unregisterMenuCommand = function (commandId) { return window.__SM_GM__.menu.unregister(${jsLit(scriptId)}, commandId); };`;
    }
  }
  // Resource subsystem: GM_getResourceText decodes the stored bytes
  // as UTF-8 on demand; GM_getResourceURL mints a blob: URL with the
  // stored content-type. Both lookups close over scriptId so the
  // runtime can find the script's prefetched resource map.
  if (spec.subsystem === 'resource') {
    switch (spec.name) {
      case 'GM_getResourceText':
        return `const GM_getResourceText = function (name) { return window.__SM_GM__.resource.getText(${jsLit(scriptId)}, name); };`;
      case 'GM_getResourceURL':
        return `const GM_getResourceURL = function (name) { return window.__SM_GM__.resource.getUrl(${jsLit(scriptId)}, name); };`;
    }
  }
  if (spec.kind === 'sync') {
    // Fall-through for sync APIs whose body hasn't been wired up yet.
    // Closure captures the literal API name so error messages
    // identify it.
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
//   - Always emits GM_info, matching TM/VM (it's available with no
//     `@grant` line at all, with `@grant none`, and alongside any
//     mix of real grants). A script with unknown grants only still
//     gets GM_info — every other emitted artifact is keyed off the
//     resolved-spec set.
//   - For each known granted API: a `const GM_x = ...` binding.
//   - The GM4 `GM` object covers granted APIs with gmDotName, plus
//     `GM.info`.
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
  const specs: GmApiSpec[] = [];
  for (const n of granted) {
    const spec = findApi(n);
    if (spec) specs.push(spec);
  }
  // GM_info is always emitted, even with an empty grant set. TM/VM
  // both treat it as implicit so a script can introspect its own
  // metadata without declaring a single grant.
  const parts: string[] = [emitGmInfo(info)];
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
  // `@grant window.onurlchange` — the only entry whose effect is an
  // eager call rather than a declaration. It has to run before the
  // body so the body's `window.onurlchange === null` feature test
  // succeeds. It lives at the END of `js` (not in `prelude`) on
  // purpose:
  //   - Ordering safety is identical. Both strings are spliced into
  //     the SAME main-body wrap function (`wrapCombinedEntry`), which
  //     only runs after the prelude's awaitDecision + waitForRunAt
  //     gates — so `window.__SM_GM__` is installed either way.
  //   - `js` is ALSO what `buildSwapEvalBody` prepends for the
  //     reload-fast-path swap, and `prelude` is not. Emitting here is
  //     what makes a hot-swapped script still get its `urlchange`
  //     surface.
  //
  // Guarded on the runtime rather than dereferencing it bare — unlike
  // the other two eager calls, which fail loudly on purpose. An
  // unguarded TypeError in this scope aborts the whole wrap function
  // and the script never runs at all, and degrading to "no urlchange
  // surface" is strictly better: the script's own `=== null` feature
  // test then correctly reports "unsupported", exactly as it would
  // under a manager without the feature. `storage.init` (in
  // `prelude`) and `resource.init` take the opposite trade — running
  // a body against missing values or missing resource bytes is worse
  // than not running it.
  if (specs.some((s) => s.subsystem === 'url-change')) {
    parts.push(
      // Both halves matter: a runtime registered before this feature
      // shipped has `__SM_GM__` but no `urlchange`, and a page can hold
      // a stale registration across an extension update.
      `if (window.__SM_GM__ && window.__SM_GM__.urlchange) window.__SM_GM__.urlchange.enable(${jsLit(info.scriptId)});`,
    );
  }
  // `@grant window.close` / `@grant window.focus` — same eager-call
  // shape as `urlchange.enable` above, and in `js` for the same
  // reasons (a hot-swapped script has to get its overrides back, and
  // both strings are spliced into the same wrap function).
  //
  // Guarded on the runtime for the same reason too: degrading to the
  // page's own `window.close()` / `.focus()` — which the browser
  // mostly ignores — is better than a TypeError that stops the script
  // from running at all.
  for (const spec of specs) {
    if (spec.subsystem !== 'window-control') continue;
    // `window.close` -> "close", `window.focus` -> "focus".
    const method = spec.name.slice('window.'.length);
    parts.push(
      `if (window.__SM_GM__ && window.__SM_GM__.windowControl) window.__SM_GM__.windowControl.enable(${jsLit(info.scriptId)}, ${jsLit(method)});`,
    );
  }
  // `resource.init`: emitted whenever GM_getResource* is granted,
  // even when `resources` is empty. Why "even when empty": the
  // runtime's resource box persists across `chrome.userScripts`
  // re-registrations within one document. If a script removed a
  // `@resource` line, skipping init would leave the prior bytes
  // resident in `byName`; the now-stale `GM_getResourceText("foo")`
  // would still resolve. `resource.init` replaces the box, so always
  // emitting it is what makes "removed resource → returns undefined"
  // actually true on the next reload.
  //
  // It lives at the END of `js` rather than in `prelude` for the same
  // reason `urlchange.enable` does: `js` is what `buildSwapEvalBody`
  // prepends for the reload-fast-path swap, and `prelude` is not.
  // The statement references only `window.__SM_GM__` and baked
  // literals, so it works identically in the wrap function and in the
  // swap eval's global scope.
  //
  // Installation ordering is unchanged for the registered path — both
  // strings are spliced into the SAME wrap function, which only runs
  // after the GM runtime has registered. What did change is the
  // relative order: `js` precedes `prelude`, so this now runs BEFORE
  // `storage.init` rather than after. The only case that can tell is
  // `storage.init`'s hard abort, which now leaves a freshly-replaced
  // resource box behind instead of the previous one — invisible,
  // since the body doesn't run either way and the box is per-document.
  const hasStorageGrant = specs.some((s) => s.subsystem === 'storage');
  const hasResourceGrant = specs.some((s) => s.subsystem === 'resource');
  if (hasResourceGrant) {
    parts.push(
      `window.__SM_GM__.resource.init(${jsLit(info.scriptId)}, ${jsLit(info.resources)});`,
    );
  }
  // Eager calls into __SM_GM__ at compile time go in the prelude when
  // they need identifiers only the wrap function has. Splicing them in
  // the IIFE top would race with the runtime's own document_start
  // registration in some Chrome builds; the injector splices `prelude`
  // inside the main-body wrap function passed to self.__smRun, which
  // only fires after both the GM runtime spec has registered AND the
  // @run-at lifecycle event resolves. See wrapCombinedEntry in
  // src/injector.ts.
  //
  // - storage.init: emitted whenever a storage grant is present; the
  //   prelude reads the snapshot off `__smDecision.gmValues` (attached
  //   by the SW to the sm:check-pending reply) and hard-aborts the
  //   script if the snapshot is missing. That `__smDecision` reference
  //   is why this one can't move into `js` — the swap eval's global
  //   scope doesn't have it. The swap path runs the equivalent init
  //   from `userscript-prelude.js` instead, where the decision object
  //   is in scope. See docs/GM-APIs-storage.md.
  const preludeLines: string[] = [];
  if (hasStorageGrant) {
    // Single source of truth: the SW-attached snapshot. We do NOT
    // bake a fallback literal — getting the snapshot wrong is more
    // dangerous than failing visibly, because a read-modify-write
    // userscript that started with stale data would silently
    // overwrite the user's real values with defaults.
    //
    // When the snapshot is missing: log via console.info (not .error —
    // see userscript-prelude.js; injected .error/.warn leak into
    // chrome://extensions/?errors), send sm:error so the failure
    // surfaces on the per-script log + badge, and `return` from the
    // @run-at callback so the user body never runs. The user can
    // recover by reloading.
    //
    // Several ways to get here, which is why the message doesn't assert
    // one cause: the SW was unreachable past the wrapper's safety
    // timeout, `handleCheckPending` errored, or — for a MAIN-world
    // script only — the SW's `bridgeMayActAs` gate refused to hand the
    // values over the bridge (see docs/injection.md#gm_-in-main-world).
    //
    // One string in both places. As two literals they had already
    // drifted — the Log copy lost the "reload" half, which is the only
    // part the reader can act on.
    const gmValuesFailure =
      "Failed reading this script's stored GM values during setup, " +
      'so the script did not run — reload the page to retry';
    preludeLines.push(
      `var __smGmSnap = (typeof __smDecision === "object" && __smDecision && __smDecision.gmValues);`,
      `if (!__smGmSnap) {`,
      `  try { console.info("[SourceMonkey] " + __smName + ": " + ${jsLit(gmValuesFailure)}); } catch (_smSE0) {}`,
      `  __smSend({ type: "sm:error", id: __smId, name: __smName, loadedAt: __smLoadedAt, url: location.href, message: ${jsLit(gmValuesFailure)} });`,
      `  return;`,
      `}`,
      `window.__SM_GM__.storage.init(${jsLit(info.scriptId)}, __smGmSnap);`,
    );
  }
  const prelude = preludeLines.join(' ');
  // Join with spaces, not newlines: the injector splices this into
  // the main-body wrap function ahead of the user body, and any
  // newline here would push the body's line 1 onto physical line 2+
  // — breaking the stack-trace line-number contract that
  // `wrapCombinedEntry` in src/injector.ts depends on. Each part is
  // a complete `const … = …;` statement so `;` + ` ` is enough.
  return {
    js: parts.join(' ') + ' ',
    prelude,
    granted: specs.map((s) => s.name),
    needsValues: hasStorageGrant,
  };
}

// Re-export so callers building GmInfoInput don't need a separate
// import from the catalog just to enumerate all known names.
export { GM_APIS };
