// Request-header surgery for `GM_xmlhttpRequest`.
//
// The problem: `fetch()` silently drops any header the Fetch Standard
// (the web standard defining `fetch`, at fetch.spec.whatwg.org) calls
// a *forbidden request header* — `Origin`, `Referer`, `Cookie`,
// `Host`, `User-Agent`, and everything with a `Sec-` or `Proxy-`
// prefix. A userscript that needs one of those (and userscripts do:
// sites gate APIs on `Sec-Fetch-Site`, `Referer`, or a hand-built
// `Cookie`) has no way to set it from JS at all — the restriction
// applies in the service worker exactly as it does on a page.
//
// The fix, and why it looks like this:
//
//   - Manifest V3 has no blocking `webRequest`, so headers can only be
//     rewritten by `declarativeNetRequest` (DNR — Chrome's rule-based
//     request-rewriting API). Rules are data, evaluated by the browser
//     after our `fetch` call has already handed the request over.
//   - So the caller's forbidden headers are *not* passed to `fetch`.
//     They're compiled into a short-lived DNR session rule that sets
//     them on the way out, and the rule is torn down when the request
//     settles.
//   - DNR cannot match on a request header, so the rule can't be
//     targeted by a tag we invent. It's targeted by what is actually
//     distinctive about our request instead: the exact URL, plus
//     `tabIds: [-1]` — "no tab", which is every extension-initiated
//     request and no page request. `tabIds` is only allowed on session
//     rules, which is what we use.
//
// What that targeting can't separate: two of our own requests to the
// same URL, in flight at once. Every rule matching a request applies,
// so an overlapping request would pick up headers meant for the other
// one — across scripts, not just within one, and a hand-built `Cookie`
// riding another script's request is a credential leak. DNR offers no
// discriminator two same-URL extension requests differ by, so instead
// of narrowing the rule the overlap itself is prevented:
// `acquireHeaderGate` (bottom of this file) serializes rule-holding
// requests per URL, and rule-less requests to that URL wait for the
// rule to come off. The rule is still removed as soon as `fetch`
// resolves — the headers are on the wire by then — so the gate holds
// for response-header latency, not body-download time.
//
// What the gate cannot cover is a same-URL, same-initiator fetch that
// never takes it — SourceMonkey's own collection and API fetches. See
// "Blind spots" in docs/xhr-header-surgery.md.

// Headers `fetch()` refuses to send. Close to the Fetch Standard's
// forbidden-request-header list, but the authority here is what Chrome
// actually drops, which is not the same set: `user-agent` came off the
// spec list and Chrome still drops it, so it stays. Prefix rules
// (`Sec-`, `Proxy-`) are handled separately in `isForbiddenHeader`.
//
// Routing a header here means a script can now genuinely set it —
// including framing headers like `content-length` and
// `transfer-encoding`, which `fetch` used to swallow harmlessly. That
// is the same latitude Tampermonkey gives, and the script asked.
//
// `Cookie` is on the list but deliberately absent here — see
// `COOKIE_HEADER` below.
const FORBIDDEN_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'permissions-policy',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
  // Forbidden only when the value names a forbidden method, but
  // `fetch` won't carry them dependably either way, so they take the
  // rule path unconditionally.
  'x-http-method',
  'x-http-method-override',
  'x-method-override',
]);

// `Cookie` needs the same surgery but has an extra consequence: a
// script-supplied Cookie replaces what the browser would have sent, so
// setting it is also a way to *drop* the user's session. Kept separate
// so callers can reason about it on its own.
const COOKIE_HEADER = 'cookie';

// Whether `fetch()` would refuse to send this header, so it has to go
// through a DNR rule instead.
export function isForbiddenHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (FORBIDDEN_HEADERS.has(lower) || lower === COOKIE_HEADER) return true;
  // Prefix rules. `Sec-` is the one that matters most in practice:
  // `Sec-Fetch-Site` is how a server tells a page request from an
  // extension one, and a service worker always sends `none` — a value
  // no page can produce, which some WAFs (web application firewalls —
  // the filtering layer in front of a site) reject outright.
  return lower.startsWith('sec-') || lower.startsWith('proxy-');
}

// A caller's headers, split by how each one has to travel.
export interface SplitHeaders {
  // Safe to hand `fetch` directly.
  passthrough: Record<string, string>;
  // Need a DNR rule. Names are lowercased — DNR matches case-insensitively
  // and lowercase is what Chrome echoes back.
  surgical: Record<string, string>;
}

