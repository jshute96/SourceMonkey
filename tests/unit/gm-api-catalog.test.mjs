// Unit tests for the GM API catalog.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  GM_APIS,
  findApi,
  canonicalizeGrant,
  resolveGrants,
  isSupportedApi,
} from '../../dist/gm-api-catalog.js';

test('catalog has both GM_xmlhttpRequest and GM.xmlHttpRequest aliases', () => {
  const spec = findApi('GM_xmlhttpRequest');
  assert.ok(spec, 'GM_xmlhttpRequest in catalog');
  assert.equal(spec.gmDotName, 'xmlHttpRequest');
  assert.equal(spec.kind, 'async');
  // GM. alias resolves to the same spec.
  assert.equal(findApi('GM.xmlHttpRequest'), spec);
});

test('catalog covers the priority surface from GM-API-strategy.md', () => {
  // The strategy doc's priority list — these must all be present.
  const priority = [
    'GM_xmlhttpRequest',
    'GM_setValue',
    'GM_getValue',
    'GM_deleteValue',
    'GM_listValues',
    'GM_addStyle',
    'GM_addElement',
    'GM_setClipboard',
    'GM_openInTab',
    'GM_notification',
    'GM_registerMenuCommand',
    'GM_getResourceText',
    'GM_getResourceURL',
    'GM_addValueChangeListener',
    'GM_removeValueChangeListener',
    'GM_download',
  ];
  for (const n of priority) {
    assert.ok(findApi(n), `${n} should be in the catalog`);
  }
});

test('GM. aliases are GM4-style (camelCase, dropped GM_ prefix)', () => {
  // Sample a few. The convention: GM_xmlhttpRequest -> GM.xmlHttpRequest
  // (note the case change on H), GM_setValue -> GM.setValue, etc.
  const cases = [
    ['GM_setValue', 'setValue'],
    ['GM_getValue', 'getValue'],
    ['GM_xmlhttpRequest', 'xmlHttpRequest'],
    ['GM_getResourceURL', 'getResourceUrl'],
    ['GM_addStyle', 'addStyle'],
    ['GM_download', 'download'],
  ];
  for (const [gm, dot] of cases) {
    assert.equal(findApi(gm).gmDotName, dot, `${gm} -> GM.${dot}`);
  }
});

test('GM_info has no GM. promised version (it returns an object, not a Promise)', () => {
  const spec = findApi('GM_info');
  assert.ok(spec);
  assert.equal(spec.gmDotPromised, undefined);
});

test('storage APIs return a Promise from the GM. namespace (per GM4 spec)', () => {
  for (const n of ['GM_setValue', 'GM_getValue', 'GM_deleteValue', 'GM_listValues']) {
    assert.equal(findApi(n).gmDotPromised, true, `${n} should be promised under GM.`);
  }
});

test('unsupported names return undefined', () => {
  assert.equal(findApi('GM_audio'), undefined);
  assert.equal(findApi('GM_webRequest'), undefined);
  assert.equal(findApi('foo'), undefined);
});

test('canonicalizeGrant maps GM. and GM_ forms to the legacy name', () => {
  assert.equal(canonicalizeGrant('GM_setValue'), 'GM_setValue');
  assert.equal(canonicalizeGrant('GM.setValue'), 'GM_setValue');
});

test('canonicalizeGrant returns null for none/blank/unsupported', () => {
  // `none` is a per-script policy handled by resolveGrants, not a
  // per-name canonicalization, so the helper just returns null here.
  assert.equal(canonicalizeGrant('none'), null);
  assert.equal(canonicalizeGrant('NONE'), null);
  assert.equal(canonicalizeGrant('  '), null);
  assert.equal(canonicalizeGrant('GM_audio'), null); // unsupported
});

test('resolveGrants collects supported names into a set', () => {
  const r = resolveGrants(['GM_setValue', 'GM.getValue', 'GM_xmlhttpRequest']);
  assert.equal(r.hasNone, false);
  assert.deepEqual(r.unknown, []);
  assert.deepEqual([...r.granted].sort(), [
    'GM_getValue',
    'GM_setValue',
    'GM_xmlhttpRequest',
  ]);
});

