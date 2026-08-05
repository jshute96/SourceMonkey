// Unit tests for the GM API catalog.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  GM_APIS,
  findApi,
  gmDotSpellings,
  canonicalizeGrant,
  resolveGrants,
  suggestGrant,
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

// ---- `GM.` spellings ----
//
// VM resolves `GM.foo` through a two-entry alias table and otherwise
// rewrites it to `'GM_' + foo` verbatim, so both the GM4 name and the
// legacy-minus-prefix name are accepted spellings. See the
// `gmDotSpellings` comment in src/gm-api-catalog.ts.

test('gmDotSpellings yields both spellings only where GM4 re-cased the name', () => {
  assert.deepEqual(gmDotSpellings(findApi('GM_xmlhttpRequest')), [
    'xmlHttpRequest',
    'xmlhttpRequest',
  ]);
  assert.deepEqual(gmDotSpellings(findApi('GM_getResourceURL')), [
    'getResourceUrl',
    'getResourceURL',
  ]);
  // Every other API's GM4 name is just the legacy name minus `GM_`.
  assert.deepEqual(gmDotSpellings(findApi('GM_setValue')), ['setValue']);
  assert.deepEqual(gmDotSpellings(findApi('GM_log')), ['log']);
  // unsafeWindow has neither a `GM_` prefix nor a GM4 alias.
  assert.deepEqual(gmDotSpellings(findApi('unsafeWindow')), []);
});

test('every catalog entry with a GM. alias exposes at most two spellings', () => {
  for (const a of GM_APIS) {
    const spellings = gmDotSpellings(a);
    assert.ok(spellings.length <= 2, `${a.name} has ${spellings.length} GM. spellings`);
    assert.equal(new Set(spellings).size, spellings.length, `${a.name} has a duplicate spelling`);
  }
});

test('both GM. spellings resolve to the same spec', () => {
  const xhr = findApi('GM_xmlhttpRequest');
  assert.equal(findApi('GM.xmlHttpRequest'), xhr);
  assert.equal(findApi('GM.xmlhttpRequest'), xhr);
  const res = findApi('GM_getResourceURL');
  assert.equal(findApi('GM.getResourceUrl'), res);
  assert.equal(findApi('GM.getResourceURL'), res);
});

test('matching stays byte-exact — mis-cased legacy names are still unknown', () => {
  // TM/VM both compare grant names exactly; we don't diverge. The
  // `GM.` spellings above are extra accepted *names*, not a
  // case-insensitive matcher.
  for (const n of ['GM_xmlHttpRequest', 'GM_Log', 'gm_setvalue', 'GM.SetValue', 'GM_XMLHttpRequest']) {
    assert.equal(findApi(n), undefined, `${n} should not resolve`);
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

test('resolveGrants accepts the rewrite-form GM. spellings', () => {
  const r = resolveGrants(['GM.xmlhttpRequest', 'GM.getResourceURL']);
  assert.deepEqual(r.unknown, []);
  assert.deepEqual([...r.granted].sort(), ['GM_getResourceURL', 'GM_xmlhttpRequest']);
});

test('resolveGrants keeps mis-cased legacy names unknown', () => {
  const r = resolveGrants(['GM_xmlHttpRequest', 'GM_Log']);
  assert.equal(r.granted.size, 0);
  assert.deepEqual(r.unknown, ['GM_xmlHttpRequest', 'GM_Log']);
});

test('suggestGrant names the case-only near miss', () => {
  assert.equal(suggestGrant('GM_xmlHttpRequest'), 'GM_xmlhttpRequest');
  assert.equal(suggestGrant('GM_Log'), 'GM_log');
  assert.equal(suggestGrant('gm_setvalue'), 'GM_setValue');
  assert.equal(suggestGrant('GM.SETVALUE'), 'GM.setValue');
  assert.equal(suggestGrant('  GM_LISTVALUES  '), 'GM_listValues');
});

test('suggestGrant returns null for exact hits and for real unknowns', () => {
  // Already valid — nothing to suggest.
  assert.equal(suggestGrant('GM_setValue'), null);
  assert.equal(suggestGrant('GM.xmlhttpRequest'), null);
  // Genuinely not in the catalog: no case-folded neighbour either.
  assert.equal(suggestGrant('GM_audio'), null);
  assert.equal(suggestGrant('GM_webRequest'), null);
  assert.equal(suggestGrant(''), null);
  assert.equal(suggestGrant('none'), null);
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
