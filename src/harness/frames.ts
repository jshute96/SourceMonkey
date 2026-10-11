// A run's iframes (frames, below): their ids, the tree of a tab's
// frames, and which of the extension's frames each is.
// See docs/sm-dev-frames.md.
//
// - Ids come from Playwright's frames (`mainFrame().childFrames()`,
//   down the tree), which cover every frame of a page, cross-origin
//   ones included (the page's own CDP frame tree leaves those out).
//   Playwright keeps one `Frame` per frame across its navigations, so
//   an id names the frame, not its document.
// - The extension knows a frame by its `frameId` and documents by
//   `documentId` (`chrome.webNavigation.getAllFrames`); nothing in
//   either side names the other's. So the two trees are matched by
//   their shape and URLs (`matchFrameTrees`).

import type { Frame, Page } from '@playwright/test';

/** One frame of a tab as the extension lists it (`webNavigation.getAllFrames`). */
export interface ExtensionFrame {
  /** 0 for the top frame. Kept across the frame's navigations. */
  frameId: number;
  /** -1 for the top frame. */
  parentFrameId: number;
  documentId: string;
  url: string;
}

/** One of a tab's iframes, as `frameNodes` lists them. */
export interface FrameNode {
  frame: Frame;
  /** Its id's number: `F3` is 3. */
  n: number;
  /** Its parent's id number, or null for a frame in the top frame. */
  parent: number | null;
  /** How deep it is: 1 for a frame in the top frame. */
  depth: number;
  url: string;
}

/**
 * The run's frame ids: `F1`, `F2`, ... across all tabs, in the order
 * frames are first seen (a page's together, in document order). The top
 * frame has none: the tab's id names it.
 *
 * A frame that has gone gives its id to the next one in its place: one
 * with the same parent and URL, as after the tab reloads. So `F2` names
 * the same iframe after a reload, though Playwright makes new `Frame`s
 * for them. Otherwise ids aren't reused.
 */
export class FrameIds {
  private next = 1;
  private readonly numbers = new WeakMap<Frame, number>();
  // Each page's numbered frames, the gone ones' places included.
  private readonly places = new WeakMap<Page, Place[]>();
  // When a frame was first found waiting (`waits`).
  private readonly seen = new WeakMap<Frame, number>();

  number(frame: Frame): number {
    const known = this.numbers.get(frame);
    if (known !== undefined) return known;
    const page = frame.page();
    let places = this.places.get(page);
    if (!places) this.places.set(page, places = []);
    const give = (child: Frame, parent: number | null): void => {
      const n = this.reused(places, child, parent) ?? this.next++;
      this.numbers.set(child, n);
      places.push({ frame: child, n, parent });
      // Gone frames' places are kept only so long, for a page that keeps
      // replacing its ad frames.
      const gone = places.filter((p) => p.frame.isDetached());
      for (const old of gone.slice(0, Math.max(0, gone.length - MAX_GONE))) places.splice(places.indexOf(old), 1);
    };
    // The page's new frames are numbered together, down its tree, so
    // ids read in document order whichever frame was heard from first.
    const walk = (parent: Frame, parentN: number | null): void => {
      // Once a frame waits, so do its later siblings: of two with one
      // URL, the one loaded first mustn't take the earlier one's id.
      let held = false;
      for (const child of parent.childFrames()) {
        if (!this.numbers.has(child) && !child.isDetached()) {
          held ||= this.waits(places, child, parentN);
          if (!held || child === frame) give(child, parentN);
        }
        const n = this.numbers.get(child);
        if (n !== undefined) walk(child, n);
      }
    };
    if (!page.isClosed()) walk(page.mainFrame(), null);
    // Detached already, or not in the tree yet (under a frame that
    // waits). Its place is kept all the same, for a later frame in it.
    if (!this.numbers.has(frame)) {
      const parent = frame.parentFrame();
      const parentN = parent && parent !== page.mainFrame() ? this.numbers.get(parent) : null;
      if (parentN === undefined || frame.isDetached()) this.numbers.set(frame, this.next++);
      else give(frame, parentN);
    }
    return this.numbers.get(frame)!;
  }

  /**
   * Whether `frame` is waiting to be numbered: see `waits`. Listings
   * leave such a frame out until it loads.
   */
  waiting(frame: Frame): boolean {
    if (this.numbers.has(frame) || frame.isDetached()) return false;
    const parent = frame.parentFrame();
    if (!parent) return false;
    const parentN = parent === frame.page().mainFrame() ? null : this.numbers.get(parent);
    if (parentN === undefined) return false;
    const places = this.places.get(frame.page()) ?? [];
    // It, or an earlier sibling that holds it back (as in `number`).
    for (const sibling of parent.childFrames()) {
      if (!this.numbers.has(sibling) && !sibling.isDetached() && this.waits(places, sibling, parentN)) return true;
      if (sibling === frame) return false;
    }
    return false;
  }

