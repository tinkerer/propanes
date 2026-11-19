// Draft persistence for composer image attachments.
//
// Text, DOM-element refs and uploaded files of a composer draft are JSON and
// live in localStorage / the drafts API. Pasted or captured images are binary
// blobs, so they are kept here instead: an in-memory map (authoritative for
// this page, so close → reopen is synchronous and never races a pending
// write) mirrored to IndexedDB so the draft also survives a reload.
//
// Everything is best-effort — a browser without IndexedDB (or with storage
// blocked) still keeps images across close/reopen through the memory map.

export interface DraftImage {
  id: string;
  name: string;
  blob: Blob;
}

/** Minimal async key/value backend; IndexedDB in the browser, fakes in tests. */
export interface DraftImageBackend {
  get(key: string): Promise<DraftImage[] | undefined>;
  set(key: string, images: DraftImage[]): Promise<void>;
  delete(key: string): Promise<void>;
}

const DB_NAME = 'pw-composer-drafts';
const STORE = 'images';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('indexedDB blocked'));
  });
}

function createIndexedDbBackend(): DraftImageBackend | null {
  if (typeof indexedDB === 'undefined') return null;
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = () => {
    if (!dbPromise) {
      dbPromise = openDb();
      // A failed open must not poison every later call.
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  };
  async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const d = await db();
    return new Promise<T>((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  return {
    get: (key) => run<DraftImage[] | undefined>('readonly', (s) => s.get(key)),
    set: async (key, images) => { await run('readwrite', (s) => s.put(images, key)); },
    delete: async (key) => { await run('readwrite', (s) => s.delete(key)); },
  };
}

export interface DraftImageStore {
  load(key: string): Promise<DraftImage[]>;
  save(key: string, images: DraftImage[]): void;
  clear(key: string): void;
}

function isDraftImage(v: any): v is DraftImage {
  return !!v && typeof v.id === 'string' && typeof v.name === 'string'
    && typeof v.blob === 'object' && v.blob !== null && typeof v.blob.size === 'number';
}

export function createDraftImageStore(backend: DraftImageBackend | null): DraftImageStore {
  // Keys written (or loaded) this page session. A present entry — even an
  // empty one — wins over the backend, whose writes may still be in flight.
  const memory = new Map<string, DraftImage[]>();
  // Backend writes are chained so a slow put can't land after a later delete.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (op: () => Promise<void>) => {
    queue = queue.then(op).catch(() => { /* best-effort */ });
  };

  return {
    async load(key) {
      const cached = memory.get(key);
      if (cached) return cached;
      if (!backend) return [];
      let stored: DraftImage[] = [];
      try {
        const raw = await backend.get(key);
        if (Array.isArray(raw)) stored = raw.filter(isDraftImage);
      } catch { /* treat as no draft */ }
      // A save/clear that happened while we were reading is newer.
      const raced = memory.get(key);
      if (raced) return raced;
      memory.set(key, stored);
      return stored;
    },
    save(key, images) {
      const next = images.map(({ id, name, blob }) => ({ id, name, blob }));
      memory.set(key, next);
      if (!backend) return;
      enqueue(() => (next.length > 0 ? backend.set(key, next) : backend.delete(key)));
    },
    clear(key) {
      this.save(key, []);
    },
  };
}

export const draftImageStore: DraftImageStore = createDraftImageStore(createIndexedDbBackend());