test('resolveGrants surfaces unknown names but doesn\'t add them', () => {
  const r = resolveGrants(['GM_setValue', 'GM_audio', 'GM_webRequest']);
  assert.deepEqual([...r.granted], ['GM_setValue']);
  assert.deepEqual(r.unknown.sort(), ['GM_audio', 'GM_webRequest']);
});

test('@grant none wins — even if other lines are present', () => {
  const r = resolveGrants(['GM_setValue', 'none']);
  assert.equal(r.hasNone, true);
  assert.equal(r.granted.size, 0);
});

test('duplicate @grant lines collapse to one entry', () => {
  const r = resolveGrants(['GM_setValue', 'GM_setValue', 'GM.setValue']);
  assert.deepEqual([...r.granted], ['GM_setValue']);
});

test('isSupportedApi covers GM. aliases', () => {
  assert.equal(isSupportedApi('GM_setValue'), true);
  assert.equal(isSupportedApi('GM.setValue'), true);
  assert.equal(isSupportedApi('GM_audio'), false);
});

test('every catalog entry has either an async subsystem or a clear sync subsystem', () => {
  for (const a of GM_APIS) {
    assert.ok(
      a.kind === 'sync' || a.kind === 'async',
      `${a.name} has invalid kind ${a.kind}`,
    );
    assert.ok(a.subsystem, `${a.name} missing subsystem`);
  }
});

test('GM_xmlhttpRequest declares @connect requirement', () => {
  const spec = findApi('GM_xmlhttpRequest');
  assert.ok(spec.requires);
  assert.ok(spec.requires.includes('connect'));
});

test('GM_getResource* declare @resource requirement', () => {
  for (const n of ['GM_getResourceText', 'GM_getResourceURL']) {
    const spec = findApi(n);
    assert.ok(spec.requires);
    assert.ok(spec.requires.includes('resource'), `${n} should require @resource`);
  }
});

// ---- window.onurlchange (a non-GM_* grant) --------------------------

test('window.onurlchange is in the catalog with the url-change subsystem', () => {
  const spec = findApi('window.onurlchange');
  assert.ok(spec, 'window.onurlchange should be in the catalog');
  assert.equal(spec.name, 'window.onurlchange');
  assert.equal(spec.subsystem, 'url-change');
  // Not a callable and not a GM4 name — so no GM. alias.
  assert.equal(spec.gmDotName, undefined);
});

test('window.onurlchange canonicalizes to itself and resolves as granted', () => {
  assert.equal(canonicalizeGrant('window.onurlchange'), 'window.onurlchange');
  assert.equal(canonicalizeGrant('  window.onurlchange  '), 'window.onurlchange');
  const r = resolveGrants(['window.onurlchange']);
  assert.equal(r.hasNone, false);
  assert.deepEqual(r.unknown, []);
  assert.deepEqual([...r.granted], ['window.onurlchange']);
  assert.equal(isSupportedApi('window.onurlchange'), true);
});

test('window.onurlchange is dropped by @grant none like every other grant', () => {
  const r = resolveGrants(['window.onurlchange', 'none']);
  assert.equal(r.hasNone, true);
  assert.equal(r.granted.size, 0);
});

test('the other TM window.* grants are deliberately NOT in the catalog', () => {
  // See docs/supported-GM-APIs.md — `window.close` / `window.focus`
  // are TM-only surface we haven't implemented, so they land in
  // `unknown` and the script gets no binding for them.
  for (const n of ['window.close', 'window.focus']) {
    assert.equal(findApi(n), undefined, `${n} should not be in the catalog`);
  }
  const r = resolveGrants(['window.close', 'window.focus', 'window.onurlchange']);
  assert.deepEqual([...r.granted], ['window.onurlchange']);
  assert.deepEqual(r.unknown.sort(), ['window.close', 'window.focus']);
});
