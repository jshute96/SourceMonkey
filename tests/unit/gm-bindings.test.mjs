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

test('emitGmBindings: sync stub bodies route through __SM_GM__.notImplemented', () => {
  const out = emitGmBindings(['GM_setValue'], makeInfo());
  assert.match(out.js, /__SM_GM__\.notImplemented\("GM_setValue"\)/);
});

test('emitGmBindings: async APIs route through sendAsync, not notImplemented', () => {
  const out = emitGmBindings(['GM_xmlhttpRequest'], makeInfo({
    grants: ['GM_xmlhttpRequest'],
  }));
  assert.match(out.js, /const GM_xmlhttpRequest = function/);
  assert.match(out.js, /__SM_GM__\.sendAsync/);
  assert.match(out.js, /type: "sm:gm-call"/);
  // The async body should NOT route through notImplemented.
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
