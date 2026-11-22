// Finished transcriptions are kept in this browser's IndexedDB, keyed by a hash of the file's
// bytes and the decoding mode, so opening the same file again is instant. Only the newest KEEP results are kept. Any
// storage error just means no caching.
export const RESULT_VERSION = 3; // bump when the model, windowing or decoders change
const DB_NAME = 'basic-pitch-live', STORE = 'results', KEEP = 12;

export async function fileHash(bytes) {
  if (!globalThis.crypto?.subtle) return null;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}
export const resultKey = (hash, mode) => (hash ? `v${RESULT_VERSION}:${mode}:${hash}` : null);
export const fileKey = async (bytes, mode) => resultKey(await fileHash(bytes), mode);

// notes: [start, end, pitch, start final at, end final at (frames), velocity]; activation:
// totalFrames x 88 bytes.
const FIELDS = 6;
export function pack({ key, name, duration, totalFrames, notes, activation }) {
  const flat = new Int32Array(notes.length * FIELDS);
  notes.forEach((n, i) => { for (let j = 0; j < FIELDS; j++) flat[i * FIELDS + j] = n[j] ?? 0; });
  return { key, name, duration, totalFrames, notes: flat, activation, savedAt: Date.now() };
}

export function unpack(rec) {
  const notes = [];
  for (let i = 0; i < rec.notes.length; i += FIELDS) notes.push(Array.from(rec.notes.subarray(i, i + FIELDS)));
  return { ...rec, notes };
}

let db;
function open() {
  db ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return db;
}

const done = (req) => new Promise((resolve) => { req.onsuccess = () => resolve(req.result); req.onerror = () => resolve(undefined); });

export async function load(key) {
  const d = key && (await open());
  if (!d) return null;
  try {
    const rec = await done(d.transaction(STORE).objectStore(STORE).get(key));
    return rec ? unpack(rec) : null;
  } catch {
    return null;
  }
}

export async function save(result) {
  const d = result.key && (await open());
  if (!d) return;
  try {
    const store = d.transaction(STORE, 'readwrite').objectStore(STORE);
    await done(store.put(pack(result)));
    const all = (await done(store.getAll())) ?? [];
    all.sort((a, b) => b.savedAt - a.savedAt);
    for (const old of all.slice(KEEP)) store.delete(old.key);
  } catch {
    // Quota or private mode: carry on without the cache.
  }
}

export async function clear() {
  const d = await open();
  if (!d) return;
  try { await done(d.transaction(STORE, 'readwrite').objectStore(STORE).clear()); } catch { /* nothing cached */ }
}