// Header names are case-insensitive, so a caller passing both `Origin`
// and `origin` collapses to one surgical entry and the last one wins.
// Object key order is the caller's own, and either value is a thing
// they asked for, so there's nothing better to pick.
export function splitHeaders(headers: Record<string, string> | undefined): SplitHeaders {
  const passthrough: Record<string, string> = {};
  const surgical: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (isForbiddenHeader(name)) surgical[name.toLowerCase()] = value;
    else passthrough[name] = value;
  }
  return { passthrough, surgical };
}

// The one header we change without being asked: `Origin`, which
// `fetch` from the service worker stamps as `chrome-extension://<id>`.
// That tells the target nothing it should act on and advertises that
// the user runs SourceMonkey, so it comes off.
//
// Only on methods that would carry one. Measured: a SW `fetch` sends
// `Origin` on POST and not on GET, so defaulting it for every request
// would install a rule per request to remove a header that isn't
// there — a declarativeNetRequest round trip each way, on the most
// common shape of request there is.
//
// Nothing else is defaulted. In particular `Sec-Fetch-Site` is left at
// the `none` the browser supplies: setting it to `same-origin` defeats
// a site's cross-origin check, and that is a thing a script should have
// to ask for rather than something every request quietly does. A script
// that needs it passes it in `headers` like any other.
const ORIGIN_LESS_METHODS = new Set(['GET', 'HEAD']);

function defaultRemovedHeaders(method: string): string[] {
  return ORIGIN_LESS_METHODS.has(method.toUpperCase()) ? [] : ['origin'];
}

// `urlFilter` is a pattern language, not a literal: `*` matches any
// run of characters and `^` matches any URL separator. A URL carrying
// either — legal in a query string — would silently widen the rule to
// other URLs, and the headers meant for one request would be applied
// to somebody else's. `|` is special only at the ends, where we put
// our own anchors, so an embedded one is already literal.
//
// URLs with a metacharacter go through `regexFilter` instead, where
// everything can be escaped exactly. Ordinary URLs keep the cheaper
// `urlFilter` path.
function hasUrlFilterMetacharacter(url: string): boolean {
  return url.includes('*') || url.includes('^');
}

// Escape for DNR's regexFilter (RE2). Every character that could be
// regex syntax is backslash-escaped, so the pattern matches the URL and
// nothing else. `/` is deliberately absent — it isn't syntax in RE2
// (there are no delimiters to close) and `\/` is what a stricter engine
// would reject.
function escapeForRegexFilter(url: string): string {
  return url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The URL as the browser will actually request it, which is what DNR
// matches against — not the string the script passed. `fetch`
// canonicalizes first: a space becomes `%20`, a bare origin gains its
// `/`, scheme and host lowercase, a default port drops, non-ASCII is
// percent-encoded or punycoded. Matching the raw string means the rule
// silently fails to apply, which for a `Cookie` override is worse than
// an error — the user's real session goes out in place of the one the
// script asked for.
//
// The fragment is dropped: it never leaves the browser, so a rule
// carrying one could never match.
//
// A URL `new URL()` can't parse is handed back unchanged; `fetch` is
// about to reject it anyway, and the request never reaches the wire.
export function canonicalizeUrlForRule(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url;
  }
}

// This extension's id, which is the "domain" of a request it starts.
// Guarded because the rule builder is also exercised outside an
// extension (unit tests); without an id the rule keeps the broader
// `tabIds` condition alone rather than failing to build.
function selfInitiatorDomain(): string | undefined {
  return typeof chrome !== 'undefined' ? chrome.runtime?.id : undefined;
}

// One request's compiled rule. `id` is the DNR session-rule id, held so
// the rule can be removed once the request settles.
export interface HeaderRuleSpec {
  id: number;
  // The canonical URL the rule matches on. Handed back so the caller's
  // same-URL gate can key on the identical string rather than
  // recomputing it and trusting the two to agree.
  target: string;
  rule: chrome.declarativeNetRequest.Rule;
}

// DNR session-rule ids. Rule 1 belongs to the install capture
// (`install-capture.ts`), so XHR rules start above it and climb.
//
// Everything from XHR_RULE_ID_MIN up is this module's band —
// `clearStaleHeaderRules` deletes any session rule in it at startup, so
// a future subsystem that wants its own session rule must stay below.
//
// Ids only have to be unique among *live* rules and each is released
// when its request settles, so the counter wraps. A collision needs
// ~999,000 requests in flight at once, or a stranded rule the sweep
// never reached; `installHeaderRule` clears the id before reusing it so
// neither turns into a failed install. That clear is not free of
// consequence, though: if the id really were still live, its request
// loses its overrides silently — so the band is sized to keep the wrap
// unreachable rather than to make the collision survivable.
const XHR_RULE_ID_MIN = 1000;
const XHR_RULE_ID_MAX = 1_000_000;
let nextRuleId = XHR_RULE_ID_MIN;

