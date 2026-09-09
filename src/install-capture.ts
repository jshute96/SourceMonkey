// Captures navigations to `*.user.js` URLs — http(s):// and file://
// alike — and routes them to the userscript viewer's preview mode
// instead.
//
// Why this is needed at all: Chrome never renders a `.user.js` URL as
// a page you can click "install" on. It is treated like any other
// resource, so a `text/javascript` response just renders as source
// text and a local file opens as text. The user never gets an install
// prompt, so a script manager has to intercept the navigation itself.
// Tampermonkey and Violentmonkey do the same thing.
//
// (Chrome ≤ 151 special-cased the suffix and forced the navigation
// into a download that was then handed to the MV2 extension
// installer. `minimum_chrome_version` in the manifest puts the floor
// at 152, where crrev 38b617ca removed that; nothing here works
// around it any more.)
//
// The capture itself is `webNavigation.onBeforeNavigate`, which fires
// before the request goes out: we rewrite the tab to
// `userscript.html?preview=…`.
//
// `file://` capture additionally depends on the user's per-extension
// "Allow access to file URLs" toggle:
//   - `webNavigation` delivery is gated on host access, so with the
//     toggle off the event is expected never to arrive.
//   - If one somehow did, the preview couldn't read the file anyway
//     and would show its fetch error.
//   - Either way the feature is absent rather than broken, so nothing
//     here tests for the toggle.
//   - Not verified automatically: Chrome grants file access
//     unconditionally to `--load-extension` builds, so the e2e suite
//     only reaches the toggle-on case. See TODO.md.
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

// Schemes the capture acts on. `file:` is here so that opening a
// local `.user.js` offers the same install prompt a remote one does;
// without it a script on disk is the one way in with no prompt at
// all. The cost (a local file opened *to read* gets hijacked) is
// accepted and mitigated rather than avoided; see
// [docs/install-capture.md] "The cost, and what pays for it".
//
// Anything else (`chrome-extension:`, `ftp:`, `data:`, …) stays out:
// those aren't collection shapes `addCollection` can register.
const CAPTURED_PROTOCOLS = new Set(['http:', 'https:', 'file:']);

