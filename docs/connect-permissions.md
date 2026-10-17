# `@connect` permissions

How SourceMonkey decides whether a script's `GM_xmlhttpRequest` may
reach a site, and how it asks the user about sites the script's
`@connect` lines don't cover.

- Policy and messages: [`src/gm-connect.ts`](../src/gm-connect.ts)
- Prompt, worker side: [`src/extension/connect-prompt.ts`](../src/extension/connect-prompt.ts)
- Prompt window: [`src/connect-prompt.html`](../src/connect-prompt.html),
  [`src/extension/connect-prompt-page.ts`](../src/extension/connect-prompt-page.ts)
- Stored answers: [`src/extension/connect-grants.ts`](../src/extension/connect-grants.ts)
- Tests: `tests/e2e/gm-connect.spec.ts`, `tests/unit/gm-connect.test.mjs`

Related: [GM-APIs.md](GM-APIs.md) (the rest of `GM_xmlhttpRequest`),
[supported-GM-APIs.md](supported-GM-APIs.md#connect-gating) (what a
script author sees), [script-viewer.md](script-viewer.md) (the Network
access row).

## Overview

A request goes ahead when:

- a `@connect` rule in the script's header covers its host (grammar
  below), or
- it goes to the requesting page's own origin, whatever the rules say.

Any other http(s) host gets the **connection prompt**: the user is
asked, and the answer is kept for the script (or not, for the one-time
choices). A URL with no host (`file:`, `data:`), or one that isn't
http(s) (`ws:`), is refused unless `@connect *` covers it.

## Compared with the reference managers

- TM also prompts for a host the script didn't declare, and since TM
  4.0 the page's own origin needs no `@connect`.
- VM doesn't enforce `@connect` at all. Its install-confirm page lists
  the declared hosts, and nothing checks them at request time.
- A script that grants `GM_xmlhttpRequest` with no `@connect` gets a
  parse-time info note (`extractStartupLogs` in `script-build.ts`),
  saying SourceMonkey will ask.

## The page's own origin

- Refusing it protects nothing: the page could `fetch` that URL
  itself. So it's allowed with or without rules, as in TM 4.
- Exact origin match (scheme, host and port), http(s) only. Chrome
  gives every local file the same bare `file://` origin, so for a
  `file:` page it would mean the whole disk.
- `self` covers the page's host too (any port), on top of the
  script's `@match` / `@include` hosts.
- A relative request URL is resolved in the page, against
  `document.baseURI` (`resolvePageUrl` in `wrapper-gm-runtime.js`), as
  `GM_download` does. The worker has no page to be relative to.

## The connection prompt

Worker side: `connect-prompt.ts`. Window: `connect-prompt.html` and
`connect-prompt-page.ts`. Answers: `connect-grants.ts`.

- A small popup window of the extension's own, not something drawn in
  the page, so the page can neither fake nor click it. No button
  starts focused, so a key meant for the page can't answer it.
- It names the script (linked to its page) and the site (linked at its
  root), and says that allowing lets the script act as the user there.
  The site link's tooltip has the request's method and URL, without the
  query string (that often holds keys).
- The choices, in two rows:
  - "Allow one time?": **Allow once** lets the requests waiting on the
    prompt go, and **Cancel** blocks them. Neither keeps anything, so
    the next request asks again. Closing the window counts as Cancel.
  - "Allow permanently?": **Allow** keeps the site in
    `chrome.storage.local`, across refreshes and updates, until reset or
    the script is removed. **Allow all sites** does the same for all
    hosts. **Deny** keeps the site the same way, as a denial. Each
    answer about a site replaces the other, and Allow all sites clears
    all denials.
- One window per (script, host). Requests that arrive while it is up
  wait on the same answer. Cancel (or closing) keeps nothing, so a
  script that retries at once reopens it; Deny is the answer that
  stops that.
- Each request waits up to 4 minutes (`CONNECT_PROMPT_WAIT_MS`), under
  the page's own 5-minute give-up, then fails with a message saying
  the prompt had no answer.
