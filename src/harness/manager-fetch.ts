// `manager fetch`: downloads Tampermonkey or Violentmonkey from the
// Chrome Web Store, unpacked, into sm-dev's cache, for `manager
// install` and `--temp-browser` to load.
//
// - One folder per manager, `~/.cache/sm-dev/managers/<name>`
//   (`$XDG_CACHE_HOME` when set), replaced whole by a newer version, so
//   a browser that loaded it from there reloads the new one.
// - The download is a CRX: a header, with the store's signature and
//   public key, then a zip. The key goes into the unpacked manifest as
//   `key`, so the copy keeps the store's extension id, as the store's
//   own install would have.
// - The store's update check says the newest version and the file's
//   SHA-256, which the download is checked against.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { extensionIdFromKey } from './extension-backend.js';
import { MANAGERS, type ManagerName } from './managers.js';

// The update service Chrome itself asks. `prodversion` is the Chrome
// version asking: a high one gets the newest build.
const UPDATE_URL = 'https://clients2.google.com/service/update2/crx';
const PROD_VERSION = '999.0';

/** Where fetched managers are kept. */
export function managerCacheDir(): string {
  const cache = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache');
  return path.join(cache, 'sm-dev', 'managers');
}

/** The folder a manager is fetched into, which is loaded unpacked. */
export function fetchedDir(name: ManagerName): string {
  return path.join(managerCacheDir(), name);
}

