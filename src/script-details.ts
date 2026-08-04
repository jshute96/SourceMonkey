// The details panel — the `<dl>` of parsed-header fields plus the
// where-did-this-come-from rows — shared by the installed-script
// viewer and the not-yet-installed preview.
//
// The two modes render the same rows from the same code; rows whose
// data a mode doesn't have simply aren't passed in (a preview has no
// Log ID, Source, or Status; an unparseable file has no header). Row
// order is fixed here so the panel doesn't reshuffle between modes.

import { openInNewTabAnchor } from './code-links.js';
import { matchTargetInfo } from './match-targets.js';
import type { StoredSource } from './script-store.js';
import { isContainerSource } from './directories.js';
import {
  appendWithSlashBreaks,
  effectiveDisplayName,
  makeSourceTypeBubble,
  sourceAnchorId,
} from './source-display.js';
import { getValue, getValues, type ParsedHeader } from './userscript-header.js';
import { versionRelation } from './version-compare.js';
import { probeLabel, type VersionProbe } from './version-probe.js';

export interface LocationRow {
  // What the row reads as — the decoded URL, or the bare fs path for
  // file:// scripts.
  text: string;
  // What the anchor points at (and what the tooltip surfaces): always
  // the real, encoded URL.
  href: string;
  // Optional trailing control, e.g. the viewer's copy-to-clipboard
  // button. Moved into the cell on every render.
  trailing?: HTMLElement;
  // Intercepts activation of the location anchor. Both viewer modes
  // use it, because a plain navigation to a `.user.js` URL — http(s)
  // or file:// — is captured straight back into a preview (see
  // install-capture.ts):
  //   - preview mode routes the click to its raw view;
  //   - installed mode stands the capture down for that one
  //     navigation, so the row's link opens what it says it opens.
  // Wired for `auxclick` too, or a middle-click would take the plain
  // path.
  onActivate?: () => void;
}

export interface DetailsModel {
  header: ParsedHeader | null;
  // Installed scripts only.
  logId?: string;
  source?: StoredSource | null;
  status?: Node;
  location?: LocationRow;
  size?: string;
  // What the script's upstream `@updateURL` / `@downloadURL` last
  // claimed, when those point somewhere we don't load from. Rendered
  // directly under the Version row so "what we run" and "what's
  // published" read together. A preview passes nothing — it hasn't been
  // probed, and inventing a row would imply we had checked.
  versionProbes?: readonly VersionProbe[];
}

export function renderDetails(container: HTMLElement, model: DetailsModel): void {
  container.replaceChildren();
  const dl = document.createElement('dl');
  const h = model.header;

  if (h) {
    addText(dl, 'Name', getValue(h, 'name'));
    addText(dl, 'Version', getValue(h, 'version'));
    addVersionProbes(dl, getValue(h, 'version'), model.versionProbes);
    addText(dl, 'Description', getValue(h, 'description'));
    addText(dl, 'Author', getValue(h, 'author'));
    addText(dl, 'Namespace', getValue(h, 'namespace'));
    addLink(dl, 'Homepage', getValue(h, 'homepage') ?? getValue(h, 'homepageURL'));
  }

  // Log ID sits right under the header fields — it's how the user maps
  // an entry in the SW console back to this script, and it should be
  // visible without scrolling.
  if (model.logId) {
    appendRow(dl, 'Log ID', logIdCell(model.logId));
  }

  if (h) {
    addPatterns(dl, 'Match', getValues(h, 'match'));
    addPatterns(dl, 'Include', getValues(h, 'include'));
    addPatterns(dl, 'Exclude', getValues(h, 'exclude'));
    // The headers that decide what the script can reach beyond the page
    // it runs in. Worth their own rows — this is the part a user is
    // actually being asked to approve at install time, and the part
    // worth re-checking on an installed script.
    addList(dl, 'Permissions', getValues(h, 'grant'), 'grant-list');
    addList(dl, 'Network access', getValues(h, 'connect'), 'grant-list');
    addList(dl, 'Loads libraries', getValues(h, 'require'));
    // Whole `@resource <name> <url>` line: the URL is the part that
    // says what gets fetched, which is the point of showing it here.
    addList(dl, 'Loads resources', getValues(h, 'resource'));
  }

  // Source row: the colored bubble + display name combo the sources
  // page uses, with the display name doubling as a back-link to the
  // sources page (anchored to this source's section). Above Location so
  // the "where did this come from" rows are grouped.
  if (model.source) {
    appendRow(dl, 'Source', sourceCell(model.source));
  }
  if (model.location) {
    appendRow(dl, 'Location', locationCell(model.location));
  }
  if (model.size) {
    appendRow(dl, 'Size', document.createTextNode(model.size));
  }
  if (model.status) {
    appendRow(dl, 'Status', model.status);
  }

  container.appendChild(dl);
}

