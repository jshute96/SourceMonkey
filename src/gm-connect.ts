// `@connect` URL gating for `GM_xmlhttpRequest`.
//
// VM's @connect grammar:
//   - `*` — wildcard, allow any host.
//   - `self` — allow same-origin requests (matched against the
//     script's @match / @include hosts).
//   - `example.com` — exact host match.
//   - `*.example.com` — match `example.com` itself OR any subdomain.
//
// SW-side validation: when a script issues `GM_xmlhttpRequest`, the
// SW pulls the script's stored header, parses out the `@connect`
// lines, and rejects the request if the URL's host doesn't satisfy
// any of them.
//
// Default policy: a script with NO `@connect` lines is BLOCKED from
// all cross-origin requests. This matches VM. TM is more
// lenient — flagging scripts without @connect as a separate concern
// — but the stricter posture is the right default for a userscript
// manager that takes the trust model seriously.

import { getValues, type ParsedHeader } from './userscript-header.js';

// Each entry is one parsed @connect line.
export interface ConnectRule {
  kind: 'wildcard' | 'self' | 'exact' | 'subdomain';
  // For `exact` and `subdomain`, the host (lowercased). Missing
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
      return { kind: 'exact', host: u.hostname };
    }
  } catch {
    // Fall through — treat the raw value as a host.
  }
  return { kind: 'exact', host: t };
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
    case 'exact':
      return rule.host === h;
    case 'subdomain':
      if (!rule.host) return false;
      return h === rule.host || h.endsWith('.' + rule.host);
    default:
      return false;
  }
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

// Check whether `url` is allowed under the script's @connect rules.
// Reason is plain English so the SW can log it / surface to the
// userscript via onerror.
//
// `denied` distinguishes "the header forbids this" from "we couldn't
// even read the URL". Both stop the request, but only the first is the
// script's `@connect` lines doing their job — see
// `connectBlockedMessage`, which must not be told to blame them for a
// URL that never parsed.
export function isUrlConnectAllowed(
  url: string,
  rules: readonly ConnectRule[],
  selfHosts: ReadonlySet<string>,
): { allowed: true } | { allowed: false; denied: boolean; reason: string } {
  if (rules.length === 0) {
    return { allowed: false, denied: true, reason: '@connect not declared' };
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    // Not a denial: a relative URL (which TM resolves and we don't)
    // lands here even for a script with `@connect *`.
    return {
      allowed: false,
      denied: false,
      reason: `${url} is not a valid URL — GM_xmlhttpRequest needs an absolute one`,
    };
  }
  for (const rule of rules) {
    if (hostMatchesRule(host, rule, selfHosts)) return { allowed: true };
  }
  return {
    allowed: false,
    denied: true,
    reason: `host ${host} not in @connect allowlist`,
  };
}

// Every error `GM_xmlhttpRequest` hands back to a userscript starts
// here, so the three paths that can fail it — the pre-flight check, the
// post-redirect re-check (`gm-xhr.ts`), and a policy we couldn't even
// load (`background.ts`) — read the same way.
export function gmXhrError(problem: string): string {
  return `[SourceMonkey] GM_xmlhttpRequest: ${problem}`;
}

// The one phrasing for a request the script's own header forbids: it
// names whose rules blocked the call rather than a "policy" object the
// reader can't see.
//
// Only for a real denial (`denied: true`). A URL we couldn't parse, or
// a failure to *evaluate* the rules, is not the header's doing and
// goes through `gmXhrError` directly.
export function connectBlockedMessage(reason: string): string {
  return gmXhrError(`blocked by this script's @connect rules: ${reason}`);
}
