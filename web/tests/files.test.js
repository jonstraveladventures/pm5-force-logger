// Each row's files, saved as the setting says: written to the chosen folder, downloaded, or not
// at all; a folder without access is reported rather than skipped silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rebuild } from "../recorder.js";
import { rowFiles, saveRow, access, updateJson } from "../files.js";

const ID = "2026-09-24_100000";
const LINES = readFileSync(new URL("../examples/sample_row.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
const DATA = rebuild(ID, LINES);
const ROW = { id: ID, data: DATA, lines: LINES };

/** A folder kept in memory, as the File System Access API presents one. */
function memoryFolder({ permission = "granted", grant = "granted", failOn = null } = {}) {
  const dir = { name: "Rowing", files: new Map(), permission, asked: 0 };
  dir.queryPermission = async () => dir.permission;
  dir.requestPermission = async () => { dir.asked++; dir.permission = grant; return grant; };
  dir.getFileHandle = async (name, { create } = {}) => {
    if (!create && !dir.files.has(name)) throw new Error("not found");
    return { createWritable: async () => {
      let body = null;
      return { write: async b => { if (name === failOn) throw new Error("disk full"); body = b; }, close: async () => { dir.files.set(name, body); } };
    } };
  };
  return dir;
}
const downloads = () => { const got = []; const fn = (name, body, type) => got.push({ name, body, type }); fn.got = got; return fn; };

test("a row's files are its raw log, its session JSON and its FIT file, named by the row", () => {
  const [raw, json, fit] = rowFiles(ID, DATA, LINES);
  assert.deepEqual([raw.name, json.name, fit.name], [`${ID}.jsonl`, `${ID}.json`, `${ID}.fit`]);
  assert.deepEqual(raw.body.trim().split("\n").map(l => JSON.parse(l)), LINES);
  assert.deepEqual(JSON.parse(json.body), JSON.parse(JSON.stringify(DATA)));
  assert.equal(String.fromCharCode(...fit.body.slice(8, 12)), ".FIT");
});

test("with a folder the page may write in, all three files go there", async () => {
  const dir = memoryFolder(), dl = downloads();
  const out = await saveRow(ROW, { mode: "folder", dir, download: dl });
  assert.deepEqual(out.written, [`${ID}.jsonl`, `${ID}.json`, `${ID}.fit`]);
  assert.equal(out.folder, "Rowing");
  assert.equal(dir.files.get(`${ID}.jsonl`), rowFiles(ID, DATA, LINES)[0].body);
  assert.equal(dl.got.length, 0, "nothing downloaded as well");
});

test("a folder Chrome wants to ask about again is reported, and written once access is given", async () => {
  const dir = memoryFolder({ permission: "prompt" }), dl = downloads();
  const out = await saveRow(ROW, { mode: "folder", dir, download: dl });
  assert.equal(out.needAccess, true);
  assert.equal(dir.files.size, 0);
  assert.equal(dir.asked, 0, "the save itself never asks: that needs a click");
  assert.equal(await access(dir, true), true);
  assert.equal((await saveRow(ROW, { mode: "folder", dir, download: dl })).written.length, 3);
});

test("refused access writes nothing and says so", async () => {
  const dir = memoryFolder({ permission: "prompt", grant: "denied" });
  assert.equal(await access(dir, true), false);
  assert.equal((await saveRow(ROW, { mode: "folder", dir, download: downloads() })).needAccess, true);
});

test("a write that fails part way names what did reach the folder", async () => {
  const dir = memoryFolder({ failOn: `${ID}.json` });
  const out = await saveRow(ROW, { mode: "folder", dir, download: downloads() });
  assert.deepEqual(out.written, [`${ID}.jsonl`]);
  assert.match(out.error, /disk full/);
});

test("downloads by default; a folder that has gone falls back to downloading; none saves nothing", async () => {
  let dl = downloads();
  const out = await saveRow(ROW, { mode: "download", download: dl });
  assert.deepEqual(dl.got.map(f => [f.name, f.type]), [[`${ID}.jsonl`, "application/x-ndjson"], [`${ID}.json`, "application/json"], [`${ID}.fit`, "application/vnd.ant.fit"]]);
  assert.equal(out.written.length, 3);
  dl = downloads();
  const lost = await saveRow(ROW, { mode: "folder", dir: null, download: dl });
  assert.equal(lost.lostFolder, true);
  assert.equal(dl.got.length, 3);
  dl = downloads();
  assert.deepEqual((await saveRow(ROW, { mode: "none", download: dl })).written, []);
  assert.equal(dl.got.length, 0);
  assert.equal((await saveRow(ROW, { download: (dl = downloads()) })).mode, "download", "no setting saved: download");
});

test("a report added after the save rewrites the session JSON in the folder only", async () => {
  const dir = memoryFolder();
  await saveRow(ROW, { mode: "folder", dir, download: downloads() });
  const later = { ...DATA, guided: { protocol: "rate" } };
  assert.equal(await updateJson(later, { mode: "folder", dir }), true);
  assert.equal(JSON.parse(dir.files.get(`${ID}.json`)).guided.protocol, "rate");
  assert.equal(await updateJson(later, { mode: "download", dir }), false);
  assert.equal(await updateJson(later, { mode: "folder", dir: memoryFolder({ permission: "prompt" }) }), false);
});