// One row per probed upstream, labeled by the header that named it —
// "Version at update URL", "Version at update/download URL". The value
// says how that copy relates to ours ("same", "2.1 (Newer)") because
// the relation is the part a user acts on; the bare number alone would
// make them do the comparison themselves. The URL rides along as the
// row's tooltip rather than a fourth column of text.
function addVersionProbes(
  dl: HTMLDListElement,
  loadedVersion: string | undefined,
  probes: readonly VersionProbe[] | undefined,
): void {
  for (const probe of probes ?? []) {
    const dd = appendRow(
      dl,
      `Version at ${probeLabel(probe.kinds)}`,
      document.createTextNode(probeValueText(loadedVersion, probe)),
    );
    // A probe can carry both a version (from an earlier success) and an
    // error (the latest attempt failed). The value column shows the
    // version, so the tooltip is where "…and we couldn't re-check it"
    // goes rather than silently reading as current.
    dd.title = probe.version !== undefined && probe.error
      ? `${probe.url} — last check failed: ${probe.error}`
      : probe.url;
    const relation = versionRelation(loadedVersion, probe.version);
    if (relation === 'newer') dd.className = 'version-newer';
  }
}

function probeValueText(loadedVersion: string | undefined, probe: VersionProbe): string {
  if (probe.version === undefined) return probe.error ?? 'unknown';
  switch (versionRelation(loadedVersion, probe.version)) {
    case 'same': return 'same';
    case 'newer': return `${probe.version} (Newer)`;
    case 'older': return `${probe.version} (Older)`;
    // One side has no `@version`, so the number is all we can honestly
    // report — no relation, no qualifier.
    case 'unknown': return probe.version;
  }
}

function addText(dl: HTMLDListElement, label: string, value: string | undefined): void {
  if (!value) return;
  appendRow(dl, label, document.createTextNode(value));
}

function addLink(dl: HTMLDListElement, label: string, value: string | undefined): void {
  if (!value) return;
  const info = safeUrl(value);
  appendRow(dl, label, info ? openInNewTabAnchor(info, value) : document.createTextNode(value));
}

// Plain (non-linkified) value list: one value renders inline, several
// render as a `<ul>`. `cls` tags rows that want monospace (@grant,
// @connect), where the values are API names and hosts rather than prose.
function addList(
  dl: HTMLDListElement,
  label: string,
  values: string[],
  cls?: string,
): void {
  if (values.length === 0) return;
  const dd = appendRow(dl, label, listNode(values, (v) => document.createTextNode(v)));
  if (cls) dd.className = cls;
}

// `@match` / `@include` / `@exclude` row: each pattern that resolves to
// a usable linkUrl via the same wildcard-trim rule as the site favicon
// becomes a clickable open-in-new-tab anchor. Patterns we can't linkify
// (host wildcard, `<all_urls>`, regex literals, file://) render as
// plain text so the row still shows every entry.
function addPatterns(dl: HTMLDListElement, label: string, values: string[]): void {
  if (values.length === 0) return;
  appendRow(dl, label, listNode(values, patternValueNode));
}