export function allocateRuleId(): number {
  const id = nextRuleId;
  nextRuleId = id >= XHR_RULE_ID_MAX ? XHR_RULE_ID_MIN : id + 1;
  return id;
}

// Drop any XHR header rule left over from a previous service-worker
// life. Rules come off in `runXhr`'s `finally`, but a worker killed
// mid-request never reaches it, and a session rule outlives the worker
// — it would go on rewriting requests to that URL for the rest of the
// browser session. Called once at startup, when no XHR can be in
// flight yet.
let staleSweep: Promise<void> | null = null;

// Resolves once the startup sweep has finished (immediately if it was
// never started). `installHeaderRule` waits on this so the sweep can't
// delete a rule added while it was reading the rule list.
export function whenStaleRulesCleared(): Promise<void> {
  return staleSweep ?? Promise.resolve();
}

export function clearStaleHeaderRules(): Promise<void> {
  staleSweep = runStaleSweep();
  return staleSweep;
}

async function runStaleSweep(): Promise<void> {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr) return;
  try {
    const rules = await dnr.getSessionRules();
    const stale = rules.filter((r) => r.id >= XHR_RULE_ID_MIN).map((r) => r.id);
    if (stale.length > 0) await dnr.updateSessionRules({ removeRuleIds: stale });
  } catch (err) {
    console.info('[SourceMonkey] could not clear stale GM_xmlhttpRequest header rules', err);
  }
}

