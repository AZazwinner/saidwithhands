/** localStorage wrappers that never throw (private mode, blocked storage, SSR). */
export function loadJson<T>(key: string, fallback: T): T {
  try {
    if (typeof window === "undefined") return fallback;
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function removeJson(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {}
}

// ---- IndexedDB, for the big things (taught signs, calibration, letter recordings) ----
// localStorage holds about 5 million characters per site, and calibration plus recordings alone filled it,
// after which every save of a sign failed. IndexedDB's quota is a share of the disk (gigabytes).

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("signnote", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction("kv").objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

const hasIdb = () => typeof indexedDB !== "undefined";

/**
 * Load a big value: IndexedDB first; a copy still in localStorage (saved by an older version) is moved
 * over and removed from localStorage. Never throws.
 */
export async function loadBig<T>(key: string): Promise<T | undefined> {
  if (typeof window === "undefined") return undefined;
  const legacy = loadJson<T | undefined>(key, undefined);
  if (!hasIdb()) return legacy;
  try {
    const v = await idbGet<T>(key);
    if (v !== undefined) {
      if (legacy !== undefined) removeJson(key);
      return v;
    }
    if (legacy !== undefined) {
      await idbSet(key, legacy);
      removeJson(key);
    }
    return legacy;
  } catch {
    return legacy;
  }
}

/** Save a big value to IndexedDB (localStorage if IndexedDB is unavailable). Resolves false on failure. */
export async function saveBig(key: string, value: unknown): Promise<boolean> {
  if (!hasIdb()) return saveJson(key, value);
  try {
    await idbSet(key, value);
    removeJson(key); // an older copy there would only take up space
    return true;
  } catch {
    return saveJson(key, value);
  }
}
