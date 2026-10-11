// What `snapshot` adds to Playwright's accessibility tree: element refs
// the other page commands take, and only the lines on screen
// (--visible). Also `probe --css`'s suggested CSS selectors.
//
// The tree is Playwright's `ariaSnapshot({ mode: 'ai' })`: YAML-like
// lines, two spaces of indent a level, each element with a `[ref=e4]`
// (`f3e4` in the frame Playwright numbers 3: an iframe, or the page's
// own frame once the tab has had a few documents).
//
// Playwright resolves a ref against the latest snapshot of the page (or
// frame) only. An element keeps its ref from one snapshot to the next,
// unless its role or name changed, which gives it a new one.

import type { Frame, FrameLocator, Locator, Page } from '@playwright/test';

import { CONTEXT_LINES } from './command-list.js';

// A ref as `snapshot` shows it, and as typed: e4, ref=e4 or [ref=e4].
const REF = /^\[?(?:ref=)?((?:f\d+)?e\d+)\]?$/;

/** The ref a selector names, if it's a ref: `e4` for `[ref=e4]`. */
export function refOf(selector: string): string | null {
  return REF.exec(selector)?.[1] ?? null;
}

// Per page, its latest snapshots: for each ref, the refs of the iframes
// it's inside, outermost first, what its line calls it, and the frame
// whose snapshot it's from when that's an iframe's (`snapshot
// --frame`); and which document they were of.
interface NotedRefs {
  frames: Map<string, string[]>;
  labels: Map<string, string>;
  roots: Map<string, Frame>;
  document: number;
}
const snapshots = new WeakMap<Page, NotedRefs>();

/**
 * The elements a selector names, or the element a ref does.
 *
 * A ref is looked up in the frame the latest snapshot showed it in,
 * through its iframes' refs, not by its prefix. Playwright finds a
 * ref's frame by the number in its prefix, and a page restored by Back
 * keeps refs numbered for a frame Playwright has since renumbered
 * ("Invalid frame in aria-ref selector"). Starting from `:root` keeps
 * Playwright from reading the prefix at all.
 */
export function locate(page: Page, selector: string, within?: Frame): Locator {
  const ref = refOf(selector);
  // A selector looks in `within` (`--frame`), else the page's own frame.
  if (!ref) return (within ?? page).locator(selector);
  const noted = snapshots.get(page);
  let scope: Page | Frame | FrameLocator = noted?.roots.get(ref) ?? page;
  for (const frame of noted?.frames.get(ref) ?? []) scope = scope.locator(`:root >> aria-ref=${frame}`).contentFrame();
  return scope.locator(`:root >> aria-ref=${ref}`);
}

/**
 * Notes where each ref of a snapshot is, for `locate`: each frame's
 * latest snapshot is the only one Playwright resolves its refs against.
 * `tree` is the whole page's, or with `within` an iframe's; `document`,
 * the page's document it was of, from `documentOf`.
 *
 * An iframe's snapshot adds to the page's latest of the same document
 * rather than replacing it: the page's other frames keep theirs, and an
 * element keeps its ref from one snapshot to the next.
 */
export function noteRefs(page: Page, tree: string, document: number, within?: Frame): void {
  const paths = framePaths(tree);
  const labels = refLabels(tree);
  const before = snapshots.get(page);
  if (!within || before?.document !== document) {
    const roots = new Map<string, Frame>();
    if (within) for (const ref of paths.keys()) roots.set(ref, within);
    snapshots.set(page, { frames: paths, labels, roots, document });
    return;
  }
  for (const [ref, path] of paths) {
    before.frames.set(ref, path);
    before.roots.set(ref, within);
  }
  for (const [ref, label] of labels) before.labels.set(ref, label);
}

/**
 * Which document the page shows: its `performance.timeOrigin`, new
 * with each load, the same across a single-page app's route changes
 * and back again after Back restores a page from the browser's cache.
 * A new document has none of the old one's refs.
 */
export function documentOf(page: Page): Promise<number> {
  return page.evaluate(() => performance.timeOrigin);
}

/**
 * Why a ref can't name anything on the page now, when that's because
 * there's no snapshot of the document showing: none taken, or the page
 * has loaded since. Null otherwise.
 */
