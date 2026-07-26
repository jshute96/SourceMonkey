// Captures web navigations to `*.user.js` URLs and routes them to the
// userscript viewer's preview mode instead.
//
// Why this is needed at all: Chrome never renders a `.user.js` URL as
// a page you can click "install" on.
//   - Chrome ≤ 151 special-cases the suffix (`UserScript::IsURLUserScript`
//     in `chrome_content_browser_client.cc`): the navigation is forced
//     into a download, and the download is then handed to the extension
//     installer, which fails now that MV2 is gone. The user sees a
//     broken-looking download plus an install error.
//   - Chrome ≥ 152 removes that special case (crrev 38b617ca, landed
//     2026-06-30), so the URL is treated like any other resource — a
//     `text/javascript` response just renders as source text.
// Either way the user never gets an install prompt, so a script manager
// has to intercept the navigation itself. Tampermonkey and
// Violentmonkey do the same thing.
//
// Two independent pieces, in order of importance:
//
//   1. The capture. `webNavigation.onBeforeNavigate` fires before the
//      request goes out; we rewrite the tab to
//      `userscript.html?preview=…`.
//      This is what actually delivers the install, and it works on
//      every Chrome version.
//
//   2. The download workaround (Chrome < 152 only). The SW may be
//      cold-starting when the navigation begins, so the response can
//      win the race against our `tabs.update`. A DNR session rule
//      rewrites the response `Content-Type` to `text/html`, which is
//      the one MIME the legacy check exempted — so Chrome renders the
//      response instead of running it through the failing installer.
//      On Chrome ≥ 152 the rule is NOT registered: without it a
//      not-captured `.user.js` renders as readable source text, and
//      with it the same page would render as garbled HTML.
//
// Redirecting via `chrome.tabs.update` (rather than a DNR `redirect`
// action) is deliberate: DNR redirects to an extension page require
// the page in `web_accessible_resources`, which hands our extension ID
// to every site for fingerprinting. An extension-initiated navigation
// has no such requirement.
//
// See [docs/install-capture.md].

import { dlog } from './debug-log.js';

// Storage key for the user-facing "capture .user.js links" toggle
// (options page). Absent means enabled — capture is the default.
export const INSTALL_CAPTURE_KEY = 'smCaptureUserJsLinks';

// The viewer page, which renders a not-yet-installed script from
// `?preview=<url>` and offers Install / Update. Same page an installed
// script opens in — see [docs/script-viewer.md].
const PREVIEW_PAGE = 'userscript.html';

// The one spelling of the suffix every matcher here keys off.
const USER_JS_SUFFIX = '.user.js';

// Session-storage prefix for one-shot capture bypasses. The preview
// page writes one of these right before navigating to the raw URL so
// its own navigation isn't captured straight back into a preview.
// Session storage (not an in-memory set) because the writer is an
// extension page and the reader is the SW, which may restart in
// between.
const BYPASS_PREFIX = 'installBypass:';

// How long a bypass stays valid. Long enough to cover a slow
// navigation start, short enough that a later manual visit to the same
// URL is captured normally again.
const BYPASS_TTL_MS = 30_000;

// Fixed session-rule id for the Chrome < 152 download workaround.
// Session rules are wiped when the browser closes, which is what we
// want: the rule is re-derived from the current option + Chrome
// version on every SW startup.
const DNR_DOWNLOAD_FIX_RULE_ID = 1;

// The Chrome milestone that removed `.user.js` download special-casing.
// At/after this version the workaround rule is not just unnecessary,
// it's harmful — see the file header.
const CHROME_USERJS_FIX_VERSION = 152;

// True for URLs the capture should act on: an http(s) URL whose path
// ends in `.user.js`. Query strings and fragments are ignored (they
// live outside `pathname`), so `…/foo.user.js?v=3#top` matches.
//
// Deliberately narrower than "any URL ending in .user.js":
//   - non-http(s) schemes are excluded. `file://` scripts are added
//     through the sources page, and capturing them would hijack a
//     local dev file the user meant to read.
//   - the suffix match is case-SENSITIVE, matching both the
//     `webNavigation` pre-filter below and `isSingleFileInput` in
//     directories.ts (which decides, post-install, whether the URL is
//     a single script or a directory to scan). Chrome's own legacy
//     check is case-insensitive, so the three ways SourceMonkey can
//     see one URL have to agree or a `FOO.USER.JS` ends up captured
//     but registered as a directory source. Lowercase is the universal
//     convention; a mixed-case suffix is simply not ours to handle.
export function isUserJsUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return u.pathname.endsWith(USER_JS_SUFFIX);
}

