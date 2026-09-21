// The details panel — the `<dl>` of parsed-header fields plus the
// where-did-this-come-from rows — shared by the installed-script
// viewer and the not-yet-installed preview.
//
// The two modes render the same rows from the same code; rows whose
// data a mode doesn't have simply aren't passed in (a preview has no
// Collection or Status; an unparseable file has no header). Row order
// is fixed here so the panel doesn't reshuffle between modes.
//
// What earns a row: the panel is NOT a mirror of the header block.
// The header block is on screen already — the first code tab opens on
// it — so a row that only repeats a tag verbatim is asking the reader
// to look at the same string twice. A row earns its place when it is
//   - identity a reader scans for (Name, Description, Version),
//   - something we resolved or computed that the file doesn't say
//     (Collection, Location, hosting-site page, Size, Status, the
//     upstream version probes), or
//   - a claim worth acting on (Homepage, Match / Include / Exclude,
//     Network access).
// Tags that fail all three — `@author`, `@namespace`, `@run-at`,
// `@icon`, … — stay in the code view where they were written.
//
// `@grant` is the deliberate omission, and the reasoning is specific
// to what our GM surface can actually do:
//   - `GM_xmlhttpRequest` is the API that reaches other origins, and
//     it is useless without `@connect` — a script with no `@connect`
//     lines is blocked from every cross-origin request (`gm-connect.ts`),
//     leaving it no further than the page's own `fetch`. So the
//     Network access row already tells that story, and tells it more
//     precisely than a grant name would.
//   - Most of the rest act within reach the page already has: styles,
//     elements, menu commands, resources, per-script storage.
//   - `GM_download` and `GM_openInTab` genuinely do reach outside the
//     page and are NOT `@connect`-gated. They are the case this
//     omission trades away; see the TODO note in docs/script-viewer.md.

import { openInNewTabAnchor } from './code-links.js';
import { makeCopyButton } from './copy-button.js';
import { standInTag, tagLocalFile, type LocalFileTag } from './file-changes.js';
import { rowTooltip, type DetailsMode } from './details-tooltips.js';
import { matchTargetInfo, sameDirLinkUrl } from './match-targets.js';
import { renderPatternIconInto } from './site-icon.js';
import type { StoredCollection } from './script-store.js';
import type { StoredRequire, StoredResource } from './external-files.js';
import { isContainerCollection, locationFsPath } from './directories.js';
import { appendWithSlashBreaks, displayLocation, formatBytes, logIdDupeSuffix, stripSriFragment } from './script-display.js';
import { sitePageRow } from './script-sites.js';
import {
  effectiveDisplayName,
  makeCollectionTypeBubble,
  collectionAnchorId,
} from './collection-display.js';
import { wireNamedTabLink } from './page-links.js';
import { getValue, getValues, type ParsedHeader } from './userscript-header.js';
import { versionRelation, type VersionRelation } from './version-compare.js';
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
  // For a `file://` location: the file, as `markFileChanges` wants it
  // tagged, so the caller can run that over the panel after the render
  // (see file-changes.ts).
  localFile?: LocalFileTag;
  // Intercepts activation of the location anchor. Both viewer modes
  // use it, because a plain navigation to a `.user.js` URL — http(s)
  // or file:// — is captured straight back into a preview (see
  // install-capture.ts):
  //   - preview mode routes the click through View raw source, which
  //     stands the capture down first;
  //   - installed mode stands the capture down for that one
  //     navigation, so the row's link opens what it says it opens.
  // Wired for `auxclick` too, or a middle-click would take the plain
  // path.
  onActivate?: () => void;
}

