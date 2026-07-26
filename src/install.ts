// Install-prompt page. The landing spot for a captured `.user.js`
// navigation (see `src/install-capture.ts`): it fetches the script,
// shows what it is and what it wants permission to do, and installs
// only when the user says so.
//
// Installing means `addSource(url)` — exactly what typing the URL into
// the sources page's Add field does. A web install is not a separate
// kind of script; it lands in the http (or github) container source
// and picks up the normal refresh / update behavior from there.
//
// The page never runs the fetched code. It's rendered as text through
// Prism, same as the viewer.
//
// See [docs/install-capture.md].

import {
  fetchHttpText,
  isHttpUrl,
  normalizeSourceInput,
  urlBaseName,
} from './directories.js';
import {
  installGithubAuthListener,
  loadGithubAuthToken,
} from './github-auth.js';
import { markInstallBypass, needsDownloadWorkaround } from './install-capture.js';
import { displayLocation, formatBytes } from './script-display.js';
import {
  addSource,
  describeError,
  getAllScripts,
  type StoredScript,
} from './script-store.js';
import { dropRawView, putRawView } from './raw-view.js';
import { updateScript } from './script-updater.js';
import {
  getValue,
  getValues,
  parseHeader,
  splitHeaderBody,
  type ParsedHeader,
} from './userscript-header.js';

// The page fetches over http(s) itself, so it needs its own copy of
// the cached GitHub token — same arrangement as the viewer's Refresh
// button.
installGithubAuthListener();
const githubTokenReady = loadGithubAuthToken();

declare const Prism: {
  highlightElement(el: Element): void;
};

