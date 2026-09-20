// ==UserScript==
// @name        SourceMonkey example: GM_info
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.3.3
// @description Render GM_info as JSON onto the page.
// @match       *://*/gm-info/gm-info.html
// @match       file:///*/gm-info/gm-info.html
// @run-at      document-end
// @grant       GM_info
// ==/UserScript==

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  const out = document.getElementById('output');
  if (!out || !status) return;

  // GM_info is technically available without an explicit @grant in TM
  // and SM, but listing it under @grant here makes the dependency
  // visible to a reader.
  const info = (typeof GM_info !== 'undefined') ? GM_info : null;
  if (!info) {
    status.textContent = 'GM_info is undefined — is the script loaded?';
    return;
  }

  // Several managers (SourceMonkey, Tampermonkey, Violentmonkey, ...)
  // may all have this script installed and run it on the same page.
  // Each copy appends its own labeled block instead of overwriting
  // #output, so the dumps can be compared side by side.
  const handler = info.scriptHandler || '(unknown handler)';
  const version = info.version ? ` ${info.version}` : '';

  const heading = document.createElement('h3');
  heading.textContent = `${handler}${version}`;
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(info, null, 2);
  const dump = document.createElement('section');
  dump.className = 'dump';
  dump.append(heading, pre);

  if (!out.dataset.runs) out.textContent = '';
  out.dataset.runs = String(Number(out.dataset.runs || 0) + 1);

  // Keep the dumps sorted by label rather than by which manager
  // happened to run first, so the page reads the same every load.
  const next = [...out.querySelectorAll('section.dump')]
    .find((d) => labelOf(d).localeCompare(labelOf(dump)) > 0);
  out.insertBefore(dump, next || null);

  renderComparison();

  status.classList.add('ran');
  status.textContent =
    `Userscript ran ${out.dataset.runs} time(s). GM_info dumped below — ` +
    'note scriptHandler and version.';

  // Flatten an object into { 'a.b.c': value } rows. Arrays are leaves
  // (kept whole), so a row like `script.matches` shows the full list.
  // An empty object is a leaf too, so it shows as `{}` rather than
  // vanishing and looking like a missing field.
  function flatten(value, prefix, rows) {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length > 0) {
      for (const key of Object.keys(value)) {
        flatten(value[key], prefix ? `${prefix}.${key}` : key, rows);
      }
    } else {
      rows[prefix] = value;
    }
    return rows;
  }

  // Rebuild the side-by-side table from every dump on the page, not
  // just this run's: each manager's copy of the script runs in its own
  // sandbox, so the shared DOM (the <pre> blocks) is the only place the
  // earlier runs' data is reachable from.
  function renderComparison() {
    const table = document.getElementById('comparison');
    if (!table) return;

    const columns = [];
    for (const d of out.querySelectorAll('section.dump')) {
      try {
        columns.push({
          label: labelOf(d),
          rows: flatten(JSON.parse(d.querySelector('pre').textContent), '', {}),
        });
      } catch {
        // Not JSON — e.g. a hand-edited page or a copy of this script
        // with a different dump format. Leave it out of the table.
      }
    }
    columns.sort((a, b) => a.label.localeCompare(b.label));

    const paths = [...new Set(columns.flatMap((c) => Object.keys(c.rows)))]
      .sort((a, b) => a.localeCompare(b));

    table.textContent = '';
    const head = table.createTHead().insertRow();
    head.append(cell('th', 'Field path'));
    for (const c of columns) head.append(cell('th', c.label));

    const body = table.createTBody();
    for (const path of paths) {
      const row = body.insertRow();
      row.append(pathCell(path));
      for (const c of columns) {
        const present = path in c.rows;
        const td = cell('td', present ? JSON.stringify(c.rows[path]) : '—');
        if (!present) td.className = 'missing';
        row.append(td);
      }
    }
  }

  // Field-path header: allow line breaks only after the dots, so a long
  // path wraps as `script.` / `namespace` rather than mid-word.
  function pathCell(path) {
    const th = document.createElement('th');
    path.split('.').forEach((part, i) => {
      if (i > 0) th.append('.', document.createElement('wbr'));
      th.append(part);
    });
    return th;
  }

  function labelOf(dump) {
    return dump.querySelector('h3').textContent;
  }

  function cell(tag, text) {
    const el = document.createElement(tag);
    el.textContent = text;
    return el;
  }
})();