export interface DetailsModel {
  header: ParsedHeader | null;
  // Which viewer is rendering. Only the label tooltips read it — a
  // preview has nothing installed, so a few rows describe themselves
  // differently there. Defaults to 'installed'.
  mode?: DetailsMode;
  // Loaded `@require` / `@resource` entries, when the caller has them.
  // Only their byte counts are used, to qualify the Size row: the
  // script's own size understates what a page pays to run it when the
  // script pulls in a jQuery. What each declaration IS stays in the
  // code view, where every require and resource has its own tab.
  //
  // A preview passes what its parse check resolved; an installed script
  // passes its stored rows; an unparsed file passes neither and the Size
  // row shows only the script's own bytes.
  files?: {
    requires?: readonly StoredRequire[];
    resources?: readonly StoredResource[];
  };
  // Where the script itself was loaded from. Only the Match / Include /
  // Exclude rows read it: a pattern that names no site can still be
  // linked when it points into the script's own directory (see
  // `sameDirLinkUrl`). Distinct from `location.href`, which for a
  // github collection is the blob *page*, not the file.
  scriptUrl?: string;
  // Installed scripts only.
  logId?: string;
  collection?: StoredCollection | null;
  // Appended to the right of the Collection row's display name — the
  // viewer's Move control. A node rather than a flag so the details
  // renderer stays free of store calls; the caller owns the behavior.
  collectionTrailing?: Node;
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
  // Set before any row is built and read only by `appendRow`. Threading
  // it through every add* helper would touch a dozen signatures to
  // deliver one value that can't vary within a single render.
  currentMode = model.mode ?? 'installed';
  container.replaceChildren();
  const dl = document.createElement('dl');
  const h = model.header;

  if (h) {
    addText(dl, 'Name', getValue(h, 'name'));
    addText(dl, 'Description', getValue(h, 'description'));
    const version = getValue(h, 'version');
    const probes = probesWorthShowing(version, model.versionProbes);
    // A script with no `@version` normally gets no Version row at all.
    // It gets one reading `<none>` when a probe DID find a version
    // upstream: that absence is one half of the comparison, and the
    // probe row directly below is meaningless without it.
    if (version) addText(dl, 'Version', version);
    else if (probes.length > 0) appendRow(dl, 'Version', document.createTextNode(NO_VERSION));
    addVersionProbes(dl, version, probes);
  }

  // Collection row: the colored bubble + display name combo the
  // collections page uses, with the display name doubling as a
  // back-link to the collections page (anchored to this collection's
  // section). Above Location so the "where did this come from" rows are
  // grouped.
  if (model.collection) {
    appendRow(dl, 'Collection', collectionCell(model.collection, model.collectionTrailing));
  }
  if (model.location) {
    appendRow(dl, 'Location', locationCell(model.location));
    addSitePage(dl, model.location.href, h);
  }
  // Straight after the hosting-site row: both name a page about this
  // script, one derived from where it lives and one claimed by the file
  // itself, and reading them together is what shows when they disagree.
  //
  // Outside the `location` block on purpose, even though it reads as
  // part of that group: `@homepage` comes from the header alone, so a
  // script whose parent collection row has vanished (no Location row,
  // see `currentFilenamePath`) must not lose it too.
  if (h) addLink(dl, 'Homepage', declaredHomepage(h));

  // Only when the log ID carries a `#N` disambiguator. Without one it
  // is the script's own basename, which the page title and the
  // Location row above already say. The `#N` is the part that isn't
  // written anywhere in the file, and it's what a console stack trace
  // or a `//# sourceURL=` line names — so a reader holding a
  // `foo.user.js#2` needs a way to ask "is that this one?".
  if (model.logId && logIdDupeSuffix(model.logId)) {
    appendRow(dl, 'Log ID', logIdCell(model.logId));
  }

  if (h) {
    addPatterns(dl, 'Match', getValues(h, 'match'), model.scriptUrl);
    addPatterns(dl, 'Include', getValues(h, 'include'), model.scriptUrl);
    addPatterns(dl, 'Exclude', getValues(h, 'exclude'), model.scriptUrl);
    // Directly under the match targets, because it is the same
    // question asked outward: those rows say which pages the script
    // reads, this one says where it may send what it read. `@grant`
    // gets no row beside it — the rest of the GM surface acts within
    // the reach the page already has, so `@connect` is where the
    // interesting part of an install decision lives. See
    // `docs/script-viewer.md`.
    addConnect(dl, getValues(h, 'connect'));
  }

  // Last of the "what does this actually pull in" group, under the
  // reach rows and above the byte total those files contribute to.
  addLocalFiles(dl, model.files);

  if (model.size) {
    appendRow(
      dl,
      'Size',
      document.createTextNode(model.size + dependencySizeSuffix(model.files)),
    );
  }
  if (model.status) {
    appendRow(dl, 'Status', model.status);
  }

  container.appendChild(dl);
}

