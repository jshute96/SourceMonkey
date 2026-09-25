// A count badge over the favicon of each tab `sm-dev run` controls, so
// those tabs stand out in the tab strip. It shows what the extension's
// toolbar badge shows for a tab: how many scripts are in play on the
// document, colored by how they are doing (see `computeBadge` in
// tab-status.ts). `0` still marks a controlled tab with no scripts.
//
// The badge is drawn in the page, in the isolated world, onto a copy of
// the site's own icon. The run pings it every couple of seconds; when
// the pings stop (the run ended or was killed), the page turns the
// badge grey, so a tab left over from a finished run reads as no longer
// controlled. Reloading such a tab drops the badge, since the scripts
// and this code went with the run's CDP session.

import type { Page } from '@playwright/test';

import { BADGE_GREEN, BADGE_GREY, BADGE_ORANGE, BADGE_RED } from '../tab-status.js';
import type { HarnessHost, PageLink } from './host.js';
import { explainMatch, type PreparedScript } from './prepare.js';

// Page-to-run calls, for the site's icon (which the page can't read
// back from a canvas when it is cross-origin). Isolated world only.
export const BADGE_BINDING = '__smHarnessBadge';
// How often the run pings each tab.
const PING_MS = 2000;
// How long without a ping before the page calls the run gone. Generous,
// since a busy run or a page stopped on a dialog can delay one.
const STALE_MS = 6000;
// Larger icons aren't fetched; the badge sits on a plain square instead.
const MAX_ICON_BYTES = 512 * 1024;
// Icons kept for the run, by URL, newest last.
const MAX_CACHED_ICONS = 50;

/**
 * A document of the tab, and the stretches of time it was the one
 * showing: more than one when the back/forward cache restores it.
 */
export interface BadgeDocument {
  url: string;
  spans: [from: number, to: number][];
}

export interface BadgeState {
  count: number;
  color: string;
}

export interface BadgeOptions {
  /** For tests: how often to ping, and how long the page waits for one. */
  pingMs?: number;
  staleMs?: number;
}

/**
 * The badge for one tab's current document: the scripts that match its
 * URL, plus any that started or failed there anyway, and the color the
 * extension would give them. Red for an error; orange while a matching
 * script hasn't started, or one started that doesn't match; else green.
 * The extension's purple (a script changed on disk) has no counterpart:
 * the run reloads the tabs a change affects, and says so when it can't.
 */
export function badgeState(
  host: HarnessHost,
  link: PageLink,
  scripts: readonly PreparedScript[],
  doc: BadgeDocument,
): BadgeState {
  const during = (at: number): boolean => doc.spans.some(([from, to]) => at >= from && at < to);
  const mine = <T extends { scriptId: string; at: number }>(records: T[]): Set<string> =>
    new Set(records.filter((r) => during(r.at) && host.pageOf(r) === link).map((r) => r.scriptId));
  const started = mine(host.reports.started);
  const errored = mine(host.reports.errors);
  const expected = new Set(scripts
    .filter((s) => s.spec && explainMatch(s.matching, doc.url).matches)
    .map((s) => s.spec!.id));
  const all = new Set([...expected, ...started, ...errored]);
  let color = BADGE_GREEN;
  if (errored.size > 0) color = BADGE_RED;
  else if ([...all].some((id) => expected.has(id) !== started.has(id))) color = BADGE_ORANGE;
  return { count: all.size, color };
}

// What the badge needs from its tab's attachment.
export interface BadgeChannel {
  readonly page: Page;
  readonly link: PageLink;
  readonly host: HarnessHost;
  scripts(): readonly PreparedScript[];
  currentDocument(): BadgeDocument;
  /** Add code to the isolated world of every new document, and this one. */
  addScript(source: string): Promise<void>;
  /** Evaluate in the current document's isolated world, if it has one. */
  evaluate(expression: string): Promise<void>;
  /** Called with each payload the page sends through `BADGE_BINDING`. */
  onCall(handler: (payload: string) => void): void;
}

// The badges on each host, so one pair of host listeners serves them
// all: a listener per tab would pass Node's default limit of ten, and
// print a warning into the run, once a run has a handful of tabs.
const badgesOn = new WeakMap<HarnessHost, { badges: Set<TabBadge>; listener: (record: object) => void }>();

export class TabBadge {
  private timer: NodeJS.Timeout | null = null;
  // One update at a time: a page stopped on a dialog answers nothing,
  // and pings must not pile up behind it.
  private sending = false;
  private again = false;
  private stopped = false;

