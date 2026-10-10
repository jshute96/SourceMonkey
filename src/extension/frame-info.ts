// Where a message from injected code came from: one of a page's
// iframes or a page's own (top-level) frame, and which page. See
// docs/frames.md.
//
// `sender.frameId > 0` alone can't tell: Chrome numbers a prerendered
// page's top frame like an iframe (its `frameType` is `outermost_frame`,
// which `MessageSender` doesn't carry). So a document with a frame id
// other than 0 is looked up with `chrome.webNavigation.getFrame`, and
// walked up through its parents to the page's document.
//
// Answers are cached by document id, which Chrome never reuses. A
// document's place doesn't change, but whether it is still in the tab
// does, so `live` is asked afresh when the caller needs it.

export interface FrameInfo {
  // One of a page's iframes (at any depth).
  subframe: boolean;
  // The page's document: the top-level frame the document is in (its
  // own id, for a top-level frame). '' when it can't be told.
  topDocId: string;
  // The page's URL as Chrome last reported it, when looked up.
  topUrl?: string;
  // Still in the tab. False for a document Chrome no longer has.
  live: boolean;
}

interface Placed { subframe: boolean; topDocId: string; topUrl?: string }

// Bounded: an entry per document of every frame that ever messaged us.
const CACHE_CAP = 1000;
const cache = new Map<string, Placed>();

function remember(documentId: string, placed: Placed): void {
  if (cache.size >= CACHE_CAP) cache.delete(cache.keys().next().value!);
  cache.set(documentId, placed);
}

// The frame `documentId` is, or null when Chrome no longer has it (it
// answers null, or refuses). `documentId` isn't in our @types/chrome
// version of `GetFrameDetails`, hence the cast.
async function getFrame(tabId: number, documentId: string): Promise<{
  parentFrameId: number; parentDocumentId?: string; url: string;
} | null> {
  try {
    const details = { tabId, documentId } as unknown as chrome.webNavigation.GetFrameDetails;
    return (await chrome.webNavigation.getFrame(details)) as { parentFrameId: number; parentDocumentId?: string; url: string } | null;
  } catch {
    return null;
  }
}

// Frames nest, but not this deep in practice; the bound keeps a
// misbehaving answer from looping.
const MAX_DEPTH = 32;

/**
 * Where `sender`'s document is. `checkLive` asks Chrome whether it is
 * still in the tab even when its place is cached.
 */
export async function frameInfo(
  sender: chrome.runtime.MessageSender,
  checkLive = false,
): Promise<FrameInfo> {
  const tabId = sender.tab?.id;
  const documentId = (sender as { documentId?: string }).documentId ?? '';
  const frameId = sender.frameId;
  if (frameId === 0) return { subframe: false, topDocId: documentId, live: true };
  // Nothing to look up with: by the frame id, as before.
  if (tabId == null || !documentId || typeof frameId !== 'number') {
    return { subframe: typeof frameId === 'number' && frameId > 0, topDocId: '', live: true };
  }
  const cached = cache.get(documentId);
  if (cached && !checkLive) return { ...cached, live: true };
  const frame = await getFrame(tabId, documentId);
  if (!frame) return { ...(cached ?? { subframe: true, topDocId: '' }), live: false };
  if (cached) return { ...cached, live: true };
  let placed: Placed;
  if (frame.parentFrameId === -1) {
    placed = { subframe: false, topDocId: documentId, topUrl: frame.url };
  } else {
    placed = { subframe: true, topDocId: '' };
    let parent = frame.parentDocumentId;
    for (let depth = 0; parent && depth < MAX_DEPTH; depth++) {
      const up = cache.get(parent);
      if (up && !up.subframe) {
        placed = { subframe: true, topDocId: up.topDocId, topUrl: up.topUrl };
        break;
      }
      const next = await getFrame(tabId, parent);
      if (!next) break;
      if (next.parentFrameId === -1) {
        placed = { subframe: true, topDocId: parent, topUrl: next.url };
        break;
      }
      parent = next.parentDocumentId;
    }
  }
  if (placed.topDocId) remember(documentId, placed);
  return { ...placed, live: true };
}

