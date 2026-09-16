// Rows stay in the browser (IndexedDB) and leave it only as files you download: the same
// session JSON and raw JSONL the Python logger writes, so its tools read them unchanged.
const DB_NAME = "pm5-force-logger", VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "started" });
      if (!db.objectStoreNames.contains("raw")) db.createObjectStore("raw", { keyPath: "started" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => { db.close(); resolve(req && req.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export const putSession = data => run("sessions", "readwrite", s => s.put(data));
export const putRaw = (started, lines) => run("raw", "readwrite", s => s.put({ started, lines }));
export const getSession = started => run("sessions", "readonly", s => s.get(started));
export const getRaw = started => run("raw", "readonly", s => s.get(started));
export const listSessions = () => run("sessions", "readonly", s => s.getAll());
export async function deleteSession(started) {
  await run("sessions", "readwrite", s => s.delete(started));
  await run("raw", "readwrite", s => s.delete(started));
}

export function download(name, text, type = "application/json") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