  // Whether a frame waits to be numbered: it hasn't loaded its first
  // document (no URL yet, or the `about:blank` a new frame starts with),
  // and a gone frame's id could be its once it has. Numbered now, it
  // would take a new id. Only for so long, as some frames stay on
  // `about:blank` (one with no `src`, or one a script writes into).
  private waits(places: Place[], frame: Frame, parent: number | null): boolean {
    const url = frame.url();
    if (url !== '' && url !== 'about:blank') return false;
    if (!places.some((p) => p.parent === parent && p.frame.isDetached() && p.frame.url() !== url)) return false;
    const now = Date.now();
    let since = this.seen.get(frame);
    if (since === undefined) this.seen.set(frame, since = now);
    return now - since < WAIT_MS;
  }

  // The id of a gone frame in `child`'s place: the same parent, and its
  // URL, or failing that the same page at another query or fragment.
  private reused(places: Place[], child: Frame, parent: number | null): number | undefined {
    const url = child.url();
    const gone = places.filter((p) => p.parent === parent && p.frame.isDetached());
    // A frame keeps its last URL once detached.
    const place = gone.find((p) => p.frame.url() === url) ?? gone.find((p) => bareUrl(p.frame.url()) === bareUrl(url));
    if (!place) return undefined;
    // Its place is taken: the new frame's from now on.
    places.splice(places.indexOf(place), 1);
    return place.n;
  }
}

// A frame FrameIds numbered: where it was, for a later one to take its id.
interface Place {
  frame: Frame;
  n: number;
  parent: number | null;
}

// How many gone frames' places a page keeps.
const MAX_GONE = 100;

// How long a frame that hasn't loaded waits to be numbered (`waits`).
const WAIT_MS = 3000;

// A URL without its query and fragment.
function bareUrl(url: string): string {
  return url.replace(/[?#].*$/, '');
}

/** `F3` or `T1.F3`: the frame's number, and the tab's if given. */
export function parseFrameRef(text: string): { tab?: number; frame: number } | null {
  const m = /^(?:[Tt](\d+)\.)?[Ff](\d+)$/.exec(text);
  if (!m) return null;
  return { ...(m[1] !== undefined ? { tab: Number(m[1]) } : {}), frame: Number(m[2]) };
}

/** A page's iframes, each after its parent, with ids given to new ones. */
export function frameNodes(page: Page, ids: FrameIds): FrameNode[] {
  const out: FrameNode[] = [];
  const walk = (parent: Frame, parentN: number | null, depth: number): void => {
    for (const frame of parent.childFrames()) {
      if (frame.isDetached() || ids.waiting(frame)) continue;
      const n = ids.number(frame);
      out.push({ frame, n, parent: parentN, depth, url: frame.url() });
      walk(frame, n, depth + 1);
    }
  };
  if (!page.isClosed()) walk(page.mainFrame(), null, 1);
  return out;
}

/** The iframe `F<n>` names in `page`, while it's there. */
export function findFrame(page: Page, ids: FrameIds, n: number): Frame | undefined {
  return frameNodes(page, ids).find((node) => node.n === n)?.frame;
}

/**
 * Which of `nodes` each of the extension's frames is, by tree shape and
 * URL: from the top down, a frame is its parent's child with the same
 * URL. `known` (the last answer) goes first, so that of two sibling
 * frames with one URL, each keeps its match.
 *
 * Returns the extension's frame ids mapped to the node keys. The top
 * frame (frameId 0) maps to null.
 */
export function matchFrameTrees<K>(
  frames: readonly ExtensionFrame[],
  nodes: readonly { key: K; parent: K | null; url: string }[],
  known: ReadonlyMap<number, K> = new Map(),
): Map<number, K | null> {
  const out = new Map<number, K | null>();
  if (!frames.some((f) => f.frameId === 0)) return out;
  out.set(0, null);
  const used = new Set<K>();
  // Down the tree a level at a time: a frame is placed once its parent is.
  let level = frames.filter((f) => f.parentFrameId === 0);
  while (level.length > 0) {
    const placed: ExtensionFrame[] = [];
    // Siblings among nodes under the same parent, in order.
    const free = (f: ExtensionFrame): { key: K; url: string }[] => {
      const parent = out.get(f.parentFrameId);
      return nodes.filter((n) => n.parent === parent && !used.has(n.key));
    };
    const sorted = level.filter((f) => out.has(f.parentFrameId)).sort((a, b) => a.frameId - b.frameId);
    const take = (f: ExtensionFrame, key: K): void => {
      out.set(f.frameId, key);
      used.add(key);
      placed.push(f);
    };
    for (const f of sorted) {
      const was = known.get(f.frameId);
      const match = free(f).find((n) => n.key === was && n.url === f.url);
      if (match) take(f, match.key);
    }
    for (const f of sorted) {
      if (out.has(f.frameId)) continue;
      const match = free(f).find((n) => n.url === f.url);
      if (match) take(f, match.key);
    }
    const ids = new Set(placed.map((f) => f.frameId));
    level = frames.filter((f) => ids.has(f.parentFrameId));
  }
  return out;
}