// What the Version row shows when the script declares no `@version`.
// Only rendered when a probe DID find one upstream — see
// `renderDetails`. Angle brackets mark it as our word for an absence
// rather than a version string a file could actually carry.
export const NO_VERSION = '<none>';

// Which probes get a row. A probe earns one when it has something the
// reader can act on:
//
//   - its version differs from ours (`newer` / `older`);
//   - exactly one side declares a `@version` at all (`unknown`) — we
//     can't say which is ahead, but "they publish 2.0 and we declare
//     nothing" is still a difference worth seeing;
//   - the latest check FAILED, whatever the version says. This row is
//     the only surface a probe failure has: probes run downstream of
//     the refresh and deliberately can't set a status or a
//     `refreshError` (see `runVersionProbes` in `script-updater.ts`),
//     and nothing logs them. Dropping the row would let a permanently
//     broken `@updateURL` go silent, and the script would read as up to
//     date when it had never once been checked.
//
// Only one case is dropped: the version matches ours AND the check
// succeeded — the expected state of an up-to-date script, and a line
// the reader would learn nothing from.
//
// Exported so the caller can ask "will any probe render?" before
// deciding how to draw the Version row above them.
export function probesWorthShowing(
  loadedVersion: string | undefined,
  probes: readonly VersionProbe[] | undefined,
): readonly VersionProbe[] {
  return (probes ?? []).filter((probe) => {
    if (probe.error) return true;
    if (probe.version === undefined) return true;
    return versionRelation(loadedVersion, probe.version) !== 'same';
  });
}

// One row per probe worth showing, labeled by the header that named it
// — "Version at update URL" or "Version at download URL".
//
// The value says how that copy relates to ours ("2.1 (Newer)") because
// the relation is the part a user acts on; the bare number alone would
// make them do the comparison themselves. Where there is no relation to
// state, the bare number is all we can honestly report. The URL rides
// along as the row's tooltip rather than a third column of text.
function addVersionProbes(
  dl: HTMLDListElement,
  loadedVersion: string | undefined,
  probes: readonly VersionProbe[],
): void {
  for (const probe of probes) {
    const relation = versionRelation(loadedVersion, probe.version);
    const dd = appendRow(
      dl,
      `Version at ${probeLabel(probe.kinds)}`,
      document.createTextNode(probeValueText(probe, relation)),
    );
    dd.title = probeTitleText(probe, relation);
    if (relation === 'newer') dd.className = 'version-newer';
  }
}

// What the row reads as. Whichever of the version and the error is the
// news goes in the value; the other one goes in the tooltip.
function probeValueText(probe: VersionProbe, relation: VersionRelation): string {
  // No version ever resolved, so the error IS the finding. The `unknown`
  // fallback covers a probe recorded before any attempt completed —
  // shouldn't outlive a check, but must not render blank if it does.
  if (probe.version === undefined) return probe.error ?? 'unknown';
  if (relation === 'newer' || relation === 'older') {
    return `${probe.version} (${relation === 'newer' ? 'Newer' : 'Older'})`;
  }
  // Our `@version` is theirs plus a `-local` tail — a copy made for
  // editing. Neither newer nor older: the release we started from.
  if (relation === 'edited') return `${probe.version} (Base of this local edit)`;
  // `unknown`: we declare no `@version` and they do. No qualifier — the
  // number is all we can say, and the Version row above reads `<none>`,
  // so the contrast is on screen without us guessing at a direction.
  if (relation === 'unknown') return probe.version;
  // `same` — reachable only when the check errored (see
  // `probesWorthShowing`). The version is old news and matches ours
  // anyway, so the failed re-check is what the row is here to say.
  return probe.error ?? probe.version;
}

function probeTitleText(probe: VersionProbe, relation: VersionRelation): string {
  if (!probe.error) return probe.url;
  // The value is showing a version, so the tooltip carries the failure
  // — otherwise the row reads as freshly confirmed when it isn't.
  if (relation !== 'same') {
    return `${probe.url} — last check failed: ${probe.error}`;
  }
  // The value is showing the error, so the tooltip carries the version
  // we last saw there, which is the part it displaced.
  return probe.version !== undefined
    ? `${probe.url} — last known version ${probe.version}`
    : probe.url;
}

