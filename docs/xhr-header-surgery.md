# XHR header surgery

How `GM_xmlhttpRequest` sets request headers the browser forbids a
script to set. Code: `src/extension/gm-xhr-headers.ts`, driven from
`src/extension/gm-xhr.ts`.

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
   method carries one. The rule is keyed on the request's *tagged*
   URL — see [Targeting](#targeting).
3. **Install.** The rule is added before the fetch starts. If it can't
   be added and the script asked for headers, the request fails
   instead of going out (see [Failure](#failure)).
4. **Fetch.** `fetch` gets the tagged URL and only the passthrough
   headers. The browser applies the rule as the request leaves.
5. **Tear down.** The rule is removed as soon as `fetch` resolves —
   the headers are on the wire by then. `runXhr`'s `finally` is the
   backstop for the abort, timeout, and error paths.

A request that needs no overrides and no `Origin` removal — a plain
GET — installs no rule at all, keeps its URL untagged, and goes out
exactly as it did before this existed.

## Why DNR and not webRequest

- MV3 removed blocking `webRequest`, so there is no callback that can
  edit a request in flight. DNR rules are data the browser evaluates
  itself, after our `fetch` call has handed the request over.
- That inverts the usual shape: we can't inspect a request and decide,
  only describe in advance which requests to rewrite and how.

## Targeting

A rule has to name the requests it applies to, and it must name
*exactly one* — the request that installed it. DNR cannot match on a
request header, so the tag-your-own-traffic approach a `webRequest`
implementation uses has nothing to key off.

The discriminator is a tag in the URL's **fragment**:

- The request goes out as `<canonical url>#sm-xhr-<rule id>`, and the
  rule matches that whole string.
- A fragment is never transmitted, so the server receives the URL the
  script asked for, byte for byte. `Response.url` drops it too, so
  `finalUrl` and the `@connect` redirect re-check are unaffected.
- The rule id doubles as the tag, so a request and its rule can't
  disagree about which one it is.
- Whatever fragment the script put on its own URL is replaced — for
  the same reasons, nothing observable depended on it.

Two conditions narrow it further. Neither is needed, since nothing
else asks for that tag, but they bound the damage if one ever escaped:

- **`tabIds: [-1]`** — "not associated with a tab", true of every
  extension-initiated request and of none of the user's page loads.
  Only session rules may use it, which is what these are.
- **`initiatorDomains: [<our extension id>]`** — requests this
  extension started. Verified with a negative control: a bogus
  initiator makes the header tests fail, so the condition really is
  evaluated and really does match us.

### That DNR matches fragments at all was measured

Chrome's documentation doesn't settle it, so a probe did, for a
service-worker `fetch` specifically:

| rule URL | request URL | rule applies |
|---|---|---|
| `/x` | `/x` | yes |
| `/x#a` | `/x#a` | yes |
| `/x#a` | `/x` | no |
| `/x` | `/x#a` | no |
| `/x#a` | `/x#b` | no |

The fragment is matched literally, in both directions — which is what
makes it a discriminator rather than a decoration. The server saw `/x`
in every case.

Prior art: Violentmonkey's MV3 path keys its XHR rule the same way
(`<url>#<request id>`, with `tabIds` alone), and its Firefox path
correlates `webRequest` callbacks by the same fragment.

- VM discriminates by `tabIds: [-1]` rather than `initiatorDomains`
  because its request comes from its offscreen document, not the
  worker — the offscreen `XMLHttpRequest` is how VM gets binary
  responses under MV3.
- Same session-rule shape otherwise: one rule per in-flight request,
  `modifyHeaders` for the forbidden and UA headers, removed in the
  request's cleanup path. VM also uses it for `anonymous`, dropping
  `Cookie` on the way out and `Set-Cookie` on the way back.

### Canonicalization

- `fetch` rewrites the URL before requesting it: a space becomes
  `%20`, a bare origin gains its `/`, scheme and host lowercase, a
  default port drops, non-ASCII is percent-encoded or punycoded.
- A rule built from the raw string then matches nothing, and the
  surgery silently doesn't happen — the failure mode a `Cookie`
  override can least afford.
- `taggedRequestUrl` runs the URL through `new URL()` and stamps the
  tag on the result, and `runXhr` fetches *that* string. The URL the
  request uses and the URL the rule matches are one value, not two
  computations that have to agree.

### Literal matching

- `urlFilter` is a pattern language: `*` matches any run of
  characters, `^` any URL separator. Both are legal in a query string.
- A URL carrying either would widen the rule past the one request that
  named it, so those go through `regexFilter` with every metacharacter
  escaped. Ordinary URLs keep the cheaper `urlFilter`.

### Why the fragment and not a query nonce

`…?__sm=<nonce>` would discriminate just as well, but the nonce
reaches the server — breaking signed URLs, exact-match routes, and
cache keys. Stripping it again doesn't work:

- **Stripping means redirecting, and a redirect drops the headers.**
  One rule has one action, so the strip has to be a second `redirect`
  rule. Measured with a two-rule probe: the redirect fires and the
  nonce never reaches the server, but the header arrives **absent**. A
  redirected request is a new request, evaluated afresh, and
  modifications matched against the old URL don't come with it — the
  same mechanism as the [redirect blind spot](#blind-spots).
- **The discriminator vanishes exactly where it's needed.** Even had
  the headers survived, the post-redirect request is on the *clean*
  URL, so its rule would have to be keyed on the clean URL — the
  non-unique key the nonce was invented to replace.

A fragment needs no stripping at all, which is what makes it work.

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

## Same-URL overlap

- A rule keyed on the URL alone would rewrite *every* same-URL request
  of ours, not only the one that installed it.
- Two overlapping requests would each pick up the other's headers,
  across scripts rather than within one — and a hand-built `Cookie`
  riding another script's request is a credential leak, not a cosmetic
  wrong-`Referer` bug.
- The URL tag closes that: each rule names one request. Nothing waits
  on anything; overlapping requests to one URL run concurrently, each
  carrying only its own headers.
- The e2e coverage is two overlapping POSTs. Confirmed to be a real
  test rather than a passing one: with the tag removed, the first
  request picks up the second's `Referer`.
- Easy to mistake for our doing, and isn't: Chrome's HTTP cache takes a
  single-writer lock per cache key, so two identical concurrent **GET**s
  are serialized by the browser regardless (measured 800ms / 1600ms for
  a pair of 800ms requests). POSTs aren't cached and aren't affected.

## What ends a rule

The rule comes off when `fetch` resolves, with `runXhr`'s `finally` as
the backstop, so every ordinary ending — success, error, `abort()`,
`timeout` — releases it. The cases worth naming are the ones where
nothing ordinary happens.

### The script sets no timeout

- `GM_xmlhttpRequest` has **no default `timeout`**, matching
  Tampermonkey and Violentmonkey. A script that omits it gets no timer,
  so nothing bounds a server that accepts the connection and never
  answers.
- A blanket default would be the wrong fix: it would also kill slow but
  healthy transfers, and the response-size cap allows bodies large
  enough to legitimately take minutes.
- What actually needs bounding is the **header phase**, since that is
  all the rule ever waits on — it comes off the moment `fetch`
  resolves, so a slow body holds nothing.
- So `XHR_HEADER_STALL_MS` (2 minutes) covers time-to-first-byte only
  and is cleared as soon as headers arrive. It reports an error rather
  than a timeout, because the script never asked for one.
- It sits below the page-side `XHR_PAGE_SIDE_TTL_MS` (5 minutes) on
  purpose, so the worker reports a wedged request instead of racing the
  page's own giving-up. Keep that ordering if either changes.

### The tab closes

- `chrome.tabs.onRemoved` cancels that tab's in-flight requests
  (`abortXhrsForTab`). Nothing else can: the page is gone, so no
  terminal event can be delivered and no one is waiting for the body.
- Without it the fetch runs to completion in the worker, holding its
  rule live for as long as the server keeps the connection open.
- This is unlike `GM_download`, where a transfer the user started is
  deliberately left running.

### The worker dies

- The rule outlives it, and `clearStaleHeaderRules` sweeps the band at
  the next startup.
- The tag does **not** make it inert on its own: the id counter
  restarts at `XHR_RULE_ID_MIN` in each worker life, so the next worker
  hands out that tag again.
- What keeps it harmless is the install path. `installHeaderRule` waits
  for the sweep, and then adds its rule in the same `updateSessionRules`
  call that clears its own id — so even a sweep that failed can't leave
  a colliding rule live.
- Rule-*less* requests (plain GET/HEAD) don't need the wait: they go
  out untagged, and a stranded rule always carries a tag.
- The wait is also why the sweep can't delete a live rule: a rule added
  during its read of the rule list would be in its snapshot.

### The removal itself fails

- `removeHeaderRule` retries once and then logs and gives up; nothing
  can force a removal.
- The consequence is now small: the stranded rule matches a tag no
  request will use again, so it rewrites nothing. It holds an id until
  the next startup sweep, and the counter's band is wide enough that
  this doesn't matter.

## Rule lifetime

- Ids come from a counter in a reserved band (`XHR_RULE_ID_MIN` and
  up) that `clearStaleHeaderRules` sweeps at startup, so a worker
  killed mid-request can't leave rules accumulating for the rest of the
  browser session.
- The id is also the URL tag, so "unique among live rules" and "unique
  among live requests" are one property rather than two — within a
  worker life. Across worker lives the counter restarts; see
  [The worker dies](#the-worker-dies).
- Installing clears its own id first: `addRules` rejects a duplicate,
  and the counter wraps.

## Blind spots

- **Redirects.** The rule matches the original URL, so a 30x hop goes
  out without the overrides and without the `Origin` removal. A
  `Cookie` override doesn't follow; the user's own cookies do.
  - The tag *does* follow — a redirect target with no fragment of its
    own inherits the request's — so a hop that lands back on the
    original URL re-matches the still-live rule and does get the
    overrides. Still invisible to servers either way.

Tracked in [TODO.md](../TODO.md).
