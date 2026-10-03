// `@connect` URL gating for `GM_xmlhttpRequest`.
//
// @connect grammar (following Tampermonkey's docs):
//   - `*` — wildcard, allow any host.
//   - `self` — the script's own hosts: the requesting page's host,
//     plus the hosts its @match / @include patterns name.
//   - `example.com` — that host OR any subdomain of it
//     (`api.example.com`), as Tampermonkey documents. A label-boundary
//     match: `evilexample.com` does not match. IP addresses and
//     single-label names (`127.0.0.1`, `localhost`, `com`) match only
//     exactly, so a bare rule can't stand for a whole TLD or IP range.
//     Multi-label public suffixes (`co.uk`) are not special-cased.
//   - `*.example.com` — `example.com` itself OR any subdomain.
//
// SW-side validation: when a script issues `GM_xmlhttpRequest`, the
// SW pulls the script's stored header, parses out the `@connect`
// lines, and rejects the request if the URL's host doesn't satisfy
// any of them.
//
// ## Default policy
//
// Requests to the **requesting document's own `http(s)` origin** are
// always allowed, `@connect` or not. That request is not a
// cross-origin escape: the page can already reach that URL itself
// with plain `fetch` / `XMLHttpRequest`. (Our SW-side fetch isn't a
// byte-for-byte stand-in — cookies are SW-managed, the page's CSP
// `connect-src` doesn't apply, and a script may override request
// headers a page cannot set at all (`gm-xhr-headers.ts`) — but it
// reaches no origin the page couldn't.) TM does the same (its `self`
// is implicit since TM 4 — Tampermonkey/tampermonkey#283).
//
// Everything else needs a rule:
//   - Rules declared and none match → deny.
//   - No `@connect` at all → deny.
//
// ## Why not just allow undeclared scripts (what the other managers do)
//
//   - **TM** prompts the user per host and remembers the answer in a
//     per-script allowlist. Faithful parity needs a consent UI we
//     don't have yet — see `TODO.md` "@connect follow-ups".
//   - **VM** doesn't implement `@connect` at all
//     (violentmonkey/violentmonkey#947 is still open), so every host
//     is reachable silently.
//
// Blocking by default keeps the trust model intact for the scripts
// that never asked for cross-origin reach. There is deliberately no
// blanket "allow everything" switch: a script here is a file the user
// edits, and the denial names the `// @connect <host>` line to add,
// which is narrower than any global override could be. The escape
// hatch for a script the user can't edit (one synced from a
// collection, where a refresh would clobber the change) is per-script
// and still to be built — see `TODO.md`.

import { getValues, type ParsedHeader } from './userscript-header.js';

// Each entry is one parsed @connect line.
export interface ConnectRule {
  // `host` is a bare host (`example.com`) and `subdomain` a
  // `*.example.com` form. Both match the host and its subdomains,
  // except that a bare IP or single-label `host` matches only exactly.
  kind: 'wildcard' | 'self' | 'host' | 'subdomain';
  // For `host` and `subdomain`, the host (lowercased). Missing
  // otherwise.
  host?: string;
}

// Lower-case, normalize, classify a single raw @connect value.
// Returns null for empty / malformed entries.
export function parseConnectEntry(raw: string): ConnectRule | null {
  const t = raw.trim().toLowerCase();
  if (t === '') return null;
  if (t === '*') return { kind: 'wildcard' };
  if (t === 'self') return { kind: 'self' };
  if (t.startsWith('*.')) {
    const host = t.slice(2);
    if (!host) return null;
    return { kind: 'subdomain', host };
  }
  // Strip a leading scheme if the user pasted a URL by mistake — TM
  // accepts both `example.com` and `https://example.com` in @connect
  // lines; we normalize to the host.
  try {
    if (/^[a-z]+:\/\//.test(t)) {
      const u = new URL(t);
      return { kind: 'host', host: u.hostname };
    }
  } catch {
    // Fall through — treat the raw value as a host.
  }
  return { kind: 'host', host: t };
}