export async function refProblem(page: Page, selector: string): Promise<string | null> {
  if (!refOf(selector)) return null;
  const noted = snapshots.get(page);
  if (!noted) return 'This tab has no snapshot yet. Take one with snapshot.';
  if (noted.document !== await documentOf(page)) return 'The page reloaded since the last snapshot. Take a new snapshot.';
  return null;
}

/** Where a snapshot's refs are: the refs of the iframes each is in. */
export function framePaths(tree: string): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  // The iframe lines this one is under, with their indents.
  const open: { depth: number; ref: string }[] = [];
  for (const line of tree.split('\n')) {
    const depth = /^ */.exec(line)![0].length;
    while (open.length && open[open.length - 1].depth >= depth) open.pop();
    const ref = /\[ref=([^\]]+)\]/.exec(line)?.[1];
    if (!ref) continue;
    paths.set(ref, [...open.map((o) => o.ref)]);
    if (/^ *- '?iframe\b/.test(line)) open.push({ depth, ref });
  }
  return paths;
}

// How long a label `named` gives can be.
const LABEL_LIMIT = 60;

/**
 * What each ref's line calls its element, its role and name as in
 * `link "past"`, so a command can say what a ref named.
 */
export function refLabels(tree: string): Map<string, string> {
  const labels = new Map<string, string>();
  for (const line of tree.split('\n')) {
    const ref = /\[ref=([^\]]+)\]/.exec(line)?.[1];
    if (!ref) continue;
    // `- 'link "a: b" [ref=e2]':` is YAML-quoted, its ' doubled.
    const quoted = /^ *- '/.test(line);
    let label = line.replace(/^ *- '?/, '').split(' [')[0];
    if (quoted) label = label.replace(/''/g, '\'');
    labels.set(ref, label.length > LABEL_LIMIT ? `${label.slice(0, LABEL_LIMIT)}…` : label);
  }
  return labels;
}

/** A selector as a command says it back: a ref with what it named, `e5 (link "past")`. */
export function named(page: Page, selector: string): string {
  const ref = refOf(selector);
  const label = ref && snapshots.get(page)?.labels.get(ref);
  return label ? `${selector} (${label})` : selector;
}

/**
 * A tree of the whole page (`:root`) without its top `- document`
 * line, which only wraps the rest, and with the rest a level less
 * indented: as a snapshot of `body` would look, plus what is outside
 * it. A tree that doesn't start that way is left as it is.
 */
export function withoutDocument(tree: string): string {
  const [first, ...rest] = tree.split('\n');
  if (!/^- document\b.*:$/.test(first) || rest.some((l) => !l.startsWith('  '))) return tree;
  return rest.map((l) => l.slice(2)).join('\n');
}

/**
 * A tree as `snapshot` prints it: without `[cursor=pointer]` on links
 * and buttons, which always have it. Elsewhere it stays, since it marks
 * something clickable that isn't a link or button.
 */
export function tidy(tree: string): string {
  return tree.replace(/^( *- '?(?:link|button)\b.*?) \[cursor=pointer\]/gm, '$1');
}

/**
 * The top refs of a snapshot of one element: its own line's, or its
 * children's when the tree leaves the element itself out. For finding
 * where it is in a snapshot of the whole page (`treeParts`).
 */
export function topRefs(tree: string): string[] {
  return tree.split('\n').filter((l) => l.startsWith('- ')).map((l) => /\[ref=([^\]]+)\]/.exec(l)?.[1]).filter((r) => r !== undefined);
}

/**
 * Where a selector's match is in the whole page's tree, as `topRefs`.
 * The whole tree folds a match that is only text (a span in a link or
 * a paragraph) into the element above it, so it's found as the nearest
 * one above that has a line. None for a match the tree leaves out
 * (hidden). Depth 1 keeps each snapshot short; Playwright still walks
 * the match's whole subtree.
 */
export async function refsOf(match: Locator, timeout: number): Promise<string[]> {
  for (let at = match; ; at = at.locator('xpath=..')) {
    const tree = await at.ariaSnapshot({ mode: 'ai', depth: 1, timeout });
    if (tree.trim() === '') return [];
    const refs = topRefs(tree);
    if (refs.length) return refs;
  }
}

/**
 * The parts of a whole page's tree `snapshot` shows for a selector or
 * `--find`, each dedented to start at the left.
 *
 * - `matches`: a selector's matches, as each one's `topRefs`. A match
 *   not in the tree (hidden, or off screen) is left out.
 * - `text`: the elements containing it, within `matches` when given. A text
 *   or /url line stands for the element it's in.
 *
 * Each part then goes `up` levels, then with `context`, as far up as
 * adds at most `CONTEXT_LINES` lines (wrappers add one each). A part
 * inside another is left out.
 *
 * The text is matched without regard to case or runs of spaces, against
 * a line's content (names, text, values, URLs), not its role or
 * `[ref=e4]`-style attributes, so `button` doesn't find every button.
 */
export function treeParts(tree: string, { matches, text, up = 0, context = false }: {
  matches?: string[][]; text?: string; up?: number; context?: boolean;
}): string[] {
  const lines = tree.split('\n');
  const depth = lines.map((l) => /^ */.exec(l)![0].length / 2);
  // Where the part a line starts ends: the next line no deeper.
  const end = (i: number): number => {
    let j = i + 1;
    while (j < lines.length && depth[j] > depth[i]) j++;
    return j;
  };
  const parent = (i: number): number => {
    for (let j = i - 1; j >= 0; j--) if (depth[j] < depth[i]) return j;
    return -1;
  };
  // Each part as the lines [start, end).
  let parts: [number, number][];
  if (matches) {
    const lineOf = new Map<string, number>();
    lines.forEach((l, i) => {
      const ref = /\[ref=([^\]]+)\]/.exec(l)?.[1];
      if (ref) lineOf.set(ref, i);
    });
    parts = [];
    for (const refs of matches) {
      const at = refs.map((r) => lineOf.get(r)).filter((i) => i !== undefined);
      if (at.length) parts.push([Math.min(...at), end(Math.max(...at))]);
    }
  } else {
    parts = [[0, lines.length]];
  }
  if (text !== undefined) {
    const wanted = squash(text);
    const hits: [number, number][] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!parts.some(([a, b]) => i >= a && i < b) || !squash(contentOf(lines[i])).includes(wanted)) continue;
      const root = /\[ref=/.test(lines[i]) ? i : Math.max(0, parent(i));
      hits.push([root, end(root)]);
    }
    parts = hits;
  }
  parts = parts.map(([a, b]) => {
    for (let n = 0; n < up && parent(a) >= 0; n++) [a, b] = [parent(a), end(parent(a))];
    if (context) {
      const size = b - a;
      while (parent(a) >= 0 && end(parent(a)) - parent(a) <= size + CONTEXT_LINES) [a, b] = [parent(a), end(parent(a))];
    }
    return [a, b];
  });
  // Parts are nested or apart: the outer one sorts first.
  parts.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  const shown: string[] = [];
  let covered = -1;
  for (const [a, b] of parts) {
    if (a < covered) continue;
    covered = b;
    shown.push(lines.slice(a, b).map((l) => l.slice(depth[a] * 2)).join('\n'));
  }
  return shown;
}

