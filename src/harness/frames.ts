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
 * The run's frame ids: `F1`, `F2`, ... in the order frames are first
 * seen, across all tabs, never reused. The top frame has none: the
 * tab's id names it.
 */
export class FrameIds {
  private next = 1;
  private readonly numbers = new WeakMap<Frame, number>();

  number(frame: Frame): number {
    let n = this.numbers.get(frame);
    if (n === undefined) {
      n = this.next++;
      this.numbers.set(frame, n);
    }
    return n;
  }
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
      if (frame.isDetached()) continue;
      const n = ids.number(frame);
      out.push({ frame, n, parent: parentN, depth, url: frame.url() });
      walk(frame, n, depth + 1);
    }
  };
  if (!page.isClosed()) walk(page.mainFrame(), null, 1);
  return out;
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
