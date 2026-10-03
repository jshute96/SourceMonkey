#!/usr/bin/env node
// Run the queries in analysis.sql against corpus.db and render them as one
// self-contained HTML page of tables.
//
// Usage:
//   node tests/greasyfork-examples/render-analysis.mjs [options]
//
//   --db PATH   database to query (default tests/greasyfork-examples/corpus.db)
//   --sql PATH  query file (default tests/greasyfork-examples/analysis.sql)
//   --out PATH  HTML to write (default tests/greasyfork-examples/analysis.html)

import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printHelp } from './corpus.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULTS = {
  db: path.join(REPO_ROOT, 'tests/greasyfork-examples/corpus.db'),
  sql: path.join(REPO_ROOT, 'tests/greasyfork-examples/analysis.sql'),
  out: path.join(REPO_ROOT, 'tests/greasyfork-examples/analysis.html'),
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Validate the flag before consuming its value, so a typo reports the typo
    // rather than a confusing "missing value". hasOwn, not `in`: `--constructor`
    // and friends live on the prototype and would otherwise pass.
    if (!arg.startsWith('--') || !Object.hasOwn(DEFAULTS, arg.slice(2))) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`Missing value for ${arg}`);
    opts[arg.slice(2)] = path.resolve(value);
  }
  return opts;
}

/**
 * Split analysis.sql into reports. `-- @report <title>` opens one, `-- @note`
 * lines attach prose to it, and everything else up to the next @report is the
 * statement. Text before the first @report is file-level preamble and ignored.
 */