// The publishing site's page for the script, derived from the Location
// URL — the location is a raw-code URL, this is the page a person can
// read. `sitePageRow` owns which sites are recognised and when the row
// would only repeat something already on screen; see
// `script-sites.ts`.
//
// Labeled with the site's own name ("Greasy Fork page") rather than a
// generic "Home page": the panel already has a Homepage row fed by the
// script's `@homepage`, and two rows with the same label saying
// different things would be worse than either alone.
function addSitePage(dl: HTMLDListElement, locationUrl: string, h: ParsedHeader | null): void {
  const row = sitePageRow(locationUrl, h ? declaredHomepage(h) : undefined);
  if (!row) return;
  appendRow(dl, row.label, openInNewTabAnchor(row.url, row.url));
}

// The header's own claim about where the script lives: the two
// spellings of the tag, first one wins. Read in three places — the
// Homepage row here and on the compare page, and the hosting-site
// row's duplicate check — which have to agree on what counts, or the
// check silently stops matching when this grows a tag.
export function declaredHomepage(h: ParsedHeader): string | undefined {
  return getValue(h, 'homepage') ?? getValue(h, 'homepageURL');
}

function addText(dl: HTMLDListElement, label: string, value: string | undefined): void {
  if (!value) return;
  appendRow(dl, label, document.createTextNode(value));
}

// `@connect` row: hosts and the wildcard/`self` forms, in the same
// face as the Match patterns above it — it was the panel's one
// monospace row, and its bullets sat a different size from its
// neighbours'. Rendered as plain text, deliberately unlinked: a
// `@connect` value is a matching rule (`self`, `*`, `*.example.com`),
// not an address, and linkifying it would invite a click that means
// nothing.
function addConnect(dl: HTMLDListElement, values: string[]): void {
  if (values.length === 0) return;
  appendRow(dl, 'Network access', listNode(values, (v) => document.createTextNode(v)));
}

function addLink(dl: HTMLDListElement, label: string, value: string | undefined): void {
  if (!value) return;
  const info = safeUrl(value);
  appendRow(dl, label, info ? openInNewTabAnchor(info, value) : document.createTextNode(value));
}

// Every `@require` / `@resource` whose body was read from a local file
// instead of the URL it declares, with the file we actually read.
//
// This row is a disclosure, not a listing: it exists because running
// something other than what a declaration names must never be silent
// (see docs/local-file-overrides.md). So it is absent for the
// overwhelming majority of scripts, and its presence is the whole
// signal. That also keeps it inside the panel's "earns a row" rule —
// it reports what we resolved, never what the header said.
//
// `@require` also wears a `local` chip on its own code tab, but
// `@resource` gets no tab at all, and the install preview has no Log
// tab to fall back on — so for a resource stand-in before install this
// row is the only surface there is.
function addLocalFiles(dl: HTMLDListElement, files: DetailsModel['files']): void {
  const entries: { kind: string; declared: string; file: LoadedFile & { localUrl: string } }[] = [];
  const groups: readonly [string, readonly LoadedFile[] | undefined][] = [
    ['@require', files?.requires],
    ['@resource', files?.resources],
  ];
  for (const [kind, list] of groups) {
    for (const f of list ?? []) {
      if (f.localUrl) entries.push({ kind, declared: f.url, file: { ...f, localUrl: f.localUrl } });
    }
  }
  if (entries.length === 0) return;

  appendRow(dl, 'Local overrides', listNode(entries, (e) => {
    const span = document.createElement('span');
    span.className = 'local-override-cell';

    const kind = document.createElement('span');
    kind.className = 'local-override-kind';
    kind.textContent = e.kind;
    span.appendChild(kind);

    // The local path is the value, because it's what the row promises
    // and what the reader needs in order to go open the file.
    //
    // Rendered as a BARE filesystem path, not the `file://` URL we
    // hold: the Location row above resolves its own `file://` location
    // the same way (`locationFsPath`, then `displayLocation`), and two
    // path styles in one panel would read as two different kinds of
    // thing. The code tab's tooltip keeps the URL form deliberately —
    // there it sits directly under the declared URL, and the pair reads
    // as "asked for this, got that".
    const localPath = locationFsPath(e.file.localUrl);
    const path = document.createElement('span');
    path.className = 'local-override-path';
    appendWithSlashBreaks(path, displayLocation(localPath));
    // Which declaration it stood in for rides along as the tooltip,
    // in the URL display form every other declared ref uses.
    path.title = `Stands in for ${displayLocation(stripSriFragment(e.declared))}`;
    // A stand-in the user has since deleted or edited gets a chip
    // saying so — until the next refresh, this row is still claiming
    // to load the bytes it holds.
    tagLocalFile(path, standInTag(localPath, e.file));
    span.appendChild(path);

    // Copies the same path the row shows — for a local file that IS the
    // useful thing to paste, and it matches what the Location row's
    // button gives you for a `file://` script.
    span.appendChild(makeCopyButton({
      label: 'Copy local file path to clipboard',
      text: () => localPath,
    }));
    return span;
  }));
}

