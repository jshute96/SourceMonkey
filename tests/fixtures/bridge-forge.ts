// Sending the bridge's events as a page could if it had the channel key
// (src/extension/channel.ts). A page without it can't name the events at
// all, so tests of the SW-side gate behind the key (`bridgeMayActAs`)
// play a page that has it, getting it from `sm.channelKey()`.

import type { Frame, Page } from '@playwright/test';

// A bridge event's name: `sync`, `reply`, `push` or `insert`.
export function bridgeEvent(kind: 'sync' | 'reply' | 'push' | 'insert', key: string): string {
  return `sourcemonkey-${kind}-${key}`;
}

// Send `payload` to the SW through the bridge and resolve with its reply,
// or null when none comes within `timeoutMs` (the bridge drops a type it
// doesn't relay without answering).
export async function bridgeRequest(
  page: Page | Frame,
  key: string,
  payload: Record<string, unknown>,
  timeoutMs = 2500,
): Promise<unknown> {
  return page.evaluate(({ sync, reply, payload, timeoutMs }) => new Promise<unknown>((resolve) => {
    const rid = 'forge-' + Math.random().toString(36).slice(2);
    const onReply = (ev: Event): void => {
      const d = JSON.parse((ev as CustomEvent<string>).detail) as { requestId?: string; reply?: unknown };
      if (d.requestId !== rid) return;
      document.removeEventListener(reply, onReply, true);
      resolve(d.reply ?? null);
    };
    document.addEventListener(reply, onReply, true);
    document.dispatchEvent(new CustomEvent(sync, { detail: JSON.stringify({ requestId: rid, payload }) }));
    setTimeout(() => { document.removeEventListener(reply, onReply, true); resolve(null); }, timeoutMs);
  }), { sync: bridgeEvent('sync', key), reply: bridgeEvent('reply', key), payload, timeoutMs });
}

// Send `payload` through the bridge with no reply asked for, as a
// wrapper's reports go.
export async function bridgeSend(page: Page | Frame, key: string, payload: Record<string, unknown>): Promise<void> {
  await page.evaluate(({ sync, payload }) => {
    document.dispatchEvent(new CustomEvent(sync, { detail: JSON.stringify({ payload }) }));
  }, { sync: bridgeEvent('sync', key), payload });
}