function parseReports(sql) {
  const reports = [];
  let current = null;
  for (const line of sql.split('\n')) {
    const report = /^--\s*@report\s+(.*)$/.exec(line);
    if (report) {
      current = { title: report[1].trim(), notes: [], sql: [] };
      reports.push(current);
      continue;
    }
    if (!current) continue;
    const note = /^--\s*@note\s+(.*)$/.exec(line);
    if (note) { current.notes.push(note[1].trim()); continue; }
    current.sql.push(line);
  }
  return reports.map((r) => ({ ...r, sql: r.sql.join('\n').trim() })).filter((r) => r.sql);
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

const UNITS = ['B', 'KB', 'MB', 'GB'];

function formatBytes(bytes) {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit++; }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`;
}

// Columns whose numbers are byte counts get human-readable text with the exact
// value on hover; everything else numeric just gets thousands separators.
const isByteColumn = (name) => /(^|_)size$/.test(name);
// Identifiers are labels that happen to be numeric — grouping their digits
// makes them read as quantities and breaks copy-paste into a query.
const isIdColumn = (name) => /(^|_)id$/.test(name);

function formatCell(column, value) {
  if (value === null || value === undefined) return { text: '—', className: 'nil' };
  if (typeof value === 'number' || typeof value === 'bigint') {
    const number = Number(value);
    if (isIdColumn(column)) return { text: String(number), className: 'num' };
    if (isByteColumn(column)) {
      return { text: formatBytes(number), className: 'num', title: `${number.toLocaleString('en-US')} bytes` };
    }
    return { text: number.toLocaleString('en-US'), className: 'num' };
  }
  const text = String(value);
  // Long values are capped with an ellipsis in CSS; keep the full string on
  // hover. One @grant in the corpus is a paragraph of release notes, and
  // without a cap its column shoves every other column off the page.
  const title = text.length > 60 ? text : undefined;
  if (/^https?:\/\//.test(text)) return { text, className: 'url', href: text, title };
  return { text, className: 'text', title };
}

/**
 * A column is numeric when every value it holds is a number. The header then
 * gets the same right-alignment as the cells, so the label sits directly over
 * its digits instead of drifting to the far side of a wide column.
 */
function isNumericColumn(rows, column) {
  let seen = false;
  for (const row of rows) {
    const value = row[column];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'number' && typeof value !== 'bigint') return false;
    seen = true;
  }
  return seen;
}

function renderTable(rows) {
  if (rows.length === 0) return '<p class="empty">No rows.</p>';
  const columns = Object.keys(rows[0]);
  const numeric = new Set(columns.filter((c) => isNumericColumn(rows, c)));
  const head = columns
    .map((c) => `<th${numeric.has(c) ? ' class="num"' : ''}>${escapeHtml(c.replace(/_$/, ''))}</th>`)
    .join('');
  const body = rows
    .map((row) => {
      const cells = columns
        .map((column) => {
          const { text, className, title, href } = formatCell(column, row[column]);
          const attrs = `${className ? ` class="${className}"` : ''}${title ? ` title="${escapeHtml(title)}"` : ''}`;
          const content = href
            ? `<a href="${escapeHtml(href)}" rel="noreferrer">${escapeHtml(text)}</a>`
            : escapeHtml(text);
          return `<td${attrs}>${content}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('\n');
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table></div>`;
}

const STYLE = `
:root { color-scheme: light dark; --fg:#1a1a1a; --bg:#fff; --muted:#5c5c5c; --line:#e0e0e0; --head:#f5f5f5; --accent:#0b5fff; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e8e8e8; --bg:#16181c; --muted:#9aa0a6; --line:#2c3038; --head:#1e2128; --accent:#7aa2ff; }
}
* { box-sizing: border-box; }
body { margin:0; padding:2rem 1.5rem 4rem; background:var(--bg); color:var(--fg);
       font:15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 68rem; margin: 0 auto; }
h1 { font-size:1.8rem; margin:0 0 .3rem; }
h2 { font-size:1.15rem; margin:2.5rem 0 .4rem; padding-top:.6rem; border-top:1px solid var(--line); }
.sub { color:var(--muted); margin:0 0 2rem; font-size:.9rem; }
.note { color:var(--muted); margin:.2rem 0 .7rem; font-size:.88rem; max-width:60rem; }
.toc { columns: 2; gap: 2rem; margin: 0 0 1rem; padding-left: 1.1rem; font-size:.9rem; }
.toc a { color:var(--accent); text-decoration:none; }
.toc a:hover { text-decoration:underline; }
.scroll { overflow-x:auto; }
/* Size to content, not to the page: a full-width table stretches its first text
   column across the whole page and strands the numbers far to the right. */
table { border-collapse:collapse; font-size:.88rem; width:auto; max-width:100%; border:1px solid var(--line); }
th, td { padding:.32rem .7rem; text-align:left; border-bottom:1px solid var(--line); white-space:nowrap; }
/* Vertical rules so a value and its header stay visibly in the same column. */
th + th, td + td { border-left:1px solid var(--line); }
th { background:var(--head); font-weight:600; position:sticky; top:0; }
th.num, td.num { text-align:right; font-variant-numeric:tabular-nums; }
td.nil { color:var(--muted); text-align:right; }
td.url, td.text { max-width:38rem; overflow:hidden; text-overflow:ellipsis; }
td a { color:var(--accent); text-decoration:none; }
tbody tr:nth-child(even) { background:color-mix(in srgb, var(--head) 45%, transparent); }
tbody tr:hover { background:color-mix(in srgb, var(--accent) 12%, transparent); }
.empty { color:var(--muted); font-style:italic; }
code { font-size:.85em; background:var(--head); padding:.1rem .3rem; border-radius:3px; }
`;

async function main() {
  if (printHelp(process.argv.slice(2), import.meta.url)) return;
  const opts = parseArgs(process.argv.slice(2));
  const db = new DatabaseSync(opts.db, { readOnly: true });
  const reports = parseReports(await readFile(opts.sql, 'utf8'));

  const sections = [];
  for (const report of reports) {
    const anchor = report.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let rows;
    try {
      rows = db.prepare(report.sql).all();
    } catch (err) {
      throw new Error(`Query "${report.title}" failed: ${err.message}`);
    }
    sections.push({ ...report, anchor, rows });
    console.info(`${report.title}: ${rows.length} row${rows.length === 1 ? '' : 's'}`);
  }

  const scriptCount = db.prepare('SELECT COUNT(*) n FROM Scripts').get().n;
  db.close();

  const toc = sections.map((s) => `<li><a href="#${s.anchor}">${escapeHtml(s.title)}</a></li>`).join('\n');
  const body = sections
    .map((s) => {
      // Notes are plain text, except `backticked` spans become <code>.
      const notes = s.notes
        .map((n) => `<p class="note">${escapeHtml(n).replace(/`([^`]+)`/g, '<code>$1</code>')}</p>`)
        .join('\n');
      return `<section>\n<h2 id="${s.anchor}">${escapeHtml(s.title)}</h2>\n${notes}\n${renderTable(s.rows)}\n</section>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GreasyFork corpus analysis</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>GreasyFork corpus analysis</h1>
<p class="sub">${scriptCount.toLocaleString('en-US')} scripts from <code>${escapeHtml(path.basename(opts.db))}</code>
 · queries in <code>${escapeHtml(path.basename(opts.sql))}</code></p>
<ul class="toc">
${toc}
</ul>
${body}
</main>
</body>
</html>
`;
  await writeFile(opts.out, html);
  console.info(`Wrote ${path.relative(REPO_ROOT, opts.out)}`);
}

await main();
