// Noticing that a newer sm-dev has been published. See
// docs/sm-dev-design.md#the-update-check.
//
// - Only published copies check: a local build updates through git.
// - Commands only read a cache file, so they never wait on the network.
//   One whose cache is a day old starts a detached process to refresh
//   it, which outlives a short command. Concurrent refreshes are
//   harmless: each writes the same answer, atomically.
// - A version is announced once it's a day old, since pnpm skips newer
//   ones: until then, the update command shown would find nothing.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { compareVersions } from '../version-compare.js';
import { quoted } from './output-style.js';
import { isDownloadRun, ownUpdateCommand } from './project-copy.js';
import { isReleaseBuild } from './rebuild-advice.js';

const REGISTRY_URL = 'https://registry.npmjs.org/sourcemonkey';
const FETCH_TIMEOUT_MS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What the last refresh found. A failed one keeps the earlier answer. */
export interface UpdateCache {
  /** When it last tried, in ms. */
  checkedAt: number;
  /** npm's `latest` version. */
  latest?: string;
  /** When `latest` was published, in ms. */
  publishedAt?: number;
}

function cacheFile(): string {
  const cache = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache');
  return path.join(cache, 'sm-dev', 'latest-version.json');
}

function readCache(): UpdateCache | null {
  try {
    const cached = JSON.parse(readFileSync(cacheFile(), 'utf8')) as UpdateCache;
    return typeof cached.checkedAt === 'number' ? cached : null;
  } catch {
    return null;
  }
}

function checkEnabled(): boolean {
  return process.env.SM_DEV_NO_UPDATE_CHECK !== '1' && !process.env.CI && isReleaseBuild();
}

/** The version to announce: newer than `current`, and at least a day old. */
export function announcedVersion(current: string, cached: UpdateCache | null, now: number): string | null {
  if (!cached?.latest || cached.publishedAt === undefined) return null;
  if (now - cached.publishedAt < DAY_MS) return null;
  return compareVersions(cached.latest, current) > 0 ? cached.latest : null;
}

export interface AvailableUpdate {
  latest: string;
  /** Left out when sm-dev can't tell how this copy was installed. */
  command?: string;
  /** `command` runs the newest version once, with nothing installed to update. */
  oneOff?: boolean;
}

/** The newer version this copy should announce, from the cache, if any. */
export function availableUpdate(current: string): AvailableUpdate | null {
  if (!checkEnabled()) return null;
  const latest = announcedVersion(current, readCache(), Date.now());
  if (!latest) return null;
  const command = ownUpdateCommand();
  if (!command) return { latest };
  return isDownloadRun() ? { latest, command, oneOff: true } : { latest, command };
}

/** The message, with `current` where nothing near it shows the version. */
export function updateNote({ latest, command, oneOff }: AvailableUpdate, current?: string): string {
  const how = !command ? 'Update it the way you installed it.'
    : oneOff ? `Run it with ${quoted(command)}.`
    : `Update with ${quoted(command)}.`;
  return `sm-dev ${latest} is available${current ? ` (current is ${current})` : ''}. ${how}`;
}

/** `--version`'s JSON field for an update. */
export function updateJson({ latest, command }: AvailableUpdate): { latest: string; command?: string } {
  return command ? { latest, command } : { latest };
}

/** Starts the detached refresh when the cache is a day old or missing. */
export function refreshUpdateCacheIfDue(): void {
  if (!checkEnabled()) return;
  const cached = readCache();
  if (cached && Date.now() - cached.checkedAt < DAY_MS) return;
  const code = `await (await import(${JSON.stringify(import.meta.url)})).refreshUpdateCache();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
}

/**
 * Asks npm for the newest version and saves the answer. A failure still
 * saves the time, so being offline doesn't start a refresh per command.
 */
export async function refreshUpdateCache(url = REGISTRY_URL): Promise<void> {
  const next: UpdateCache = { ...readCache(), checkedAt: Date.now() };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.ok) {
      const body = await res.json() as { 'dist-tags'?: { latest?: string }; time?: Record<string, string> };
      const latest = body['dist-tags']?.latest;
      const publishedAt = latest ? Date.parse(body.time?.[latest] ?? '') : NaN;
      if (latest && !Number.isNaN(publishedAt)) Object.assign(next, { latest, publishedAt });
    }
  } catch {
    // Offline, or an unexpected answer: keep what it had.
  }
  const file = cacheFile();
  const temp = `${file}.${randomBytes(4).toString('hex')}`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temp, JSON.stringify(next) + '\n');
    await rename(temp, file);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}
