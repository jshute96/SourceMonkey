// GitHub personal access token storage + helper for attaching the
// `Authorization: Bearer <token>` header onto requests that target a
// GitHub host (so we can fetch private repos and lift the
// unauthenticated 60/hour rate limit to 5000/hour).
//
// Mirrors `debug-log.ts`'s shape: one chrome.storage.local key, a
// cached in-memory copy, a `load…` for boot-time hydration, and an
// `install…Listener` for live updates without an SW restart.
//
// Hosts we attach the header to:
//   - api.github.com           (Contents API, repo metadata)
//   - raw.githubusercontent.com (raw bytes for blob URLs we rewrite to)
// Any other URL passes through untouched. Sending the header to
// non-GitHub hosts would leak the token, so the gate is strict.
//
// Notable omission: `github.com/<o>/<r>/raw/<ref>/<path>` (the "Raw"
// button URL). GitHub serves a 302 to raw.githubusercontent.com on
// that route, and the Fetch spec strips the `Authorization` header
// on cross-origin redirects — so the auth header would never reach
// raw, and the github.com hop itself doesn't honour our PAT for the
// bytes either. `normalizeGithubInput` rewrites `/blob/` and bare-
// repo URLs to the raw form at add time; users with a `/raw/` URL
// in hand can paste either the `/blob/` form (auto-rewritten) or the
// `raw.githubusercontent.com` form directly.

export const GITHUB_AUTH_TOKEN_KEY = 'githubAuthToken';

let cachedToken = '';

export function getGithubAuthToken(): string {
  return cachedToken;
}

// Test/debug hook. Production callers should toggle the storage key
// instead so the change persists and is observed via onChanged.
export function _setGithubAuthTokenForTests(value: string): void {
  cachedToken = value;
}

export async function loadGithubAuthToken(): Promise<void> {
  try {
    const got = await chrome.storage.local.get(GITHUB_AUTH_TOKEN_KEY);
    const raw = got[GITHUB_AUTH_TOKEN_KEY];
    cachedToken = typeof raw === 'string' ? raw : '';
  } catch {
    cachedToken = '';
  }
}

// The load, memoized. A service worker that woke up to answer a fetch
// request has a startup read in flight; a caller that needs the token
// to be *there* awaits this instead of racing it. Subsequent changes
// arrive through the onChanged listener below, so one load is enough.
let loadOnce: Promise<void> | null = null;
export function ensureGithubAuthTokenLoaded(): Promise<void> {
  if (!loadOnce) loadOnce = loadGithubAuthToken();
  return loadOnce;
}

export function installGithubAuthListener(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes[GITHUB_AUTH_TOKEN_KEY];
    if (!change) return;
    cachedToken = typeof change.newValue === 'string' ? change.newValue : '';
  });
}

// True if the URL targets a GitHub-controlled host we'd want to
// authenticate against. Pure function — exported for unit tests.
export function isGithubAuthUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'api.github.com') return true;
  if (host === 'raw.githubusercontent.com') return true;
  // `github.com` itself is intentionally NOT in the gate — the only
  // bytes-serving route on that host (`/<o>/<r>/raw/...`) 302s to
  // raw.githubusercontent.com, and the Fetch spec strips
  // `Authorization` on cross-origin redirects. See the module header.
  return false;
}

// Return the `Authorization` header (and the `X-GitHub-Api-Version`
// pinning header) for a GitHub URL when a token is set; an empty
// object otherwise. Safe to spread into a `headers` object that may
// already carry an `Accept`. Callers should ALWAYS go through this
// helper rather than reading `cachedToken` directly so the host gate
// can't be accidentally skipped.
export function githubAuthHeaders(url: string): Record<string, string> {
  if (!cachedToken) return {};
  if (!isGithubAuthUrl(url)) return {};
  return {
    Authorization: `Bearer ${cachedToken}`,
    // Pin the REST API version. Optional for the endpoints we hit
    // today, but cheap insurance against a future shape change.
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// True when a request to this URL would actually carry the GitHub
// auth header (URL is GitHub-eligible AND a token is configured).
// Same predicate `githubAuthHeaders` uses; exposed so log/UI callers
// can mirror its decision without re-running the header build.
export function isGithubAuthInUse(url: string): boolean {
  if (!cachedToken) return false;
  return isGithubAuthUrl(url);
}

// True when a *collection URL* (the stored collectionPath, not a
// per-fetch URL) describes content SourceMonkey reaches through GitHub
// — covers the github-dir case where `collectionPath` is a
// `github.com/<o>/<r>/tree/...` page URL but the actual scan + per-
// script fetches go to api.github.com + raw.githubusercontent.com.
// Returns true iff a token is configured AND the collection URL is
// recognisably GitHub. Used by the collection-refresh log line.
export function isGithubAuthInUseForCollection(collectionPath: string): boolean {
  if (!cachedToken) return false;
  if (isGithubAuthUrl(collectionPath)) return true;
  // github.com page URLs (`/blob/`, `/tree/`, bare repo) aren't
  // fetched directly — but a github-dir collection resolves to authed
  // api.github.com + raw.githubusercontent.com calls. Recognise the
  // github.com host so those collections get the suffix too.
  try {
    const host = new URL(collectionPath).hostname.toLowerCase();
    return host === 'github.com';
  } catch {
    return false;
  }
}

// Log-line suffix used by the updater so the SW console makes it
// obvious when a collection refresh / per-script check is going out
// authenticated. Empty string when no token would apply, so callers
// can unconditionally `${label}${githubTokenLogSuffix(url)}`.
export function githubTokenLogSuffix(url: string): string {
  return isGithubAuthInUseForCollection(url) ? ' (with GitHub token)' : '';
}
