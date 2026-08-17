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
3. **Gate.** Every request takes the per-URL gate — exclusively when
   it compiled a rule, shared otherwise — so no two rules for one URL
   are ever live together and no rule-less request runs under one.
   See [Same-URL serialization](#same-url-serialization).
4. **Install.** The rule is added before the fetch starts. If it can't
   be added and the script asked for headers, the request fails
   instead of going out (see [Failure](#failure)).
5. **Fetch.** `fetch` gets only the passthrough headers. The browser
   applies the rule as the request leaves.
6. **Tear down.** The rule is removed as soon as `fetch` resolves —
   the headers are on the wire by then — and only then does the gate
   open. `runXhr`'s `finally` is the backstop for the abort, timeout,
   and error paths.

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

## What ends a hold

Both the rule and the URL's gate come off in `runXhr`'s `finally`, so
every ordinary ending — success, error, `abort()`, `timeout` — releases
them. The cases worth naming are the ones where nothing ordinary
happens.

### The script sets no timeout

- `GM_xmlhttpRequest` has **no default `timeout`**, matching
  Tampermonkey and Violentmonkey. A script that omits it gets no timer,
  so nothing bounds a server that accepts the connection and never
  answers.
- A blanket default would be the wrong fix: it would also kill slow but
  healthy transfers, and the response-size cap allows bodies large
  enough to legitimately take minutes.
- What actually needs bounding is the **header phase**, since that is
  all the rule and the gate ever wait on — both are released the moment
  `fetch` resolves, so a slow body holds neither.
- So `XHR_HEADER_STALL_MS` (2 minutes) covers time-to-first-byte only
  and is cleared as soon as headers arrive. It reports an error rather
  than a timeout, because the script never asked for one.
- It is armed **after** the URL's gate is held, not when the request is
  created. Time spent queued behind another request is not the server
  being slow, and a message naming the server for it would blame the
  wrong party.
- It sits below the page-side `XHR_PAGE_SIDE_TTL_MS` (5 minutes) so
  that when both could report, the worker's more specific message wins.
  Keep that ordering if either changes.
- **Best-effort, not guaranteed.** An MV3 worker is torn down after
  roughly 30s idle, and a pending `fetch` does not by itself keep it
  alive — a wedged request with no other extension activity is exactly
  the shape that gets the worker killed first. Then the timer dies with
  it and the page's own TTL reports instead. The backstop earns its
  keep when other activity holds the worker up; it is not the only net.

### The tab closes

- `chrome.tabs.onRemoved` cancels that tab's in-flight requests
  (`abortXhrsForTab`). Nothing else can: the page is gone, so no
  terminal event can be delivered and no one is waiting for the body.
- Without it the fetch runs to completion in the worker, holding its
  rule live and its URL's gate shut against other scripts for as long
  as the server keeps the connection open.
- This is unlike `GM_download`, where a transfer the user started is
  deliberately left running.

### The worker dies

- The gate is worker memory, so it goes with the worker — nothing to
  clean up.
- The rule outlives it, and `clearStaleHeaderRules` sweeps the band at
  the next startup.
- A stranded rule is inert in the meantime: it requires `tabIds: [-1]`
  plus our own initiator, and a dead worker issues no such requests
  (extension pages have real tab ids).
- **Every** request waits for that sweep, not just the ones installing
  a rule. A stale rule matches by URL, so a request with no rule of its
  own is exactly as exposed to it; after the first sweep the wait is an
  already-resolved promise.

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

## Same-URL serialization

### The hazard

- A rule matches by URL, so it rewrites *every* same-URL request of
  ours — not only the one that installed it.
- Two overlapping requests to one URL would each pick up the other's
  headers, across scripts rather than just within one.
- A script's hand-built `Cookie` riding another script's request is a
  credential leak, not a cosmetic wrong-`Referer` bug.

### Why a gate instead of a narrower rule

- DNR cannot match a request header, and two same-URL requests from
  this extension are identical in every field a condition can test.
- With no discriminator to add, the remaining move is to prevent the
  overlap rather than describe our way out of it.

#### Why not put a unique id in the URL

The tempting version: fetch `…?__sm=<nonce>`, key the rule on that —
a perfect per-request discriminator — and have DNR strip the nonce
again so the server never sees it. It doesn't survive contact with how
DNR applies actions.

- **Stripping means redirecting, and a redirect drops the headers.**
  One rule has one action, so the strip has to be a second `redirect`
  rule. Measured with a two-rule probe (redirect the nonce'd URL to
  the clean one, `modifyHeaders` on the nonce'd URL): the redirect
  fires and the nonce never reaches the server, but the header arrives
  **absent**. A redirected request is a new request, evaluated afresh,
  and the modifications matched against the old URL don't come with
  it. This is the same mechanism as the [redirect blind
  spot](#blind-spots).
- **The discriminator vanishes exactly where it's needed.** Even had
  the headers survived, the post-redirect request is on the *clean*
  URL, so its rule would have to be keyed on the clean URL — the
  non-unique key the nonce was invented to replace.
- **Not stripping is worse.** Leave the nonce in and the headers do
  apply, but the script no longer gets the request it asked for: the
  nonce reaches the server, breaking signed URLs, exact-match routes,
  and cache keys.

### How it works

- `acquireHeaderGate` in `gm-xhr-headers.ts` is a per-URL gate, keyed
  on the same canonical URL the rule matches.
- A request carrying **script-supplied** forbidden headers holds it
  **exclusively**. Everything else holds it **shared** — any number
  together — so no rule can appear under them either.
- Shared covers the rule-less requests *and* the ones whose only rule
  is our own `Origin` removal. Those rules are interchangeable (each
  says nothing but "remove origin"), and the only rule-less methods are
  GET and HEAD, which carry no `Origin` for one to strip. So ordinary
  POSTs to one endpoint still run concurrently; gating on "has a rule"
  would have serialized them to remove a header nobody asked about.
- Grants are strictly FIFO, so plain requests can't starve a surgical
  one or slip in front of a rule that was already waiting to exist.
- The gate is keyed on the **whole URL**, not the host. Requests to
  different paths or query strings on one site never wait for each
  other; a site's requests are as parallel as they ever were.
- A hold ends when `fetch` resolves — when the server's response
  *headers* arrive, not when the body finishes — so what a same-URL
  queue costs is one time-to-first-byte per request ahead of it. The
  body streams after the gate has already reopened.
- The gate is worker memory, so a killed worker can't strand it; the
  stranded *rules* are what the startup sweep handles.
- An abort or timeout that lands while a request is still queued drops
  it out of the queue and answers it immediately. Without that, a
  waiter's own `timeout` would be bounded by whatever the request ahead
  of it was waiting on — the holder, not the script, would decide when
  `ontimeout` fired.

What a script sees: overlapping same-URL requests where one sets
forbidden headers go out one at a time, each carrying exactly its own —
with one residual, below.

### When the guarantee can still break

- The gate opens after the rule is removed, but `removeHeaderRule`
  cannot force the removal: if `updateSessionRules` fails twice it logs
  and gives up, and the URL reopens with the rule still live.
- The next same-URL request would then run under it — the leak the gate
  exists to close, now quiet. Nothing can retry it back into existence,
  and holding the URL shut forever would be worse.
- It needs `declarativeNetRequest` itself to be failing, so in practice
  the extension is already broken; the stranded rule is cleared by the
  next startup sweep.

### The cost

- A request that hangs holds its URL's gate until it settles, so other
  same-URL requests wait behind it — the *holder's* own `timeout` is
  what bounds that, and it may not have one.
- A waiter is never at the holder's mercy for its own terminal event,
  though: its `timeout` (or an `abort()`) takes it out of the queue on
  its own clock.
- The same hang used to leave a live rule contaminating those requests
  instead, so this trades a wrong-headers bug for a delay.

## Blind spots

- **Redirects.** The rule matches the original URL, so a 30x hop goes
  out without the overrides and without the `Origin` removal. A
  `Cookie` override doesn't follow; the user's own cookies do.
- **SourceMonkey's own other fetches share the initiator.** The
  condition pins the rule to this extension, but collection and
  GitHub-API fetches are also this extension — and they don't take the
  gate — so a script that races one at the same URL can attach headers
  to it. It can't read the response.

Tracked in [TODO.md](../TODO.md).
