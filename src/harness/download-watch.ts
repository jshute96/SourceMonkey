// Says where a download from one of the run's tabs went, as it finishes.
// A page's own downloads (a link, a script's `<a download>` click) pass
// SourceMonkey by, so without this a run has no record of them at all.
// An http(s) `GM_download` gets its own line from the extension's report;
// a `blob:` or `data:` one is an `<a download>` click in the page, so it
// gets this line.
//
// Chrome reports downloads over CDP only to a client that asks
// (`Browser.setDownloadBehavior` with `eventsEnabled`), and to all such
// clients for all tabs, so each is checked against the run's tabs.

import type { Browser, CDPSession } from '@playwright/test';

import { withoutQuery, type ControlledTab } from './console-commands.js';

export interface DownloadWatch {
  /** Stop listening; no line prints after this. */
  stop(): Promise<void>;
}

/**
 * Start reporting the run's downloads through `out`. `tabs` is read as
 * each download starts, so a tab opened later counts.
 *
 * With `downloadsDir` (a launched browser), downloads are saved there.
 * Without, they keep the browser's own setting, as its person set it.
 *
 * Never throws: reporting downloads is a side feature, so a browser
 * that refuses it gets a note, and the run goes on without it.
 */
export async function watchDownloads(
  browser: Browser,
  tabs: () => ControlledTab[],
  out: (line: string) => void,
  { downloadsDir }: { downloadsDir?: string } = {},
): Promise<DownloadWatch> {
  let cdp: CDPSession | undefined;
  let stopped = false;
  const say = (line: string): void => {
    if (!stopped) out(line);
  };
  try {
    const session = cdp = await browser.newBrowserCDPSession();
    // Ours, by guid, from start to end; a download of another client's
    // tab is null. A promise, since finding the tab takes round trips
    // and a small download can finish first.
    const started = new Map<string, Promise<{ url: string; prefix: string } | null>>();
    // Each target's parent or opener frame, recorded as it's created: a
    // new tab that turns into a download closes at once, often before
    // its download could be traced back through it. Kept for the run
    // (a few ids per tab), since a closed one may still be asked about.
    const parents = new Map<string, string>();
    const record = ({ targetInfo: t }: { targetInfo: { targetId: string; parentFrameId?: string; openerFrameId?: string; openerId?: string } }): void => {
      const up = t.parentFrameId ?? t.openerFrameId ?? t.openerId;
      if (up) parents.set(t.targetId, up);
    };
    session.on('Target.targetCreated', record);
    session.on('Target.targetInfoChanged', record);
    await session.send('Target.setDiscoverTargets', { discover: true });
    session.on('Browser.downloadWillBegin', (event) => {
      started.set(event.guid, tabOf(session, parents, tabs(), event.frameId).then((tab) => tab
        ? { url: event.url, prefix: tab.n > 1 ? `[T${tab.n}] ` : '' }
        : null));
    });
    session.on('Browser.downloadProgress', (event) => {
      if (event.state === 'inProgress') return;
      const pending = started.get(event.guid);
      if (!pending) return;
      started.delete(event.guid);
      void pending.then((download) => {
        if (!download) return;
        const from = shownUrl(download.url);
        if (event.state === 'completed') {
          // Chrome doesn't promise the path on all platforms.
          say(`${download.prefix}[sm-dev] Download saved: ${event.filePath || 'in the browser\'s download folder'} (from ${from})`);
        } else {
          // Chrome reports a download cancelled in its UI and one that
          // failed the same way.
          say(`${download.prefix}[sm-dev] Download from ${from} did not finish: It was cancelled or failed`);
        }
      });
    });
    // `allow` into a folder of ours for a launched browser: unlike
    // `default`, it skips Chrome's prompts for a dangerous or insecure
    // download, which nobody could answer in a hidden browser, so the
    // download would wait forever. It keeps the file's own name, where
    // Playwright's `allowAndName` (which its connection sets up) uses a
    // GUID.
    //
    // `default` for a connected browser: its own setting, and its own
    // prompts for a person to answer.
    await session.send('Browser.setDownloadBehavior', downloadsDir
      ? { behavior: 'allow', downloadPath: downloadsDir, eventsEnabled: true }
      : { behavior: 'default', eventsEnabled: true });
  } catch (err) {
    out(`[sm-dev] Downloads from the run's tabs won't be reported: ${(err as Error).message}`);
    if (cdp) await detach(cdp);
    cdp = undefined;
  }
  return {
    stop: async () => {
      stopped = true;
      if (cdp) await detach(cdp);
    },
  };
}

// The run's tab a download came from, by its frame:
// - a tab's top frame has the tab's target id;
// - a new tab that became the download (a `target=_blank` link, a
//   `window.open`) names the frame that opened it;
// - a cross-site iframe is a target of its own, naming its parent frame;
// - a same-site iframe is in a tab's frame tree.
// Followed up a few steps, since each of those can lead to another.
async function tabOf(
  cdp: CDPSession,
  parents: Map<string, string>,
  tabs: ControlledTab[],
  frameId: string,
  depth = 0,
): Promise<ControlledTab | undefined> {
  // An extension's download (`chrome.downloads`) has no frame.
  if (!frameId || depth > 5) return undefined;
  const top = tabs.find((t) => t.targetId === frameId);
  if (top) return top;
  const up = parents.get(frameId) ?? await cdp.send('Target.getTargetInfo', { targetId: frameId }).then(
    ({ targetInfo: t }) => t.parentFrameId ?? t.openerFrameId ?? t.openerId,
    () => undefined,
  );
  if (up) return tabOf(cdp, parents, tabs, up, depth + 1);
  for (const tab of tabs) {
    if (tab.page.isClosed()) continue;
    const ids = await frameIds(tab).catch(() => new Set<string>());
    if (ids.has(frameId)) return tab;
  }
  return undefined;
}

async function frameIds(tab: ControlledTab): Promise<Set<string>> {
  const session = await tab.page.context().newCDPSession(tab.page);
  try {
    const { frameTree } = await session.send('Page.getFrameTree');
    const ids = new Set<string>();
    const walk = (node: typeof frameTree): void => {
      ids.add(node.frame.id);
      node.childFrames?.forEach(walk);
    };
    walk(frameTree);
    return ids;
  } finally {
    await detach(session);
  }
}

// A `data:` URL can be megabytes, so only its kind is shown.
function shownUrl(url: string): string {
  if (url.startsWith('data:')) return 'a data: URL';
  if (url.startsWith('blob:')) return url;
  return withoutQuery(url);
}

async function detach(session: CDPSession): Promise<void> {
  await session.detach().catch(() => undefined);
}