// Parse every `@connect` line from a header, dropping empties.
export function parseConnectRules(header: ParsedHeader): ConnectRule[] {
  const out: ConnectRule[] = [];
  for (const raw of getValues(header, 'connect')) {
    const rule = parseConnectEntry(raw);
    if (rule) out.push(rule);
  }
  return out;
}

// Match `host` (lowercased; no port) against one rule. The `self`
// rule is matched against `selfHosts` — the hostnames the script
// declared via @match / @include, plus the requesting page's host
// when `decideConnect` knew it.
export function hostMatchesRule(
  host: string,
  rule: ConnectRule,
  selfHosts: ReadonlySet<string>,
): boolean {
  const h = host.toLowerCase();
  switch (rule.kind) {
    case 'wildcard':
      return true;
    case 'self':
      // TM treats `self` as "the script's own origins or their
      // subdomains" (VM doesn't enforce `@connect` at all). We're
      // conservative: exact match only. See TODO.md "@connect self
      // subdomain handling" — known divergence pending a real compat
      // report.
      return selfHosts.has(h);
    case 'host':
      // A bare `example.com` covers its subdomains too, as Tampermonkey
      // documents. But not a bare IP or single label: `@connect 0.0.1`
      // must not reach `127.0.0.1`, nor `@connect com` all of `.com`.
      if (!rule.host) return false;
      if (h === rule.host) return true;
      return !isExactOnlyHost(rule.host) && h.endsWith('.' + rule.host);
    case 'subdomain':
      // The `.` prefix keeps it to whole labels, so `evilexample.com`
      // doesn't match `*.example.com`.
      if (!rule.host) return false;
      return h === rule.host || h.endsWith('.' + rule.host);
    default:
      return false;
  }
}

// A bare `@connect` host that has no subdomains to cover: an IP
// address (all-numeric dotted, or IPv6 with `:`), or a single label
// (`localhost`, `com`).
function isExactOnlyHost(host: string): boolean {
  return /^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.');
}

// True when the header has no usable `@connect` rule, so all its
// `GM_xmlhttpRequest` calls are refused. The same parse enforcement
// uses, so a header whose `@connect` lines are all malformed counts.
export function hasNoConnectRules(header: ParsedHeader): boolean {
  return parseConnectRules(header).length === 0;
}

// Extract the set of "self" hosts from a script header's match/
// include lines. Used to resolve the `self` @connect token.
// Patterns we don't understand (regex includes, malformed globs)
// are skipped — they don't contribute to "self".
export function extractSelfHosts(header: ParsedHeader): Set<string> {
  const out = new Set<string>();
  const all = [...getValues(header, 'match'), ...getValues(header, 'include')];
  for (const pat of all) {
    const host = extractHostFromPattern(pat);
    if (host) out.add(host.toLowerCase());
  }
  return out;
}

// Pull a hostname out of a `@match` / `@include` glob if it has one.
// `<all_urls>`, regex literals, and host-less patterns return null.
function extractHostFromPattern(pat: string): string | null {
  if (pat === '<all_urls>') return null;
  if (pat.startsWith('/') && pat.endsWith('/')) return null; // regex literal
  // Match an URL-like glob: <scheme>://<host>/...
  const m = /^[\w*]+:\/\/([^/]+)\//.exec(pat);
  if (!m) return null;
  const host = m[1];
  // A pure `*` host doesn't tell us anything useful for "self".
  if (host === '*') return null;
  // `*.example.com` → use `example.com` as the self host.
  if (host.startsWith('*.')) return host.slice(2);
  return host;
}

// Everything the policy needs about one request, beyond its URL.
export interface ConnectContext {
  // The script's parsed @connect lines. Empty = the script declared
  // none.
  rules: readonly ConnectRule[];
  // Hosts named by the script's @match / @include patterns, used to
  // resolve the `self` token.
  selfHosts: ReadonlySet<string>;
  // Origin of the document that issued the request (`https://x.com`),
  // when the SW could determine it. Absent for a sender with no
  // resolvable origin; an opaque origin arrives as the literal
  // `'null'` (sandboxed frame) and never matches. A local page's
  // origin is a bare `file://`, which the http(s) gate below rules
  // out rather than this check.
  pageOrigin?: string;
}

