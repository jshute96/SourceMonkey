// The channel key and the registry our page-world entries share through
// it (src/extension/channel.ts): one registry per world, which the gate
// hands only to the key, and which the page can't swap out.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WRAPPER_GM_RUNTIME, WRAPPER_PRELUDE } from '../../dist/generated-wrappers.js';
import { buildConfigBlob } from '../../dist/extension/injector.js';
import { documentKey, registryExpr, rekey, withChannelKey } from '../../dist/extension/channel.js';
import { KEY, registryOf } from './channel-helpers.mjs';

// A page's `window` and `document` as our entries see them: the real
// globals, plus what the prelude and runtime touch at load. The gate
// goes on the document.
function makePage() {
  const window = Object.create(globalThis);
  window.addEventListener = () => {};
  window.removeEventListener = () => {};
  const document = { visibilityState: 'visible', readyState: 'loading', addEventListener() {}, removeEventListener() {} };
  return { window, document };
}

function run(code, { window, document }) {
  // eslint-disable-next-line no-new-func
  new Function('window', 'self', 'document', 'chrome', code)(window, window, document, undefined);
}

test('the first entry defines the gate; config, prelude and runtime meet in one registry', () => {
  const page = makePage();
  const { window, document } = page;
  // As in a page: a script's config runs before any prelude has loaded.
  run(buildConfigBlob({
    id: 'one', name: 'One', sourceUrl: 'sourcemonkey://x/one.user.js', loadedAt: 1, runAt: 'document-idle',
    needsGmValues: false, matching: null, startupLogs: [], logLabel: 'one.user.js',
  }), page);
  const reg = registryOf(document);
  assert.equal(reg.cfgQueue.length, 1, 'queued for the prelude');
  run(WRAPPER_PRELUDE, page);
  assert.equal(reg.cfgQueue, null, 'the prelude drained it');
  assert.ok(reg.prelude.scripts.one, 'into its own table');
  assert.equal(typeof reg.run, 'function');
  run(WRAPPER_GM_RUNTIME, page);
  assert.equal(typeof reg.gm.sendAsync, 'function');
  // None of it is a page global.
  for (const name of ['__SM_GM__', '__smPrelude', '__smRun', '__smSealed', '__smCfgQueue']) {
    assert.equal(Object.hasOwn(window, name), false, name);
  }
});

test('the gate gives ours only for the key, and the page can\'t replace it', () => {
  const page = makePage();
  const { window, document } = page;
  run(WRAPPER_PRELUDE, page);
  const gate = document.__smGate;
  // Any other string gets an empty registry of its own.
  const guessed = gate('guess');
  assert.notEqual(guessed, registryOf(document));
  assert.equal(guessed.prelude, undefined);
  assert.equal(gate('guess'), guessed, 'one per key');
  assert.equal(gate('__proto__').prelude, undefined, 'no inherited keys');
  assert.equal(gate(KEY), registryOf(document));
  const desc = Object.getOwnPropertyDescriptor(document, '__smGate');
  assert.equal(desc.writable, false);
  assert.equal(desc.configurable, false);
  assert.equal(desc.enumerable, false);
  assert.equal(Reflect.set(document, '__smGate', () => ({})), false);
  // Its source doesn't give the key away.
  assert.doesNotMatch(Function.prototype.toString.call(gate), new RegExp(KEY));
});

test('the runtime is a fixed property of the registry', () => {
  const page = makePage();
  const { window, document } = page;
  run(WRAPPER_GM_RUNTIME, page);
  const reg = registryOf(document);
  const gm = reg.gm;
  assert.equal(Reflect.set(reg, 'gm', {}), false);
  assert.equal(reg.gm, gm);
});

test('the registry carries built-ins as they were when it was made', async () => {
  const page = makePage();
  const { window, document } = page;
  // eslint-disable-next-line no-new-func
  const reg = new Function('document', `return ${registryExpr()};`)(document);
  assert.equal(reg.freeze, Object.freeze);
  assert.equal(typeof reg.info, 'function');
  // A later entry gets the same one.
  // eslint-disable-next-line no-new-func
  assert.equal(new Function('document', `return ${registryExpr()};`)(document), reg);
  // No prototype: a missing field reads as undefined, past any getter.
  assert.equal(Object.getPrototypeOf(reg), null);
  assert.equal(typeof reg.apply, 'function');
  assert.equal(await reg.resolve(3), 3);
});

test('withChannelKey puts the key in place of the stand-in', () => {
  // Under Node the key is the stand-in itself, so this only checks that
  // nothing else changes.
  assert.equal(withChannelKey(WRAPPER_PRELUDE), WRAPPER_PRELUDE);
  assert.ok(WRAPPER_PRELUDE.includes(JSON.stringify(KEY)));
});

test('a manual run\'s key is its document and script\'s own, the same in every run there', async () => {
  const a = await documentKey('doc-a', 's1');
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(await documentKey('doc-a', 's1'), a);
  assert.notEqual(await documentKey('doc-b', 's1'), a);
  // Each script's runs have their own.
  assert.notEqual(await documentKey('doc-a', 's2'), a);
  assert.notEqual(a, KEY);
  // Code built under the install's key moves to it whole.
  const code = withChannelKey(WRAPPER_PRELUDE) + registryExpr();
  const moved = rekey(code, a);
  assert.ok(!moved.includes(KEY));
  assert.equal(moved.split(a).length, code.split(KEY).length);
});

test('the static wrappers carry the same registry code as generated entries', () => {
  // Three copies of one piece of code: kept in step by this. Compared
  // with whitespace and semicolons left out, from `(function(k){` to
  // the call.
  const body = (code) => {
    const flat = code.replace(/[\s;]+/g, '');
    const start = flat.indexOf('(function(k){varg=document.__smGate');
    assert.ok(start >= 0, 'found the registry code');
    return flat.slice(start, flat.indexOf('})(', start));
  };
  const generated = body(registryExpr());
  assert.equal(body(WRAPPER_PRELUDE), generated);
  assert.equal(body(WRAPPER_GM_RUNTIME), generated);
});
