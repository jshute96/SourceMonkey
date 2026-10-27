// Hands a backup's copy of a script from the import dialog to the
// compare page it opens (`compare.html?import=<token>`). The backup
// lives only in the dialog's page, and pages don't write storage
// (docs/worker-writes.md), so the compare tab asks the dialog's page
// for it over a BroadcastChannel, which reaches every page of the
// extension. Once that dialog closes, the copy is gone and the compare
// page says so.

import type { PushedFile } from '../external-files.js';

// The backup's copy, as the import would store it.
export interface ImportCompareSide {
  // The backup file's name, for "Import from <file>".
  fileName: string;
  text: string;
  // The URL it would be stored under: the installed copy's.
  fileUrl: string;
  // Its bundled dependency files, by ref.
  files: Record<string, PushedFile>;
}

const CHANNEL = 'sourcemonkey-import-compare';

// How long the compare page waits for the dialog's page to answer.
const ANSWER_MS = 2000;

type Message = { want: string } | { token: string; side: ImportCompareSide };

// The copies offered by this page, and the channel it answers on.
const offered = new Map<string, ImportCompareSide>();
let answering: BroadcastChannel | null = null;

// Keeps `side` for a compare tab to ask for, and returns its token.
export function offerImportSide(side: ImportCompareSide): string {
  if (!answering) {
    answering = new BroadcastChannel(CHANNEL);
    answering.onmessage = (ev: MessageEvent<Message>) => {
      if (!('want' in ev.data)) return;
      const side = offered.get(ev.data.want);
      if (side) answering!.postMessage({ token: ev.data.want, side } satisfies Message);
    };
  }
  const token = crypto.randomUUID();
  offered.set(token, side);
  return token;
}

// Drops every copy offered, when the dialog closes.
export function withdrawImportSides(): void {
  offered.clear();
  answering?.close();
  answering = null;
}

// The copy `token` names, from the page that offered it; undefined when
// no page answers.
export function requestImportSide(token: string): Promise<ImportCompareSide | undefined> {
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(CHANNEL);
    const done = (side: ImportCompareSide | undefined): void => {
      clearTimeout(timer);
      channel.close();
      resolve(side);
    };
    const timer = setTimeout(() => done(undefined), ANSWER_MS);
    channel.onmessage = (ev: MessageEvent<Message>) => {
      if ('token' in ev.data && ev.data.token === token) done(ev.data.side);
    };
    channel.postMessage({ want: token } satisfies Message);
  });
}
