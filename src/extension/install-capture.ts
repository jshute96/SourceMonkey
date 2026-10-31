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
// before the request goes out. The preview opens in a new tab beside
// the one navigating, so closing it gets back to where the person was.
// That tab's navigation is left to run, so other script managers can
// still catch it; if nobody does, the tab goes back (`watchedTabs`).
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
// Opening the preview with `chrome.tabs.create` (rather than a DNR
// `redirect` action) is deliberate: DNR redirects to an extension page require
// the page in `web_accessible_resources`, which hands our extension ID
// to every site for fingerprinting. An extension-initiated navigation
// has no such requirement.
//
// See [docs/install-capture.md].

import { dlog } from '../debug-log.js';

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

// Marks a captured preview opened in a tab of its own, beside the tab
// that navigated, as opposed to one that replaced that tab (when Chrome
// refused a new one). Decides how the preview gets out of the way when
// the URL turns out to be a web page: close itself, or continue there.
// Forging it could only make a preview close its own tab.
export const BESIDE_PARAM = 'beside';

// Build the preview URL for a captured script URL. The script URL is
// carried as a normal query param; the viewer is the only consumer and
// it validates the value before fetching anything.
export function buildPreviewPageUrl(scriptUrl: string, beside = true): string {
  const qs = new URLSearchParams({ preview: scriptUrl, [CAPTURED_PARAM]: '1' });
  if (beside) qs.set(BESIDE_PARAM, '1');
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

// Captured navigations still under way, keyed by tab id.
//
// The capture opens the preview in a new tab beside the one navigating,
// and leaves that tab's own navigation to the script running, so other
// script managers can still catch it. A watch follows that navigation
// to its end and cleans up after it:
//   - It commits to the script (no other manager took it): go back to
//     the page it came from, or close a tab with no history.
//   - It becomes a download (`Content-Disposition: attachment`): cancel
//     it and remove the file, since the preview already covers the
//     script.
//   - It commits to anything else (another manager's install page, a
//     different navigation): leave it alone.
//
// A watch ends at the tab's next commit (a second later when that's
// the script, as it goes back), when its download is cancelled, a
// second after the navigation fails, or when the tab closes. It is set
// as the navigation starts, before anything is awaited, so a fast
// response can't get past it. In memory only: the worker is kept awake by the events it waits
// on, and a lost watch at worst leaves raw source showing or a file
// downloaded.
interface Watch {
  url: string;
  // `deciding` while `captureNavigation` runs, then `beside` once the
  // preview has its tab. `leaving`: the script committed, and the tab
  // goes back soon.
  state: 'deciding' | 'beside' | 'leaving';
  // A commit seen while deciding, for `captureNavigation` to act on.
  committedUrl?: string;
  // The navigation became a download while deciding, so it is over
  // and the tab still shows its page.
  downloaded?: boolean;
  // The navigation failed while deciding; `captureNavigation` ends the
  // watch once the preview is open.
  errored?: boolean;
  // This watch took over from a navigation still in flight (a second
  // click while the first loads), whose abort is reported to this tab next and
  // isn't this navigation failing.
  expectsAbort?: boolean;
  // The URL the tab showed as the navigation started: where going back
  // would land.
  backTo: Promise<string | undefined>;
  // The tab the preview opened in, set as soon as it's asked for, so a
  // second click's capture can wait on the first's.
  preview?: Promise<number | undefined>;
  // Resolves to whether the navigation was captured. A download is
  // only cancelled once it is known not to be the person's own, such
  // as View raw source behind a bypass.
  captured: Promise<boolean>;
  decide: (captured: boolean | Promise<boolean>) => void;
}
const watchedTabs = new Map<number, Watch>();

// How long a tab showing the raw script waits before going back. Another
// script manager may be about to rewrite it (Violentmonkey does once its
// own fetch of the script is in), and going back would cancel that.
const LEAVE_DELAY_MS = 1000;

// How long to let a back navigation commit before asking where it
// landed (see `leaveRawScript`). A back navigation to a blank or new-tab
// page commits at once.
const GO_BACK_SETTLE_MS = 300;

function newWatch(url: string, tabId: number): Watch {
  let decide!: Watch['decide'];
  const captured = new Promise<boolean>((resolve) => { decide = resolve; });
  // `webNavigation` reports any URL, where `tabs` hides `chrome://` and
  // `about:` ones without the `tabs` permission.
  const backTo = chrome.webNavigation.getFrame({ tabId, frameId: 0 })
    .then((frame) => frame?.url, () => undefined);
  return { url, state: 'deciding', backTo, captured, decide };
}

// A page not worth going back to: none, a blank page, or the new-tab
// page. A tab that would land there is closed instead.
//
// The URL comes from `getFrame` when the capture's listener runs. If
// the script had already committed by then (a worker started by this
// navigation, or a fast `file://` load), that's the script itself, and
// where going back lands is unknown until it has.
function isBlankPage(url: string | undefined): boolean {
  return !url || url === 'about:blank'
    || /^chrome:\/\/(newtab|new-tab-page)\/?$/.test(url)
    || url.startsWith('chrome-search://local-ntp');
}

function endWatch(tabId: number, w: Watch): void {
  if (watchedTabs.get(tabId) === w) watchedTabs.delete(tabId);
}

// Whether a commit is the watched script's URL. Any `.user.js` URL
// counts, so a server redirect to another one does too.
function isScriptCommit(w: Watch, url: string): boolean {
  return url === w.url || isUserJsUrl(url);
}

// Cancel a download and leave nothing behind. A small file can finish
// before the cancel lands, which makes the cancel a no-op, so a
// complete file is removed from disk before its entry is erased.
async function discardDownload(id: number): Promise<void> {
  await chrome.downloads.cancel(id);
  const [item] = await chrome.downloads.search({ id });
  if (item?.state === 'complete') await chrome.downloads.removeFile(id).catch(() => {});
  await chrome.downloads.erase({ id });
}

// After `LEAVE_DELAY_MS`, go back from the script's URL, unless another
// commit (another manager's page) ended the watch first.
function leaveRawScriptSoon(tabId: number, w: Watch): void {
  w.state = 'leaving';
  setTimeout(() => {
    if (watchedTabs.get(tabId) !== w) return;
    endWatch(tabId, w);
    void leaveRawScript(tabId, w);
  }, LEAVE_DELAY_MS);
}

// Back to the page the script link was on, or close the tab when going
// back would land on nothing worth keeping (`isBlankPage`), as for a URL
// entered in a new tab or a middle-clicked link.
//
// Not when the preview's tab is already gone: it closed itself for a web
// page (see below), and the tab is all the person has left.
//
// Not when the URL turned out to be a web page: the person was heading
// there, and the preview closes itself instead (see the viewer's markup
// handling). Asked of the document itself, since the commit doesn't say
// what was served, with the same two tests as the viewer's markup gate:
// an HTML document, or text that starts with `<` (a page served as
// JavaScript, which Chrome shows as text).
async function leaveRawScript(tabId: number, w: Watch): Promise<void> {
  const previewTabId = await w.preview;
  if (previewTabId !== undefined && !await chrome.tabs.get(previewTabId).catch(() => undefined)) return;
  const [probe] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.contentType === 'text/html'
      || (document.body?.textContent ?? '').trimStart().startsWith('<'),
  }).catch(() => []);
  if (probe?.result === true) return;
  const remove = () => chrome.tabs.remove(tabId).catch(() => {});
  const backTo = await w.backTo;
  if (backTo === undefined || !isScriptCommit(w, backTo)) {
    if (isBlankPage(backTo)) await remove();
    else await chrome.tabs.goBack(tabId).catch(remove);
    return;
  }
  // Unknown: go back, then close the tab if that landed on a blank page.
  if (!await chrome.tabs.goBack(tabId).then(() => true, () => false)) return void await remove();
  await new Promise((resolve) => setTimeout(resolve, GO_BACK_SETTLE_MS));
  const landed = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null);
  if (landed && isBlankPage(landed.url)) await remove();
}