/** The version fetched, or null when there is none. */
export function fetchedVersion(name: ManagerName): string | null {
  try {
    const manifest = JSON.parse(readFileSync(path.join(fetchedDir(name), 'manifest.json'), 'utf8')) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

export interface Fetched {
  dir: string;
  version: string;
  /** Newly downloaded, rather than already the newest. */
  downloaded: boolean;
  /** The version it replaced, if any. */
  replaced?: string;
}

/**
 * Fetches the manager's newest version, unless it's fetched already.
 * Throws an error saying which step failed.
 */
export async function fetchManager(name: ManagerName, out: (line: string) => void): Promise<Fetched> {
  const { label, storeId } = MANAGERS[name];
  if (!storeId) throw new Error(`Internal error: ${label} has no Web Store id to fetch it by`);
  const dir = fetchedDir(name);
  const have = fetchedVersion(name);
  const latest = await newestVersion(label, storeId);
  if (have === latest.version) return { dir, version: have, downloaded: false };
  out(`[sm-dev] Fetching ${label} ${latest.version} from the Chrome Web Store`);
  let crx: Buffer;
  try {
    const res = await fetch(latest.url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    crx = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new Error(`${label} could not be downloaded from the Chrome Web Store: ${(err as Error).message}`);
  }
  if (latest.sha256 && createHash('sha256').update(crx).digest('hex') !== latest.sha256) {
    throw new Error(`The ${label} download from the Chrome Web Store doesn't match the checksum the store gave. Try again.`);
  }
  const { key, zip } = readCrx(crx, storeId);
  const parent = managerCacheDir();
  await mkdir(parent, { recursive: true });
  // Unpacked beside it, then swapped in, so a failure leaves the old
  // copy as it was.
  const fresh = path.join(parent, `.${name}-${randomBytes(4).toString('hex')}`);
  try {
    await unzipTo(zip, fresh);
    // The store's signature over the files, which Chrome refuses in an
    // unpacked extension (a name starting with _ is reserved).
    await rm(path.join(fresh, '_metadata'), { recursive: true, force: true });
    const manifestFile = path.join(fresh, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
    manifest.key = key;
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
    if (existsSync(dir)) {
      const old = `${fresh}-old`;
      await rename(dir, old);
      await rename(fresh, dir);
      await rm(old, { recursive: true, force: true });
    } else {
      await rename(fresh, dir);
    }
  } catch (err) {
    await rm(fresh, { recursive: true, force: true });
    throw new Error(`${label} could not be unpacked into ${dir}: ${(err as Error).message}`);
  }
  return { dir, version: latest.version, downloaded: true, ...(have ? { replaced: have } : {}) };
}

// The store's newest version of an extension, with where to download it.
async function newestVersion(label: string, storeId: string): Promise<{ version: string; url: string; sha256?: string }> {
  const query = `${UPDATE_URL}?prodversion=${PROD_VERSION}&acceptformat=crx3&x=${encodeURIComponent(`id=${storeId}&uc`)}`;
  let xml: string;
  try {
    const res = await fetch(query, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } catch (err) {
    throw new Error(`The Chrome Web Store could not be asked for ${label}'s newest version: ${(err as Error).message}`);
  }
  const check = /<updatecheck\b([^>]*)>/.exec(xml)?.[1] ?? '';
  const attr = (attrName: string): string | undefined => new RegExp(`\\b${attrName}="([^"]*)"`).exec(check)?.[1];
  const version = attr('version');
  const url = attr('codebase');
  if (attr('status') !== 'ok' || !version || !url) {
    throw new Error(`The Chrome Web Store has no download for ${label} (status ${attr('status') ?? 'missing'})`);
  }
  return { version, url: url.replace(/&amp;/g, '&'), sha256: attr('hash_sha256') };
}

/**
 * A CRX3 file's zip, and the public key (base64) its extension id comes
 * from. Throws when it isn't one, or none of its keys gives `id`.
 */
export function readCrx(crx: Buffer, id: string): { key: string; zip: Buffer } {
  if (crx.length < 12 || crx.toString('latin1', 0, 4) !== 'Cr24' || crx.readUInt32LE(4) !== 3) {
    throw new Error('The download is not a Chrome extension package (CRX3)');
  }
  const headerSize = crx.readUInt32LE(8);
  const header = crx.subarray(12, 12 + headerSize);
  // CrxFileHeader: field 2 (sha256_with_rsa) and 3 (sha256_with_ecdsa)
  // are AsymmetricKeyProofs, whose field 1 is the public key.
  const keys: Buffer[] = [];
  for (const [field, proof] of protoFields(header)) {
    if (field !== 2 && field !== 3) continue;
    for (const [inner, value] of protoFields(proof)) if (inner === 1) keys.push(value);
  }
  const key = keys.map((k) => k.toString('base64')).find((k) => extensionIdFromKey(k) === id);
  if (!key) throw new Error(`The package has no key for extension id ${id}`);
  return { key, zip: crx.subarray(12 + headerSize) };
}

// The length-delimited fields of a protobuf message, as [number, bytes].
// Other wire types are skipped.
function protoFields(buf: Buffer): [number, Buffer][] {
  const fields: [number, Buffer][] = [];
  let i = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (i >= buf.length) throw new Error('The package header is cut short');
      const byte = buf[i++];
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
      shift += 7;
    }
  };
  while (i < buf.length) {
    const tag = varint();
    const wire = tag % 8;
    const field = Math.floor(tag / 8);
    if (wire === 0) varint();
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) {
      const length = varint();
      fields.push([field, buf.subarray(i, i + length)]);
      i += length;
    } else {
      throw new Error('The package header is not readable');
    }
  }
  return fields;
}

/**
 * Writes a zip's files under `dir`: stored or deflated entries, which
 * is what a CRX holds. A name that would land outside `dir` is refused.
 */
export async function unzipTo(zip: Buffer, dir: string): Promise<void> {
  // The end of central directory record, last in the file but for a
  // comment of up to 64KB.
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('The package\'s zip has no central directory');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const root = path.resolve(dir);
  await mkdir(root, { recursive: true });
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('The package\'s zip directory is damaged');
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`The package holds a file outside its folder: ${name}`);
    if (name.endsWith('/')) {
      await mkdir(target, { recursive: true });
      continue;
    }
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    let body: Buffer;
    if (method === 0) body = data;
    else if (method === 8) body = inflateRawSync(data);
    else throw new Error(`The package's file ${name} is compressed in a way sm-dev can't read (method ${method})`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
}
