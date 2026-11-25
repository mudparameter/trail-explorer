// The browser's own database, where the website keeps everything: the config
// files, downloaded road data and elevation tiles. Nothing leaves the browser.
// Works in a page and in a worker.

const NAME = 'trail-explorer';
const VERSION = 1;
/** files: config files by path. meta: small settings. osm: road data, a record per download. terrain: elevation tile PNGs. */
export type StoreName = 'files' | 'meta' | 'osm' | 'terrain';

let opening: Promise<IDBDatabase> | null = null;
export function db(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const s of ['files', 'meta', 'terrain']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
      if (!d.objectStoreNames.contains('osm')) d.createObjectStore('osm', { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('This browser would not open its storage.'));
    req.onblocked = () => reject(new Error('Trail Explorer is open in another tab with an older version. Close it and reload.'));
  });
  return opening;
}

const done = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return done((await db()).transaction(store).objectStore(store).get(key));
}

/** Writes values and deletes keys (value undefined) in one transaction: all or none. */
export async function put(store: StoreName, entries: [IDBValidKey | null, unknown][]): Promise<IDBValidKey[]> {
  const tx = (await db()).transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  const keys: Promise<IDBValidKey>[] = [];
  for (const [k, v] of entries) {
    if (v === undefined) os.delete(k!);
    else keys.push(done(k === null ? os.add(v) : os.put(v, k)));
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('The browser could not save. It may be out of space.'));
  });
  return Promise.all(keys);
}

/** Every key and value in a store. */
export async function all<T>(store: StoreName): Promise<[IDBValidKey, T][]> {
  const os = (await db()).transaction(store).objectStore(store);
  const [keys, values] = await Promise.all([done(os.getAllKeys()), done(os.getAll())]);
  return keys.map((k, i) => [k, values[i] as T]);
}

/** The keys in a store that exist, of those given. */
export async function have(store: StoreName, keys: IDBValidKey[]): Promise<Set<IDBValidKey>> {
  const os = (await db()).transaction(store).objectStore(store);
  const found = await Promise.all(keys.map((k) => done(os.count(k))));
  return new Set(keys.filter((_, i) => found[i]! > 0));
}
