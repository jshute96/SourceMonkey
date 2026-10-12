// The channel key's pieces as unit tests see them. Under Node the
// wrappers keep their placeholder key (src/channel-placeholder.ts), so a
// test reaches the world's registry and names the bridge's events with
// it. See src/extension/channel.ts.

export const KEY = '__SM_KEY__';

// The registry our entries share, from the gate on `document` (a test's
// stand-in).
export function registryOf(document) {
  return document.__smGate(KEY);
}

// A bridge event's name: `sync`, `reply`, `push` or `insert`.
export function eventName(kind) {
  return `sourcemonkey-${kind}-${KEY}`;
}

// A gate for a test's stub of the old globals (`__smPrelude`, `__smRun`,
// `__smSealed`, `__SM_GM__`), so generated code, which asks
// `document.__smGate` for the registry, finds them there. Read at each
// call, so a test can fill the stub in afterwards. The prelude gets a
// plain `callAs` unless the stub has its own.
export function stubGate(stub) {
  const callAs = (fn, t) => Reflect.apply(fn, t, []);
  return (k) => (k !== KEY ? undefined : {
    get prelude() { return { callAs, ...stub.__smPrelude }; },
    get run() { return stub.__smRun; },
    get sealed() { return stub.__smSealed; },
    get gm() { return stub.__SM_GM__; },
    freeze: Object.freeze,
    apply: Reflect.apply,
    resolve: (v) => Promise.resolve(v),
    reject: (e) => Promise.reject(e),
    info: () => {},
  });
}

// `stub` with a gate over itself (`stubGate`), to pass as `self`,
// `window` and `document` to generated code.
export function gated(stub) {
  stub.__smGate = stubGate(stub);
  return stub;
}

// Global-eval `code` (as the reload swap does) with a `document` holding
// a gate over `stub` in place for the call.
export function evalWithGate(code, stub = {}) {
  const had = 'document' in globalThis;
  const before = globalThis.document;
  globalThis.document = gated(stub);
  try {
    return (0, eval)(code);
  } finally {
    if (had) globalThis.document = before;
    else delete globalThis.document;
  }
}
