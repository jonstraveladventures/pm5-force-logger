// Each row's files, saved as soon as the row is: the raw log, the session JSON and the FIT file,
// named as History's buttons name them. By default they are downloaded to the browser's downloads
// folder. Settings can send them to a folder chosen once instead (Chrome and Edge on a computer),
// or turn them off, when the row stays in this browser and History has its files at any time.
// The folder is remembered in this browser; Chrome asks again for access to it on a later visit
// unless it was told to allow it on every visit.
import * as Fit from "./fit.js";

export const MODES = ["download", "folder", "none"];
const KEY = "pm5_files", HANDLES = "pm5-force-logger-files";

export function mode() {
  try { const m = JSON.parse(localStorage.getItem(KEY)); return MODES.includes(m) ? m : "download"; } catch { return "download"; }
}
export function setMode(m) { try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* private window */ } }

/** Whether this browser lets a page be given a folder to write in. */
export const canPickFolder = () => typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";

/** One row's files: [{name, type, body}], body a string or bytes. */
export function rowFiles(id, data, lines) {
  return [
    { name: `${id}.jsonl`, type: "application/x-ndjson", body: lines.map(l => JSON.stringify(l)).join("\n") + "\n" },
    { name: `${id}.json`, type: "application/json", body: JSON.stringify(data, null, 1) },
    { name: Fit.fileName(data), type: "application/vnd.ant.fit", body: Fit.encode(data) },
  ];
}

// ---------- the chosen folder: a handle kept in its own small database ----------
function handles(how, fn) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(HANDLES, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("handles");
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const db = r.result, t = db.transaction("handles", how), req = fn(t.objectStore("handles"));
      t.oncomplete = () => { db.close(); resolve(req.result); };
      t.onerror = () => { db.close(); reject(t.error); };
    };
  });
}
export async function folder() { try { return (await handles("readonly", s => s.get("rows"))) || null; } catch { return null; } }

/** Ask for a folder (call from a click). Returns it, or null if the picker was closed. */
export async function chooseFolder() {
  let dir;
  try { dir = await window.showDirectoryPicker({ id: "pm5-rows", mode: "readwrite", startIn: "downloads" }); }
  catch (e) { if (e.name === "AbortError") return null; throw e; }
  await handles("readwrite", s => s.put(dir, "rows"));
  setMode("folder");
  return dir;
}

/** Whether the page may write in `dir`; with `ask` (only from a click) Chrome asks if it must. */
export async function access(dir, ask = false) {
  const opts = { mode: "readwrite" };
  if ((await dir.queryPermission(opts)) === "granted") return true;
  return ask ? (await dir.requestPermission(opts)) === "granted" : false;
}

/** Save one row's files as the setting says. Returns {mode, folder, written, needAccess, error}:
 *  `written` names the files that reached the folder or were downloaded. A folder that has gone
 *  (the browser's storage was cleared) falls back to a download, so the files still arrive. */
export async function saveRow({ id, data, lines }, { mode: m = mode(), dir = null, download }) {
  if (m === "none") return { mode: m, written: [] };
  const files = rowFiles(id, data, lines);
  if (m === "folder" && dir) {
    const out = { mode: m, folder: dir.name, written: [] };
    try {
      if (!(await access(dir))) return { ...out, needAccess: true };
      for (const f of files) {
        const w = await (await dir.getFileHandle(f.name, { create: true })).createWritable();
        await w.write(f.body); await w.close();
        out.written.push(f.name);
      }
    } catch (e) { out.error = e.message; }
    return out;
  }
  for (const f of files) download(f.name, f.body, f.type);
  return { mode: "download", written: files.map(f => f.name), ...(m === "folder" ? { lostFolder: true } : {}) };
}

/** Rewrite a row's session JSON in the folder (a guided report added after the save). Downloads
 *  are left alone: a second copy would arrive as "name (1).json". */
export async function updateJson(data, { mode: m = mode(), dir = null } = {}) {
  if (m !== "folder" || !dir || !(await access(dir))) return false;
  const w = await (await dir.getFileHandle(`${data.started}.json`, { create: true })).createWritable();
  await w.write(JSON.stringify(data, null, 1)); await w.close();
  return true;
}