  constructor(private readonly channel: BadgeChannel, private readonly options: BadgeOptions = {}) {}

  async start(): Promise<void> {
    this.channel.onCall((payload) => this.onCall(payload));
    await this.channel.addScript(pageSource(this.options.staleMs ?? STALE_MS));
    // Disposed while the script went in: `stop` has already run.
    if (this.stopped) return;
    this.listen();
    // Also the ping that keeps the badge colored.
    this.timer = setInterval(() => this.update(), this.options.pingMs ?? PING_MS);
    this.timer.unref();
    this.update();
  }

  /** Send the current state now, or as soon as the last send is done. */
  update(): void {
    if (this.stopped) return;
    if (this.sending) {
      this.again = true;
      return;
    }
    this.sending = true;
    const { host, link } = this.channel;
    const state = badgeState(host, link, this.channel.scripts(), this.channel.currentDocument());
    void this.channel.evaluate(`globalThis.__smBadgeSet && globalThis.__smBadgeSet(${JSON.stringify(state)})`)
      .catch(() => undefined)
      .finally(() => {
        this.sending = false;
        if (this.again) {
          this.again = false;
          this.update();
        }
      });
  }

  /** Stop pinging, and grey the badge now rather than when pings are missed. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.unlisten();
    await this.channel.evaluate('globalThis.__smBadgeSet && globalThis.__smBadgeSet(null)').catch(() => undefined);
  }

  // Starts and errors change the count or color; skips don't, since a
  // skipped script is already out of the count by its rules.
  private listen(): void {
    const { host } = this.channel;
    let entry = badgesOn.get(host);
    if (!entry) {
      const badges = new Set<TabBadge>();
      const listener = (record: object): void => {
        const from = host.pageOf(record);
        for (const badge of badges) if (badge.channel.link === from) badge.update();
      };
      entry = { badges, listener };
      badgesOn.set(host, entry);
      host.on('start', listener);
      host.on('script-error', listener);
    }
    entry.badges.add(this);
  }

  private unlisten(): void {
    const { host } = this.channel;
    const entry = badgesOn.get(host);
    if (!entry?.badges.delete(this) || entry.badges.size > 0) return;
    host.off('start', entry.listener);
    host.off('script-error', entry.listener);
    badgesOn.delete(host);
  }

  // The page's calls: that a new document's badge is ready, or a
  // request for the bytes of an icon it can't read itself.
  private onCall(payload: string): void {
    let href: unknown;
    try {
      href = (JSON.parse(payload) as { icon?: unknown }).icon;
    } catch {
      return;
    }
    if (typeof href !== 'string') {
      this.update();
      return;
    }
    void iconDataUrl(this.channel.page, href).then((data) => this.channel.evaluate(
      `globalThis.__smBadgeIcon && globalThis.__smBadgeIcon(${JSON.stringify(href)}, ${JSON.stringify(data)})`,
    )).catch(() => undefined);
  }
}

// Icons by URL, for the run. Fetched through the browser context, so a
// site's cookies go along, as they do for the tab's own icon request.
// A failure isn't kept, so a network blip costs one document its icon,
// not the rest of the run.
const icons = new Map<string, Promise<string | null>>();

function iconDataUrl(page: Page, href: string): Promise<string | null> {
  const known = icons.get(href);
  if (known) {
    // Newest last, so the oldest goes first when the cache is full.
    icons.delete(href);
    icons.set(href, known);
    return known;
  }
  const fetching = fetchIcon(page, href);
  icons.set(href, fetching);
  while (icons.size > MAX_CACHED_ICONS) icons.delete(icons.keys().next().value!);
  void fetching.then((data) => {
    if (data === null && icons.get(href) === fetching) icons.delete(href);
  });
  return fetching;
}

// Images only. Code in the isolated world can ask for any URL, so a
// userscript could otherwise read a page through here without the
// `@connect` check its own requests get.
async function fetchIcon(page: Page, href: string): Promise<string | null> {
  if (!/^https?:/i.test(href)) return null;
  try {
    const res = await page.context().request.get(href, { timeout: 5000, maxRedirects: 5 });
    if (!res.ok()) return null;
    const body = await res.body();
    if (body.byteLength === 0 || body.byteLength > MAX_ICON_BYTES) return null;
    let type = (res.headers()['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    // `.ico` files are often served untyped; the ICO signature tells.
    if (!type.startsWith('image/') && body.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) type = 'image/x-icon';
    if (!type.startsWith('image/')) return null;
    return `data:${type};base64,${body.toString('base64')}`;
  } catch {
    return null;
  }
}

// The page's side, in the isolated world, top frame only. Draws the
// site's icon with the badge on a canvas and makes that the tab's icon.
//
// - The site's own icon links are kept but set aside (their `rel`
//   renamed), so the browser has only ours to pick; Chrome doesn't
//   reliably take the last of several. A site that changes its icon
//   later is followed, whether it adds a link, changes a set-aside
//   one, or finds ours as "the" icon link and sets its `href`.
// - Same-origin icons load directly; others come from the run, since a
//   cross-origin image would taint the canvas.
// - A tab taken over from an earlier run still has that run's badge
//   code in the page. Chrome hands the new session the same named
//   world, so that code simply carries on with the new run's pings.
//   Should a world ever not be shared, two instances would take each
//   other's links for the site's, so only the newest, named on the
//   root element, draws, and an older one stops.
//
// `__smBadgeSet(state)` comes from the run with every ping; `null`
// means the run is ending. `__smBadgeIcon(href, dataUrl)` answers a
// request for an icon's bytes.
//
// Registering it creates the isolated world in every frame, not just
// the top, as a script with `@grant`s would; that costs an empty
// context per frame.
function pageSource(staleMs: number): string {
  return `(function(){
  if (self !== top || globalThis.__smBadgeSet) return;
  var BINDING = ${JSON.stringify(BADGE_BINDING)};
  var STALE_MS = ${staleMs};
  var GREY = ${JSON.stringify(BADGE_GREY)};
  var SIZE = 32;
  var ICON_WAIT_MS = 10000;
  var owner = Math.random().toString(36).slice(2);
  var state = null;
  var lastPing = 0;
  var lastTick = Date.now();
  var connected = false;
  var siteIcon = null;
  var images = Object.create(null);
  var link = null;
  var linkHref = '';
  var drawn = '';
  var observer = null;
  var ticker = 0;
  function call(message) {
    var fn = globalThis[BINDING];
    if (typeof fn === 'function') { try { fn(JSON.stringify(message)); } catch (e) {} }
  }
  function isIcon(el) {
    return el.localName === 'link' && !el.hasAttribute('data-sm-badge')
      && (el.getAttribute('rel') || '').toLowerCase().split(/\\s+/).indexOf('icon') >= 0;
  }
  // Whether this is still the newest instance. A root the site rebuilt
  // without the mark is taken back rather than taken as a newer one.
  function current() {
    var root = document.documentElement;
    if (!root) return false;
    var mark = root.getAttribute('data-sm-badge-owner');
    if (!mark) root.setAttribute('data-sm-badge-owner', owner);
    return !mark || mark === owner;
  }
  // Superseded by a newer run's instance: leave the page to it.
  function retire() {
    if (observer) observer.disconnect();
    clearInterval(ticker);
  }
  // Sets aside the site's icon links, noting the last one's URL, which
  // is also the newest when a site adds one to change its icon.
  function takeSiteIcons() {
    var links = document.querySelectorAll('link[rel]');
    for (var i = 0; i < links.length; i++) {
      var el = links[i];
      if (!isIcon(el)) continue;
      el.setAttribute('data-sm-rel', el.getAttribute('rel'));
      el.setAttribute('rel', 'sm-set-aside-icon');
      if (el.href) siteIcon = el.href;
    }
  }
  function defaultIcon() {
    return /^https?:$/.test(location.protocol) ? location.origin + '/favicon.ico' : null;
  }
  function image(href) {
    var entry = images[href];
    if (entry !== undefined) return entry;
    images[href] = 'loading';
    var sameOrigin = false;
    try { sameOrigin = new URL(href).origin === location.origin; } catch (e) {}
    if (/^data:/i.test(href) || sameOrigin) {
      load(href, href);
    } else {
      call({ icon: href });
      // A reply lost on the way is taken as no icon, not waited on.
      setTimeout(function () { if (images[href] === 'loading') load(href, null); }, ICON_WAIT_MS);
    }
    return 'loading';
  }
  function load(href, data) {
    if (!data) { images[href] = null; draw(); return; }
    var img = new Image();
    img.onload = function () { images[href] = img; draw(); };
    img.onerror = function () { images[href] = null; draw(); };
    img.src = data;
  }
  globalThis.__smBadgeIcon = load;
  function draw() {
    if (!state || !document.head) return;
    if (!current()) { retire(); return; }
    var href = siteIcon || defaultIcon();
    var img = href ? image(href) : null;
    // Drawn without the site's icon only once it's known there is none,
    // so the tab doesn't flash a plain square while it loads.
    if (img === 'loading') return;
    var color = connected ? state.color : GREY;
    var text = state.count > 99 ? '99+' : String(state.count);
    var key = [href, img ? 'icon' : 'none', color, text].join(' ');
    if (key === drawn && link && link.isConnected && link.getAttribute('href') === linkHref) return;
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    var ctx = canvas.getContext('2d');
    if (img) {
      // Fitted, keeping its shape: an SVG sized only by its viewBox
      // can be wider than it is tall.
      var w0 = img.naturalWidth || SIZE, h0 = img.naturalHeight || SIZE;
      var scale = Math.min(SIZE / w0, SIZE / h0);
      var dw = w0 * scale, dh = h0 * scale;
      try { ctx.drawImage(img, (SIZE - dw) / 2, (SIZE - dh) / 2, dw, dh); } catch (e) { img = null; }
    }
    if (!img) {
      ctx.fillStyle = '#9e9e9e';
      ctx.beginPath();
      ctx.roundRect(2, 2, SIZE - 4, SIZE - 4, 6);
      ctx.fill();
    }
    ctx.font = 'bold 19px sans-serif';
    var h = 20;
    var w = Math.min(SIZE, Math.max(h, ctx.measureText(text).width + 6));
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(SIZE - w, SIZE - h, w, h, 6);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, SIZE - w / 2, SIZE - h / 2 + 1, w - 2);
    var url;
    try { url = canvas.toDataURL('image/png'); } catch (e) { return; }
    drawn = key;
    linkHref = url;
    // A new element each time: the browser reliably rereads the tab's
    // icon when one is added.
    if (link) link.remove();
    link = document.createElement('link');
    link.rel = 'icon';
    link.href = url;
    // What it shows, for tests and anyone inspecting the page.
    link.setAttribute('data-sm-badge', text + ' ' + color);
    document.head.appendChild(link);
  }
  function onChanges(records) {
    var changed = false;
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === 'attributes') {
        var el = r.target;
        if (el === link) {
          // Site code that took ours for the icon link and set it: that
          // is the site's icon now.
          if (r.attributeName === 'href' && el.getAttribute('href') !== linkHref) { siteIcon = el.href; changed = true; }
        } else if (el.hasAttribute('data-sm-rel')) {
          if (r.attributeName === 'href') { siteIcon = el.href; changed = true; }
        } else if (isIcon(el)) {
          changed = true;
        }
      } else {
        // Only icon links matter, so a busy page's other changes cost
        // no more than this check.
        for (var j = 0; j < r.addedNodes.length; j++) {
          if (r.addedNodes[j].nodeType === 1 && isIcon(r.addedNodes[j])) changed = true;
        }
        for (var k = 0; k < r.removedNodes.length; k++) {
          if (r.removedNodes[k] === link) changed = true;
        }
      }
    }
    if (!changed) return;
    takeSiteIcons();
    draw();
  }
  function watch() {
    document.documentElement.setAttribute('data-sm-badge-owner', owner);
    // An earlier run's badge is the old instance's, not the site's.
    var old = document.querySelectorAll('link[data-sm-badge]');
    for (var i = 0; i < old.length; i++) old[i].remove();
    takeSiteIcons();
    // The browser only takes icons from the head, so only it is watched.
    observer = new MutationObserver(onChanges);
    observer.observe(document.head || document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['rel', 'href'] });
    draw();
  }
  globalThis.__smBadgeSet = function (next) {
    if (next === null) {
      connected = false;
    } else {
      state = next;
      connected = true;
      lastPing = Date.now();
    }
    draw();
  };
  ticker = setInterval(function () {
    var now = Date.now();
    // A tick that comes late in a showing tab means the page itself was
    // held up (a dialog, a restore from the back/forward cache), and
    // the pings with it; they get a fresh wait rather than a grey flash.
    // A hidden tab's timers are slowed on purpose, so there it isn't.
    if (now - lastTick > 3000 && document.visibilityState === 'visible') lastPing = now;
    lastTick = now;
    if (connected && now - lastPing > STALE_MS) { connected = false; draw(); }
  }, 1000);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
  else watch();
  call({ ready: true });
})();`;
}
