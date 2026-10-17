// The E-numbers sm-dev gives Tampermonkey's scripts, whose own ids are
// uuids: one file in sm-dev's cache, `tampermonkey-ids.json`, mapping
// each uuid to its number. A uuid is unique across browsers, so one
// file serves them all. A number stays with its uuid for a week after
// sm-dev last saw it, as SourceMonkey keeps its numbers after a
// removal. See docs/sm-dev-tampermonkey.md.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { managerCacheDir } from './manager-fetch.js';

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

interface Saved {
  next: number;
  ids: Record<string, { n: number; seen: number }>;
}

// `SM_DEV_TM_IDS` moves it, as the tests do, to keep their scripts'
// numbers out of the person's own file.
function file(): string {
  return process.env.SM_DEV_TM_IDS?.trim() || path.join(path.dirname(managerCacheDir()), 'tampermonkey-ids.json');
}

function load(): Saved {
  try {
    const saved = JSON.parse(readFileSync(file(), 'utf8')) as Saved;
    if (typeof saved.next === 'number' && saved.ids && typeof saved.ids === 'object') return saved;
  } catch {
    // None yet, or unreadable: numbering starts again.
  }
  return { next: 1, ids: {} };
}

/** The numbers of Tampermonkey's scripts, by uuid, read from and kept in sm-dev's cache. */
export class TmIds {
  private saved = load();
  private readonly byNumber = new Map<number, string>();

  constructor() {
    this.index();
  }

  private index(): void {
    this.byNumber.clear();
    for (const [uuid, { n }] of Object.entries(this.saved.ids)) this.byNumber.set(n, uuid);
  }

  /**
   * The numbers of `uuids`, the scripts installed now, giving each new
   * one the next number. Saves the file when anything changed, read
   * again first so another sm-dev's numbers aren't lost.
   */
  numbersOf(uuids: string[]): Map<string, number> {
    const now = Date.now();
    this.saved = load();
    let changed = false;
    for (const uuid of uuids) {
      const known = this.saved.ids[uuid];
      if (known) {
        // Kept in step only once a day: a save per listing isn't needed.
        if (now - known.seen > 24 * 60 * 60 * 1000) {
          known.seen = now;
          changed = true;
        }
        continue;
      }
      this.saved.ids[uuid] = { n: this.saved.next++, seen: now };
      changed = true;
    }
    for (const [uuid, { seen }] of Object.entries(this.saved.ids)) {
      if (now - seen > KEEP_MS && !uuids.includes(uuid)) {
        delete this.saved.ids[uuid];
        changed = true;
      }
    }
    if (changed) this.save();
    this.index();
    return new Map(uuids.map((uuid) => [uuid, this.saved.ids[uuid]!.n]));
  }

  /** The number of `uuid`, when it has one. */
  numberOf(uuid: string): number | undefined {
    return this.saved.ids[uuid]?.n;
  }

  /** The uuid number `n` was given, when it's still kept. */
  uuidOf(n: number): string | undefined {
    return this.byNumber.get(n);
  }

  private save(): void {
    const to = file();
    mkdirSync(path.dirname(to), { recursive: true });
    // Whole or not at all, for another sm-dev reading it meanwhile.
    const tmp = `${to}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.saved)}\n`);
    renameSync(tmp, to);
  }
}