// Why a request was allowed, or why it wasn't. `via` names which rule
// let it through, for anyone debugging a verdict.
//
// Two independent axes on a refusal:
// - `denied` separates "the header forbids this" from "we couldn't even
//   read the URL". Both stop the request, but only the first is the
//   script's `@connect` lines doing their job — see
//   `connectBlockedMessage`, which must not be told to blame them for a
//   URL that never parsed.
// - `undeclared` marks the denials whose fix is "add a @connect line"
//   rather than "add this host".
export type ConnectVerdict =
  | { allowed: true; via: 'same-origin' | 'rule' }
  | { allowed: false; reason: string; denied: boolean; undeclared: boolean };

// Decide whether `url` may be requested on behalf of a script.
// Reasons are plain English so the SW can log them / surface them to
// the userscript via onerror.
export function decideConnect(url: string, ctx: ConnectContext): ConnectVerdict {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    // Not a denial: a URL the parser rejects lands here even for a
    // script with `@connect *`. A page-relative URL normally never
    // reaches this point — `resolveXhrUrl` (gm-xhr.ts) resolves it
    // against the sender's document first — but it does when the SW
    // couldn't identify the sender's page.
    return {
      allowed: false,
      denied: false,
      undeclared: false,
      // Query string dropped: the reason lands in the Log tab, which
      // never carries one (see `logConnectVerdict`).
      reason: `${url.split('?')[0]} is not a valid URL; GM_xmlhttpRequest needs an absolute one`,
    };
  }
  // Same-origin first, and independent of the declared rules: a
  // script that declares `@connect example.com` still gets to talk to
  // the page it is running on, which is what TM does since 4.0. Exact
  // origin equality (scheme + host + port), not just host — a
  // different port or a scheme downgrade IS cross-origin to the page,
  // so it has to be declared like any other host.
  //
  // Web schemes only. The argument for the allowance is "the page
  // could fetch this itself"; that doesn't hold for `file://`, where
  // Chrome serializes the origin as a bare `file://` shared by every
  // local file, so a single no-@connect script on one local page
  // would inherit read access to the whole disk. Non-web targets go
  // through the declared rules like any other host.
  if (
    (target.protocol === 'http:' || target.protocol === 'https:') &&
    isUsableOrigin(ctx.pageOrigin) &&
    target.origin === ctx.pageOrigin
  ) {
    return { allowed: true, via: 'same-origin' };
  }
  const host = target.hostname;
  // Fold the page host in only when a `self` rule can use it — the
  // predicate runs again on every redirect hop, and the common script
  // has no `self` line at all.
  const selfHosts = ctx.rules.some((r) => r.kind === 'self')
    ? withPageHost(ctx.selfHosts, ctx.pageOrigin)
    : ctx.selfHosts;
  for (const rule of ctx.rules) {
    if (hostMatchesRule(host, rule, selfHosts)) return { allowed: true, via: 'rule' };
  }
  if (ctx.rules.length === 0) {
    return {
      allowed: false,
      denied: true,
      undeclared: true,
      // A host-less URL (`file:`, `data:`, `blob:`) can't be named in a
      // rule at all — only `@connect *` covers it — so telling the
      // author to add `// @connect ` with nothing after it would be
      // worse than saying nothing.
      // Phrased as the fix alone: `connectDenialClause` supplies the
      // "this script declares no @connect" half, so repeating it here
      // would say it twice in one sentence.
      reason: host
        ? `add "// @connect ${host}" to the script header`
        : `a ${schemeName(target)} URL has no host to declare, so only "// @connect *" covers it`,
    };
  }
  return {
    allowed: false,
    denied: true,
    undeclared: false,
    reason: host
      ? `host ${host} not in @connect allowlist`
      : `${schemeName(target)} URL has no host, so no @connect entry matches it`,
  };
}