// Code-hosting sites that serve an HTML *page* — a file browser with
// syntax highlighting, line numbers, and navigation — at a URL whose
// path still ends in `.user.js`. Those pages are something the user
// asked to read and Chrome renders them correctly on its own, so the
// capture stays out of the way.
//
// Only the page-view path is listed. Each of these hosts serves the
// real bytes from a different path (noted per entry), and those stay
// captured — the exclusion is about the rendering, not the host.
//
// Not a completeness claim, and it doesn't need to be: an unlisted
// forge's blob view is still captured, but the preview then sees a
// markup response and continues to the page by itself. This list only
// saves the round trip for the hosts worth knowing in advance.
//
// Pasting any of these URLs into the collections page's Add field
// still installs the script — that path rewrites a blob URL to its raw
// form (`normalizeCollectionInput`).
const CODE_HOST_PAGE_VIEWS: { host: string; path: RegExp }[] = [
  // bytes at raw.githubusercontent.com, or /<o>/<r>/raw/…
  { host: 'github.com', path: /^\/[^\/]+\/[^\/]+\/blob\// },
  // bytes at /-/raw/…; the group segment count varies, so no anchor
  { host: 'gitlab.com', path: /\/-\/blob\// },
  // bytes at /<w>/<r>/raw/…
  { host: 'bitbucket.org', path: /^\/[^\/]+\/[^\/]+\/src\// },
  // Gitea: page at /src/branch/<b>/…, bytes at /raw/branch/<b>/…
  { host: 'codeberg.org', path: /^\/[^\/]+\/[^\/]+\/src\// },
];

function isCodeHostPageView(u: URL): boolean {
  // `?raw=true` on a blob URL is GitHub's own "give me the bytes"
  // switch — it 302s to raw.githubusercontent.com. Excluding it would
  // lose the capture entirely, since `onBeforeNavigate` does not fire
  // again for a server redirect.
  if (u.searchParams.get('raw') === 'true' || u.searchParams.get('raw') === '1') return false;
  // `hostname` is already lowercased by the URL parser. `www.` is
  // stripped so the same rule covers the redirecting alias.
  const host = u.hostname.replace(/^www\./, '');
  return CODE_HOST_PAGE_VIEWS.some((e) => e.host === host && e.path.test(u.pathname));
}

// True for URLs the capture should act on: an http(s) or file:// URL
// whose path ends in `.user.js`, excluding the forge page views above.
// Query strings and fragments are ignored (they live outside
// `pathname`), so `…/foo.user.js?v=3#top` matches.
//
// The suffix match is case-SENSITIVE, matching both the
// `webNavigation` pre-filter below and `isSingleFileInput` in
// directories.ts (which decides, post-install, whether the URL is a
// single script or a directory to scan). Chrome's own legacy check is
// case-insensitive, so the three ways SourceMonkey can see one URL
// have to agree or a `FOO.USER.JS` ends up captured but registered as
// a directory collection. Lowercase is the universal convention; a
// mixed-case suffix is simply not ours to handle.
export function isUserJsUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!CAPTURED_PROTOCOLS.has(u.protocol)) return false;
  if (!u.pathname.endsWith(USER_JS_SUFFIX)) return false;
  return !isCodeHostPageView(u);
}

// Marks a preview the capture opened, as opposed to one the user asked
// for from the collections page. Only the captured kind may bail out
// on its own (see the viewer's markup handling): a capture is us
// guessing that a URL was a script, so being wrong means getting out
// of the way. A preview the user explicitly asked for is a request we
// owe an answer to, and silently navigating them off SourceMonkey to
// some web page would be the wrong one.
//
// Nothing on the web can set this, and it has to stay that way: a page
// that could forge it could make the viewer navigate the tab and plant
// a capture bypass. `deep-link.ts` strips it for that reason. The
// whole flow — who adds it, who strips it, who reads it — is written
// up in [docs/install-capture.md], "The `captured=1` marker".
export const CAPTURED_PARAM = 'captured';

// Build the preview URL for a captured script URL. The script URL is
// carried as a normal query param — the viewer is the only consumer and
// it validates the value before fetching anything.
export function buildPreviewPageUrl(scriptUrl: string): string {
  const qs = new URLSearchParams({ preview: scriptUrl, [CAPTURED_PARAM]: '1' });
  return `${chrome.runtime.getURL(PREVIEW_PAGE)}?${qs.toString()}`;
}

function bypassKey(url: string): string {
  return BYPASS_PREFIX + url;
}

// Record a one-shot "don't capture this URL" marker. Called from the
// preview page's View collection action.
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
// mirror wrong until the next toggle.
let captureFlagGeneration = 0;

// The live mirror, not a settled answer: it reads the optimistic
// default (on) until the startup read lands, so only a poll for
// `false` means anything. Exposed for the e2e suite, where a test that
// turns capture off needs to know the SW has seen the change before it
// navigates — the storage write resolving is not the same as the
// `onChanged` listener having run.
export function isCaptureEnabled(): boolean {
  return captureEnabled;
}

async function loadCaptureFlag(): Promise<void> {
  const generation = captureFlagGeneration;
  try {
    const got = await chrome.storage.local.get(INSTALL_CAPTURE_KEY);
    if (generation !== captureFlagGeneration) return;
    captureEnabled = got[INSTALL_CAPTURE_KEY] !== false;
  } catch (err) {
    // Leave the mirror at its default rather than taking the SW's
    // startup down; the next toggle re-syncs everything.
    console.info('[SourceMonkey] could not read the .user.js capture setting', err);
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
    // The bump above makes an in-flight initial read discard its
    // result, so the toggle can't be clobbered by a stale value. The
    // flag itself lands synchronously; `captureFlagReady` is reset so
    // that a LATER navigation isn't parked behind the superseded
    // startup read.
    captureEnabled = change.newValue !== false;
    captureFlagReady = Promise.resolve();
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
    // don't defeat it, and it is case-sensitive — the same rule
    // `isUserJsUrl` applies, so the two agree on `FOO.USER.JS` (not
    // captured). No scheme condition: the filter is scheme-agnostic,
    // so `file://` navigations arrive here too and `isUserJsUrl` is
    // the only thing deciding which schemes are in scope.
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
