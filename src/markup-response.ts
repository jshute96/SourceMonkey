// Recognizing an HTML page served where JavaScript was expected.
//
// The failure this catches is a *soft* one: the request succeeded, the
// status was 200, and the bytes are a perfectly good web page — just
// not the script we asked for. Left alone it flows onward and is
// reported as a syntax error in the user's script, which blames the
// wrong file. The classic shapes:
//   - a forge's file-browser page (`github.com/<o>/<r>/blob/…`) instead
//     of the raw bytes;
//   - a login / SSO wall or captive portal answering at 200;
//   - a `@require` URL that has rotted into a 200-with-error-page;
//   - a local *directory* whose name matches the ref — Chrome answers
//     `file://` directory reads with a generated HTML listing.
//
// Two independent tests, because each catches what the other misses:
//   - `isMarkupContentType` — the server told us. Free, and right even
//     when the body is unreadable.
//   - `looksLikeMarkup` — the bytes tell us. Needed when there is no
//     Content-Type at all (the `file://` XHR leg often has none) or the
//     server mislabels HTML as `text/plain`.
//
// Deliberately NOT applied to `@resource` (an HTML resource is a
// legitimate thing to fetch and hand to `GM_getResourceText`), to
// `@icon` (already gated on `image/*`), or to `file://` directory
// listings (which are HTML *by design* — see `parseListing` in
// directories.ts). The rule is "this text is about to be treated as
// JavaScript", not "this text arrived over the network".
//
// See [docs/requires.md] "Markup gate" for the two tests written up
// together, plus [docs/install-capture.md] and [docs/diagnostics.md].

// True for the Content-Type families that mean markup. A denylist, not
// an allowlist: `application/octet-stream` and friends are common and
// legitimate for JavaScript (GitHub serves every release asset that
// way), so only the types that can't be a script are rejected.
// `text/html-sandboxed` is caught by the prefix and deserves to be;
// XHTML is spelled `application/xhtml+xml`, so it needs its own clause
// to match the same intent.
//
// `application/json` is deliberately absent: a JSON error envelope at
// 200 is a real soft-failure shape, but so is a legitimate JS module
// served by a mislabelling host, and the eval-side try/catch already
// contains the damage.
//
// Trims defensively so the rule holds for a caller that hands over a
// raw header rather than the lowercased/trimmed one every producer in
// file-loader.ts passes.
export function isMarkupContentType(contentType: string): boolean {
  const type = contentType.trim().toLowerCase();
  return type.startsWith('text/html') || type.startsWith('application/xhtml');
}

// True when the text itself is a markup document: the first thing in
// it, past any BOM and leading whitespace, is `<`.
//
// Why the FIRST character and not "does it contain HTML" — a forge's
// blob page embeds the file's own lines, metadata block and all, so a
// search anywhere in the body finds `// ==UserScript==` and concludes
// the page IS the script. Position is the only reliable signal, and it
// is exactly the signal a served `.js` file gives: JavaScript starts
// with code or a comment, never with a tag.
//
// The check is on the leading character, not on the metadata block's
// position, because a script may legitimately carry leading text — a
// license banner above the block is common, is preserved
// (`leadingText`, userscript-header.ts), and must keep working.
//
// Known false positive, accepted: `<!--` at the very top of a file is
// valid JavaScript (Annex B HTML-like comments), so a script opening
// with one is called markup. That spelling belongs to 1990s inline
// `<script>` blocks and does not occur in userscripts.
export function looksLikeMarkup(text: string): boolean {
  // A leading BOM needs no special handling: ECMAScript's `WhiteSpace`
  // production includes U+FEFF, so `\s` matches it here exactly as
  // `trim` would. (`userscript-header.ts` strips one explicitly for a
  // different reason — a `/m` regex's `^` won't match past it.)
  //
  // Anchored regex rather than `trimStart().startsWith('<')`: the
  // rejected inputs are whole web pages, and trimming one allocates a
  // second copy of it to look at a single character.
  return /^\s*</.test(text);
}

// The one wording for "we got a web page instead of JavaScript",
// shared by every caller so the same problem never gets two spellings.
//
// `localUrl` splits it into two sentences on purpose: blaming the
// server when the bytes came off local disk would be a flatly wrong
// diagnosis, and the common way to hit the local case is a directory
// whose name matches the ref.
//
// `contentType` is the *evidence*, not decoration — pass it only when
// the header is what proved this, and leave it out when the body did.
// A parenthetical reading `(Content-Type "text/plain")` next to a
// claim that the response is HTML reads as a contradiction.
//
// `expected` names what we wanted instead. Almost always JavaScript,
// but the same fetcher reads collection manifests, and telling someone
// their manifest isn't JavaScript names the wrong thing.
export function markupResponseMessage(
  opts: { localUrl?: string; contentType?: string; expected?: string } = {},
): string {
  const evidence = opts.contentType ? ` (Content-Type "${opts.contentType}")` : '';
  const expected = opts.expected ?? 'JavaScript';
  return opts.localUrl
    ? `The local file ${opts.localUrl} is an HTML page, not ${expected}${evidence} — a folder with that name would look like this`
    : `The server returned an HTML page, not ${expected}${evidence} — the link may be dead or behind a login`;
}

// Thrown by the script-text fetchers so a caller can tell this apart
// from every other read failure without matching on wording (which
// docs/diagnostics.md forbids, and which would go stale the first time
// the message is reworded).
//
// The preview is the caller that cares: for a captured navigation,
// "this is a web page" is not an error to report but a sign the
// capture should never have fired, so it continues to the page instead.
export class MarkupResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarkupResponseError';
  }
}