// `https:` → `https`, for reasons that read as prose.
function schemeName(url: URL): string {
  return url.protocol.replace(/:$/, '');
}

// Every error `GM_xmlhttpRequest` hands back to a userscript starts
// here, so the three paths that can fail it — the pre-flight check, the
// post-redirect re-check (`gm-xhr.ts`), and a policy we couldn't even
// load (`background.ts`) — read the same way.
export function gmXhrError(problem: string): string {
  return `[SourceMonkey] GM_xmlhttpRequest: ${problem}`;
}

// The one phrasing for "we could not set the headers you asked for".
// Says the request was not sent, because the alternative a reader would
// assume — sent without them — is exactly what we refuse to do: the
// headers here are the ones the browser won't let a script set, and
// dropping a `Cookie` override would send the user's own session
// instead.
export function headerRuleFailedMessage(): string {
  return gmXhrError(
    'The headers this request asked for could not be applied, so it was not sent',
  );
}

// The one phrasing for a request the server never started answering.
// Says "no response headers" rather than "timed out" because the script
// may have set no timeout at all — this is the worker's own backstop,
// and a request left waiting forever would hold its header rule and
// block later requests to the same URL.
export function headerStallMessage(stallMs: number): string {
  const minutes = Math.round(stallMs / 60000);
  const howLong = minutes === 1 ? '1 minute' : `${minutes} minutes`;
  return gmXhrError(
    `The server sent no response headers within ${howLong}, so this request was given up on`,
  );
}

// The one phrasing for a request the script's own header forbids: it
// names whose rules blocked the call rather than a "policy" object the
// reader can't see. Shared by the page-facing error and the Log row so
// the two can't drift.
//
// `undeclared` picks the honest half. A script that listed hosts was
// refused BY those rules; a script that listed none has no rules to
// blame, and its fix is a different one — telling it "your @connect
// rules blocked this" when it wrote none is the mis-attribution
// docs/diagnostics.md warns about.
export function connectDenialClause(reason: string, undeclared: boolean): string {
  return undeclared
    ? `blocked because this script declares no @connect: ${reason}`
    : `blocked by this script's @connect rules: ${reason}`;
}

// The page-facing wrapper around that clause.
//
// Only for a real denial (`denied: true`). A URL we couldn't parse, or
// a failure to *evaluate* the rules, is not the header's doing and
// goes through `gmXhrError` directly.
export function connectBlockedMessage(reason: string, undeclared = false): string {
  return gmXhrError(connectDenialClause(reason, undeclared));
}

// The verdict for "we could not even evaluate the rules". Built here
// rather than at the call site so the shape stays in one place if
// `ConnectVerdict` grows a field: `denied: false` keeps the blame off
// the script's header, which never got a say.
export function policyFailureVerdict(reason: string): ConnectVerdict {
  return { allowed: false, reason, denied: false, undeclared: false };
}

// An origin string we can compare against. `undefined` (sender with no
// origin) and `'null'` (an opaque origin — a sandboxed frame) both
// mean "we don't know what same-origin would be here". A `file://`
// page is NOT opaque — Chrome gives it a bare `file://` origin, which
// the http(s) gate in `decideConnect` rules out instead, and for a
// different reason (every local file shares that one origin).
function isUsableOrigin(origin: string | undefined): origin is string {
  return typeof origin === 'string' && origin !== '' && origin !== 'null';
}

// Fold the requesting page's host into the `self` set. TM's `self` is
// "the domain of the page the script runs on"; our @match-derived
// hosts are a static approximation of that, useful when the page
// origin is unknown and for a script matched at several hosts.
function withPageHost(
  selfHosts: ReadonlySet<string>,
  pageOrigin: string | undefined,
): ReadonlySet<string> {
  if (!isUsableOrigin(pageOrigin)) return selfHosts;
  let host: string;
  try {
    host = new URL(pageOrigin).hostname.toLowerCase();
  } catch {
    return selfHosts;
  }
  if (!host || selfHosts.has(host)) return selfHosts;
  return new Set([...selfHosts, host]);
}