// Tail on the Size row accounting for what the script loads alongside
// itself: ` (plus 2 @require files: 125 KB, 1 @resource file: 4 KB)`,
// carrying only the halves that exist and '' when neither does.
//
// Counts entries that actually loaded and reported a size, NOT the
// declarations in the header. A `@require` that failed to fetch
// contributes no bytes, so counting it would promise a total the
// number beside it doesn't include.
//
// A failure therefore shows up as the tail going missing entirely, not
// as a short count: `attachFiles` reports a failure with EMPTY lists,
// so one broken dependency drops the whole suffix. The declarations
// themselves stay visible in the metadata block either way, and the
// error itself is what the message bar above the panel is for.
function dependencySizeSuffix(files: DetailsModel['files']): string {
  const parts: string[] = [];
  const groups: readonly [string, readonly LoadedFile[] | undefined][] = [
    ['@require', files?.requires],
    ['@resource', files?.resources],
  ];
  for (const [tag, entries] of groups) {
    const sizes = (entries ?? []).map((e) => e.size).filter((s): s is number => s != null);
    if (sizes.length === 0) continue;
    const total = sizes.reduce((a, b) => a + b, 0);
    const noun = sizes.length === 1 ? 'file' : 'files';
    parts.push(`${sizes.length} ${tag} ${noun}: ${formatBytes(total)}`);
  }
  return parts.length === 0 ? '' : ` (plus ${parts.join(', ')})`;
}

// What the Size and Local overrides rows read off a loaded dependency,
// narrowed to what both stored shapes have in common — `StoredRequire`
// and `StoredResource` differ in how they carry their bodies, and none
// of that matters here.
interface LoadedFile {
  // The DECLARED url, kept even when a local file stood in for it.
  url: string;
  size?: number;
  // Present exactly when this entry was overridden from local disk.
  localUrl?: string;
  // The stand-in's listing mtime when it was read, for the "modified"
  // chip (file-changes.ts).
  fsMtime?: number;
}

// `@match` / `@include` / `@exclude` row: each pattern that resolves to
// a usable linkUrl via the same wildcard-trim rule as the site favicon
// becomes a clickable open-in-new-tab anchor, led by that site's
// favicon (the globe when the pattern names no site). A pattern naming
// no site gets a second chance against the script's own directory.
// Patterns we can't linkify either way (`<all_urls>`, regex literals,
// a host wildcard with nothing to anchor on) render as plain text so
// the row still shows every entry.
//
// Always a bulleted list, even for one pattern: these rows sit
// together and an icon-led inline value beside an icon-led list read
// as two different things.
function addPatterns(
  dl: HTMLDListElement,
  label: string,
  values: string[],
  scriptUrl: string | undefined,
): void {
  if (values.length === 0) return;
  appendRow(dl, label, bulletList(values, (p) => patternValueNode(p, scriptUrl)));
}

// One value renders inline; several render as a `<ul>` (folded when
// long — see `bulletList`). Generic in the item type so the rows whose
// items aren't plain strings (Local overrides) share the same
// one-vs-many rule rather than reimplementing it.
function listNode<T>(values: readonly T[], make: (v: T) => Node): Node {
  if (values.length === 1) return make(values[0]);
  return bulletList(values, make);
}

// How many items a details-panel list shows before folding the rest
// behind a "(N more)" link. Long enough that ordinary scripts never
// fold; short enough that a fifty-site `@match` block doesn't push the
// code box off the screen.
const LIST_FOLD_AT = 10;

