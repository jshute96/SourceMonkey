// Unit tests for the per-script GM_* / GM.* binding emitter.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { emitGmBindings } from '../../dist/gm-bindings.js';

function makeInfo(over = {}) {
  return {
    scriptId: 'script-1',
    name: 'Hello',
    version: '1.0.0',
    namespace: 'https://example.com',
    description: 'a test script',
    matches: ['https://example.com/*'],
    includes: [],
    excludes: [],
    grants: ['GM_setValue'],
    runAt: 'document_idle',
    scriptMetaStr: '// ==UserScript==\n// @name Hello\n// ==/UserScript==',
    scriptHandlerVersion: '0.0.1',
    initialValues: {},
    resources: {},
    ...over,
  };
}

test('emitGmBindings: empty granted set → empty output', () => {
  const out = emitGmBindings([], makeInfo({ grants: [] }));
  assert.equal(out.js, '');
  assert.deepEqual(out.granted, []);
});

test('emitGmBindings: emits GM_info even with a single grant', () => {
  const out = emitGmBindings(['GM_setValue'], makeInfo());
  assert.match(out.js, /const GM_info = /);
  // GM_info is frozen — match the Object.freeze wrapper.
  assert.match(out.js, /Object\.freeze\(/);
});

test('emitGmBindings: emits a const for each granted GM_x', () => {
  const out = emitGmBindings(['GM_setValue', 'GM_getValue'], makeInfo({
    grants: ['GM_setValue', 'GM_getValue'],
  }));
  assert.match(out.js, /const GM_setValue = function/);
  assert.match(out.js, /const GM_getValue = function/);
});

test('emitGmBindings: storage bodies route to __SM_GM__.storage helpers', () => {
  // Phase 3+ — storage is wired up, no longer notImplemented.
  const out = emitGmBindings(
    ['GM_setValue', 'GM_getValue', 'GM_deleteValue', 'GM_listValues'],
    makeInfo({ grants: ['GM_setValue', 'GM_getValue', 'GM_deleteValue', 'GM_listValues'] }),
  );
  assert.match(out.js, /__SM_GM__\.storage\.get\("script-1"/);
  assert.match(out.js, /__SM_GM__\.storage\.set\("script-1"/);
  assert.match(out.js, /__SM_GM__\.storage\.del\("script-1"/);
  assert.match(out.js, /__SM_GM__\.storage\.list\("script-1"/);
  // Storage APIs should NOT throw not-implemented anymore.
  assert.doesNotMatch(out.js, /notImplemented\("GM_setValue"\)/);
});

test('emitGmBindings: storage init call lands in the prelude (not the lazy js)', () => {
  const out = emitGmBindings(['GM_setValue'], makeInfo({
    initialValues: { foo: 'bar', count: 42 },
  }));
  // Eager `storage.init` must NOT sit in the IIFE-top js block — the
  // GM runtime may not be installed yet at that point. It moves to
  // the prelude, which the injector splices into the wrapper inside
  // `__smWaitForRunAt`'s callback (runtime is guaranteed ready by then).
  assert.doesNotMatch(out.js, /storage\.init/);
  assert.match(out.prelude, /__SM_GM__\.storage\.init\("script-1", \{"foo":"bar","count":42\}\)/);
});

test('emitGmBindings: storage init prelude has empty object when no values yet', () => {
  const out = emitGmBindings(['GM_setValue'], makeInfo({ initialValues: {} }));
  assert.doesNotMatch(out.js, /storage\.init/);
  assert.match(out.prelude, /__SM_GM__\.storage\.init\("script-1", \{\}\)/);
});

test('emitGmBindings: storage init NOT emitted when no storage grant', () => {
  const out = emitGmBindings(['GM_xmlhttpRequest'], makeInfo({
    grants: ['GM_xmlhttpRequest'],
  }));
  assert.doesNotMatch(out.js, /storage\.init/);
  assert.equal(out.prelude, '');
});

test('emitGmBindings: DOM bodies route to __SM_GM__.dom helpers', () => {
  // Phase 4 — DOM APIs are wired up.
  const out = emitGmBindings(['GM_addStyle', 'GM_addElement'], makeInfo({
    grants: ['GM_addStyle', 'GM_addElement'],
  }));
  assert.match(out.js, /const GM_addStyle = function/);
  assert.match(out.js, /__SM_GM__\.dom\.addStyle/);
  assert.match(out.js, /const GM_addElement = function/);
  assert.match(out.js, /__SM_GM__\.dom\.addElement/);
  // Should NOT route through notImplemented.
  assert.doesNotMatch(out.js, /notImplemented\("GM_addStyle"\)/);
  assert.doesNotMatch(out.js, /notImplemented\("GM_addElement"\)/);
});

test('emitGmBindings: GM_getResourceText routes to __SM_GM__.resource.getText', () => {
  const out = emitGmBindings(['GM_getResourceText'], makeInfo({
    grants: ['GM_getResourceText'],
  }));
  assert.match(out.js, /const GM_getResourceText = function/);
  assert.match(out.js, /__SM_GM__\.resource\.getText\("script-1"/);
  assert.doesNotMatch(out.js, /notImplemented\("GM_getResourceText"\)/);
});

test('emitGmBindings: GM_getResourceURL routes to __SM_GM__.resource.getUrl', () => {
  const out = emitGmBindings(['GM_getResourceURL'], makeInfo({
    grants: ['GM_getResourceURL'],
  }));
  assert.match(out.js, /const GM_getResourceURL = function/);
  assert.match(out.js, /__SM_GM__\.resource\.getUrl\("script-1"/);
  assert.doesNotMatch(out.js, /notImplemented\("GM_getResourceURL"\)/);
});

test('emitGmBindings: resource.init prelude emitted when resources are declared', () => {
  const out = emitGmBindings(['GM_getResourceText'], makeInfo({
    grants: ['GM_getResourceText'],
    resources: { myCss: { b64: 'YQ==', ct: 'text/css' } },
  }));
  assert.match(out.prelude, /__SM_GM__\.resource\.init\("script-1"/);
  assert.match(out.prelude, /"myCss"/);
  assert.match(out.prelude, /"b64":"YQ=="/);
});

test('emitGmBindings: resource.init prelude emitted even when resources are empty', () => {
  // Empty-init is load-bearing: it resets the runtime's per-script box
  // so a prior reload's resources don't leak when the new declaration
  // set drops to zero. See gm-bindings.ts for the rationale.
  const out = emitGmBindings(['GM_getResourceText'], makeInfo({
    grants: ['GM_getResourceText'],
    resources: {},
  }));
  assert.match(out.prelude, /__SM_GM__\.resource\.init\("script-1", \{\}\)/);
});

test('emitGmBindings: GM_registerMenuCommand routes to __SM_GM__.menu.register with the scriptId', () => {
  const out = emitGmBindings(['GM_registerMenuCommand'], makeInfo({
    grants: ['GM_registerMenuCommand'],
  }));
  assert.match(out.js, /const GM_registerMenuCommand = function/);
  assert.match(out.js, /__SM_GM__\.menu\.register\("script-1"/);
  assert.doesNotMatch(out.js, /notImplemented\("GM_registerMenuCommand"\)/);
});

test('emitGmBindings: GM_unregisterMenuCommand routes to __SM_GM__.menu.unregister with the scriptId', () => {
  const out = emitGmBindings(['GM_unregisterMenuCommand'], makeInfo({
    grants: ['GM_unregisterMenuCommand'],
  }));
  assert.match(out.js, /const GM_unregisterMenuCommand = function/);
  assert.match(out.js, /__SM_GM__\.menu\.unregister\("script-1"/);
});

test('emitGmBindings: GM_log routes to __SM_GM__.log.write with the scriptId', () => {
  const out = emitGmBindings(['GM_log'], makeInfo({ grants: ['GM_log'] }));
  assert.match(out.js, /const GM_log = function/);
  assert.match(out.js, /__SM_GM__\.log\.write\("script-1"/);
  assert.doesNotMatch(out.js, /notImplemented\("GM_log"\)/);
});

test('emitGmBindings: GM_openInTab routes to __SM_GM__.tab.open with the scriptId', () => {
  const out = emitGmBindings(['GM_openInTab'], makeInfo({ grants: ['GM_openInTab'] }));
  assert.match(out.js, /const GM_openInTab = function/);
  assert.match(out.js, /__SM_GM__\.tab\.open\("script-1"/);
  // Not routed through the generic sendAsync envelope.
  assert.doesNotMatch(out.js, /"sm:gm-call"[^}]*GM_openInTab/);
});

test('emitGmBindings: GM_notification routes to __SM_GM__.notification.show with the scriptId', () => {
  const out = emitGmBindings(['GM_notification'], makeInfo({ grants: ['GM_notification'] }));
  assert.match(out.js, /const GM_notification = function/);
  assert.match(out.js, /__SM_GM__\.notification\.show\("script-1"/);
});

test('emitGmBindings: GM.log is a pass-through alias (no Promise wrap)', () => {
  // GM_log is kind:sync without gmDotPromised, so the GM4 alias should
  // be a pass-through, not Promise-wrapped.
  const out = emitGmBindings(['GM_log'], makeInfo({ grants: ['GM_log'] }));
  assert.match(out.js, /log: function [^}]*GM_log\.apply/);
  assert.doesNotMatch(out.js, /log: function [^}]*Promise\.resolve\(GM_log/);
});

test('emitGmBindings: GM_xmlhttpRequest routes to __SM_GM__.xhr.start', () => {
  // Phase 8+ — XHR is wired through the runtime's xhr subsystem
  // (page-side dispatch + per-request id), not the generic
  // sendAsync envelope (that's for one-shot async APIs).
  const out = emitGmBindings(['GM_xmlhttpRequest'], makeInfo({
    grants: ['GM_xmlhttpRequest'],
  }));
  assert.match(out.js, /const GM_xmlhttpRequest = function/);
  assert.match(out.js, /__SM_GM__\.xhr\.start\("script-1"/);
  assert.doesNotMatch(out.js, /notImplemented\("GM_xmlhttpRequest"\)/);
});

test('emitGmBindings: emits a GM object with the GM4 aliases for granted APIs', () => {
  const out = emitGmBindings(['GM_setValue', 'GM_xmlhttpRequest'], makeInfo({
    grants: ['GM_setValue', 'GM_xmlhttpRequest'],
  }));
  assert.match(out.js, /const GM = Object\.freeze\(\{/);
  assert.match(out.js, /setValue:/);
  assert.match(out.js, /xmlHttpRequest:/);
  // GM4 storage forms wrap in Promise.resolve.
  assert.match(out.js, /setValue: function [^}]*Promise\.resolve\(GM_setValue/);
});

test('emitGmBindings: GM.info is exposed (not GM.GM_info)', () => {
  const out = emitGmBindings(['GM_setValue'], makeInfo());
  assert.match(out.js, /info: GM_info/);
});

test('emitGmBindings: GM_info script.grant reflects the granted list', () => {
  const out = emitGmBindings(['GM_setValue', 'GM_addStyle'], makeInfo({
    grants: ['GM_setValue', 'GM_addStyle'],
  }));
  // The JSON literal embedded into GM_info includes a `grant` array.
  assert.match(out.js, /"grant":\["GM_setValue","GM_addStyle"\]/);
});

test('emitGmBindings: GM_info.scriptHandler is "SourceMonkey"', () => {
  const out = emitGmBindings(['GM_setValue'], makeInfo());
  assert.match(out.js, /"scriptHandler":"SourceMonkey"/);
});

test('emitGmBindings: unknown granted names are silently dropped', () => {
  const out = emitGmBindings(['GM_audio'], makeInfo({
    grants: ['GM_audio'],
  }));
  // No GM_audio binding emitted, no GM_info either (no real grant present).
  assert.equal(out.js, '');
  assert.deepEqual(out.granted, []);
});

test('emitGmBindings: granted names with no GM. alias still get GM_x but not a GM. property', () => {
  // unsafeWindow has no gmDotName, so no `GM.unsafeWindow` is emitted.
  const out = emitGmBindings(['unsafeWindow'], makeInfo({
    grants: ['unsafeWindow'],
  }));
  assert.match(out.js, /const unsafeWindow = window/);
  // The `GM` object should NOT have an unsafeWindow property
  // (it shouldn't even be emitted if no other APIs have gmDotName).
  // GM_info is always there and has the `info` alias, so the GM object
  // exists; just check that unsafeWindow isn't a property.
  assert.doesNotMatch(out.js, /unsafeWindow:/);
});

test('emitGmBindings: scriptMetaStr is passed through verbatim into GM_info', () => {
  const meta = '// ==UserScript==\n// @name "Quoted"\n// ==/UserScript==';
  const out = emitGmBindings(['GM_setValue'], makeInfo({
    scriptMetaStr: meta,
  }));
  // JSON-encoded form should contain the embedded newlines as \n.
  assert.match(out.js, /"scriptMetaStr":"\/\/ ==UserScript==\\n/);
});

test('emitGmBindings: granted output names match the input order (filtered to supported)', () => {
  const out = emitGmBindings(
    ['GM_setValue', 'GM_unsupported_thing', 'GM_addStyle'],
    makeInfo({ grants: ['GM_setValue', 'GM_addStyle'] }),
  );
  assert.deepEqual(out.granted, ['GM_setValue', 'GM_addStyle']);
});

test('emitGmBindings: escapes </script> in scriptMetaStr to dodge inline-injection breakouts', () => {
  // Defense in depth: chrome.userScripts takes raw code, not HTML, so
  // this can't actually break out today — but if the wrapper is ever
  // serialized into a <script> tag, an unescaped </script> in the
  // meta block would close it.
  const out = emitGmBindings(['GM_setValue'], makeInfo({
    scriptMetaStr: 'before </script> after',
  }));
  assert.match(out.js, /<\\\/script>/);
  assert.doesNotMatch(out.js, /<\/script>/);
});
