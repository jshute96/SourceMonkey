// Directory store + userscript scanning + per-script read access.
//
// We use the File System Access API: each directory is registered via
// showDirectoryPicker(), which both grants us read permission and
// gives us a FileSystemDirectoryHandle we can persist in IndexedDB.
// Across reloads the handle round-trips; permission may need to be
// re-requested via user gesture (queryPermission → requestPermission).
//
// Two stores, because no single one does both jobs:
//   - chrome.storage.local: user-visible list ({id, name}) for rendering
//     and removal — small, fast, syncs with the options-page UI.
//   - IndexedDB: the handle itself, keyed by id. Handles aren't valid
//     in chrome.storage but are structured-cloneable into IndexedDB.

const DB_NAME = 'vibemonkey';
const DB_VERSION = 1;
const HANDLE_STORE = 'directoryHandles';
const STORAGE_KEY = 'directories';

export interface DirectoryEntry {
  id: string;
  name: string; // handle.name at the time of add — just for display
}

export interface FoundScript {
  name: string;         // leaf file name, e.g. "foo.user.js"
  relativePath: string; // path relative to the directory root, e.g. "sub/foo.user.js"
}

// ---------- IndexedDB plumbing ----------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveHandle(id: string, handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb();
  await idbRequest(db.transaction(HANDLE_STORE, 'readwrite').objectStore(HANDLE_STORE).put(handle, id));
}

export async function loadHandle(id: string): Promise<FileSystemDirectoryHandle | undefined> {
  const db = await openDb();
  return idbRequest(db.transaction(HANDLE_STORE, 'readonly').objectStore(HANDLE_STORE).get(id));
}

export async function deleteHandle(id: string): Promise<void> {
  const db = await openDb();
  await idbRequest(db.transaction(HANDLE_STORE, 'readwrite').objectStore(HANDLE_STORE).delete(id));
}

// ---------- chrome.storage.local wrappers ----------

export async function getDirectories(): Promise<DirectoryEntry[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as DirectoryEntry[]) ?? [];
}

export async function setDirectories(directories: DirectoryEntry[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: directories });
}

// ---------- Permission ----------

// FileSystemHandle's queryPermission/requestPermission aren't in the
// standard DOM typings, so narrow via this interface rather than `any`.
interface HandleWithPermission {
  queryPermission(opts: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(opts: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export async function hasReadPermission(handle: FileSystemHandle): Promise<boolean> {
  const h = handle as unknown as HandleWithPermission;
  return (await h.queryPermission({ mode: 'read' })) === 'granted';
}

// requestPermission() requires a user gesture; only call this from an
// event handler that was triggered by user interaction.
export async function ensureReadPermission(handle: FileSystemHandle): Promise<boolean> {
  if (await hasReadPermission(handle)) return true;
  const h = handle as unknown as HandleWithPermission;
  return (await h.requestPermission({ mode: 'read' })) === 'granted';
}

// ---------- Scanning ----------

export const MAX_SCAN_DEPTH = 2; // levels of subdirectory below the root

export async function scanForUserScripts(
  handle: FileSystemDirectoryHandle,
  depth = 0,
  prefix = '',
): Promise<FoundScript[]> {
  const results: FoundScript[] = [];
  // entries() is async-iterable; the TS DOM lib types it loosely.
  const entries = (handle as unknown as {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }).entries();
  for await (const [name, child] of entries) {
    if (child.kind === 'file' && name.endsWith('.user.js')) {
      results.push({ name, relativePath: prefix + name });
    } else if (child.kind === 'directory' && depth < MAX_SCAN_DEPTH) {
      const sub = await scanForUserScripts(
        child as FileSystemDirectoryHandle,
        depth + 1,
        prefix + name + '/',
      );
      results.push(...sub);
    }
  }
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

// ---------- File read ----------

// Walk a relative path within a directory handle and return the
// referenced file's text contents. Caller must have read permission.
export async function readFileFromDirectory(
  rootHandle: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<string> {
  const parts = relativePath.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error('empty relative path');
  let dir = rootHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i]);
  }
  const fileHandle = await dir.getFileHandle(parts[parts.length - 1]);
  const file = await fileHandle.getFile();
  return file.text();
}