// A `<ul>` of `values`, folded past `LIST_FOLD_AT`: the tail is hidden
// behind a last bullet reading "(N more)", which swaps the whole list
// in and turns into "(show fewer)". All items are rendered up front —
// the fold is display only — so a per-item side effect (a favicon
// fetch) happens once, whether or not the reader ever expands.
function bulletList<T>(values: readonly T[], make: (v: T) => Node): HTMLUListElement {
  const ul = document.createElement('ul');
  const items: HTMLLIElement[] = [];
  for (const v of values) {
    const li = document.createElement('li');
    li.appendChild(make(v));
    ul.appendChild(li);
    items.push(li);
  }
  // A "(1 more)" bullet takes the line it would save; show the item.
  const hidden = items.slice(LIST_FOLD_AT);
  if (hidden.length < 2) return ul;

  const toggleLi = document.createElement('li');
  toggleLi.className = 'list-fold';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'list-fold-toggle';
  toggleLi.appendChild(toggle);
  ul.appendChild(toggleLi);
  const setFolded = (folded: boolean): void => {
    for (const li of hidden) li.hidden = folded;
    toggle.textContent = folded ? `(${hidden.length} more)` : '(show fewer)';
    toggle.setAttribute('aria-expanded', String(!folded));
  };
  toggle.addEventListener('click', () => setFolded(!hidden[0].hidden));
  setFolded(true);
  return ul;
}

function patternValueNode(pattern: string, scriptUrl: string | undefined): Node {
  const target = matchTargetInfo(pattern);
  const linkUrl = target?.linkUrl ?? sameDirLinkUrl(pattern, scriptUrl);
  let text: Node;
  if (!linkUrl) {
    // Non-linkable pattern (`<all_urls>`, regex literal, etc.); render
    // as plain text but still allow slash-aware wrapping in case the
    // pattern is long.
    const span = document.createElement('span');
    appendWithSlashBreaks(span, pattern);
    text = span;
  } else {
    text = openInNewTabAnchor(linkUrl, pattern);
  }
  // Icon first, then the pattern; both open the same URL.
  const cell = document.createElement('span');
  cell.className = 'pattern-cell';
  const slot = document.createElement('span');
  slot.className = 'site-icon pattern-icon';
  renderPatternIconInto(slot, target, linkUrl);
  cell.append(slot, text);
  return cell;
}

function logIdCell(logId: string): Node {
  const span = document.createElement('span');
  span.className = 'log-id-cell';
  span.textContent = logId;
  return span;
}

// Collection-row cell: colored type bubble on the left (linking out to
// the underlying file:// / http(s):// URL), followed by the
// collection's display name as a back-link to the collections page
// anchored at this collection's section. Also each side's Collection
// cell on the compare page.
export function collectionCell(collection: StoredCollection, trailing?: Node): Node {
  const cell = document.createElement('span');
  cell.className = 'collection-cell';

  cell.appendChild(makeCollectionTypeBubble(collection.path));

  const nameLink = document.createElement('a');
  nameLink.className = 'collection-display-name';
  appendWithSlashBreaks(nameLink, effectiveDisplayName(collection));
  // The collections page is a named tab: this opens it beside the
  // viewer rather than replacing it, reusing the one that is already
  // open and scrolling it to this collection. See src/page-links.ts.
  wireNamedTabLink(nameLink, 'collections', collectionAnchorId(collection.id));
  // Tooltip surfaces the raw stored path; the anchor itself jumps to
  // the section on the collections page. Container collections have a
  // synthetic `container:…` path which would leak — skip then.
  if (!isContainerCollection(collection.path)) nameLink.title = collection.path;
  cell.appendChild(nameLink);
  if (trailing) cell.appendChild(trailing);

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
  if (row.localFile) tagLocalFile(pathEl, row.localFile);
  cell.appendChild(pathEl);

  // The caller's button is a single long-lived element; appendChild
  // moves it into the new cell on every render, so any in-flight
  // "Copied" flash carries across.
  if (row.trailing) cell.appendChild(row.trailing);

  return cell;
}

// See `renderDetails` — the mode the rows currently being built belong
// to, for their label tooltips.
let currentMode: DetailsMode = 'installed';

function appendRow(dl: HTMLDListElement, label: string, value: Node): HTMLElement {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const tip = rowTooltip(label, currentMode);
  if (tip) dt.title = tip;
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
