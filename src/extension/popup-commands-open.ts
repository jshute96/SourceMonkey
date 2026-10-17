// Which scripts' menu command lists the person opened or closed in a
// tab's popup, kept for the tab's lifetime: someone using one of a
// script's commands is likely to come back for another, so a list they
// opened stays open the next time the popup shows, across reloads and
// navigations in the tab.
//
// One `popupopen:<tabId>` row per tab in `chrome.storage.session`
// ({ [scriptId]: open }), which outlasts the worker going idle between
// popups and clears with the browser. Only the worker writes it (the
// popup asks, `POPUP_SET_COMMANDS_OPEN_MESSAGE`); background.ts's
// `tabs.onRemoved` drops a closed tab's row.

const KEY_PREFIX = 'popupopen:';

type OpenByScript = Record<string, boolean>;

function rowKey(tabId: number): string {
  return `${KEY_PREFIX}${tabId}`;
}

// Writes are chained, so two quick toggles in a row don't both read the
// row before either writes it.
let writes: Promise<unknown> = Promise.resolve();

async function readRow(tabId: number): Promise<OpenByScript> {
  const row = (await chrome.storage.session.get(rowKey(tabId)))[rowKey(tabId)];
  return row && typeof row === 'object' ? row as OpenByScript : {};
}

// After the writes already asked for, so a popup opened just after a
// toggle sees it.
export async function getCommandsOpen(tabId: number): Promise<OpenByScript> {
  await writes;
  return readRow(tabId);
}

export function setCommandsOpen(tabId: number, scriptId: string, open: boolean): Promise<void> {
  const write = writes.then(async () => {
    const row = await readRow(tabId);
    await chrome.storage.session.set({ [rowKey(tabId)]: { ...row, [scriptId]: open } });
  });
  writes = write.catch(() => undefined);
  return write;
}

export function dropCommandsOpen(tabId: number): Promise<void> {
  const write = writes.then(() => chrome.storage.session.remove(rowKey(tabId)));
  writes = write.catch(() => undefined);
  return write;
}
