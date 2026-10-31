// ==UserScript==
// @name         Show SourceMonkey test status on Greasy Fork
// @namespace    https://github.com/jshute96/SourceMonkey
// @version      0.8.1
// @description  On Greasy Fork script pages, for scripts that have been tested with SourceMonkey, show the test results
// @match        https://greasyfork.org/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      jshute96.github.io
// @connect      localhost
// @noframes
// ==/UserScript==

// This reads corpus.json and corpus-help.js, and then shows test results on
// Greasy Fork pages. It reads them from one of two locations:
//
// - Published: the copies on GitHub Pages, as last pushed (the default).
// - Local: a server on localhost:8765, for results not pushed yet. Run this
//   from the SourceMonkey repo to start it:
//
//     tests/greasyfork-examples/serve-results.mjs
//
// The script's menu has an item for each, and shows the selected one checked. Choosing
// the other switches to it and reloads the page.
//
// After loading, the data is cached in GM storage, with a copy for each source.
// The cached copy is used if the server can't be reached, and when the data
// file hasn't changed.

(function () {
  'use strict';

  // Where the results are read from, chosen with the menu command.
  const SOURCES = {
    published: 'https://jshute96.github.io/SourceMonkey/tests/greasyfork-examples/',
    local: 'http://localhost:8765/',
  };
  const sourceKey = GM_getValue('source', 'published') === 'local' ? 'local' : 'published';
  const BASE = SOURCES[sourceKey];
  const CORPUS_URL = BASE + 'corpus.json';
  const HELP_URL = BASE + 'corpus-help.js';
  // Copies stored before there was a choice of source. Read first, so
  // most page loads write nothing.
  for (const old of ['corpus', 'help']) {
    if (GM_getValue(old, null) != null) GM_deleteValue(old);
  }

  // One item per source, the one in use checked. On every Greasy Fork page,
  // not only those with scripts to mark.
  const SOURCE_LABELS = {
    published: 'Published results (GitHub Pages)',
    local: 'Local results (localhost:8765)',
  };
  for (const [key, label] of Object.entries(SOURCE_LABELS)) {
    GM_registerMenuCommand((key === sourceKey ? '☑ ' : '☐ ') + label, () => {
      if (key === sourceKey) return;
      GM_setValue('source', key);
      location.reload();
    });
  }
  // Bump to rebuild the stored copies, after changing what they hold.
  const CACHE_FORMAT = 6;

  const log = (...args) => console.log('[show-on-GreasyFork]', ...args);

  // Each n/a reason and fail blame, as the status line shows it. What
  // each means, for the hover, is in corpus-help.js.
  const DETAIL_LABELS = {
    'requires-login': 'requires login',
    'paid': 'paid site',
    'geo-blocked': 'geo-blocked',
    'bot-blocked': 'bot-blocked',
    'site-gone': 'site gone',
    'needs-interaction': 'needs interaction',
    'not-web': 'not a web page',
    'other-browser': 'not for Chrome',
    'unsafe': 'looked unsafe',
    'game': 'game site',
    'other': 'other reason',
    'script': 'script problem',
    'sourcemonkey': 'SourceMonkey problem',
    'unknown': 'unknown cause',
  };

  // The header colors of SourceMonkey's own pages (`--header-bg`,
  // `--header-border`, `--brand-fg` in src/styles.css).
  GM_addStyle(`
    .smts-row { display: flex; align-items: flex-start; gap: 0 1em; }
    .smts-row > .script-meta-block { flex: 0 1 600px; min-width: 0; }
    /* Narrowed beside the panel, a long word (a license URL) would overflow
       into it. Greasy Fork's break-word doesn't shrink the column; anywhere does. */
    .smts-row .inline-script-stats dd { overflow-wrap: anywhere; }
    @media screen and (width <= 800px) { .smts-row { flex-wrap: wrap; } }
    .smts-panel {
      flex: 1 1 16em; max-width: 30em; min-width: 0; margin-bottom: 1em;
      display: flex; align-items: flex-start; gap: .6em;
      background: #f2e9dc; border: 1px solid #b59a78; border-radius: 6px;
      padding: .4em .7em; color: #222; font-size: small; line-height: 1.5;
    }
    .smts-icon { font-size: 2.2em; line-height: 1; font-weight: bold; flex: none; width: 1em; text-align: center; align-self: center; }
    .smts-body { min-width: 0; overflow-wrap: anywhere; }
    /* :visited too, which Greasy Fork colors red. */
    .smts-title, .smts-title:visited { font-weight: bold; color: #6b4423; }
    .smts-ok { color: #2a8a2a; }
    .smts-fail { color: #c33; }
    .smts-unknown { color: #8a7a66; }
    .smts-muted { color: #6f655a; }
    .smts-code { font-family: monospace; }
    .smts-clip { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .smts-tags { display: flex; flex-wrap: wrap; gap: .25em; margin-top: .2em; }
    .smts-tag {
      background: #fff8ee; border: 1px solid #b59a78; border-radius: 3px;
      padding: 0 .35em; font-size: .9em; line-height: 1.4; cursor: default;
    }
  `);

  // The corpus's tag definitions, and for its scripts, the fields the panel
  // uses, keyed by script ID, with short names to keep the stored copy small. A field with no value is left out: an
  // `undefined` would make SourceMonkey store the whole object in its
  // larger typed form.
  //   e:  validation error, only for an invalid script
  //   vg: validation's derived tags, only for an invalid script
  //   t:  test status (pass, fail, inconclusive, n/a); absent if untested
  //   d:  test detail: the n/a reason or the fail blame
  //   at: test date, or the validation date for an untested invalid script
  //   v:  version tested or validated, with `at`
  //   g:  hand-added tags
  function summarize(corpus) {
    const entries = {};
    const put = (o, key, value) => { if (value != null) o[key] = value; };
    for (const [id, rec] of Object.entries(corpus.scripts)) {
      const o = {};
      const invalid = rec.valid?.status === 'invalid';
      if (invalid) {
        o.e = rec.valid.error || rec.valid.status;
        if (rec.valid.tags?.length) o.vg = rec.valid.tags;
      }
      const test = rec.test;
      if (test) {
        put(o, 't', test.status);
        put(o, 'd', test.reason ?? test.blame);
      }
      const dated = test || (invalid ? rec.valid : null);
      if (dated) {
        put(o, 'at', dated.date);
        put(o, 'v', dated.version);
      }
      if (rec.tags?.length) o.g = rec.tags;
      entries[id] = o;
    }
    return { tags: corpus.tags, scripts: entries };
  }

  // The response to a request, rejecting with a short message for the
  // panel. The manager's own, longer error goes to the console.
  function request(method, url, responseType) {
    const host = new URL(url).host;
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        responseType,
        nocache: true,
        onload: (res) => {
          if (res.status !== 200) reject(new Error(`The server on ${host} returned HTTP ${res.status}.`));
          else resolve(res);
        },
        onerror: (res) => {
          log(`${method} ${url} failed:`, res.error);
          reject(Object.assign(new Error(`Server not reachable on ${host}.`), { unreachable: true }));
        },
        ontimeout: () => reject(new Error(`The server on ${host} did not answer in time.`)),
      });
    });
  }

  function lastModified(res) {
    const m = /^last-modified:\s*(.+?)\s*$/im.exec(res.responseHeaders || '');
    return m ? m[1] : null;
  }

  // `build(response)` for the file at `url`, kept in GM storage under `key`
  // with the file's Last-Modified date. A HEAD request checks the date; only
  // a changed file (or a changed CACHE_FORMAT) is downloaded and built again.
  // If the server can't be reached, an earlier copy is used.
  async function cachedLoad(name, url, responseType, build) {
    const key = `${name}:${sourceKey}`;
    const cached = GM_getValue(key, null);
    const usable = cached?.format === CACHE_FORMAT && cached.lastModified;
    let date;
    try {
      date = lastModified(await request('HEAD', url));
    } catch (err) {
      if (!usable) throw err;
      log(`${key}: using the stored copy from ${cached.lastModified}; could not check for a newer one: ${err.message}`);
      return cached.data;
    }
    if (usable && date === cached.lastModified) {
      log(`${key}: unchanged since ${date}, using the stored copy`);
      return cached.data;
    }
    const res = await request('GET', url, responseType);
    const data = build(res.response);
    // A file the server gives no date for is fetched every time.
    const stored = lastModified(res);
    if (stored) GM_setValue(key, { format: CACHE_FORMAT, lastModified: stored, data });
    log(`${key}: ${cached ? 'changed' : 'not stored yet'}, fetched and rebuilt (${stored || 'no Last-Modified'})`);
    return data;
  }

  function loadCorpus() {
    return cachedLoad('corpus', CORPUS_URL, 'json', (corpus) => {
      if (typeof corpus?.scripts !== 'object' || typeof corpus.tags !== 'object') {
        throw new Error('corpus.json is not in the corpus format.');
      }
      return summarize(corpus);
    });
  }

  // corpus-help.js assigns one strict-JSON object, so parse that object
  // out of it rather than running the file. Without it, the panel just
  // has no hovers.
  async function loadHelp() {
    try {
      return await cachedLoad('help', HELP_URL, 'text', (text) => {
        const start = text.indexOf('{', text.indexOf('CORPUS_HELP ='));
        return JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
      });
    } catch (err) {
      log('No descriptions:', err.message);
      return { test: {}, detail: {}, tag: {} };
    }
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function line(body, text, cls) {
    const div = el('div', cls, text);
    body.append(div);
    return div;
  }

  // A line cut to one row with an ellipsis. `full` is its tooltip when
  // the line shows less: cut short, or a shortened form of `full`.
  function clippedLine(body, text, full = text) {
    const div = line(body, text, 'smts-clip');
    div.addEventListener('mouseenter', () => {
      div.title = full !== text || div.scrollWidth > div.clientWidth ? full : '';
    });
  }

  // A validation error in a few words (`@require file not loadable`),
  // without the URL and location.
  function shortError(error) {
    const msg = error.replace(/ \(in the script[^)]*\)$/, '');
    // The message follows the first `: ` before a capital; a URL can hold spaces.
    const fetch = /^@(require|resource) .*?: ([A-Z].*)$/s.exec(msg);
    if (fetch) {
      const [, key, problem] = fetch;
      const size = /^The file is larger than the ([\d.]+ \w+) limit/.exec(problem);
      if (size) return `@${key} file over ${size[1]}`;
      if (problem.startsWith('URLs with the data: scheme')) return `@${key} data: URL not supported`;
      // Anything else means it didn't download.
      return `@${key} file not loadable`;
    }
    // The parser's message never fits; the tooltip has it.
    if (msg.startsWith('Syntax error')) return 'syntax error';
    if (/^@(?:match|include|exclude) /.test(msg)) return 'unusable @match';
    if (msg.startsWith('This is a user style')) return 'user style, not a userscript';
    return msg;
  }

  // A tag's description: its own entry, or its `prefix:*` entry with the
  // name filled in (see corpus-help.js), as in results.html's tagHelp.
  function tagHelp(help, tag) {
    if (Object.hasOwn(help, tag)) return help[tag];
    const colon = tag.indexOf(':');
    const pattern = colon > 0 && help[tag.slice(0, colon) + ':*'];
    return pattern ? pattern.replaceAll('{name}', tag.slice(colon + 1)) : '';
  }

  // The status line's text, and its hover saying what that means.
  function testStatus(rec, help) {
    const label = DETAIL_LABELS[rec.d] || rec.d || 'unknown cause';
    const text = {
      pass: 'Passed',
      fail: `Failed: ${label}`,
      inconclusive: 'Inconclusive',
      'n/a': `Not tested: ${label}`,
    }[rec.t] || rec.t;
    const why = rec.t === 'fail' || rec.t === 'n/a' ? help.detail[rec.d] : '';
    return { text, help: [help.test[rec.t], why].filter(Boolean).join(' ') };
  }

  // The panel for one script, or null for a script not in the corpus.
  function buildPanel(id, result, pageVersion) {
    const panel = el('div', 'smts-panel');
    const icon = el('div', 'smts-icon');
    const body = el('div', 'smts-body');
    panel.append(icon, body);
    // Named when it isn't the default, so local results aren't taken for published ones.
    const title = el('a', 'smts-title', 'SourceMonkey test status' + (sourceKey === 'local' ? ' (local)' : ''));
    title.href = BASE + 'results.html?' + new URLSearchParams({ q: id });
    title.target = '_blank';
    body.append(title);
    const setIcon = (cls, mark) => { icon.className = 'smts-icon ' + cls; icon.textContent = mark; };

    if (result.error) {
      setIcon('smts-fail', '!');
      line(body, 'Could not load test results.');
      line(body, result.error.message);
      if (result.error.unreachable && sourceKey === 'local') {
        line(body, 'Run ').append(el('code', 'smts-code', 'tests/greasyfork-examples/serve-results.mjs'));
      }
      return panel;
    }
    const rec = Object.hasOwn(result.map, id) ? result.map[id] : null;
    if (!rec) return null;

    // Validation shows only when it failed.
    const invalid = rec.e != null;
    if (invalid) clippedLine(body, `Validation failed: ${shortError(rec.e)}`, rec.e);

    if (rec.t) {
      const { text, help } = testStatus(rec, result.help);
      line(body, text).title = help;
    } else if (!invalid) {
      line(body, 'Not tested yet').title = result.help.test.untested || '';
    }
    if (rec.at) {
      let when = `Updated: ${rec.at}`;
      // Results for another version may not hold for this one.
      if (rec.v && pageVersion && rec.v !== pageVersion) when += `, older version ${rec.v}`;
      line(body, when, 'smts-muted');
    }
    const names = [...(rec.vg || []), ...(rec.g || [])];
    if (names.length) {
      const tags = el('div', 'smts-tags');
      for (const name of names) {
        // The panel already says it's invalid.
        const chip = el('span', 'smts-tag', name.replace(/^invalid:/, ''));
        const help = tagHelp(result.help.tag, name);
        if (help) chip.title = help;
        tags.append(chip);
      }
      body.append(tags);
    }

    if (invalid || rec.t === 'fail') setIcon('smts-fail', '✗');
    else if (rec.t === 'pass') setIcon('smts-ok', '✓');
    else setIcon('smts-unknown', '?');
    return panel;
  }

  // Put the panel beside the stats block, wrapping both in a flex row.
  function attach(metaBlock, panel) {
    const row = el('div', 'smts-row');
    metaBlock.before(row);
    row.append(metaBlock, panel);
  }

  // Each place to show a panel: { id, version, metaBlock }.
  function findTargets() {
    const targets = [];
    for (const li of document.querySelectorAll('li[data-script-id]')) {
      const metaBlock = li.querySelector('.script-meta-block');
      if (metaBlock) targets.push({ id: li.dataset.scriptId, version: li.dataset.scriptVersion, metaBlock });
    }
    const stats = document.getElementById('script-stats');
    const idMatch = location.pathname.match(/\/scripts\/(\d+)/);
    if (stats && idMatch && stats.parentElement.classList.contains('script-meta-block')) {
      const version = document.querySelector('dd.script-show-version')?.textContent.trim();
      targets.push({ id: idMatch[1], version, metaBlock: stats.parentElement });
    }
    return targets;
  }

  const targets = findTargets();
  if (!targets.length) return;
  Promise.all([loadCorpus(), loadHelp()]).then(
    // Hand-added tags are defined in the corpus; corpus-help.js has the built-in ones.
    ([corpus, help]) => ({ map: corpus.scripts, help: { ...help, tag: { ...corpus.tags, ...help.tag } } }),
    (error) => ({ error }),
  ).then((result) => {
    // Without results, one panel says so, on the first script, rather
    // than one per row of a listing.
    for (const t of result.error ? targets.slice(0, 1) : targets) {
      // Scripts outside the corpus get no panel.
      const panel = buildPanel(t.id, result, t.version);
      if (panel) attach(t.metaBlock, panel);
    }
  });
})();
