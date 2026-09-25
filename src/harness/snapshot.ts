// What `snapshot` adds to Playwright's accessibility tree: element refs
// the other page commands take, only the lines on screen (--visible),
// and a suggested CSS selector for each element (--css).
//
// The tree is Playwright's `ariaSnapshot({ mode: 'ai' })`: YAML-like
// lines, two spaces of indent a level, each element with a `[ref=e4]`
// (`f3e4` in the frame Playwright numbers 3: an iframe, or the page's
// own frame once the tab has had a few documents).
//
// Playwright resolves a ref against the latest snapshot of the page (or
// frame) only. An element keeps its ref from one snapshot to the next,
// unless its role or name changed, which gives it a new one.

import type { FrameLocator, Locator, Page } from '@playwright/test';

// A ref as `snapshot` shows it, and as typed: e4, ref=e4 or [ref=e4].
const REF = /^\[?(?:ref=)?((?:f\d+)?e\d+)\]?$/;

/** The ref a selector names, if it's a ref: `e4` for `[ref=e4]`. */
export function refOf(selector: string): string | null {
  return REF.exec(selector)?.[1] ?? null;
}

// Per page, its latest snapshot: for each ref, the refs of the iframes
// it's inside, outermost first, and what its line calls it; and which
// document it was of.
const snapshots = new WeakMap<Page, { frames: Map<string, string[]>; labels: Map<string, string>; document: number }>();

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
export function locate(page: Page, selector: string): Locator {
  const ref = refOf(selector);
  if (!ref) return page.locator(selector);
  let scope: Page | FrameLocator = page;
  for (const frame of snapshots.get(page)?.frames.get(ref) ?? []) scope = scope.locator(`:root >> aria-ref=${frame}`).contentFrame();
  return scope.locator(`:root >> aria-ref=${ref}`);
}

/**
 * Notes where each ref of a snapshot is, for `locate`: the latest
 * snapshot is the only one Playwright resolves refs against. `within`
 * is the frames the snapshot's root is in; `document`, the page's
 * document it was of, from `documentOf`.
 */
export function noteRefs(page: Page, tree: string, document: number, within: string[] = []): void {
  snapshots.set(page, { frames: framePaths(tree, within), labels: refLabels(tree), document });
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
export function framePaths(tree: string, within: string[] = []): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  // The iframe lines this one is under, with their indents.
  const open: { depth: number; ref: string }[] = [];
  for (const line of tree.split('\n')) {
    const depth = /^ */.exec(line)![0].length;
    while (open.length && open[open.length - 1].depth >= depth) open.pop();
    const ref = /\[ref=([^\]]+)\]/.exec(line)?.[1];
    if (!ref) continue;
    paths.set(ref, [...within, ...open.map((o) => o.ref)]);
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

/** The frames a ref's element is in, as `noteRefs` recorded them. */
export function framesAround(page: Page, selector: string): string[] {
  const ref = refOf(selector);
  return (ref && snapshots.get(page)?.frames.get(ref)) || [];
}

/**
 * A tree as `snapshot` prints it: without `[cursor=pointer]` on links
 * and buttons, which always have it. Elsewhere it stays, since it marks
 * something clickable that isn't a link or button.
 */
export function tidy(tree: string): string {
  return tree.replace(/^( *- '?(?:link|button)\b.*?) \[cursor=pointer\]/gm, '$1');
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

// How many elements' selectors are worked out at once.
const CSS_BATCH = 50;
const CSS_TIMEOUT_MS = 2000;
// How many elements take long enough to say so first (about 2ms each).
const CSS_SLOW = 1000;

/**
 * The tree with a suggested CSS selector after each ref, as
 * `[ref=e4] [css=#submit]`. An element gone since the snapshot, or one
 * without a selector that finds only it, gets none.
 */
export async function withCss(
  page: Page, tree: string, say: (line: string) => void, stopped: () => boolean,
): Promise<string> {
  const refs = [...new Set(pageRefs(tree))];
  if (refs.length > CSS_SLOW) say(`Finding selectors for ${refs.length} elements takes a while. --visible or a selector gives fewer.`);
  const found = new Map<string, string>();
  // A dialog stops the page, so each call would wait out its timeout.
  for (let i = 0; i < refs.length && !stopped(); i += CSS_BATCH) {
    await Promise.all(refs.slice(i, i + CSS_BATCH).map(async (ref) => {
      const css = await locate(page, ref).evaluate(cssFor, undefined, { timeout: CSS_TIMEOUT_MS }).catch(() => null);
      if (css) found.set(ref, css);
    }));
  }
  return tree.replace(/\[ref=([^\]]+)\]/g, (whole, ref: string) => found.has(ref) ? `${whole} [css=${found.get(ref)}]` : whole);
}

/**
 * The refs of a tree's lines, less those in an iframe's content: a
 * selector there would be within its frame, which the commands don't
 * look in. The ref's prefix doesn't tell, since the page's own frame
 * can have one too.
 */
export function pageRefs(tree: string): string[] {
  const refs: string[] = [];
  // The indent of the iframe line whose content this is, if any.
  let frameDepth: number | null = null;
  for (const line of tree.split('\n')) {
    const depth = /^ */.exec(line)![0].length;
    if (frameDepth !== null && depth <= frameDepth) frameDepth = null;
    if (frameDepth !== null) continue;
    const ref = /\[ref=([^\]]+)\]/.exec(line)?.[1];
    if (ref) refs.push(ref);
    if (/^ *- '?iframe\b/.test(line)) frameDepth = depth;
  }
  return refs;
}

/**
 * A CSS selector that finds only `el`, or null. The first of its id,
 * tag, telling attributes and classes that does, else a `>` path up
 * to an ancestor that has one, with `:nth-of-type` where siblings look
 * alike. Names that look generated (`:r1:`, `css-1x2y3z`, `x1lliihq`,
 * or with a long number in them) are passed over, since they change
 * between loads or builds of a site.
 *
 * Unique as Playwright's CSS engine sees it, which looks inside open
 * shadow roots too. An element in a shadow root gets none, since a path
 * can't cross into one. Runs in the page, so it's self-contained.
 */
export function cssFor(el: Element): string | null {
  if (!(el.getRootNode() instanceof Document)) return null;
  // The document and every open shadow root in it, found once for all
  // of a snapshot's elements: kept on the document for a moment.
  const cache = document as unknown as Record<symbol, { at: number; roots: (Document | ShadowRoot)[] } | undefined>;
  const key = Symbol.for('sm-dev shadow roots');
  let roots = cache[key] && Date.now() - cache[key].at < 1000 ? cache[key].roots : null;
  if (!roots) {
    roots = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const e of roots[i].querySelectorAll('*')) if (e.shadowRoot) roots.push(e.shadowRoot);
    }
    cache[key] = { at: Date.now(), roots };
  }
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
