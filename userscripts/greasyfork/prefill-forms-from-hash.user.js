// ==UserScript==
// @name         Greasy Fork: Fill post/update/import forms from URL parameters
// @namespace    https://github.com/jshute96/SourceMonkey
// @version      0.2.11
// @description  Fills Greasy Fork's new script, new version, and import script forms from URL parameters, so they can be opened pre-filled.
// @author       Jeff Shute <jshute@gmail.com>
// @license      MIT
// @icon         https://jshute96.github.io/SourceMonkey/userscripts/site-icons/greasyfork.org.png
// @match        https://jshute96.github.io/SourceMonkey/userscripts/greasyfork/open-prefilled-form.html*
// @match        https://greasyfork.org/script_versions/new*
// @match        https://greasyfork.org/*/script_versions/new*
// @match        https://greasyfork.org/scripts/*/versions/new*
// @match        https://greasyfork.org/*/scripts/*/versions/new*
// @match        https://greasyfork.org/import*
// @match        https://greasyfork.org/*/import*
// @match        file:///*/userscripts/greasyfork/open-prefilled-form.html*
// @grant        GM_xmlhttpRequest
// @connect      greasyfork.org
// @connect      localhost
// @noframes
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[gf-prefill]';

  // Greasy Fork prefixes most paths with a locale ("/en/scripts/..."), but the
  // locale is optional. Everything below matches with or without it.
  //
  // The @match patterns already narrow us to these three pages (and the
  // opener page, handled apart from them), but they can't express "one
  // optional locale segment" (their wildcards span slashes), so these are the
  // precise version, and they also tell us *which* page we're on.
  const LOCALE = '(?:/[a-z]{2}(?:-[A-Za-z]{2,4})?)?';
  const PAGE_PATTERNS = [
    { page: 'new-script', re: new RegExp(`^${LOCALE}/script_versions/new/?$`) },
    { page: 'new-version', re: new RegExp(`^${LOCALE}/scripts/\\d+[^/?#]*/versions/new/?$`) },
    { page: 'import', re: new RegExp(`^${LOCALE}/import/?$`) },
  ];

  // Image types the attachments input accepts, plus the code upload's type.
  // Used to label the File objects we synthesise; Greasy Fork sniffs content
  // server-side, but a wrong type here makes the input reject the drop.
  const MIME_BY_EXTENSION = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    js: 'text/javascript',
    css: 'text/css',
  };

  function detectPage(pathname) {
    for (const { page, re } of PAGE_PATTERNS) {
      if (re.test(pathname)) return page;
    }
    return null;
  }

  // Resolves when the form is parsed and the page's own setup has run, which
  // is about when a document-idle script would start.
  //
  // A DOMContentLoaded listener added at document-start is registered ahead of
  // the page's, so it runs first. The timeout lets the page's listeners go
  // before we touch the form. A manager can also start us after the event has
  // fired, so don't wait for it then.
  function whenDomReady() {
    return new Promise((resolve) => {
      if (document.readyState !== 'loading') {
        resolve();
        return;
      }
      document.addEventListener('DOMContentLoaded', () => setTimeout(resolve, 0), { once: true });
    });
  }

  // Every parameter we understand, per page. Used to warn about typos and
  // about parameters aimed at the wrong page — both of which otherwise just
  // do nothing, which you don't notice until after posting.
  const SCRIPT_FORM_PARAMS = [
    'code', 'code_url', 'code_upload',
    'additional_info_html', 'additional_info_markdown',
    'additional_info_html_url', 'additional_info_markdown_url',
    'image_files', 'script_type', 'name', 'description', 'adult', 'source_editor',
  ];
  const KNOWN_PARAMS = {
    'new-script': [...SCRIPT_FORM_PARAMS, 'script_locale'],
    'new-version': [
      ...SCRIPT_FORM_PARAMS,
      'changelog_html', 'changelog_markdown',
      'changelog_html_url', 'changelog_markdown_url',
      'remove_images',
    ],
    import: ['urls', 'language', 'sync_type'],
  };
  // Accepted everywhere. "submit" is listed so that a URL built before it was
  // disabled gets a real explanation rather than "unknown parameter".
  const COMMON_PARAMS = ['keep_hash', 'submit'];

  function warnAboutUnknownParams(params, page) {
    const known = new Set([...KNOWN_PARAMS[page], ...COMMON_PARAMS]);
    const everywhere = new Set(Object.values(KNOWN_PARAMS).flat());
    for (const key of params.keys()) {
      if (known.has(key)) continue;
      if (everywhere.has(key)) {
        console.error(`${TAG} parameter "${key}" is not available on the ${page} page; ignored`);
      } else {
        console.error(`${TAG} unknown parameter "${key}"; ignored`);
      }
    }
  }

  // Warn about combinations where one value silently wins over another.
  function warnAboutConflicts(params) {
    const groups = [
      ['code', 'code_url', 'code_upload'],
      ['additional_info_html', 'additional_info_markdown',
       'additional_info_html_url', 'additional_info_markdown_url'],
      ['changelog_html', 'changelog_markdown',
       'changelog_html_url', 'changelog_markdown_url'],
    ];
    for (const group of groups) {
      const given = group.filter((key) => params.has(key));
      if (given.length > 1) {
        console.error(`${TAG} only one of ${given.join(', ')} is used; the first listed wins`);
      }
    }
  }

  // Flags accept the usual spellings; "#adult" with no value means true.
  const TRUE_VALUES = ['1', 'true', 'yes', 'on', ''];
  const FALSE_VALUES = ['0', 'false', 'no', 'off'];

  function readFlag(params, key) {
    if (!params.has(key)) return null;
    const value = params.get(key).trim().toLowerCase();
    if (TRUE_VALUES.includes(value)) return true;
    if (FALSE_VALUES.includes(value)) return false;
    console.error(`${TAG} "${key}=${params.get(key)}" is not a yes/no value; ignored`);
    return null;
  }

  // Parse the hash ourselves rather than with URLSearchParams: that class
  // decodes "+" as a space, which silently corrupts any JavaScript we're
  // pasting into the code field. Values are expected to be
  // encodeURIComponent-encoded; a literal "+" survives as "+".
  function parseHash() {
    const params = new Map();
    const raw = location.hash.replace(/^#/, '');
    if (!raw) return params;
    for (const pair of raw.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const key = eq === -1 ? pair : pair.slice(0, eq);
      const value = eq === -1 ? '' : pair.slice(eq + 1);
      try {
        params.set(decodeURIComponent(key), decodeURIComponent(value));
      } catch (e) {
        console.error(`${TAG} could not decode hash parameter "${key}":`, e);
      }
    }
    return params;
  }

  // ---------- Loading remote / local content ----------

  // The URLs serve-files.py serves. The match is the part that names one
  // running server, without the "/" after it.
  const FILE_SERVER_URL = /^http:\/\/[^/]+\/gf-prefill-[A-Za-z0-9_-]{16,}(?=\/)/;
  const LOOPBACK_HOST = /^(?:localhost|.*\.localhost|127(?:\.\d+){3}|\[::1\]|0\.0\.0\.0)$/i;

  // These URLs come from a link anyone could have written, and what they load
  // lands in a form the person may post. So there are no local paths or file://
  // reads, and on this machine only the file server's own URLs: other local
  // services are off limits. This has to be enforced here, since @connect only
  // covers hosts, and not every manager enforces it.
  function assertLoadable(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Cannot load "${url}": It is not a full http or https URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Cannot load "${url}": Only http and https URLs can be loaded`);
    }
    if (LOOPBACK_HOST.test(parsed.hostname) && !FILE_SERVER_URL.test(parsed.href)) {
      throw new Error(`Cannot load "${url}": Only the file server from greasyfork-url.py can be used on this machine`);
    }
  }

  // GM_xmlhttpRequest bypasses CORS, which plain fetch() can't do for most
  // hosts. We fall back to fetch() if the grant isn't available.
  async function loadUrl(target, responseType) {
    assertLoadable(target);
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: target,
          responseType: responseType === 'blob' ? 'blob' : 'text',
          onload: (res) => {
            const body = responseType === 'blob' ? res.response : res.responseText;
            if (res.status >= 400) {
              reject(new Error(`HTTP ${res.status} for ${target}`));
            } else if (body == null || (responseType === 'blob' && body.size === 0)) {
              reject(new Error(`empty response for ${target}`));
            } else {
              resolve(body);
            }
          },
          onerror: () => reject(new Error(`request failed for ${target}`)),
          ontimeout: () => reject(new Error(`request timed out for ${target}`)),
        });
      });
    }
    return fetch(target).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${target}`);
      return responseType === 'blob' ? res.blob() : res.text();
    });
  }

  async function loadFile(pathOrUrl) {
    const blob = await loadUrl(pathOrUrl, 'blob');
    const name = decodeURIComponent(pathOrUrl.split(/[?#]/)[0].split('/').pop() || 'upload');
    const extension = name.split('.').pop().toLowerCase();
    const type = blob.type && blob.type !== 'application/octet-stream'
      ? blob.type
      : (MIME_BY_EXTENSION[extension] || 'application/octet-stream');
    return new File([blob], name, { type });
  }

  // ---------- Setting form controls ----------

  function setText(selector, value) {
    const field = document.querySelector(selector);
    if (!field) {
      console.error(`${TAG} field not found: ${selector}`);
      return false;
    }
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    console.log(`${TAG} set ${selector} (${value.length} chars)`);
    return true;
  }

  function setRadio(selector) {
    const radio = document.querySelector(selector);
    if (!radio) {
      console.error(`${TAG} radio not found: ${selector}`);
      return false;
    }
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    console.log(`${TAG} selected radio ${selector}`);
    return true;
  }

  // File inputs can't be assigned a path, but they can be assigned a FileList,
  // and a DataTransfer is the only way to build one. Order is preserved, which
  // is what decides the display order of image attachments.
  function setFiles(selector, files) {
    const input = document.querySelector(selector);
    if (!input) {
      console.error(`${TAG} file input not found: ${selector}`);
      return false;
    }
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    console.log(`${TAG} attached ${files.length} file(s) to ${selector}: ${files.map((f) => f.name).join(', ')}`);
    return true;
  }

  // The additional-info and changelog fields each live in a .previewable
  // wrapper holding Write/Preview tabs and the textarea. Clicking the Preview
  // tab makes Greasy Fork render the text we just typed.
  function showPreview(textareaSelector) {
    const textarea = document.querySelector(textareaSelector);
    const previewable = textarea && textarea.closest('.previewable');
    const tab = previewable && previewable.querySelector('a.preview-tab');
    if (!tab) {
      console.error(`${TAG} preview tab not found for ${textareaSelector}`);
      return;
    }
    tab.click();
    console.log(`${TAG} clicked the Preview tab for ${textareaSelector}`);
  }

  // Greasy Fork's "Enable syntax-highlighting source editor" checkbox swaps
  // the code textarea for an ace editor, seeded from the textarea's value at
  // page load and hidden behind it. On submit, Greasy Fork copies the ace
  // content back over the textarea — so anything we write into the textarea
  // while the editor is up is silently discarded when the form posts.
  //
  // Turning the editor off avoids that. Order matters: unchecking makes Greasy
  // Fork copy ace's content *into* the textarea, so it has to happen before we
  // write, not after. The box is unchecked by default, but Chrome restores
  // checkbox state across reloads, so it can be on at load time.
  //
  // Returns whether it tore anything down, so the caller can write again.
  function ensureSourceEditorOff() {
    let changed = false;
    const toggle = document.querySelector('input.enable-source-editor');
    if (toggle && toggle.checked) {
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      changed = true;
      console.log(`${TAG} turned off the syntax-highlighting editor so the code field can be set`);
    }
    // Greasy Fork imports the ace module before building the editor, so the
    // editor can appear *after* the checkbox was unticked — and unticking a
    // box that has no editor yet does nothing. What actually protects our
    // text is this element's absence: Greasy Fork's submit hook only copies
    // the editor over the textarea while it exists.
    const editor = document.getElementById('ace-editor');
    if (editor) {
      editor.remove();
      const textarea = document.getElementById('script_version_code');
      if (textarea) textarea.style.display = '';
      changed = true;
      console.log(`${TAG} removed the syntax-highlighting editor covering the code field`);
    }
    return changed;
  }

  // Turn the editor on, once the code is already in the textarea — ace seeds
  // itself from the textarea's current value, so this order preserves it.
  function enableSourceEditor() {
    const toggle = document.querySelector('input.enable-source-editor');
    if (!toggle) {
      console.error(`${TAG} syntax-highlighting checkbox not found`);
      return;
    }
    if (toggle.checked) return;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    console.log(`${TAG} turned on the syntax-highlighting editor`);
  }

  // ---------- Field groups shared by the two script forms ----------

  // "additional_info_html" / "additional_info_markdown" (and the changelog
  // equivalents) pick the markup radio and fill the text in one parameter.
  // Each also accepts an "_url" variant that loads the text from a URL.
  async function applyMarkupField(params, spec) {
    for (const markup of ['html', 'markdown']) {
      const inlineKey = `${spec.prefix}_${markup}`;
      const urlKey = `${inlineKey}_url`;
      let text = null;
      if (params.has(inlineKey)) {
        text = params.get(inlineKey);
      } else if (params.has(urlKey)) {
        text = await loadUrl(params.get(urlKey), 'text');
        console.log(`${TAG} loaded ${inlineKey} from ${params.get(urlKey)}`);
      }
      if (text === null) continue;
      setRadio(spec.radio(markup));
      setText(spec.textarea, text);
      return spec.textarea;
    }
    return null;
  }

  const ADDITIONAL_INFO = {
    prefix: 'additional_info',
    radio: (markup) => `#script_version_additional_info_0_value_markup_${markup}`,
    textarea: '#script-version-additional-info-0',
  };

  const CHANGELOG = {
    prefix: 'changelog',
    radio: (markup) => `#script_version_changelog_markup_${markup}`,
    textarea: '#script_version_changelog',
  };

  const SCRIPT_TYPE_VALUES = { public: '1', unlisted: '2', library: '3', 1: '1', 2: '2', 3: '3' };

  async function applyScriptForm(params, page) {
    const previewTargets = [];

    // Code: inline text, text loaded from a URL, or a real file upload.
    if (params.has('code') || params.has('code_url')) {
      ensureSourceEditorOff();
      let code = params.get('code');
      if (code === undefined) {
        code = await loadUrl(params.get('code_url'), 'text');
        console.log(`${TAG} loaded code from ${params.get('code_url')} (${code.length} chars)`);
      }
      setText('#script_version_code', code);
      // The editor can finish building while we were fetching, seeded from
      // the value the field had before us. If it did, drop it and write again.
      if (ensureSourceEditorOff()) setText('#script_version_code', code);
    }

    // Explicit control over the syntax-highlighting editor. Applied after the
    // code so that switching it on hands ace the text we just wrote; without
    // this parameter the editor is only ever turned off, and only when we're
    // setting the code.
    const sourceEditor = readFlag(params, 'source_editor');
    if (sourceEditor === true) enableSourceEditor();
    else if (sourceEditor === false) ensureSourceEditorOff();
    if (params.has('code_upload')) {
      setFiles('#code-upload', [await loadFile(params.get('code_upload'))]);
    }

    previewTargets.push(await applyMarkupField(params, ADDITIONAL_INFO));
    if (page === 'new-version') {
      previewTargets.push(await applyMarkupField(params, CHANGELOG));
    }

    if (params.has('image_files')) {
      const paths = params.get('image_files').split(',').map((p) => p.trim()).filter(Boolean);
      const files = [];
      // Sequential, not Promise.all: the order of the resulting FileList is
      // the order the images appear in, so keep it deterministic.
      for (const path of paths) files.push(await loadFile(path));
      setFiles('#script_version_attachments', files);
    }

    // Existing attachments on the new-version page each get a
    // "remove-attachment-<signed id>" checkbox. "all" is the documented
    // value; a plain yes/no is accepted too since it reads the same.
    if (params.has('remove_images')) {
      const value = params.get('remove_images').trim().toLowerCase();
      const removing = value === 'all' ? true : readFlag(params, 'remove_images');
      if (removing) {
        const boxes = document.querySelectorAll('input[type="checkbox"][id^="remove-attachment-"]');
        for (const box of boxes) {
          box.checked = true;
          box.dispatchEvent(new Event('change', { bubbles: true }));
        }
        console.log(`${TAG} marked ${boxes.length} existing attachment(s) for removal`);
      }
    }

    if (params.has('script_type')) {
      const value = SCRIPT_TYPE_VALUES[params.get('script_type').toLowerCase()];
      if (value) {
        setRadio(`#script_script_type_${value}`);
      } else {
        console.error(`${TAG} unknown script_type: ${params.get('script_type')}`);
      }
    }

    // Only shown for the Library script type, but harmless to set either way.
    if (params.has('name')) setText('#library-name', params.get('name'));
    if (params.has('description')) setText('#library-description', params.get('description'));

    if (params.has('script_locale')) applyLocale(params.get('script_locale'));

    const adult = readFlag(params, 'adult');
    if (adult !== null) {
      const box = document.getElementById('script_adult_content_self_report');
      if (!box) {
        console.error(`${TAG} adult content checkbox not found`);
      } else {
        box.checked = adult;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        console.log(`${TAG} set adult content flag to ${box.checked}`);
      }
    }

    return previewTargets.filter(Boolean);
  }

  // The locale select's option values are numeric database ids, which nobody
  // wants to memorise, so also accept the visible label or its parenthesised
  // language code ("Spanish", "es").
  function applyLocale(wanted) {
    const select = document.querySelector('select[name="script[locale_id]"]');
    if (!select) {
      console.error(`${TAG} locale select not found`);
      return;
    }
    const needle = wanted.trim().toLowerCase();
    const match = [...select.options].find((option) => {
      if (option.value === wanted) return true;
      // Labels read "Spanish (es)": match all of it, the name before the
      // code, or the code.
      const label = option.textContent.trim().toLowerCase();
      const code = label.match(/^(.*?)\s*\(([^)]+)\)$/);
      return label === needle || (code && (code[1] === needle || code[2] === needle));
    });
    if (!match) {
      console.error(`${TAG} no locale option matching "${wanted}"`);
      return;
    }
    select.value = match.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    console.log(`${TAG} set locale to ${match.textContent.trim()}`);
  }

  function applyImportForm(params) {
    if (params.has('urls')) {
      // Accept commas as well as newlines so a launcher doesn't have to encode
      // %0A; the textarea itself wants one URL per line.
      const urls = params.get('urls').split(/[\n,]/).map((u) => u.trim()).filter(Boolean);
      setText('#sync-urls', urls.join('\n'));
    }
    if (params.has('language')) {
      const language = params.get('language').toLowerCase();
      const id = { detect: 'sync-language-detect', '': 'sync-language-detect', js: 'sync-language-js', css: 'sync-language-css' }[language];
      if (id) {
        setRadio(`#${id}`);
      } else {
        console.error(`${TAG} unknown language: ${params.get('language')}`);
      }
    }
    if (params.has('sync_type')) {
      const type = params.get('sync_type').toLowerCase();
      const id = { automatic: 'sync-type-2', manual: 'sync-type-1' }[type];
      if (id) {
        setRadio(`#${id}`);
      } else {
        console.error(`${TAG} unknown sync_type: ${params.get('sync_type')}`);
      }
    }
    return [];
  }

  // ---------- Submitting (disabled) ----------
  //
  // Auto-submit is deliberately switched off. The parameters live in a URL,
  // and a URL is clickable from anywhere — an email, a forum post, a
  // redirect. A "submit" parameter that worked would mean one click on a
  // link someone else wrote posts a script to your Greasy Fork account with
  // nothing shown to you first. Prompting first would be no better than the
  // intended workflow, which is: open the filled form, read the preview,
  // click the site's own button.
  //
  // Kept here rather than deleted so it's clear this was a decision, and
  // what it would take to undo. The two forms differ: "Post new version"
  // and "Import" are plain submit inputs, while "Post script" can be a
  // button wired to invisible reCAPTCHA whose token is attached by its own
  // click handler — so a click, not form.submit(), would be required there.
  //
  // function submitForm(page) {
  //   const button = page === 'import'
  //     ? document.querySelector('form[action*="/import/add"] input[type="submit"][name="commit"]')
  //     : document.querySelector('#new_script_version input[type="submit"][name="commit"], ' +
  //                              '#new_script_version button.g-recaptcha[type="submit"]');
  //   if (!button) {
  //     console.error(`${TAG} submit button not found on ${page}`);
  //     return;
  //   }
  //   button.click();
  // }

  // ---------- The opener page ----------
  //
  // greasyfork-url.py opens open-prefilled-form.html rather than the form, so
  // that a browser without this script gets a status page with install links
  // rather than a blank form. This script fills in that page's status rows,
  // and its redirect is what takes everyone else on to the form.
  //
  // First it checks the two things that would otherwise lose the form's values
  // or files with nothing to show for it: Greasy Fork's sign-in redirect drops
  // the hash, and the file server only stays up for a short time.
  //
  // "to" comes from the URL, so a link anyone wrote can set it. The origin is
  // fixed and PAGE_PATTERNS limits the path to the forms, so the page can't be
  // used to redirect elsewhere. The redirect gives a link no more than linking
  // to the form directly does, and the person still has to submit the form.
  //
  // replace() keeps this page out of history, so Back doesn't bounce forward
  // again. The hash goes through untouched: it's only decoded on the form.

  const FORM_ORIGIN = 'https://greasyfork.org';

  const SIGN_IN_PATH = /^(?:\/[^/]+)?\/users\/sign_in\/?$/;
  const CHECK_TIMEOUT_MS = 10000;
  const SERVER_PING_MS = 20000;

  // Resolves with the response, or null if the request failed.
  function requestForCheck(url) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: CHECK_TIMEOUT_MS,
        onload: resolve,
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    });
  }

  // True unless Greasy Fork answers with its sign-in page. A failed check counts
  // as signed in, since going to the form is the most this could have stopped.
  async function isSignedIn(target) {
    const response = await requestForCheck(FORM_ORIGIN + target);
    if (!response || !response.finalUrl) return true;
    return !SIGN_IN_PATH.test(new URL(response.finalUrl).pathname);
  }

  // The file servers named by the form's values.
  function fileServersIn(params) {
    const sources = [params.get('code_upload'), ...(params.get('image_files') || '').split(',')];
    const servers = new Set();
    for (const source of sources) {
      const match = source && source.trim().match(FILE_SERVER_URL);
      if (match) servers.add(match[0]);
    }
    return [...servers];
  }

  // Each request also counts as activity, which keeps the server up.
  async function isServerUp(server) {
    const response = await requestForCheck(`${server}/alive`);
    return Boolean(response) && response.status === 200;
  }

  // Sets a status row on the opener page: its mark ("ok", "bad" or
  // "checking"), its text if given, and whether its fix shows.
  function setRow(name, state, text) {
    const row = document.getElementById(`${name}-row`);
    row.hidden = false;
    row.dataset.state = state;
    const value = document.getElementById(name);
    if (text && value) value.textContent = text;
    const fix = document.getElementById(`${name}-fix`);
    if (fix) fix.hidden = state !== 'bad';
  }

  async function runOpenerPage() {
    // The page's defaults are for a browser without this script. Hide them
    // until they're filled in, so they don't flash up. The DOM may not exist
    // yet this early, so this is a stylesheet.
    const style = document.createElement('style');
    style.textContent = '#status { visibility: hidden; }';
    (document.head || document.documentElement).append(style);
    await whenDomReady();
    setRow('manager', 'ok', `${GM_info.scriptHandler} ${GM_info.version}`);
    setRow('script', 'ok', `installed, version ${GM_info.script.version}`);
    style.remove();

    const target = new URLSearchParams(location.search).get('to');
    const known = target !== null && detectPage(target) !== null;
    if (!known || !location.hash) {
      document.getElementById('continue').hidden = true;
      document.getElementById('usage').hidden = false;
      if (target !== null && !known) setRow('link', 'bad');
      return;
    }

    const servers = fileServersIn(parseHash());
    setRow('sign-in', 'checking');
    if (servers.length) setRow('files', 'checking');
    const [serversUp, signedIn] = await Promise.all([
      Promise.all(servers.map(isServerUp)),
      isSignedIn(target),
    ]);
    const filesOk = serversUp.every(Boolean);

    setRow('sign-in', signedIn ? 'ok' : 'bad', signedIn ? 'signed in' : 'not signed in');
    if (servers.length) setRow('files', filesOk ? 'ok' : 'bad', filesOk ? 'available' : 'no longer available');
    if (signedIn && filesOk) {
      location.replace(FORM_ORIGIN + target + location.hash);
      return;
    }
    // Reload can't bring the files back; the files row says to rerun the command.
    if (!filesOk) document.getElementById('continue').hidden = true;
    // Signing in can take longer than the file server would otherwise wait.
    if (filesOk && servers.length) setInterval(() => servers.forEach(isServerUp), SERVER_PING_MS);
  }

  // ---------- Entry point ----------

  async function main() {
    const page = detectPage(location.pathname);
    if (!page) return;
    const params = parseHash();
    if (params.size === 0) return;

    await whenDomReady();

    console.log(`${TAG} init on ${page} with ${params.size} parameter(s): ${[...params.keys()].join(', ')}`);
    warnAboutUnknownParams(params, page);
    warnAboutConflicts(params);
    if (params.has('submit')) {
      console.error(`${TAG} "submit" is disabled; review the filled form and click the site's own button`);
    }

    let previewTargets = [];
    try {
      previewTargets = page === 'import'
        ? applyImportForm(params)
        : await applyScriptForm(params, page);
    } catch (e) {
      console.error(`${TAG} stopped, form only partly filled:`, e);
      return;
    }

    // Drop the parameters from the address bar once they've been applied: the
    // code is bulky, and a reload would otherwise overwrite manual edits.
    if (readFlag(params, 'keep_hash') !== true) {
      history.replaceState(null, '', location.pathname + location.search);
    }

    for (const target of previewTargets) showPreview(target);
    console.log(`${TAG} done: form filled, ready for you to review and submit`);
  }

  // Anywhere else @match allows is a copy of the opener page: the one on
  // github.io, or a local file: copy given to greasyfork-url.py --opener-page.
  if (location.origin === FORM_ORIGIN) main();
  else runOpenerPage();
})();