// Build the preview URL for a captured script URL. The script URL is
// carried as a normal query param — the viewer is the only consumer and
// it validates the value before fetching anything.
export function buildPreviewPageUrl(scriptUrl: string): string {
  const qs = new URLSearchParams({ preview: scriptUrl });
  return `${chrome.runtime.getURL(PREVIEW_PAGE)}?${qs.toString()}`;
}

// Extract the Chrome major version from a user-agent string. Returns
// null when the string doesn't look like Chrome at all; callers treat
// null as "assume a version that still needs the workaround", matching
// what Violentmonkey does — a spurious rule on a non-Chrome browser is
// harmless because the whole module only runs where DNR exists.
export function parseChromeMajor(ua: string): number | null {
  const m = /Chrom(?:e|ium)\/(\d+)/.exec(ua);
  return m ? Number(m[1]) : null;
}

// True when this browser still has the legacy `.user.js` download
// path and therefore needs the Content-Type workaround.
export function needsDownloadWorkaround(ua: string): boolean {
  const major = parseChromeMajor(ua);
  return major === null || major < CHROME_USERJS_FIX_VERSION;
}

function bypassKey(url: string): string {
  return BYPASS_PREFIX + url;
}

// Record a one-shot "don't capture this URL" marker. Called from the
// preview page's View source action.
export async function markInstallBypass(url: string): Promise<void> {
  await chrome.storage.session.set({ [bypassKey(url)]: Date.now() + BYPASS_TTL_MS });
}

// Read-and-clear a bypass marker. Returns true when the caller should
// let the navigation through untouched.
export async function consumeInstallBypass(url: string): Promise<boolean> {
  const key = bypassKey(url);
  const got = await chrome.storage.session.get(key);
  const expiresAt = got[key];
  if (typeof expiresAt !== 'number') return false;
  await chrome.storage.session.remove(key);
  return expiresAt > Date.now();
}

// In-SW mirror of the capture toggle. Read once at startup and kept
// current by the storage listener, so the navigation handler never has
// to await storage on the critical path — every millisecond there is a
// millisecond the response can use to win the race.
//
// It starts at the default (on), which is a lie for a user who turned
// capture off: an MV3 service worker is woken *by* the navigation
// event, so the first navigation after every wake can arrive before
// the initial read lands. `captureFlagReady` is awaited on the async
// side of the handler — off the sync fast path — so that navigation
// gets the real answer too.
let captureEnabled = true;
let captureFlagReady: Promise<void> = Promise.resolve();

// Bumped by every write. The initial read applies its result only if
// nothing newer landed while it was in flight — otherwise a toggle made
// during startup would be clobbered by the stale value, leaving the
// mirror and the DNR rule both wrong until the next toggle.
let captureFlagGeneration = 0;

async function loadCaptureFlag(): Promise<void> {
  const generation = captureFlagGeneration;
  try {
    const got = await chrome.storage.local.get(INSTALL_CAPTURE_KEY);
    if (generation !== captureFlagGeneration) return;
    await applyCaptureFlag(got[INSTALL_CAPTURE_KEY] !== false);
  } catch (err) {
    // Leave the mirror at its default rather than taking the SW's
    // startup down; the next toggle re-syncs everything.
    console.info('[SourceMonkey] could not read the .user.js capture setting', err);
  }
}

async function applyCaptureFlag(enabled: boolean): Promise<void> {
  captureEnabled = enabled;
  await syncDownloadWorkaroundRule();
}

// Response-header rule conditions landed in Chrome 128 but aren't in
// @types/chrome 0.0.287 yet, so the condition is assembled through a
// locally widened type. The cast is confined to this declaration
// rather than applied to the whole rule, so everything else in the
// literal is still type-checked.
type ResponseHeaderCondition = chrome.declarativeNetRequest.RuleCondition & {
  responseHeaders?: { header: string; values?: string[] }[];
};
type HeaderRule = Omit<chrome.declarativeNetRequest.Rule, 'condition'> & {
  condition: ResponseHeaderCondition;
};