// A tree line's content, for `treeParts`: without its indent, YAML
// quoting, role or `text:`-style key, and `[...]` attributes.
function contentOf(line: string): string {
  let rest = line.replace(/^ *- /, '');
  if (rest.startsWith('\'')) rest = rest.replace(/^'|'(:?)$/g, '$1').replace(/''/g, '\'');
  // role "name" [attr] [attr]: text, each part but the role optional.
  const parts = /^[\w/-]+(?: ("(?:[^"\\]|\\.)*"))?(?: \[[^\]]*\])*(?::(.*))?$/.exec(rest);
  if (!parts) return rest;
  return `${parts[1] ?? ''} ${parts[2] ?? ''}`.replace(/\\"/g, '"');
}

function squash(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const BOX = / \[box=(-?[\d.]+),(-?[\d.]+),([\d.]+),([\d.]+)\]/;

/**
 * The lines of a tree taken with `boxes: true` that show on screen, in
 * a viewport of `width` by `height`, with the boxes taken out. A line
 * stays when its element's box is at least partly on screen, or when a
 * line under it stays, so each kept line still has its parents. A line
 * without a box (text, a link's /url) goes with the element it's in.
 */
export function onScreen(tree: string, width: number, height: number): string {
  const kept: string[] = [];
  // The open lines above this one: where each sits on the page, what of
  // the page it can show in (a frame's content, only its frame's box),
  // and whether it shows, or has a line under it that does.
  interface Open {
    depth: number;
    shows: boolean;
    // Where the frame the line is in starts, and what of it shows.
    offset: { x: number; y: number };
    clip: Box;
    // Its own box on the page, for a frame's content.
    box: Box | null;
    frame: boolean;
    index: number;
    kept: boolean;
  }
  const open: Open[] = [];
  const lines = tree.split('\n');
  const keep: boolean[] = lines.map(() => false);
  const texts: string[] = [];
  const screen: Box = { x: 0, y: 0, width, height };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const depth = (/^ */.exec(line)![0].length) / 2;
    while (open.length && open[open.length - 1].depth >= depth) open.pop();
    const parent = open[open.length - 1];
    const match = BOX.exec(line);
    texts.push(match ? line.replace(BOX, '') : line);
    // Inside a frame, boxes are from the frame's corner.
    const offset = parent ? (parent.frame && parent.box ? { x: parent.box.x, y: parent.box.y } : parent.offset) : { x: 0, y: 0 };
    const clip = parent ? (parent.frame && parent.box ? overlap(parent.clip, parent.box) : parent.clip) : screen;
    let box: Box | null = null;
    let shows: boolean;
    if (match) {
      box = { x: offset.x + Number(match[1]), y: offset.y + Number(match[2]), width: Number(match[3]), height: Number(match[4]) };
      shows = meets(box, clip);
    } else {
      shows = parent ? parent.shows : true;
    }
    const frame = /^ *- '?iframe\b/.test(line);
    open.push({ depth, shows, offset, clip, box, frame, index: i, kept: false });
    if (shows) {
      // It, and every line above it, stays.
      for (let j = open.length - 1; j >= 0 && !open[j].kept; j--) {
        open[j].kept = true;
        keep[open[j].index] = true;
      }
    }
  }
  for (let i = 0; i < texts.length; i++) if (keep[i]) kept.push(texts[i]);
  return kept.join('\n');
}

// Whether a box is at least partly inside `clip`. An element with no
// size shows when its corner does.
function meets(box: Box, clip: Box): boolean {
  return box.x < clip.x + clip.width && box.y < clip.y + clip.height
    && box.x + Math.max(box.width, 1) > clip.x && box.y + Math.max(box.height, 1) > clip.y;
}

function overlap(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x, y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}

/** One of a selector's matches, as `probe` shows it. */
export interface Match {
  /** A selector that finds only it (see `cssFor`), or null. */
  css: string | null;
  /** Whether it's in a shadow root, where a selector path can't reach. */
  shadow: boolean;
  /** Its HTML on one line, cut at `HTML_MAX` characters. */
  html: string;
}

const HTML_MAX = 500;

/**
 * The first `max` elements a selector matches, in one call to the page,
 * and how many it matched then. `framed` when they're in a frame, where
 * a selector would only work within it.
 */
export async function probeMatches(
  page: Page, selector: string, max: number, timeout: number, within?: Frame,
): Promise<{ framed: boolean; count: number; matches: Match[] }> {
  const locator = locate(page, selector, within);
  const limits = { max, htmlMax: HTML_MAX };
  // Playwright finds a ref's element in the world it took the snapshot
  // in, which `evaluate` looks in and `evaluateAll` doesn't.
  if (refOf(selector)) return locator.evaluate(matchesOf, limits, { timeout });
  return locator.evaluateAll(matchesOf, limits);
}

// Playwright sends a page function as its source, so openRoots and
// cssFor (which are self-contained) go along by being written into it.
// Made with `new Function` only to have that source: it never runs here.
const matchesOf = new Function(
  `return (els, { max, htmlMax }) => {
    const openRoots = ${openRoots.toString()};
    const cssFor = ${cssFor.toString()};
    const list = Array.isArray(els) ? els : [els];
    const roots = openRoots();
    return {
      framed: window !== window.top,
      count: list.length,
      matches: list.slice(0, max).map((el) => {
        const html = el.outerHTML.replace(/\\s*\\n\\s*/g, ' ');
        return {
          css: cssFor(el, roots),
          shadow: !(el.getRootNode() instanceof Document),
          html: html.length > htmlMax ? html.slice(0, htmlMax) + '\\u2026' : html,
        };
      }),
    };
  };`,
)() as (els: Element | Element[], limits: { max: number; htmlMax: number }) => { framed: boolean; count: number; matches: Match[] };

/**
 * The document and every open shadow root in it, which Playwright's CSS
 * engine looks inside too. Runs in the page, so it's self-contained.
 */
export function openRoots(): (Document | ShadowRoot)[] {
  const roots: (Document | ShadowRoot)[] = [document];
  for (let i = 0; i < roots.length; i++) {
    for (const e of roots[i].querySelectorAll('*')) if (e.shadowRoot) roots.push(e.shadowRoot);
  }
  return roots;
}

/**
 * A CSS selector that finds only `el`, or null. The first of its id,
 * tag, telling attributes and classes that does, else a `>` path up
 * to an ancestor that has one, with `:nth-of-type` where siblings look
 * alike. Names that look generated (`:r1:`, `css-1x2y3z`, `x1lliihq`,
 * or with a long number in them) are passed over, since they change
 * between loads or builds of a site.
 *
 * Unique as Playwright's CSS engine sees it, across `roots` (from
 * `openRoots`). An element in a shadow root gets none, since a path
 * can't cross into one. Runs in the page, so it's self-contained.
 */
export function cssFor(el: Element, roots: (Document | ShadowRoot)[]): string | null {
  if (!(el.getRootNode() instanceof Document)) return null;
  const all = roots;
  const only = (selector: string): boolean => {
    try {
      let count = 0;
      for (const root of all) {
        const found = root.querySelectorAll(selector);
        count += found.length;
        if (count > 1 || (found.length === 1 && found[0] !== el)) return false;
      }
      return count === 1;
    } catch {
      return false;
    }
  };
  const generated = (name: string): boolean => /^[:_\d]|:|\d{3,}|^(css|sc|jsx|svelte|emotion)-/.test(name)
    || (/^[a-z]{1,2}\d/i.test(name) && name.length >= 6 && !/[-_]/.test(name));
  const quote = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const choices = (e: Element): string[] => {
    const tag = CSS.escape(e.localName);
    const found: string[] = [];
    if (e.id && !generated(e.id)) found.push(`#${CSS.escape(e.id)}`);
    found.push(tag);
    for (const name of ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label', 'placeholder', 'title', 'alt', 'type', 'role', 'href']) {
      const value = e.getAttribute(name);
      if (value && value.length <= 60) found.push(`${tag}[${name}=${quote(value)}]`);
    }
    const classes = [...e.classList].filter((c) => !generated(c)).slice(0, 3).map((c) => `.${CSS.escape(c)}`);
    for (const c of classes) found.push(tag + c);
    if (classes.length > 1) found.push(tag + classes.join(''));
    return found;
  };
  const path: string[] = [];
  for (let e: Element | null = el; e; e = e.parentElement) {
    const options = choices(e);
    const unique = options.find((o) => only([o, ...path].join(' > ')));
    if (unique) return [unique, ...path].join(' > ');
    // Among its siblings, what tells it apart.
    const siblings = e.parentElement ? [...e.parentElement.children] : [e];
    const apart = options.find((o) => {
      try {
        return siblings.filter((s) => s.matches(o)).length === 1;
      } catch {
        return false;
      }
    });
    const tag = CSS.escape(e.localName);
    path.unshift(apart ?? `${tag}:nth-of-type(${siblings.filter((s) => s.localName === e!.localName).indexOf(e) + 1})`);
    if (only(path.join(' > '))) return path.join(' > ');
  }
  return null;
}