function listNode(values: string[], make: (v: string) => Node): Node {
  if (values.length === 1) return make(values[0]);
  const ul = document.createElement('ul');
  for (const v of values) {
    const li = document.createElement('li');
    li.appendChild(make(v));
    ul.appendChild(li);
  }
  return ul;
}

function patternValueNode(pattern: string): Node {
  const info = matchTargetInfo(pattern);
  if (!info) {
    // Non-linkable pattern (`<all_urls>`, regex literal, etc.); render
    // as plain text but still allow slash-aware wrapping in case the
    // pattern is long.
    const span = document.createElement('span');
    appendWithSlashBreaks(span, pattern);
    return span;
  }
  return openInNewTabAnchor(info.linkUrl, pattern);
}

function logIdCell(logId: string): Node {
  const span = document.createElement('span');
  span.className = 'log-id-cell';
  span.textContent = logId;
  return span;
}

// Source-row cell: colored type bubble on the left (linking out to the
// underlying file:// / http(s):// URL), followed by the source's
// display name as a back-link to the sources page anchored at this
// source's section.
function sourceCell(source: StoredSource): Node {
  const cell = document.createElement('span');
  cell.className = 'source-cell';

  cell.appendChild(makeSourceTypeBubble(source.path));

  const nameLink = document.createElement('a');
  nameLink.className = 'source-display-name';
  appendWithSlashBreaks(nameLink, effectiveDisplayName(source));
  // Page-relative (both pages sit at the extension root) so the href
  // doesn't carry the `chrome-extension://<id>/` prefix.
  nameLink.href = `sources.html#${sourceAnchorId(source.id)}`;
  // Tooltip surfaces the raw stored path; the anchor itself jumps to
  // the section on the sources page. Container sources have a
  // synthetic `container:<kind>` path which would leak — skip then.
  if (!isContainerSource(source.path)) nameLink.title = source.path;
  cell.appendChild(nameLink);

  return cell;
}

function locationCell(row: LocationRow): Node {
  const cell = document.createElement('span');
  cell.className = 'filename-cell';

  // Wrap the path in an anchor so it doubles as an open-in-new-tab
  // link. http(s) URLs navigate normally; file:// links are accepted
  // by the anchor but Chromium typically refuses to navigate to them
  // from a chrome-extension page — the path is still readable, still
  // selectable, and the Copy button beside it is the reliable
  // "send this to another app" affordance.
  const pathEl = document.createElement('a') as HTMLAnchorElement;
  pathEl.className = 'filename-text';
  pathEl.href = row.href;
  pathEl.target = '_blank';
  pathEl.rel = 'noopener noreferrer';
  // Display text is the bare fs path for file:// scripts, and the
  // percent-decoded URL for the rest; the tooltip surfaces the actual
  // href, so the encoded form the browser will request is one hover
  // away and the user can see what would open (file://... vs
  // http://...) without clicking through. Slash-aware appender lets
  // long paths wrap at `/` boundaries before breaking mid-segment.
  pathEl.title = row.href;
  appendWithSlashBreaks(pathEl, row.text);
  if (row.onActivate) {
    const handler = row.onActivate;
    for (const type of ['click', 'auxclick']) {
      pathEl.addEventListener(type, (ev) => {
        ev.preventDefault();
        handler();
      });
    }
  }
  cell.appendChild(pathEl);

  // The caller's button is a single long-lived element; appendChild
  // moves it into the new cell on every render, so any in-flight
  // "Copied" flash carries across.
  if (row.trailing) cell.appendChild(row.trailing);

  return cell;
}

function appendRow(dl: HTMLDListElement, label: string, value: Node): HTMLElement {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.appendChild(value);
  dl.append(dt, dd);
  return dd;
}

// Header values are file content, so a `@homepage` can be anything.
// Only linkify what parses as an absolute http(s) URL — a relative or
// javascript: value stays plain text.
function safeUrl(value: string): string | null {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}
