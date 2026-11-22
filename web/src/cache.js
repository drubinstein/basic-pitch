// Finished transcriptions are kept in this browser's IndexedDB, keyed by a hash of the file's
// bytes and the decoding mode, so opening the same file again is instant. Only the newest KEEP results are kept. Any
// storage error just means no caching.
export const RESULT_VERSION = 2; // bump when the model, windowing or decoders change
const DB_NAME = 'basic-pitch-live', STORE = 'results', KEEP = 12;

export async function fileKey(bytes, mode) {
  if (!globalThis.crypto?.subtle) return null;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `v${RESULT_VERSION}:${mode}:` + Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

// notes: [start, end, pitch, start final at, end final at] frames; activation: totalFrames x 88 bytes.
export function pack({ key, name, duration, totalFrames, notes, activation }) {
  const flat = new Int32Array(notes.length * 5);
  notes.forEach((n, i) => flat.set(n, i * 5));
  return { key, name, duration, totalFrames, notes: flat, activation, savedAt: Date.now() };
}

export function unpack(rec) {
  const notes = [];
  for (let i = 0; i < rec.notes.length; i += 5) notes.push(Array.from(rec.notes.subarray(i, i + 5)));
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