// Add / remove the Chrome < 152 Content-Type rule to match the current
// capture setting. With capture off the user asked for stock browser
// behavior, so the workaround comes off too.
async function syncDownloadWorkaroundRule(): Promise<void> {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr) return;
  // Note what the rewrite means for any `.user.js` response that
  // actually reaches the renderer (only when the capture loses the
  // cold-start race): the browser HTML-parses the script — collapsed
  // whitespace, and an inline `<script>` in the file would run on its
  // host's origin. That's why the preview page's raw view never
  // navigates to a rewritten response on these versions; it serves its
  // own fetched copy as text/plain. See [docs/install-capture.md]
  // before widening this rule.
  const wanted = captureEnabled && needsDownloadWorkaround(navigator.userAgent);
  const rules: HeaderRule[] = wanted
    ? [
        {
          id: DNR_DOWNLOAD_FIX_RULE_ID,
          // Chrome's legacy check was `filename ends with .user.js &&
          // mime != text/html`, so setting text/html is precisely the
          // exemption. Restricted to main-frame GETs whose response
          // claims to be script/text: a `.user.js` fetched as a
          // subresource, or already served as HTML, is left alone.
          //
          // `^[^?]*` anchors the suffix to the path, so the rule covers
          // exactly what `isUserJsUrl` covers — without it,
          // `…/view?f=a.user.js` would be rewritten despite the capture
          // deliberately ignoring that shape. No `#` alternative: the
          // fragment is never sent, so DNR never sees one.
          condition: {
            regexFilter: '^[^?]*\\.user\\.js(\\?.*)?$',
            isUrlFilterCaseSensitive: true,
            requestMethods: ['get' as chrome.declarativeNetRequest.RequestMethod],
            resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
            responseHeaders: [{ header: 'content-type', values: ['*/javascript*', 'text/plain*'] }],
          },
          action: {
            type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
            responseHeaders: [
              {
                header: 'content-type',
                // Carries a charset: replacing the header outright drops
                // whatever the server declared, and Chrome would fall
                // back to the locale default and mojibake a UTF-8 script.
                value: 'text/html; charset=utf-8',
                operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
              },
            ],
          },
        },
      ]
    : [];
  try {
    await dnr.updateSessionRules({
      removeRuleIds: [DNR_DOWNLOAD_FIX_RULE_ID],
      addRules: rules as chrome.declarativeNetRequest.Rule[],
    });
  } catch (err) {
    // A malformed rule or a Chrome that rejects the response-header
    // condition shouldn't take the capture down with it — the capture
    // itself doesn't depend on this rule.
    console.info('[SourceMonkey] could not update the .user.js download workaround rule', err);
  }
}

// Wire the capture. Safe to call when webNavigation is unavailable —
// the feature just stays off.
export function installUserJsCapture(): void {
  const wn = chrome.webNavigation;
  if (!wn) {
    console.info('[SourceMonkey] chrome.webNavigation not available; .user.js capture disabled');
    return;
  }

  captureFlagReady = loadCaptureFlag();
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes[INSTALL_CAPTURE_KEY];
    if (!change) return;
    captureFlagGeneration++;
    // Keep `captureFlagReady` pointing at the newest apply so a
    // navigation racing a toggle waits for the toggle, not for a read
    // that has already been superseded.
    captureFlagReady = applyCaptureFlag(change.newValue !== false);
  });

  wn.onBeforeNavigate.addListener(
    (d) => {
      if (d.frameId !== 0) return;
      if (!captureEnabled) return;
      if (!isUserJsUrl(d.url)) return;
      void captureNavigation(d.tabId, d.url);
    },
    // Cheap pre-filter so the listener isn't woken for every
    // navigation. `pathSuffix` matches the path only, so query strings
    // don't defeat it. It IS case-sensitive while `isUserJsUrl` is
    // not — a `FOO.USER.JS` URL is simply not captured, which is fine
    // for a suffix that is lowercase by universal convention.
    { url: [{ pathSuffix: '.user.js' }] },
  );
}

async function captureNavigation(tabId: number, url: string): Promise<void> {
  // Re-check against the settled flag: the sync check upstream may have
  // run against the startup default. Cheap — resolved for every
  // navigation but the first after an SW wake.
  await captureFlagReady;
  if (!captureEnabled) return;
  if (await consumeInstallBypass(url)) {
    dlog(`[SourceMonkey] .user.js capture bypassed for ${url}`);
    return;
  }
  console.log(`[SourceMonkey] capturing .user.js navigation: ${url}`);
  // The tab may have closed (or navigated on) between the event firing
  // and this update landing; ignore the resulting rejection.
  await chrome.tabs.update(tabId, { url: buildPreviewPageUrl(url) }).catch(() => {});
}
