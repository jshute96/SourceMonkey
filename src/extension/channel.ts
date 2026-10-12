// The channel key: a random secret, one per install, baked into the code
// we register, that keeps the page out of what our page-world (MAIN)
// pieces share. See docs/injection.md#the-channel-key.
//
// Two things use it:
//   - The registry. Our MAIN-world entries (each script's config, prelude
//     and program, the GM runtime) are separate scripts, so they meet
//     through the document. Each gets the one shared registry object from
//     `document.__smGate(key)`, which hands it out only for the key. The
//     page can see the gate but can't call it usefully, and can't
//     replace it: it's defined at document_start, before any page script,
//     non-writable and non-configurable.
//   - The bridge's events. Their names end in the key, so the page can
//     neither send nor hear them.
//
// The page never sees the key: it is only ever in code Chrome injects
// (which the page can't read), and only in top-level statements and in
// functions that run before any page script, never in one the page could
// get hold of later (through `.caller`, or a stack trace's call sites)
// and `toString`. See docs/injection.md#the-channel-key.

import { CHANNEL_KEY_PLACEHOLDER } from '../channel-placeholder.js';

const STORAGE_KEY = 'channelKey';

let key: string | null = null;

// Whether this is the extension itself, rather than unit tests building
// code under Node (with whatever `chrome` stub a test installs).
function inExtension(): boolean {
  return (globalThis as { location?: { protocol?: string } }).location?.protocol === 'chrome-extension:';
}

// The key, made and stored the first time, and again for each new
// extension version: a key that leaked stops working at the next update,
// which places every registration again anyway. Every spec build awaits
// this before building. One load at a time, so two first callers can't
// each make a key.
let loading: Promise<string> | null = null;
export function loadChannelKey(): Promise<string> {
  if (key) return Promise.resolve(key);
  if (!inExtension()) return Promise.resolve(CHANNEL_KEY_PLACEHOLDER);
  loading ??= readOrMakeKey().finally(() => { loading = null; });
  return loading;
}

async function readOrMakeKey(): Promise<string> {
  const version = chrome.runtime.getManifest().version;
  const got = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as { key?: unknown; version?: unknown } | undefined;
  if (got && typeof got.key === 'string' && /^[0-9a-f]{32}$/.test(got.key) && got.version === version) {
    key = got.key;
    return key;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const made = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  await chrome.storage.local.set({ [STORAGE_KEY]: { key: made, version } });
  key = made;
  return key;
}

// The key, once `loadChannelKey` has run. Under Node (unit tests) the
// placeholder.
export function channelKey(): string {
  if (key) return key;
  if (!inExtension()) return CHANNEL_KEY_PLACEHOLDER;
  throw new Error('Internal error: The channel key was used before it was loaded');
}

// `code` (a static wrapper file) with the key in place of the stand-in.
// Throws if the stand-in isn't there: every install would otherwise
// share the stand-in as its key.
export function withChannelKey(code: string): string {
  const stand = JSON.stringify(CHANNEL_KEY_PLACEHOLDER);
  if (!code.includes(stand)) throw new Error('Internal error: A wrapper has no channel key stand-in');
  return code.split(stand).join(JSON.stringify(channelKey()));
}

// A JavaScript expression for the shared registry, for generated code.
// The first of our entries to run in a document defines the gate; the
// rest call it. The static wrapper files carry the same code (`reg` in
// each), and `tests/unit/channel.test.mjs` checks they stay in step.
//
// - On `document`, not `window`: a navigation from a frame's initial
//   `about:blank` to a same-origin page keeps the Window, so a parent
//   could plant a gate there before our code runs. Each navigation gets
//   a new Document.
// - One registry per key (a manual run's code has a key of its own; see
//   `documentKey`), in an object with no prototype, read by bracket
//   access: no `Map`, whose `get` the page could replace to see the
//   key. A caller with any other string, the page included, gets an
//   empty registry of its own.
// - Registries have no prototype either, so reading a field one lacks
//   can't hand it to a getter the page put on `Object.prototype`.
// - Each carries built-ins as they were when the gate was made, for
//   generated code that runs after the page's: `freeze`, `apply`
//   (Reflect.apply), `resolve` / `reject` (a promise made with the
//   `Promise` constructor of then), `info` (console.info). See
//   `emitGmBindings`.
export function registryExpr(): string {
  return '(function(k){var g=document.__smGate;if(typeof g!=="function"){'
    + 'var m=Object.create(null),c=Object.create,f=Object.freeze,a=Reflect.apply,p=Promise;'
    + 'var i=console.info.bind(console);'
    + 'var rs=function(v){return new p(function(y){y(v)})};var rj=function(e){return new p(function(y,n){n(e)})};'
    + 'g=function(x){if(typeof x!=="string")return void 0;var r=m[x];'
    + 'if(!r){r=c(null);r.freeze=f;r.apply=a;r.resolve=rs;r.reject=rj;r.info=i;m[x]=r}return r};'
    + 'var d=c(null);d.value=g;Object.defineProperty(document,"__smGate",d)}return g(k)})'
    + `(${JSON.stringify(channelKey())})`;
}

// The key a manual run of script `scriptId` gets in document
// `documentId`, in place of the install's. A manual run's page-world code is injected long after
// the page's own, so the built-ins it captures may be the page's
// replacements, and either could hand the page whatever key the code
// carries. This one opens only that document's bridge (the run injects
// its own, `onlyScript` limiting it to the run's script), so a page that
// got it reaches only that script there. Per script, so each script's
// runs have a bridge of their own (another script's would filter them
// out). The same in every run of the script in a document, so a run
// replaces the last one's state. See docs/manual-scripts.md.
export async function documentKey(documentId: string, scriptId: string): Promise<string> {
  const data = new TextEncoder().encode(`${await loadChannelKey()}:${documentId}:${scriptId}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

// `code` built under the install's key, rekeyed to `to`.
export function rekey(code: string, to: string): string {
  return code.split(channelKey()).join(to);
}

// The bridge's code (built under the install's key) as a manual run's
// bridge: relaying only `scriptId`'s traffic.
export function onlyScript(bridgeCode: string, scriptId: string): string {
  const stand = JSON.stringify('__SM_ONLY__');
  if (!bridgeCode.includes(stand)) throw new Error('Internal error: The bridge has no script stand-in');
  return bridgeCode.split(stand).join(JSON.stringify(scriptId));
}
