// A tab's DevTools (CDP) sessions, one per process its frames run in:
// the page's own, and one for each iframe Chrome runs in a process of
// its own (an out-of-process iframe): one from another site than its
// parent (another registrable domain: not just another subdomain or
// port), with site isolation on, as it is by default. The page's session
// never sees inside those, so evaluating in such a frame, or telling
// which frame a console line came from, needs the frame's own session.
// See docs/sm-dev-frames.md.
//
// - Each session has `Runtime` on, and keeps its execution contexts
//   (each world of each frame it covers).
// - A session's frames are known by CDP frame ids; sm-dev knows frames
//   by Playwright's `Frame`. A session's root is exact (the page, or
//   the frame the session was made for). Below it, a frame is matched
//   by its parent and URL, as `matchFrameTrees` does for the extension.

import type { CDPSession, Frame, Page } from '@playwright/test';

/** An execution context: one world in one frame. */
export interface ContextInfo {
  /** The CDP id of its frame. */
  frameId: string;
  /** The world's name: '' for the page's own. */
  name: string;
  /** The frame's own (main) world. */
  isDefault: boolean;
  /** For an extension's world, its origin (`chrome-extension://<id>`). */
  origin: string;
}

/** One session: the page's, or an out-of-process iframe's. */
export interface FrameSession {
  cdp: CDPSession;
  /** The frame it was made for: the page's main frame, or the iframe. */
  root: Frame;
  /** Its execution contexts by id, as `Runtime` reports them. */
  contexts: Map<number, ContextInfo>;
  /** Its CDP target's id, once asked for (`targetIdOf`). */
  targetId?: Promise<string | undefined>;
}

/** What a session's setup can listen for besides its contexts. */
export type SessionSetup = (session: FrameSession) => void | Promise<void>;

// The CDP frame tree, as `Page.getFrameTree` gives it.
interface FrameTree {
  frame: { id: string; url: string; urlFragment?: string };
  childFrames?: FrameTree[];
}

export class FrameSessions {
  private readonly sessions = new Map<Frame, Promise<FrameSession | null>>();
  // Frames tried and found to be in their parent's process, by the URL
  // they had: a navigation can move a frame into a process of its own.
  private readonly inParent = new WeakMap<Frame, string>();
  private disposed = false;
  // Bumped on each frame change, which can change a session's frame tree.
  private generation = 0;
  private readonly trees = new WeakMap<FrameSession, { generation: number; tree: Promise<FrameTree | null> }>();
  private readonly onAttached = (frame: Frame): void => {
    this.generation++;
    if (frame !== this.page.mainFrame()) void this.sessionFor(frame);
  };
  // A navigation can move a frame into a process of its own or back into
  // its parent's, which ends its own target: its session is opened again.
  private readonly onNavigated = (frame: Frame): void => {
    this.generation++;
    if (frame === this.page.mainFrame()) return;
    this.close(frame);
    void this.sessionFor(frame);
  };
  private readonly onDetached = (frame: Frame): void => {
    this.generation++;
    this.close(frame);
  };

  private constructor(private readonly page: Page, private readonly setup: SessionSetup) {}

  /**
   * Sessions for `page` and each out-of-process iframe it has or gets,
   * each set up with `setup` before `Runtime` is on (so it hears the
   * contexts that exist already). Null when the page has closed.
   */
  static async attach(page: Page, setup: SessionSetup = () => undefined): Promise<FrameSessions | null> {
    const sessions = new FrameSessions(page, setup);
    const main = await sessions.open(page.mainFrame());
    if (typeof main !== 'object' || main === null) return null;
    page.on('frameattached', sessions.onAttached);
    page.on('framenavigated', sessions.onNavigated);
    page.on('framedetached', sessions.onDetached);
    for (const frame of page.frames()) sessions.onAttached(frame);
    return sessions;
  }

  /** The page's own session. */
  async pageSession(): Promise<FrameSession | null> {
    return this.sessions.get(this.page.mainFrame()) ?? null;
  }

  /** Every session open now. */
  async all(): Promise<FrameSession[]> {
    return (await Promise.all(this.sessions.values())).filter((s): s is FrameSession => s !== null);
  }

  /**
   * The session `frame` runs in, and its CDP frame id there, or null
   * when it can't be found (detached, or between documents).
   */
  async locate(frame: Frame): Promise<{ session: FrameSession; frameId: string } | null> {
    if (frame.isDetached()) return null;
    // The nearest of the frame and its ancestors with a session.
    const path: Frame[] = [];
    let session: FrameSession | null = null;
    for (let f: Frame | null = frame; f; f = f.parentFrame()) {
      session = f === this.page.mainFrame() ? await this.pageSession() : await this.sessionFor(f);
      if (session) break;
      path.unshift(f);
    }
    if (!session) return null;
    const tree = await this.treeOf(session);
    if (!tree) return null;
    let node = tree;
    let at = session.root;
    for (const step of path) {
      const child = await this.childNode(node, at, step);
      if (!child) return null;
      node = child;
      at = step;
    }
    return { session, frameId: node.frame.id };
  }

