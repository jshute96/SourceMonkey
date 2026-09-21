// Unit tests for the stored-value codec in src/wrapper-gm-runtime.js.
//
// The codec is the thing that stops chrome.storage's JSON round-trip
// from quietly rewriting what a userscript stored (Date -> ISO string,
// NaN -> null, Map -> {}). Two properties matter and both are checked
// here:
//
//   - fidelity: encode -> JSON round-trip -> decode returns an equal
//     value, for every type the codec claims to handle;
//   - backwards compatibility: a value JSON already round-trips is
//     stored RAW, so rows written by builds that predate the codec
//     decode to themselves.
//
// The runtime is a plain injected script rather than a module, so we
// evaluate the built wrapper against a minimal window stub and read
// the codec off `window.__SM_GM__.storage`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WRAPPER_GM_RUNTIME } from '../../dist/generated-wrappers.js';

function loadRuntime() {
  // Every DOM / chrome touch in the runtime's init is inside a
  // try/catch, so a near-bare object is enough to get it installed.
  // It does have to inherit the real globals, though: the codec reads
  // the typed-array and Error constructors off `window`, which in a
  // page IS the global object.
  const window = Object.create(globalThis);
  window.addEventListener = () => {};
  const document = { visibilityState: 'visible' };
  new Function('window', 'document', WRAPPER_GM_RUNTIME)(window, document);
  return window.__SM_GM__.storage;
}

const { encodeValue, decodeValue } = loadRuntime();

// What the value actually looks like after the trip to disk: the
// message hop and chrome.storage.local both serialize JSON-style.
function throughStorage(value) {
  return decodeValue(JSON.parse(JSON.stringify(encodeValue(value))));
}

test('JSON-clean values are stored raw (backwards compatible)', () => {
  for (const v of [
    1,
    0,
    -3.5,
    'hi',
    '',
    true,
    false,
    null,
    [1, 'two', null, { a: [] }],
    { a: 1, b: { c: ['d'] } },
    {},
    [],
  ]) {
    // Identity, not just equality: nothing is wrapped, so what lands
    // in chrome.storage.local is exactly what older builds wrote.
    assert.equal(encodeValue(v), v, `should pass through raw: ${JSON.stringify(v)}`);
    assert.deepEqual(throughStorage(v), v);
  }
});

test('legacy rows decode to themselves', () => {
  // Anything without the envelope marker is already the value.
  for (const raw of [42, 'str', null, true, [1, 2], { a: 1 }, { __smv__: 'not ours' }]) {
    assert.deepEqual(decodeValue(raw), raw);
  }
});

test('Date survives the round-trip', () => {
  const d = new Date('2024-03-01T12:34:56.789Z');
  const out = throughStorage(d);
  assert.ok(out instanceof Date);
  assert.equal(out.getTime(), d.getTime());
});

test('Invalid Date stays an Invalid Date', () => {
  const out = throughStorage(new Date(NaN));
  assert.ok(out instanceof Date);
  assert.ok(Number.isNaN(out.getTime()));
});

test('non-JSON numbers survive', () => {
  assert.ok(Number.isNaN(throughStorage(NaN)));
  assert.equal(throughStorage(Infinity), Infinity);
  assert.equal(throughStorage(-Infinity), -Infinity);
  assert.equal(Object.is(throughStorage(-0), -0), true);
  // Nested, too — the whole value gets wrapped because of one leaf.
  assert.deepEqual(throughStorage({ a: [1, NaN] }).a[1], NaN);
});

test('undefined survives, at the top level and nested', () => {
  assert.equal(throughStorage(undefined), undefined);
  const out = throughStorage({ a: undefined, b: 1 });
  assert.ok('a' in out, 'the key should still exist');
  assert.equal(out.a, undefined);
  assert.equal(out.b, 1);
  assert.deepEqual(throughStorage([undefined, 1]), [undefined, 1]);
});

test('RegExp survives with its flags', () => {
  const out = throughStorage(/ab+c/gi);
  assert.ok(out instanceof RegExp);
  assert.equal(out.source, 'ab+c');
  assert.equal(out.flags, 'gi');
});

test('Map and Set survive, including non-string keys', () => {
  const m = new Map([['a', 1], [2, { b: new Date(0) }]]);
  const out = throughStorage(m);
  assert.ok(out instanceof Map);
  assert.equal(out.size, 2);
  assert.equal(out.get('a'), 1);
  assert.equal(out.get(2).b.getTime(), 0);

  const s = new Set(['x', 3, NaN]);
  const outSet = throughStorage(s);
  assert.ok(outSet instanceof Set);
  assert.equal(outSet.size, 3);
  assert.ok(outSet.has('x'));
  assert.ok(outSet.has(3));
});

