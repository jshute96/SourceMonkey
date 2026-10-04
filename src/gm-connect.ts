// `@connect` URL gating for `GM_xmlhttpRequest`.
//
// @connect grammar (following Tampermonkey's docs):
//   - `*` — wildcard, allow any host.
//   - `self` — allow same-origin requests (matched against the
//     script's @match / @include hosts).
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
// A host no rule covers isn't refused outright: the extension asks the
// user, as Tampermonkey does, and remembers the answer per script (see
// `decideConnect` and docs/connect-permissions.md). Violentmonkey doesn't enforce
// @connect at all.

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
// rule is matched against the union of `selfHosts` — the set of
// hostnames the script declared via @match / @include.
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
      // TM/VM both treat `self` as "the script's own origins or
      // their subdomains". We're conservative: exact match only.
      // See TODO.md "@connect self subdomain handling" — known
      // cross-manager divergence pending a real compat report.
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
// `GM_xmlhttpRequest` calls to other sites need the user's say-so. The
// same parse enforcement uses, so a header whose `@connect` lines are
// all malformed counts.
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

// What to do with a request to `url`, before any choice the user has
// made about this script's hosts (those live in the extension, see
// `connect-grants.ts`):
//   - `allow`: a `@connect` rule covers the host, or the request goes to
//     the requesting page's own origin.
//   - `ask`: an http(s) host nothing covers. The caller looks up the
//     user's earlier answer for it, or asks.
//   - `deny`: a URL with no host to ask about (`file:`, `data:`), or not
//     http(s) (`ws:`, `ftp:`), which only `@connect *` covers.
//   - `invalid`: the URL didn't parse. Not a denial: no rule was even
//     consulted, so `connectBlockedMessage` must not blame the rules.
//
// The page's own origin is allowed whatever the rules say, as
// Tampermonkey 4 does: the page could already `fetch` it, so refusing
// it protects nothing and breaks ordinary scripts. It is exact origin
// equality (scheme, host and port), and http(s) only: Chrome gives every
// local file the same bare `file://` origin, so for a `file:` page it
// would mean the whole disk.
//
// `pageOrigin` also joins `self`, which in Tampermonkey means the page
// the script runs on, as well as the script's @match / @include hosts.
export type ConnectDecision =
  | { verdict: 'allow' }
  | { verdict: 'ask'; host: string }
  | { verdict: 'deny'; reason: string }
  | { verdict: 'invalid'; reason: string };

export function decideConnect(
  url: string,
  rules: readonly ConnectRule[],
  selfHosts: ReadonlySet<string>,
  pageOrigin?: string,
): ConnectDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { verdict: 'invalid', reason: `${url} is not a valid URL` };
  }
  const web = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  const page = webOrigin(pageOrigin);
  if (web && page && parsed.origin === page.origin) return { verdict: 'allow' };
  const host = parsed.hostname.toLowerCase();
  const selfs = page ? new Set([...selfHosts, page.hostname]) : selfHosts;
  for (const rule of rules) {
    // A host-less URL has nothing for a host rule to match, but `*`
    // means any URL at all.
    if (!host && rule.kind !== 'wildcard') continue;
    if (hostMatchesRule(host, rule, selfs)) return { verdict: 'allow' };
  }
  if (web && host) return { verdict: 'ask', host };
  return {
    verdict: 'deny',
    reason: host
      ? `Only http(s) sites can be allowed, so only @connect * covers a ${parsed.protocol} URL.`
      : `A ${parsed.protocol} URL has no host to allow, so only @connect * covers it.`,
  };
}

// The page's origin when it is an http(s) one, else null.
function webOrigin(origin: string | undefined): URL | null {
  if (!origin) return null;
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
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

// For a request that never got a response: Chrome's `fetch` rejects
// with a bare "Failed to fetch" for a name that doesn't resolve, a
// refused or dropped connection, a failed TLS handshake, and a request
// another extension blocked alike, so the causes are listed rather than
// one guessed (see TODO.md for telling them apart). The host is the
// request's own; a redirect `fetch` followed to a dead host lands here
// too, with nothing to tell us which hop failed.
export function unreachableMessage(host: string): string {
  return gmXhrError(
    `Could not reach ${host}. The name may not resolve, or the connection was refused, failed or blocked.`,
  );
}

// The one phrasing for a request the script's own header forbids: it
// names whose rules blocked the call rather than a "policy" object the
// reader can't see. `reason` is a sentence of its own.
//
// Only for a real denial. A URL we couldn't parse, or a failure to
// *evaluate* the rules, is not the header's doing and goes through
// `gmXhrError` directly.
export function connectBlockedMessage(reason: string): string {
  return gmXhrError(`This script's @connect rules don't allow this request. ${reason}`);
}

// The one phrasing for a host the user refused this script in the
// prompt. Says where the refusal can be undone, since it lasts until
// reset.
export function connectDeniedMessage(host: string): string {
  return gmXhrError(
    `Connecting to ${host} was denied for this script. `
    + 'Manage permissions on the script\'s page in SourceMonkey.',
  );
}

// The one phrasing for a request whose prompt the user cancelled (or
// closed). Nothing is kept, so the next request asks again, which goes
// without saying.
export function connectCancelledMessage(host: string): string {
  return gmXhrError(`SourceMonkey's permission prompt for connecting to ${host} was cancelled, so this request was blocked`);
}

// The one phrasing for a prompt that couldn't be shown. `cause` is
// Chrome's reason.
export function connectPromptFailedMessage(host: string, cause: string): string {
  // Chrome's reason, capitalized as a tail after `: ` is.
  const tail = cause.charAt(0).toUpperCase() + cause.slice(1);
  return gmXhrError(`SourceMonkey could not open its permission prompt for connecting to ${host}: ${tail}`);
}

// The one phrasing for a request refused because the script already has
// as many prompts open as it may (`MAX_PROMPTS_PER_SCRIPT`).
export function connectTooManyPromptsMessage(host: string, open: number): string {
  return gmXhrError(
    `SourceMonkey is already asking about ${open} other sites for this script, so this request to ${host} was blocked. `
    + 'Answer those permission prompts, then try again.',
  );
}

// The one phrasing for a request whose prompt went unanswered too long.
// The prompt closes with it, so the next request asks again.
export function connectUnansweredMessage(host: string, waitMs: number): string {
  const minutes = Math.round(waitMs / 60000);
  const howLong = minutes === 1 ? '1 minute' : `${minutes} minutes`;
  return gmXhrError(
    `SourceMonkey's permission prompt for connecting to ${host} had no answer within ${howLong}, `
    + 'so this request was stopped',
  );
}