// Open the preview in a new tab beside `tab`. `openerTabId` makes Chrome
// return to that tab when the preview is closed. Focused only if `tab`
// was: a middle-clicked background tab, or a script navigating one,
// shouldn't pull the preview forward.
async function openPreviewBeside(tab: chrome.tabs.Tab, preview: string): Promise<number | undefined> {
  return chrome.tabs.create({
    url: preview,
    active: tab.active,
    windowId: tab.windowId,
    index: tab.index + 1,
    openerTabId: tab.id,
  }).then((created) => created.id, () => undefined);
}

// In-SW mirror of the capture toggle. Read once at startup and kept
// current by the storage listener, so the navigation handler never has
// to await storage on the critical path: the watch has to be in place
// before the response can commit.
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
      const w = newWatch(d.url, d.tabId);
      // A second navigation in the same tab (a second click while the
      // first loads) takes over from the first, whose `captureNavigation` then stops. To the same
      // URL, it keeps the first's preview, if open, rather than opening
      // another, and where going back lands.
      const old = watchedTabs.get(d.tabId);
      if (old?.url === d.url) {
        w.preview = old.preview;
        w.backTo = old.backTo;
      }
      if (old && old.state !== 'leaving' && old.committedUrl === undefined && !old.downloaded) {
        w.expectsAbort = true;
      }
      old?.decide(w.captured);
      watchedTabs.set(d.tabId, w);
      void captureNavigation(d.tabId, w, d.timeStamp);
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

  wn.onCommitted.addListener((d) => {
    if (d.frameId !== 0) return;
    const w = watchedTabs.get(d.tabId);
    if (!w) return;
    if (w.state === 'deciding') {
      w.committedUrl = d.url;
      return;
    }
    // `beside` and the script: go back soon. `leaving` and anything:
    // another manager took the tab first, so stay.
    if (w.state === 'beside' && isScriptCommit(w, d.url)) leaveRawScriptSoon(d.tabId, w);
    else endWatch(d.tabId, w);
  });

  // A watched navigation turned into a download. `url` is the URL the
  // download started from, `finalUrl` where redirects took it. A
  // download item names no tab, so this matches by URL alone: a
  // download of the same URL from another tab, while a watch for it is
  // live, would be cancelled too. Watches end soon after their own
  // navigation does, which keeps that window small.
  chrome.downloads?.onCreated.addListener((item) => {
    for (const [tabId, w] of watchedTabs) {
      if (w.url !== item.url && w.url !== item.finalUrl) continue;
      void w.captured.then((captured) => {
        if (!captured) return;
        if (w.state === 'deciding') w.downloaded = true;
        else endWatch(tabId, w);
        dlog(`[SourceMonkey] cancelling the download of captured ${item.url}`);
        return discardDownload(item.id);
      }).catch(() => {});
      return;
    }
  });

  // The watched navigation failed or was stopped (Esc, a 204, a network
  // error), so nothing will commit. A navigation that becomes a download
  // fails too, and its download can be reported just after, so the
  // watch stays a moment for it.
  wn.onErrorOccurred.addListener((d) => {
    if (d.frameId !== 0) return;
    const w = watchedTabs.get(d.tabId);
    if (!w) return;
    if (w.expectsAbort) {
      w.expectsAbort = false;
      return;
    }
    if (w.state === 'deciding') w.errored = true;
    else endWatchSoon(d.tabId, w);
  });

  chrome.tabs.onRemoved.addListener((tabId) => { watchedTabs.delete(tabId); });
}

