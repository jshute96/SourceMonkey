// Canonical `sourcemonkey://<id>/<file>.user.js` URL the injector
// emits as `//# sourceURL=` on each registered script. Lifted to
// its own module so the viewer can match `sourcemonkey://…:L:C`
// refs in log messages against the same string the wrapper used.
//
// `name` is the script's `@name` (or relativePath fallback). Any
// character that wouldn't be safe in a URL path segment is replaced
// with `_`; an empty result falls back to `script` so a `@name`
// that's all punctuation still yields a parsable URL.
export function buildSourceUrl(id: string, name: string): string {
  const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'script';
  return `sourcemonkey://${id}/${safe}.user.js`;
}
