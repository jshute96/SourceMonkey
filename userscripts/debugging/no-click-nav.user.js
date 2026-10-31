// ==UserScript==
// @name         Navigate without clicking (test helper)
// @namespace    sourcemonkey-test
// @version      1.4.2
// @description  Hovering a link 2s follows it, hovering Back goes back; Alt-C (hovered link), Alt-B (back) and Alt-L (asks for a URL) navigate after 3s
// @match        *://*/*
// @match        file:///*
// @grant        none
// ==/UserScript==

(function () {
  // The label lives in a shadow root under a custom element, so page CSS
  // (div rules, inherited fonts, root font-size) can't restyle it.
  const host = document.createElement('sm-no-click-nav');
  host.style.cssText = 'all:initial !important';
  const shadow = host.attachShadow({ mode: 'closed' });
  // Bottom right, so it stays clear of Chrome's link-URL bubble on the left.
  shadow.innerHTML = `<style>
    div { all: initial; }
    #bar {
      position: fixed; bottom: 8px; right: 8px; z-index: 2147483647;
      display: flex; align-items: center; gap: 6px; max-width: 70vw;
      font: 12px/1.3 system-ui, sans-serif; color: #fff;
    }
    #badge, #back { font: inherit; color: inherit; border-radius: 4px; opacity: .85; }
    #badge {
      padding: 4px 8px; background: #222; pointer-events: none; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #back { padding: 8px 16px; background: #246; cursor: pointer; flex: none; }
  </style><div id="bar"><div id="badge"></div><div id="back">Back</div></div>`;
  const bar = shadow.getElementById('bar');
  const badge = shadow.getElementById('badge');
  const back = shadow.getElementById('back');

  // Chrome's per-site zoom (Ctrl +/-) scales CSS pixels, so cancel it out.
  // Pages can't read the zoom level directly; outerWidth/innerWidth
  // approximates it, snapped to Chrome's preset levels.
  const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
  const unzoom = () => {
    const ratio = outerWidth / innerWidth;
    const zoom = ZOOM_LEVELS.reduce((a, b) => (Math.abs(b - ratio) < Math.abs(a - ratio) ? b : a));
    bar.style.zoom = String(1 / zoom);
  };
  unzoom();
  addEventListener('resize', unzoom);
  const showBadge = (text) => {
    badge.textContent = text;
    if (!host.isConnected) document.documentElement.appendChild(host);
  };
  const KEY_DELAY_S = 3;
  const HOVER_DELAY_S = 2;
  const IDLE_TEXT =
    `Hover a link ${HOVER_DELAY_S}s to follow it. In ${KEY_DELAY_S}s: ` +
    'Alt-C follows hovered link, Alt-B goes back, Alt-L opens a URL';

  // "example.com" would otherwise resolve as a path on the current site.
  // Checks for "scheme://" rather than just "scheme:" so "localhost:8000"
  // still gets http:// added.
  const withScheme = (url) =>
    /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^(about|data|javascript|mailto|blob):/i.test(url)
      ? url
      : `http://${url}`;

  // Only one countdown runs at a time; starting another replaces it.
  // `fromHover` lets moving off the link cancel a hover countdown without
  // cancelling one started by a key.
  let countdown = null;
  let fromHover = false;

  function cancel() {
    clearInterval(countdown);
    countdown = null;
    fromHover = false;
  }

  function later(seconds, what, action, hover = false) {
    cancel();
    fromHover = hover;
    let left = seconds;
    const tick = () => {
      if (left <= 0) {
        cancel();
        // Reset first, for actions that stay on this page (a #hash link).
        showBadge(IDLE_TEXT);
        action();
        return;
      }
      showBadge(`${what} in ${left}s`);
      left--;
    };
    countdown = setInterval(tick, 1000);
    tick();
  }

  let hovered = null;

  document.addEventListener('mouseover', (e) => {
    const a = e.target.closest?.('a[href]') ?? null;
    if (a === hovered) return;
    hovered = a;
    if (countdown !== null && !fromHover) return;
    if (a) {
      later(HOVER_DELAY_S, `Following ${a.href}`, () => { location.href = a.href; }, true);
    } else {
      cancel();
      showBadge(IDLE_TEXT);
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const key = e.key.toLowerCase();
    if (key === 'c' && hovered) {
      e.preventDefault();
      const href = hovered.href;
      later(KEY_DELAY_S, `Following ${href}`, () => { location.href = href; });
    } else if (key === 'b') {
      e.preventDefault();
      later(KEY_DELAY_S, 'Going back', () => history.back());
    } else if (key === 'l') {
      e.preventDefault();
      const url = prompt(`URL to open in ${KEY_DELAY_S}s:`, hovered?.href ?? location.href);
      if (url?.trim()) {
        const target = withScheme(url.trim());
        later(KEY_DELAY_S, `Opening ${target}`, () => { location.href = target; });
      }
    }
  }, true);

  // Keys don't reach the page while the popup has focus, so Back also has
  // a hover target, like links. The page's mouseover handler runs first and
  // sees no link here, so it has already cancelled any hover countdown.
  back.addEventListener('mouseenter', () => {
    if (countdown !== null && !fromHover) return;
    later(HOVER_DELAY_S, 'Going back', () => history.back(), true);
  });
  back.addEventListener('mouseleave', () => {
    if (!fromHover) return;
    cancel();
    showBadge(IDLE_TEXT);
  });
  back.addEventListener('click', () => {
    cancel();
    history.back();
  });

  // Going back can restore this page from the back/forward cache with the
  // label still showing the last countdown, so reset it.
  addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    cancel();
    hovered = null;
    showBadge(IDLE_TEXT);
  });

  showBadge(IDLE_TEXT);
})();