// Build the session rule that applies `surgical` to the request for
// `url`. Returns null when there's nothing to do — no overrides and
// nothing to remove — so the common request costs no rule at all.
export function buildHeaderRule(
  url: string,
  surgical: Record<string, string>,
  method = 'GET',
): HeaderRuleSpec | null {
  const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [];
  for (const [header, value] of Object.entries(surgical)) {
    requestHeaders.push({
      header,
      value,
      operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
    });
  }
  for (const header of defaultRemovedHeaders(method)) {
    // A caller-supplied value wins over the default removal.
    if (header in surgical) continue;
    requestHeaders.push({
      header,
      operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation,
    });
  }
  if (requestHeaders.length === 0) return null;
  const target = canonicalizeUrlForRule(url);
  const initiator = selfInitiatorDomain();
  const id = allocateRuleId();
  return {
    id,
    target,
    rule: {
      id,
      // Constant, and it does not arbitrate between our own rules:
      // where two live rules match one request, Chrome applies both,
      // and for a header they both set it picks one unspecified
      // winner. See the same-URL hazard in the file header.
      priority: 1,
      action: {
        type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders,
      },
      condition: {
        // `|` anchors mean "the whole URL, exactly"; `^…$` is the
        // regex equivalent for URLs that can't use urlFilter safely.
        ...(hasUrlFilterMetacharacter(target)
          ? { regexFilter: `^${escapeForRegexFilter(target)}$` }
          : { urlFilter: `|${target}|` }),
        isUrlFilterCaseSensitive: true,
        // Two narrowings, both needed. `tabIds: [-1]` is "not
        // associated with a tab", which every extension request is and
        // no page load is; `initiatorDomains` then pins it to requests
        // this extension started, so a site's own service worker
        // fetching the same URL can't pick the headers up.
        //
        // Verified rather than assumed: with a bogus initiator the
        // header e2e tests fail, so the condition really is evaluated
        // and really does match us.
        //
        // What neither separates is SourceMonkey's own other fetches —
        // collections, the GitHub API — which share this initiator.
        tabIds: [-1],
        ...(initiator ? { initiatorDomains: [initiator] } : {}),
        resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Same-URL gate.
//
// A live header rule rewrites *every* matching same-URL request of
// ours, not just the one that installed it — and a request with no rule
// of its own is just as exposed as one with a different rule. So every
// XHR takes a per-URL gate before it fetches:
//
//   - A request carrying script-supplied forbidden headers holds the
//     URL *exclusively*: nothing else to that URL runs while its rule
//     is live, because its rule would rewrite whatever did.
//   - Everything else holds it *shared*: any number run together.
//
// Shared covers two kinds of request, and the second is the subtle one:
//
//   - No rule at all (a plain GET or HEAD).
//   - A rule that only removes our own `Origin` — every POST/PUT/… with
//     no headers of its own gets one. Those rules are *interchangeable*:
//     each says nothing but "remove origin", so one applying to another
//     such request does exactly what that request's own rule does. They
//     are harmless to a rule-less request too, since the only rule-less
//     methods are GET and HEAD, which carry no `Origin` to remove.
//
// Classifying those as shared is what keeps ordinary POSTs concurrent —
// gating on "has a rule" instead would serialize every POST to a URL to
// strip a header nobody asked about.
//
// Grants are strictly FIFO — a shared request arriving behind a queued
// exclusive one waits — so a stream of plain requests can't starve an
// override, and (more important) can't slip in under a rule that was
// already waiting to exist when they arrived.
//
// A hold ends when the request's headers are known to be on the wire
// and its rule (if any) is off — `fetch` resolving — so a same-URL
// wait costs response-header latency, not body-download time. The
// `finally` in `runXhr` releases on the abort/timeout/error paths. A
// worker killed mid-request takes the whole gate map with it, so
// unlike the DNR rules there is nothing to sweep.

interface GateWaiter {
  exclusive: boolean;
  grant: () => void;
  // Drops this waiter if it is still queued. Used when its request is
  // aborted, so a dead request neither delays the queue behind it nor
  // takes a turn it can't use.
  cancel: () => void;
}

interface UrlGate {
  sharedHolders: number;
  exclusiveHeld: boolean;
  waiters: GateWaiter[];
}

const urlGates = new Map<string, UrlGate>();

// Acquire the gate for `url` — the *canonical* URL
// (`canonicalizeUrlForRule`), the same string the rule matches on, so
// two spellings of one URL can't land on different gates.
//
// Resolves to a release function; releasing twice is a no-op. Resolves
// to `null` instead if `signal` aborts before the turn comes: a queued
// request whose caller gave up has no reason to wait out the queue, and
// waiting would hold its `ontimeout` until the holder ahead finished —
// a wait its own `timeout` is supposed to bound.
export function acquireHeaderGate(
  url: string,
  exclusive: boolean,
  signal?: AbortSignal,
): Promise<(() => void) | null> {
  if (signal?.aborted) return Promise.resolve(null);
  let gate = urlGates.get(url);
  if (!gate) {
    gate = { sharedHolders: 0, exclusiveHeld: false, waiters: [] };
    urlGates.set(url, gate);
  }
  const g = gate;
  const admit = (): (() => void) => {
    if (exclusive) g.exclusiveHeld = true;
    else g.sharedHolders += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (exclusive) g.exclusiveHeld = false;
      else g.sharedHolders -= 1;
      pumpGate(url, g);
    };
  };
  // Jumping the queue would let a shared request run under a rule that
  // was already waiting to install, so the gate must be free AND nobody
  // may be ahead of us.
  const free = exclusive
    ? !g.exclusiveHeld && g.sharedHolders === 0
    : !g.exclusiveHeld;
  if (free && g.waiters.length === 0) return Promise.resolve(admit());
  return new Promise((resolve) => {
    let settled = false;
    const waiter: GateWaiter = {
      exclusive,
      grant: () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(admit());
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(null);
      },
    };
    function onAbort(): void {
      const at = g.waiters.indexOf(waiter);
      if (at >= 0) g.waiters.splice(at, 1);
      waiter.cancel();
      // Dropping a waiter can unblock the ones behind it — an exclusive
      // waiter leaving lets queued shared requests through.
      pumpGate(url, g);
    }
    g.waiters.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Admit whoever the head of the queue allows: one exclusive waiter
// alone, or every consecutive shared waiter up to the next exclusive
// one. Runs after each release; deletes the map entry once the gate is
// idle so the map only ever holds in-flight URLs.
function pumpGate(url: string, gate: UrlGate): void {
  while (gate.waiters.length > 0) {
    const head = gate.waiters[0];
    if (head.exclusive) {
      if (gate.exclusiveHeld || gate.sharedHolders > 0) break;
      gate.waiters.shift();
      head.grant();
      break;
    }
    if (gate.exclusiveHeld) break;
    gate.waiters.shift();
    head.grant();
  }
  if (!gate.exclusiveHeld && gate.sharedHolders === 0 && gate.waiters.length === 0) {
    // By key *and* identity: deleting by key alone would be correct
    // only as long as every acquire leaves a holder or a waiter behind,
    // and a stale gate object silently sharing a URL is the exact leak
    // this whole mechanism exists to prevent.
    if (urlGates.get(url) === gate) urlGates.delete(url);
  }
}