test('BigInt survives', () => {
  const out = throughStorage(9007199254740993n);
  assert.equal(typeof out, 'bigint');
  assert.equal(out, 9007199254740993n);
});

test('typed arrays survive with their element type', () => {
  const u8 = new Uint8Array([0, 1, 254, 255]);
  const out = throughStorage(u8);
  assert.ok(out instanceof Uint8Array);
  assert.deepEqual([...out], [0, 1, 254, 255]);

  const f64 = new Float64Array([1.5, -0.25, Math.PI]);
  const outF = throughStorage(f64);
  assert.ok(outF instanceof Float64Array);
  assert.deepEqual([...outF], [1.5, -0.25, Math.PI]);

  const i16 = new Int16Array([-32768, 32767]);
  const outI = throughStorage(i16);
  assert.ok(outI instanceof Int16Array);
  assert.deepEqual([...outI], [-32768, 32767]);
});

test('a typed array view over a larger buffer keeps only its own bytes', () => {
  const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
  const view = new Uint8Array(backing.buffer, 2, 3);
  const out = throughStorage(view);
  assert.deepEqual([...out], [1, 2, 3]);
  assert.equal(out.byteOffset, 0, 'decodes over a fresh, exactly-sized buffer');
});

test('a large typed array survives (chunked base64)', () => {
  // Past the 32k apply() chunk boundary, which is where an unchunked
  // String.fromCharCode.apply would blow the argument stack.
  const big = new Uint8Array(100_000);
  for (let i = 0; i < big.length; i++) big[i] = i % 256;
  const out = throughStorage(big);
  assert.equal(out.length, big.length);
  assert.deepEqual([...out.subarray(0, 4)], [0, 1, 2, 3]);
  assert.deepEqual([...out.subarray(-2)], [(big.length - 2) % 256, (big.length - 1) % 256]);
});

test('ArrayBuffer and DataView survive', () => {
  const buf = new Uint8Array([1, 2, 3]).buffer;
  const out = throughStorage(buf);
  assert.ok(out instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(out)], [1, 2, 3]);

  const dv = new DataView(new Uint8Array([0, 0, 0, 7]).buffer);
  const outDv = throughStorage(dv);
  assert.ok(outDv instanceof DataView);
  assert.equal(outDv.getUint32(0), 7);
});

test('an empty typed array survives', () => {
  const out = throughStorage(new Uint8Array(0));
  assert.ok(out instanceof Uint8Array);
  assert.equal(out.length, 0);
});

test('Error survives with its type, message and attached properties', () => {
  const e = new TypeError('bad input');
  e.code = 42;
  const out = throughStorage(e);
  assert.ok(out instanceof TypeError);
  assert.equal(out.name, 'TypeError');
  assert.equal(out.message, 'bad input');
  assert.equal(out.code, 42);
  assert.ok(typeof out.stack === 'string' && out.stack.length > 0);
});

test('an Error subclass keeps its name on a plain Error', () => {
  class HttpError extends Error {
    constructor(msg) {
      super(msg);
      this.name = 'HttpError';
    }
  }
  const out = throughStorage(new HttpError('418'));
  assert.ok(out instanceof Error);
  assert.equal(out.name, 'HttpError');
  assert.equal(out.message, '418');
});

test('binary values nest inside ordinary structures', () => {
  const out = throughStorage({ blobs: [new Uint8Array([7]), null], when: new Date(0) });
  assert.ok(out.blobs[0] instanceof Uint8Array);
  assert.equal(out.blobs[0][0], 7);
  assert.equal(out.blobs[1], null);
  assert.equal(out.when.getTime(), 0);
});

test('a class instance keeps its properties but not its prototype', () => {
  // Documented limit: the class is not reachable at decode time.
  class Point {
    constructor(x) {
      this.x = x;
      this.at = new Date(0);
    }
  }
  const out = throughStorage(new Point(3));
  assert.equal(out.x, 3);
  assert.equal(out.at.getTime(), 0, 'nested tagged types inside it still revive');
  assert.equal(out instanceof Point, false);
});

test('object key order is preserved', () => {
  const v = { z: new Date(0), a: 1, m: 2 };
  assert.deepEqual(Object.keys(throughStorage(v)), ['z', 'a', 'm']);
});