- A prompt with no request left waiting on it (timed out, aborted, or
  its tab closed) closes, so it doesn't ask about nothing or keep the
  worker running.
- A script gets at most 3 prompt windows at once
  (`MAX_PROMPTS_PER_SCRIPT`). A request for a fourth site fails at once,
  so a script looping over hosts can't bury the user in windows.
- The window sends a message every 20 seconds, so the worker isn't
  stopped for being idle while requests wait on it.
- The answer carries the script id and host, so it is saved even if
  the worker restarted and lost track of the window. The worker takes
  answers only from the prompt page itself.
- A request aborted (or whose tab closed, or whose `timeout` fired)
  while it waits stops waiting at once. `reserveXhr` makes it abortable
  before `runXhr` starts, and the post-redirect check is given the
  request's abort signal too.
- The Log tab (`gm-xhr` source) gets:
  - an info entry when a prompt opens, naming the request (without its
    query string);
  - an entry for the answer: info for an allowance, a warning for Deny,
    Cancel or closing;
  - a warning when a kept denial blocks a request, once per site for
    each page the script runs on (keyed by the page's document), so a
    retrying script doesn't fill the log.
- The script's page lists the answers under Network access (as
  `Undeclared in @connect:`), each with
  a Reset button that clears it (see
  [script-viewer.md](script-viewer.md)).
- sm-dev reports each prompt and answers it with `connect` (see
  [sm-dev-design.md](sm-dev-design.md)).

## Rules

Grammar (lower-case before matching):

- `*` — wildcard, allow any host.
- `self` — allow the script's own `@match`/`@include` hosts (and
  `*.host` subdomains in those globs contribute `host`).
- `example.com` — that host **and** any subdomain, as TM documents
  (`@connect example.com` covers `api.example.com`). Matched on whole
  labels, so `evilexample.com` doesn't match.
  - An IP address or single-label name (`127.0.0.1`, `localhost`,
    `com`) matches only exactly, so a bare rule can't cover a TLD or
    an IP range.
  - Multi-label public suffixes aren't special-cased: `@connect co.uk`
    covers all of `.co.uk`.
- `*.example.com` — the same: `example.com` itself **and** any subdomain.
- A scheme-prefixed URL like `https://example.com` is accepted and
  normalized to its host.

## Where the check runs

- In `handleXhrStart`, before `fetch`. The SW reads the script's
  stored header once (`loadConnectPolicy`), and `decideConnect`
  answers `allow`, `ask`, `deny` or `invalid` for a URL. An `ask`
  goes to the user's standing answer or the prompt.
- A refused request ships an `error` event back to the page, so the
  userscript's `onerror` catches it.
- The same check runs on the post-redirect URL. `fetch` follows
  redirects by default, so an allowed host could 302 to another one.
  `runXhr` re-checks `res.url` whenever the response was redirected
  (asking about its host if need be) and drops the body, returning an
  `error`, if it's refused. See the redirect note under "Known
  limitations".

## Trust caveat

The same trust caveat as the other async-envelope handlers applies:
the message-supplied `scriptId` is wrapper-supplied, so a sibling
userscript that knows another script's id can spoof an XHR under
that script's `@connect` allowlist. Same-extension userscripts are
within the user's trust boundary. Documented limitation; revisit
if real reports come in.

## Known limitations

- **A redirect's outbound hop still happens.**
  - The post-redirect check refuses to hand the script the response,
    but `fetch` has already sent the request to the redirect target.
  - `fetch` gives no per-hop hook, and `redirect: 'manual'` yields an
    opaque response with no readable `Location`.
  - That hop carries the user's cookies. So a script can provoke a
    blind credentialed request to a site it wasn't allowed: the
    response stays out of reach, the side effect on the target doesn't.
- **One prompt window per site**, up to 3 per script. One window
  listing several sites would be kinder (see TODO.md).
- **An answer covers one exact host**, not its subdomains. Allow all
  sites covers them all.
- **The prompt asks per request, not at install.** Nothing yet reviews
  the `@connect` hosts a script declares when it is installed or
  gains new ones in an update (see TODO.md).