const titleEl = document.getElementById('title') as HTMLHeadingElement;
const subtitleEl = document.getElementById('subtitle') as HTMLParagraphElement;
const bannerSlot = document.getElementById('banner-slot') as HTMLDivElement;
const messageEl = document.getElementById('message') as HTMLParagraphElement;
const detailsEl = document.getElementById('details') as HTMLDListElement;
const installBtn = document.getElementById('install-btn') as HTMLButtonElement;
const openBtn = document.getElementById('open-btn') as HTMLButtonElement;
const updateBtn = document.getElementById('update-btn') as HTMLButtonElement;
const continueBtn = document.getElementById('continue-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
const viewSourceBtn = document.getElementById('view-source-btn') as HTMLButtonElement;
const codeHeading = document.getElementById('code-heading') as HTMLHeadingElement;
const codeBox = document.getElementById('code-box') as HTMLPreElement;
const codeEl = document.getElementById('code') as HTMLElement;

// The URL as it arrived from the capture (what the user clicked), and
// the normalized form we actually fetch and store. They differ for
// github.com blob URLs, which `normalizeSourceInput` rewrites to their
// raw counterpart. Both matter: the raw form is what we hand to
// `addSource`, the clicked form is what we show and what a bypass has
// to be keyed on (that's the URL the browser will navigate to).
const clickedUrl = new URLSearchParams(location.search).get('url') ?? '';
let fetchUrl = clickedUrl;

// The fetched body, kept so "View raw source" can hand it to a new tab
// without a second round-trip. Empty until the fetch lands.
let sourceText = '';

// Parsed metadata block of the fetched script, shared by the render and
// the button wiring (which re-runs after a duplicate install).
let parsedHeader: ParsedHeader | null = null;

// Session keys backing raw-view tabs, all dropped when this page goes
// away. A set rather than a single key because each click opens its own
// tab, and two clicks can be in flight at once.
const rawViewKeys = new Set<string>();

void bootstrap();

async function bootstrap(): Promise<void> {
  cancelBtn.addEventListener('click', leavePage);
  viewSourceBtn.addEventListener('click', openRawSource);

  if (!clickedUrl || !isHttpUrl(clickedUrl)) {
    // Only reachable by hand-editing the URL — the capture never
    // produces anything but an http(s) URL.
    setMessage('No script URL to install. This page opens automatically when you click a .user.js link.', true);
    viewSourceBtn.hidden = true;
    return;
  }

  subtitleEl.textContent = 'from ';
  const link = document.createElement('a');
  // A real href so hover / copy-link-address show the true URL, but
  // the click is handled: a plain navigation to a `.user.js` URL is
  // either captured straight back here or rendered unreadably (see
  // openRawSource).
  link.href = clickedUrl;
  // Decoded for reading; the href keeps the real, encoded URL, so
  // hover / copy-link-address still hand out something that works.
  link.textContent = displayLocation(clickedUrl);
  // `auxclick` too: a middle-click would otherwise open a plain tab on
  // the `.user.js` URL, which the capture would turn into a second
  // install prompt.
  for (const type of ['click', 'auxclick']) {
    link.addEventListener(type, (ev) => {
      ev.preventDefault();
      openRawSource();
    });
  }
  subtitleEl.append(link);

  setMessage('Loading…');
  await githubTokenReady;

  let text: string;
  try {
    fetchUrl = await normalizeSourceInput(clickedUrl);
    const result = await fetchHttpText(fetchUrl);
    // `unchanged` needs a conditional request to happen, and we send
    // none — but the type includes it, so fail loudly rather than
    // rendering an empty page if that ever changes.
    if (result.kind !== 'ok') throw new Error('no content returned');
    text = result.text;
  } catch (err) {
    setMessage(`Could not fetch this script: ${describeError(err)}`, true);
    return;
  }

  setMessage('');
  sourceText = text;
  render(text);
}

function render(text: string): void {
  const split = splitHeaderBody(text);
  parsedHeader = parseHeader(text);
  const name = (parsedHeader && getValue(parsedHeader, 'name')) || urlBaseName(fetchUrl);

  titleEl.textContent = name;
  renderCode(text);

  if (split.error) {
    // Not a userscript (or a broken one). Chrome would have downloaded
    // this or shown it as source; say so and leave installing off the
    // table — `addSource` would only create an `invalid` row.
    renderBanner(
      `This file has ${split.error === 'no metadata block' ? 'no' : 'an unterminated'} ` +
        '// ==UserScript== metadata block, so it is not an installable userscript.',
    );
    renderDetails(null, text);
    installBtn.hidden = true;
    // Most likely this URL is a web page that merely ends in
    // `.user.js` — a forge's blob view, say. The capture can't tell
    // (it runs before any response headers exist), so give the user
    // the way through it lands on nothing else offers: go to the page.
    continueBtn.hidden = false;
    continueBtn.addEventListener('click', () => {
      void markInstallBypass(clickedUrl).then(() => {
        location.href = clickedUrl;
      });
    });
    return;
  }

  renderDetails(parsedHeader, text);
  void wireInstallButtons().catch((err) => {
    setMessage(`Could not check whether this is already installed: ${describeError(err)}`, true);
  });
}

// Look for an existing row for this URL and pick the button set. A
// container script's `relativePath` holds the full URL the user added
// (post-normalization), which is exactly what `addSource` would store
// for this install — so it's the field to match on.
async function wireInstallButtons(): Promise<void> {
  const scripts = await getAllScripts();
  const existing = scripts.find((s) => s.relativePath === fetchUrl);

  if (!existing) {
    installBtn.hidden = false;
    installBtn.disabled = false;
    installBtn.onclick = () => void doInstall();
    return;
  }

  renderInstalledBanner(existing, parsedHeader);
  installBtn.hidden = true;
  openBtn.hidden = false;
  openBtn.onclick = () => {
    location.href = `userscript.html?script=${encodeURIComponent(existing.id)}`;
  };
  updateBtn.hidden = false;
  updateBtn.onclick = () => void doUpdate(existing.id);
}

async function doInstall(): Promise<void> {
  const spinner = startBusy(installBtn);
  try {
    const result = await addSource(clickedUrl);
    if (!result) {
      // Raced another tab (or the same URL under a different spelling
      // that normalizes to an already-installed one). Re-run the button
      // wiring so the page converges on the Open / Update pair instead
      // of offering an Install that can only repeat this message.
      setMessage('This script is already installed.', false);
      await wireInstallButtons();
      return;
    }
    const scriptId =
      result.kind === 'existingContainer'
        ? result.scriptId
        : result.source.scriptIds[0];
    location.href = scriptId
      ? `userscript.html?script=${encodeURIComponent(scriptId)}`
      : 'sources.html';
  } catch (err) {
    setMessage(`Install failed: ${describeError(err)}`, true);
  } finally {
    spinner.remove();
    installBtn.disabled = false;
  }
}

async function doUpdate(scriptId: string): Promise<void> {
  const spinner = startBusy(updateBtn);
  try {
    await updateScript(scriptId, 'manual');
    location.href = `userscript.html?script=${encodeURIComponent(scriptId)}`;
  } catch (err) {
    setMessage(`Update failed: ${describeError(err)}`, true);
    spinner.remove();
    updateBtn.disabled = false;
  }
}

// Show the unprocessed file in a new tab, leaving the prompt open
// behind it. How we get there depends on what the browser does with a
// `.user.js` response (see install-capture.ts):
//
//   - Chrome ≥ 152 renders it as source text on its own, so navigate
//     for real — the address bar keeps the true URL. Capture is stood
//     down for that one navigation.
//   - Chrome ≤ 151 renders it only if the download workaround has
//     rewritten the response to `text/html`, which HTML-parses the
//     script into one unreadable run-on line. Show the copy we already
//     fetched on `raw.html` instead — a real page, so the tab gets a
//     title naming the file.
//
// With no fetched copy to hand over — the fetch failed, or hasn't
// landed yet — there is nothing to render locally, so it navigates on
// any version. That doubles as the retry for a URL our fetch couldn't
// read: the tab carries cookies the extension's fetch doesn't. On
// Chrome ≤ 151 the result is whatever the browser makes of it (the
// run-on-line render, or a download) — hence the label change, so the
// button doesn't promise a readable view it can't deliver.
function openRawSource(): void {
  if (!sourceText || !needsDownloadWorkaround(navigator.userAgent)) {
    // Mark the bypass before opening so the capture listener can't see
    // the navigation first.
    markInstallBypass(clickedUrl)
      .then(() => openTab(clickedUrl))
      .catch((err) => setMessage(`Could not open the source: ${describeError(err)}`, true));
    return;
  }
  putRawView({ title: urlBaseName(fetchUrl), text: sourceText })
    .then((url) => {
      const key = new URL(url).searchParams.get('key');
      if (key) rawViewKeys.add(key);
      openTab(url);
    })
    // `chrome.storage.session` is quota-limited and shared with the
    // per-script logs, so a big script can genuinely fail here. Say so
    // rather than having the button do nothing.
    .catch((err) => setMessage(`Could not open the source: ${describeError(err)}`, true));
}

// Open a new tab beside this one. `chrome.tabs.create`, not
// `window.open`: an extension page opened through `window.open` comes
// up without the `chrome.*` APIs, so `raw.html` would have no way to
// read the text handed to it.
function openTab(url: string): void {
  void chrome.tabs.create({ url });
}

// The handed-off text outlives this page unless dropped. The tabs that
// opened it have already rendered their copies by the time this fires;
// only a reload of one would notice.
addEventListener('pagehide', () => {
  for (const key of rawViewKeys) void dropRawView(key);
  rawViewKeys.clear();
});

// Cancel: back to wherever the click came from. The captured
// navigation never committed, so the previous entry is the referring
// page. A tab opened straight into the install page (target=_blank
// from a site's install button) has no history to go back to, so close
// it — via `chrome.tabs.remove`, because Chrome refuses `window.close()`
// for a tab that wasn't opened by script.
function leavePage(): void {
  if (history.length > 1) {
    history.back();
    return;
  }
  void chrome.tabs.getCurrent().then((tab) => {
    if (tab?.id != null) void chrome.tabs.remove(tab.id);
  });
}

function renderDetails(header: ParsedHeader | null, text: string): void {
  detailsEl.textContent = '';
  if (header) {
    addTextRow('Name', getValue(header, 'name'));
    addTextRow('Version', getValue(header, 'version'));
    addTextRow('Description', getValue(header, 'description'));
    addTextRow('Author', getValue(header, 'author'));
    addTextRow('Namespace', getValue(header, 'namespace'));
    addLinkRow('Homepage', getValue(header, 'homepage') ?? getValue(header, 'homepageURL'));
    addListRow('Runs on', [...getValues(header, 'match'), ...getValues(header, 'include')]);
    addListRow('Except on', getValues(header, 'exclude'));
    // The headers that decide what the script can reach beyond the page
    // it runs in. Worth their own rows — this is the part of an install
    // prompt a user is actually being asked to approve.
    addListRow('Permissions', getValues(header, 'grant'), 'grant-list');
    addListRow('Network access', getValues(header, 'connect'), 'grant-list');
    addListRow('Loads libraries', getValues(header, 'require'));
    // Whole `@resource <name> <url>` line: the URL is the part that
    // says what gets fetched, which is the point of showing it here.
    addListRow('Loads resources', getValues(header, 'resource'));
  }
  addTextRow('Size', formatBytes(new TextEncoder().encode(text).length));
  addLinkRow('URL', displayLocation(fetchUrl));
}

function addTextRow(label: string, value: string | undefined): void {
  if (!value) return;
  const dd = appendRow(label);
  dd.textContent = value;
}

function addLinkRow(label: string, value: string | undefined): void {
  if (!value) return;
  const dd = appendRow(label);
  // Rendered inert: these URLs come from the fetched file, and the one
  // navigation this page offers is the explicit View raw source button.
  const code = document.createElement('code');
  code.textContent = value;
  dd.append(code);
}

function addListRow(label: string, values: string[], cls?: string): void {
  if (values.length === 0) return;
  const dd = appendRow(label);
  if (cls) dd.className = cls;
  if (values.length === 1) {
    dd.textContent = values[0];
    return;
  }
  const ul = document.createElement('ul');
  for (const v of values) {
    const li = document.createElement('li');
    li.textContent = v;
    ul.append(li);
  }
  dd.append(ul);
}

function appendRow(label: string): HTMLElement {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  detailsEl.append(dt, dd);
  return dd;
}

function renderCode(text: string): void {
  codeHeading.hidden = false;
  codeBox.hidden = false;
  // textContent, never innerHTML — Prism walks the text nodes and adds
  // its own markup, so nothing from the fetched file is ever parsed as
  // HTML.
  codeEl.textContent = text;
  Prism.highlightElement(codeEl);
}

function renderBanner(text: string): void {
  const div = document.createElement('div');
  div.className = 'banner';
  const p = document.createElement('p');
  p.textContent = text;
  div.append(p);
  bannerSlot.append(div);
}

function renderInstalledBanner(existing: StoredScript, header: ParsedHeader | null): void {
  const installedVersion = existing.header ? getValue(existing.header, 'version') : undefined;
  const offeredVersion = header ? getValue(header, 'version') : undefined;
  let text = 'This script is already installed';
  if (installedVersion && offeredVersion && installedVersion !== offeredVersion) {
    text += ` (version ${installedVersion}; this copy says ${offeredVersion})`;
  } else if (installedVersion) {
    text += ` (version ${installedVersion})`;
  }
  text += '.';
  const div = document.createElement('div');
  div.className = 'banner installed';
  const p = document.createElement('p');
  p.textContent = text;
  div.append(p);
  bannerSlot.append(div);
}

function setMessage(text: string, isError = false): void {
  messageEl.textContent = text;
  messageEl.classList.toggle('error', isError);
}

function startBusy(btn: HTMLButtonElement): HTMLElement {
  btn.disabled = true;
  const spinner = document.createElement('span');
  spinner.className = 'busy-spinner';
  btn.after(spinner);
  return spinner;
}
