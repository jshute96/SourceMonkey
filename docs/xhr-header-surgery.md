# XHR header surgery

How `GM_xmlhttpRequest` sets request headers the browser forbids a
script to set. Code: `src/gm-xhr-headers.ts`, driven from
`src/gm-xhr.ts`.

For the rest of the XHR implementation see
[GM-APIs.md](GM-APIs.md#gm_xmlhttprequest); for the script-facing
surface see
[supported-GM-APIs.md](supported-GM-APIs.md#forbidden-headers).

## What it does

- A userscript can put any header in `GM_xmlhttpRequest`'s `headers`,
  including ones the browser normally refuses, and it reaches the
  server.
- Without it, those headers are dropped with no error — the request
  goes out looking ordinary and the script has no way to tell.

## Why it's needed

- The [Fetch Standard](https://fetch.spec.whatwg.org/) — the web
  standard that defines `fetch()`, and what every browser implements —
  calls some headers *forbidden request headers*, and has `fetch()`
  drop them silently rather than error.
- The list: `Origin`, `Referer`, `Cookie`, `Host`, `User-Agent`, the
  transport ones, and everything prefixed `Sec-` or `Proxy-`. They're
  reserved for the browser to set, so a server can trust them.
- The restriction applies in the service worker exactly as on a page,
  so running the request in the extension doesn't escape it.

### The case that forced it

- `Sec-Fetch-Site` tells a server what kind of context issued a
  request. A service worker always sends `none` — a value no page can
  produce.
- Sites whose WAF (web application firewall — the filtering layer in
  front of a site) requires same-origin API calls reject `none`
  outright, so those endpoints were unreachable no matter how correct
  the script's cookies and tokens were.
- Being a `Sec-` header, it's forbidden by prefix rather than by name,
  which is why an override list built from the familiar names
  (`Origin`, `Referer`, …) wouldn't have covered it.

## How a request flows

1. **Split.** `splitHeaders` sorts the caller's headers into the ones
   `fetch` will carry and the ones it would drop.
2. **Compile.** The dropped ones become a `declarativeNetRequest` (DNR
   — Chrome's rule-based request-rewriting API) session rule: a `set`
   entry per header, plus a `remove` for our own `Origin` where the
   method carries one.
3. **Install.** The rule is added before the fetch starts. If it can't
   be added and the script asked for headers, the request fails
   instead of going out (see [Failure](#failure)).
4. **Fetch.** `fetch` gets only the passthrough headers. The browser
   applies the rule as the request leaves.
5. **Tear down.** The rule is removed as soon as `fetch` resolves —
   the headers are on the wire by then. `runXhr`'s `finally` is the
   backstop for the abort, timeout, and error paths.

A request that needs no overrides and no `Origin` removal — a plain
GET — installs no rule at all and goes out exactly as it did before
this existed.

## Why DNR and not webRequest

- MV3 removed blocking `webRequest`, so there is no callback that can
  edit a request in flight. DNR rules are data the browser evaluates
  itself, after our `fetch` call has handed the request over.
- That inverts the usual shape: we can't inspect a request and decide,
  only describe in advance which requests to rewrite and how.

## Targeting

The hard part. DNR must be told which requests a rule applies to, and
it cannot match on a request header — so the tag-your-own-traffic
approach that `webRequest` implementations use (Violentmonkey's
`VM-Verify` header) has nothing to key off.

What the rule matches instead:

- **The exact URL**, canonicalized the way `fetch` will canonicalize
  it. DNR matches the URL the browser requests, not the string the
  script wrote — see [Canonicalization](#canonicalization).
- **`tabIds: [-1]`** — "not associated with a tab", true of every
  extension-initiated request and of none of the user's page loads.
  Only session rules may use it, which is what these are.
- **`initiatorDomains: [<our extension id>]`** — narrows it further to
  requests this extension started, so a site's own service worker
  fetching the same URL doesn't pick the headers up. Verified with a
  negative control: a bogus initiator makes the header tests fail, so
  the condition is really evaluated and really does match us.

### Canonicalization

- `fetch` rewrites the URL before requesting it: a space becomes
  `%20`, a bare origin gains its `/`, scheme and host lowercase, a
  default port drops, non-ASCII is percent-encoded or punycoded.
- A rule built from the raw string then matches nothing, and the
  surgery silently doesn't happen — the failure mode a `Cookie`
  override can least afford.
- `canonicalizeUrlForRule` runs the URL through `new URL()` first and
  drops the fragment, which never leaves the browser.

### Literal matching

- `urlFilter` is a pattern language: `*` matches any run of
  characters, `^` any URL separator. Both are legal in a query string.
- A URL carrying either would widen the rule onto URLs the request
  never named, so those go through `regexFilter` with every
  metacharacter escaped. Ordinary URLs keep the cheaper `urlFilter`.

## Defaults

Only one header is touched without being asked:

- **`Origin` is removed**, on the methods that carry one. Ours would
  read `chrome-extension://<id>`, which tells the target nothing it
  should act on and advertises that the user runs SourceMonkey.
  Measured: a SW `fetch` sends it on POST, not on GET or HEAD.
- A caller-supplied `Origin` wins over the removal.

**`Sec-Fetch-Site` is deliberately not defaulted.** Claiming
`same-origin` defeats a cross-origin check the site put there on
purpose. A script that needs it asks for it; `@connect` is what makes
that the user's decision rather than ours.

## Failure

- If the rule can't be installed and the script asked for headers, the
  request is **not sent** — it fails with `The headers this request
  asked for could not be applied, so it was not sent`.
- Sending it anyway would be worse than an error: the script's
  `Cookie` wouldn't apply and the user's real session would go in its
  place, which is the opposite of what was asked.
- A rule that exists only to strip our own `Origin` falls back quietly
  — that one isn't the script's request.

## Rule lifetime

- Ids come from a counter in a reserved band (`XHR_RULE_ID_MIN` and
  up) that `clearStaleHeaderRules` sweeps at startup, so a worker
  killed mid-request can't leave a rule rewriting that URL for the
  rest of the browser session.
- `installHeaderRule` awaits that sweep. The sweep reads the rule list
  first, and a rule added during the read would be in its snapshot and
  get deleted while live.
- Installing also clears its own id first: `addRules` rejects a
  duplicate, and the counter wraps.

## Blind spots

- **Same-URL overlap.** Every matching rule applies, so two
  overlapping tab-less requests to one URL each pick up the other's
  headers — across scripts, not just within one. A script's hand-built
  `Cookie` can ride another script's request.
  - Headers the two rules don't share combine, so each request carries
    more than it asked for.
  - A header *both* set is written once by one of them; DNR doesn't
    say which wins between equal-priority rules, so it's a
    nondeterministic replacement rather than a merge.
  - Removing the rule at `fetch` resolution rather than after the body
    keeps the window as small as it can be without a discriminator DNR
    doesn't offer.
- **Redirects.** The rule matches the original URL, so a 30x hop goes
  out without the overrides and without the `Origin` removal. A
  `Cookie` override doesn't follow; the user's own cookies do.
- **SourceMonkey's own other fetches share the initiator.** The
  condition pins the rule to this extension, but collection and
  GitHub-API fetches are also this extension, so a script that races
  one at the same URL can attach headers to it. It can't read the
  response.

Tracked in [TODO.md](../TODO.md).