test('a value carrying the envelope marker is wrapped, not misread', () => {
  const v = { __smv__: 1, v: ['p', 'decoy'] };
  const out = throughStorage(v);
  assert.deepEqual(out, v);
});

test('functions and symbols keep their JSON behaviour', () => {
  // JSON omits them from objects and nulls them in arrays; the codec
  // reproduces that rather than inventing a representation.
  assert.deepEqual(throughStorage({ a: 1, f() {} }), { a: 1 });
  assert.deepEqual(throughStorage([1, () => {}, 2]), [1, null, 2]);
});

test('toJSON is honoured, as JSON.stringify would', () => {
  assert.deepEqual(throughStorage({ toJSON: () => ({ x: 1 }) }), { x: 1 });
});

// --- Regressions from code review ---

test('a spoofed Symbol.toStringTag falls back to the object walk', () => {
  // Object.prototype.toString honours Symbol.toStringTag, so any
  // object can claim to be a Date/Map/Uint8Array. Taking the tagged
  // branch on one of those either throws out of GM_setValue or
  // silently discards its real properties; it has to degrade to what
  // an ordinary object has always done.
  for (const tag of ['Date', 'Map', 'Set', 'RegExp', 'Error', 'Uint8Array', 'ArrayBuffer', 'DataView']) {
    const decoy = { [Symbol.toStringTag]: tag, real: 1, when: new Date(0) };
    let out;
    assert.doesNotThrow(() => {
      out = throughStorage(decoy);
    }, `${tag} decoy should not throw`);
    assert.equal(out.real, 1, `${tag} decoy should keep its properties`);
    assert.equal(out.when.getTime(), 0, `${tag} decoy should still revive nested types`);
  }
});

test('a Proxy over a real Map degrades instead of throwing', () => {
  // The Proxy reports "[object Map]" but refuses the internal slot
  // that Map.prototype.forEach needs.
  const proxied = new Proxy(new Map([['a', 1]]), {});
  let out;
  assert.doesNotThrow(() => {
    out = throughStorage(proxied);
  });
  assert.deepEqual(out, {});
});

test('a spoofed tag on an otherwise plain value stays stored raw', () => {
  // The fallback must also roll back `state.plain`, or a value that
  // JSON round-trips fine ends up needlessly wrapped.
  const decoy = { [Symbol.toStringTag]: 'Date', a: 1 };
  assert.equal(encodeValue(decoy), decoy);
});

test('an own __proto__ key decodes as a property, not a prototype', () => {
  // JSON.parse produces objects with own __proto__ keys, so this is
  // reachable; a plain `obj[key] = …` would set the prototype.
  const v = JSON.parse('{"__proto__": {"polluted": 1}}');
  v.when = new Date(0); // force the tagged path
  const out = throughStorage(v);
  assert.deepEqual(Object.keys(out).sort(), ['__proto__', 'when']);
  assert.equal(out.polluted, undefined, 'prototype must not have been replaced');
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.deepEqual(out.__proto__, { polluted: 1 });
  assert.equal({}.polluted, undefined, 'Object.prototype must be untouched');
});

test('an own __proto__ key on an Error decodes as a property', () => {
  const e = new Error('x');
  Object.defineProperty(e, '__proto__', {
    value: { polluted: 1 }, writable: true, enumerable: true, configurable: true,
  });
  const out = throughStorage(e);
  assert.ok(out instanceof Error);
  assert.equal(out.polluted, undefined);
  assert.deepEqual(Object.getOwnPropertyDescriptor(out, '__proto__').value, { polluted: 1 });
});

test('an undecodable envelope comes back inspectable, not undefined', () => {
  // Returning undefined would also defeat GM_getValue's default,
  // because the key is present.
  const corrupt = { __smv__: 1, v: 'not a node array' };
  assert.deepEqual(decodeValue(corrupt), undefined);
  const unknownFormat = { __smv__: 99, v: ['p', 1] };
  assert.deepEqual(decodeValue(unknownFormat), unknownFormat);
});

test('a circular reference throws at the call site', () => {
  const a = { name: 'a' };
  a.self = a;
  assert.throws(() => encodeValue(a), /circular reference/);
});

test('sibling references are not mistaken for cycles', () => {
  const shared = { s: 1 };
  const out = throughStorage({ x: shared, y: shared });
  assert.deepEqual(out, { x: { s: 1 }, y: { s: 1 } });
});
