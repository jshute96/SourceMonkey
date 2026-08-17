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
// What that targeting can't separate: two tab-less requests to the same
// URL, in flight at once. Every rule matching a request applies, so a
// request picks up headers meant for the other one — and that is
// across scripts, not just within one. (A header both rules set is
// written once, by whichever DNR picks between equal priorities.) A script's hand-built `Cookie` can end
// up on another script's overlapping request to the same URL. Both
// scripts need `@connect` for the host and the requests have to
// overlap, but it is a credential leak, not a cosmetic one.
//
// The window is held to the minimum available: the rule comes off as
// soon as `fetch` resolves — the headers are on the wire by then —
// rather than after the body has been read, so a slow download no
// longer keeps a rule live. Closing it properly needs a discriminator
// DNR can match on, which for request headers it does not have.

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
// neither turns into a failed install.
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
