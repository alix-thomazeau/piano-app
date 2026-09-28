// Stockage local (IndexedDB) : les morceaux et leurs stats restent sur l'appareil.
const DB_NAME = 'piano-coach';
const STORE = 'songs';
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export const listSongs = () => tx('readonly', s => s.getAll());
export const getSong = id => tx('readonly', s => s.get(id));
export const putSong = song => tx('readwrite', s => s.put(song));
export const deleteSong = id => tx('readwrite', s => s.delete(id));

// Petites préférences (sensibilité micro, affichage…)
export function getPref(key, fallback) {
  try {
    const v = localStorage.getItem('pc.' + key);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
export function setPref(key, value) {
  try { localStorage.setItem('pc.' + key, JSON.stringify(value)); } catch { /* stockage indisponible */ }
}