  /**
   * The CDP target id of an iframe Chrome runs in a process of its own,
   * which a raw CDP client attaches to (`Target.attachToTarget`).
   * Undefined for one in its parent's process, which is part of the
   * page's target.
   */
  async targetIdOf(frame: Frame): Promise<string | undefined> {
    if (frame === this.page.mainFrame()) return undefined;
    const session = await this.sessionFor(frame);
    if (!session) return undefined;
    session.targetId ??= session.cdp.send('Target.getTargetInfo').then((r) => r.targetInfo.targetId, () => undefined);
    return session.targetId;
  }

  /** The frame a session's CDP frame id names, or undefined. */
  async frameOf(session: FrameSession, frameId: string): Promise<Frame | undefined> {
    const tree = await this.treeOf(session);
    if (!tree) return undefined;
    const walk = async (node: FrameTree, frame: Frame): Promise<Frame | undefined> => {
      if (node.frame.id === frameId) return frame;
      for (const child of frame.childFrames()) {
        const childNode = await this.childNode(node, frame, child);
        if (!childNode) continue;
        const found = await walk(childNode, child);
        if (found) return found;
      }
      return undefined;
    };
    return walk(tree, session.root);
  }

  /** Detach all its sessions. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.page.off('frameattached', this.onAttached);
    this.page.off('framenavigated', this.onNavigated);
    this.page.off('framedetached', this.onDetached);
    const all = await this.all();
    await Promise.all(all.map((s) => s.cdp.detach().catch(() => undefined)));
  }

  // The CDP node of `child` (a Playwright child of `frame`) among the
  // children of `node` (`frame`'s CDP node): one in its own process
  // isn't in this tree. Siblings with one URL go by order.
  private async childNode(node: FrameTree, frame: Frame, child: Frame): Promise<FrameTree | undefined> {
    const local: Frame[] = [];
    for (const c of frame.childFrames()) if (!await this.sessionFor(c)) local.push(c);
    const url = child.url();
    const same = local.filter((c) => c.url() === url);
    const nodes = (node.childFrames ?? []).filter((n) => n.frame.url + (n.frame.urlFragment ?? '') === url || n.frame.url === url);
    return nodes[same.indexOf(child)];
  }

  // A session's CDP frame tree, read once until the frames change: a
  // console line from each frame asks for it.
  private treeOf(session: FrameSession): Promise<FrameTree | null> {
    const known = this.trees.get(session);
    if (known?.generation === this.generation) return known.tree;
    const tree = session.cdp.send('Page.getFrameTree').then((r) => r.frameTree as FrameTree, () => null);
    this.trees.set(session, { generation: this.generation, tree });
    return tree;
  }

  // Ends an iframe's own session, if it has one.
  private close(frame: Frame): void {
    const known = this.sessions.get(frame);
    if (!known) return;
    this.sessions.delete(frame);
    void known.then((session) => session?.cdp.detach()).catch(() => undefined);
  }

  // A frame's own session, opened if it runs out of process; null when
  // it shares its parent's. Asked again after the frame navigates
  // elsewhere, which can move it.
  private sessionFor(frame: Frame): Promise<FrameSession | null> {
    if (frame === this.page.mainFrame()) return this.sessions.get(frame) ?? Promise.resolve(null);
    const known = this.sessions.get(frame);
    if (known) return known;
    if (this.inParent.get(frame) === frame.url()) return Promise.resolve(null);
    const url = frame.url();
    const opening: Promise<FrameSession | null> = this.open(frame).then((session) => {
      if (session === 'in-parent') this.inParent.set(frame, url);
      // A failure other than that is tried again next time.
      if (typeof session !== 'object' || session === null) {
        if (this.sessions.get(frame) === opening) this.sessions.delete(frame);
        return null;
      }
      // Its target went (the frame left): the next look opens another.
      session.cdp.on('Inspector.detached', () => { if (this.sessions.get(frame) === opening) this.sessions.delete(frame); });
      return session;
    });
    this.sessions.set(frame, opening);
    return opening;
  }

  // A session for `frame`; 'in-parent' when it shares its parent's
  // process, so has none of its own; null when it couldn't be opened.
  private async open(frame: Frame): Promise<FrameSession | 'in-parent' | null> {
    if (this.disposed || frame.isDetached()) return null;
    let cdp: CDPSession;
    try {
      // Playwright refuses a frame that shares its parent's process.
      cdp = await this.page.context().newCDPSession(frame === this.page.mainFrame() ? this.page : frame);
    } catch {
      return frame.isDetached() ? null : 'in-parent';
    }
    const session: FrameSession = { cdp, root: frame, contexts: new Map() };
    cdp.on('Runtime.executionContextCreated', ({ context }) => {
      const aux = (context.auxData ?? {}) as { frameId?: string; isDefault?: boolean };
      session.contexts.set(context.id, { frameId: aux.frameId ?? '', name: context.name, isDefault: aux.isDefault === true, origin: context.origin });
    });
    cdp.on('Runtime.executionContextDestroyed', (ev) => { session.contexts.delete(ev.executionContextId); });
    cdp.on('Runtime.executionContextsCleared', () => { session.contexts.clear(); });
    try {
      await this.setup(session);
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
    } catch {
      await cdp.detach().catch(() => undefined);
      return null;
    }
    // Disposed meanwhile: nothing would detach it later.
    if (this.disposed) {
      await cdp.detach().catch(() => undefined);
      return null;
    }
    if (frame === this.page.mainFrame()) this.sessions.set(frame, Promise.resolve(session));
    return session;
  }
}