// A failed navigation's watch ends a second later: one that became a
// download fails too, and its download can be reported just after.
function endWatchSoon(tabId: number, w: Watch): void {
  setTimeout(() => endWatch(tabId, w), LEAVE_DELAY_MS);
}

async function captureNavigation(tabId: number, w: Watch, navigationStart: number): Promise<void> {
  const { url } = w;
  const current = () => watchedTabs.get(tabId) === w;
  // How long each step took, logged with the capture: a slow capture
  // shows the raw script for that long before the preview opens.
  const t0 = Date.now();
  // Before the listener ran at all: a worker started by this navigation
  // shows its startup here.
  const steps = [`listener ${Math.max(0, Math.round(t0 - navigationStart))}ms after the navigation began`];
  const step = (name: string) => steps.push(`${name} at +${Date.now() - t0}ms`);
  // Re-check against the settled flag: the sync check upstream may have
  // run against the startup default. Cheap: resolved for every
  // navigation but the first after an SW wake.
  await captureFlagReady;
  step('setting');
  const bypassed = captureEnabled && await consumeInstallBypass(url);
  step('bypass');
  if (!captureEnabled || bypassed) {
    if (captureEnabled) dlog(`[SourceMonkey] .user.js capture bypassed for ${url}`);
    endWatch(tabId, w);
    w.decide(false);
    return;
  }
  w.decide(true);
  if (!current()) return;
  // The tab may have closed (or navigated on) between the event firing
  // and these calls landing; ignore the resulting rejections.
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  step('tab');
  if (!tab) {
    endWatch(tabId, w);
    return;
  }
  if (!current()) return;
  // A second click's capture uses the first's preview, once it's
  // open, if it still is.
  const inherited = await w.preview;
  const reused = inherited !== undefined && await chrome.tabs.get(inherited).then(() => true, () => false);
  if (!reused) w.preview = openPreviewBeside(tab, buildPreviewPageUrl(url));
  const previewTabId = await w.preview;
  step(previewTabId === undefined ? 'no new tab (replacing this one)' : reused ? 'preview tab (reused)' : 'preview tab');
  console.log(`[SourceMonkey] captured .user.js navigation: ${url} (${steps.join(', then ')})`);
  if (previewTabId === undefined) {
    // Chrome can refuse a new tab here (an app or popup window). Use
    // this one rather than leave the click doing nothing, unless
    // another manager's page already took it.
    endWatch(tabId, w);
    if (w.committedUrl === undefined || isScriptCommit(w, w.committedUrl)) {
      await chrome.tabs.update(tabId, { url: buildPreviewPageUrl(url, false) }).catch(() => {});
    }
    return;
  }
  if (!current()) return;
  if (w.downloaded) {
    endWatch(tabId, w);
  } else if (w.errored) {
    w.state = 'beside';
    endWatchSoon(tabId, w);
  } else if (w.committedUrl === undefined) {
    w.state = 'beside';
  } else if (isScriptCommit(w, w.committedUrl)) {
    leaveRawScriptSoon(tabId, w);
  } else {
    endWatch(tabId, w);
  }
}
