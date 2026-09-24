// The FIT writer, read back by a reader written from the file format's own description rather
// than from the writer: header, definition and data messages, developer field descriptions.
// The files it produces have also been checked against two outside parsers, the official Garmin
// FIT SDK and fitdecode; tests/verify_fit.py runs that check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encode, crc16, strokeRate, peakPosition, startTime, DEV_FIELDS, APP_UUID } from "../fit.js";

const sample = JSON.parse(readFileSync(new URL("./fixtures/sample_session.json", import.meta.url), "utf8"));

// ---------- a reader that knows only the FIT format ----------
const SIZES = { 0x00: 1, 0x01: 1, 0x02: 1, 0x07: 1, 0x0a: 1, 0x0d: 1, 0x83: 2, 0x84: 2, 0x8b: 2, 0x85: 4, 0x86: 4, 0x8c: 4 };
const INVALID = { 1: 0xff, 2: 0xffff, 4: 0xffffffff };

function read(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(bytes[0], 14, "header size");
  assert.equal(String.fromCharCode(...bytes.slice(8, 12)), ".FIT");
  const dataSize = v.getUint32(4, true);
  assert.equal(v.getUint16(12, true), crc16(bytes.slice(0, 12)), "header CRC");
  assert.equal(bytes.length, 14 + dataSize + 2, "declared data size");
  assert.equal(v.getUint16(bytes.length - 2, true), crc16(bytes.slice(0, bytes.length - 2)), "file CRC");

  const defs = new Map(), out = [];
  let i = 14;
  while (i < 14 + dataSize) {
    const h = bytes[i++];
    assert.equal(h & 0x80, 0, "no compressed timestamp headers");
    const local = h & 0x0f;
    if (h & 0x40) {
      i += 2;                                   // reserved, architecture (little-endian)
      const global = v.getUint16(i, true); i += 2;
      const n = bytes[i++], fields = [];
      for (let k = 0; k < n; k++, i += 3) fields.push({ num: bytes[i], size: bytes[i + 1], base: bytes[i + 2] });
      const dev = [];
      if (h & 0x20) { const m = bytes[i++]; for (let k = 0; k < m; k++, i += 3) dev.push({ num: bytes[i], size: bytes[i + 1], index: bytes[i + 2] }); }
      defs.set(local, { global, fields, dev });
      continue;
    }
    const d = defs.get(local);
    assert.ok(d, `data message for an undefined local type ${local}`);
    const msg = { global: d.global, f: {}, dev: {} };
    const take = (f, into) => {
      if (f.base === 0x07) { let s = ""; for (let k = 0; k < f.size; k++) if (bytes[i + k]) s += String.fromCharCode(bytes[i + k]); into[f.num] = s; i += f.size; return; }
      if (f.base === 0x0d && f.size > 1) { into[f.num] = [...bytes.slice(i, i + f.size)]; i += f.size; return; }
      const unit = SIZES[f.base];
      assert.ok(unit, `unknown base type 0x${f.base.toString(16)}`);
      assert.equal(f.size, unit, `field ${f.num} size matches its base type`);
      const raw = unit === 1 ? bytes[i] : unit === 2 ? v.getUint16(i, true) : v.getUint32(i, true);
      i += unit;
      into[f.num] = raw === INVALID[unit] ? null : raw;
    };
    for (const f of d.fields) take(f, msg.f);
    // a real reader takes the base type from the field description; here the size in the
    // definition says it, and every rowing field we write is an unsigned 8- or 16-bit number
    for (const f of d.dev) take({ ...f, base: f.size === 1 ? 0x02 : 0x84 }, msg.dev);
    out.push(msg);
  }
  assert.equal(i, 14 + dataSize, "messages fill the declared data size exactly");
  return out;
}
const of = (msgs, global) => msgs.filter(m => m.global === global);

test("the checksum depends on the bytes and their order", () => {
  // the values themselves are checked where it counts: the header and file checksums this
  // writer produces are the ones the Garmin SDK verifies in tests/verify_fit.py
  assert.equal(crc16([]), 0);
  assert.notEqual(crc16([1, 2, 3]), crc16([3, 2, 1]));
  assert.notEqual(crc16([1, 2, 3]), crc16([1, 2, 4]));
});

test("a row encodes to a readable activity file with one record per stroke", () => {
  const msgs = read(encode(sample));
  const [fileId] = of(msgs, 0);
  assert.equal(fileId.f[0], 4, "an activity file");
  assert.equal(fileId.f[8], "pm5-force-logger");
  const records = of(msgs, 20), laps = of(msgs, 19), sessions = of(msgs, 18), activities = of(msgs, 34);
  assert.equal(records.length, sample.strokes.length);
  assert.equal(laps.length, 1);
  assert.equal(sessions.length, 1);
  assert.equal(activities.length, 1);
  assert.equal(of(msgs, 21).length, 2, "a timer start and a timer stop");

  const s = sessions[0];
  assert.equal(s.f[5], 15, "sport rowing");
  assert.equal(s.f[6], 14, "sub-sport indoor rowing");
  assert.equal(s.f[7], Math.round(sample.summary.elapsed_s * 1000));
  assert.equal(s.f[9], Math.round(sample.summary.distance_m * 100));
  assert.equal(s.f[10], sample.strokes[sample.strokes.length - 1].stroke_count);
  assert.equal(s.f[16], sample.summary.avg_hr);
  assert.equal(s.dev[10], 1, "RecordingStrategy: one record per stroke");
});

test("the developer fields carry the stroke, scaled as the standard defines them", () => {
  const msgs = read(encode(sample));
  const r = of(msgs, 20)[0], st = sample.strokes[0];
  assert.equal(r.dev[DEV_FIELDS.DriveLength.num], Math.round(st.drive_length_m * 1000));
  assert.equal(r.dev[DEV_FIELDS.StrokeDriveTime.num], Math.round(st.drive_time_s * 1000));
  assert.equal(r.dev[DEV_FIELDS.StrokeRecoveryTime.num], Math.round(st.recovery_time_s * 1000));
  assert.equal(r.dev[DEV_FIELDS.DragFactor.num], sample.summary.drag_factor_avg);
  assert.equal(r.dev[DEV_FIELDS.StrokeWork.num], Math.round(st.work_j));
  // pounds to newtons, at scale 10
  assert.equal(r.dev[DEV_FIELDS.PeakDriveForceN.num], Math.round(st.peak_force_lbf * 4.4482216152605 * 10));
  assert.equal(r.dev[DEV_FIELDS.AverageDriveForceN.num], Math.round(st.avg_force_lbf * 4.4482216152605 * 10));
  // rate to 0.01 spm from the drive and recovery times, with the whole number in native cadence
  const rate = 60 / (st.drive_time_s + st.recovery_time_s);
  assert.equal(r.dev[DEV_FIELDS.StrokeRate.num], Math.round(rate * 100));
  assert.equal(r.f[4], Math.floor(rate));
  assert.equal(r.f[53], Math.round((rate - Math.floor(rate)) * 128));
  // the peak's place in the drive, and that place in millimetres of the reported drive length
  const p = peakPosition(st);
  assert.equal(r.dev[DEV_FIELDS.PeakForcePositionNorm.num], Math.round(p.norm));
  assert.equal(r.dev[DEV_FIELDS.PeakForcePositionAbs.num], Math.round(p.abs));
  assert.ok(p.norm > 0 && p.norm < 10000);
});

test("every developer field is described in the file, under the standard's UUID", () => {
  const msgs = read(encode(sample));
  const [ns] = of(msgs, 207);
  assert.equal(ns.f[1].map(b => b.toString(16).padStart(2, "0")).join(""), APP_UUID.replace(/-/g, ""));
  assert.equal(ns.f[3], 0, "developer data index 0");
  const described = of(msgs, 206);
  const byName = new Map(described.map(d => [d.f[3], d]));
  for (const [name, spec] of Object.entries(DEV_FIELDS)) {
    const d = byName.get(name);
    assert.ok(d, `${name} is described`);
    assert.equal(d.f[1], spec.num, `${name} field number`);
    assert.equal(d.f[6], spec.scale, `${name} scale`);
    assert.equal(d.f[8], spec.units, `${name} units`);
  }
  // and every field a record actually carries has a description
  const used = new Set(of(msgs, 20).flatMap(r => Object.keys(r.dev).map(Number)));
  const nums = new Set(described.map(d => d.f[1]));
  for (const n of used) assert.ok(nums.has(n), `field ${n} is described`);
});

test("the PM5's splits become laps, and a row without them becomes one", () => {
  const splits = [1, 2, 3].map(n => ({ split_number: n, split_time_s: 60, split_distance_m: 211, end_s: 60 * n,
    split_spm: 22, split_hr: 130 + n, split_pace_s: 142, split_calories: 10, split_power_w: 160, split_speed_ms: 3.5 }));
  const msgs = read(encode({ ...sample, splits }));
  const laps = of(msgs, 19);
  assert.equal(laps.length, 3);
  assert.deepEqual(laps.map(l => l.f[254]), [0, 1, 2], "laps are indexed in order");
  assert.deepEqual(laps.map(l => l.f[7]), [60000, 60000, 60000]);
  assert.deepEqual(laps.map(l => l.f[15]), [131, 132, 133], "each lap keeps its own average heart rate");
  assert.equal(laps.reduce((a, l) => a + l.f[10], 0), sample.strokes[sample.strokes.length - 1].stroke_count,
    "the strokes are shared out across the laps without being counted twice");
  assert.equal(of(msgs, 18)[0].f[26], 3, "the session says how many laps there are");
  assert.equal(of(msgs, 19).length, 3);
  assert.equal(read(encode(sample)).filter(m => m.global === 19).length, 1);
});

test("a stroke exactly on a split boundary is written once", () => {
  const splits = [1, 2, 3].map(n => ({ split_number: n, split_time_s: 60, split_distance_m: 211, end_s: 60 * n }));
  const k = sample.strokes.findIndex(s => s.elapsed_s > 60);
  const strokes = sample.strokes.map((s, i) => i === k ? { ...s, elapsed_s: 60 } : s);   // lands on the end of lap one
  const withLaps = of(read(encode({ ...sample, strokes, splits })), 20).length;
  assert.equal(withLaps, of(read(encode({ ...sample, strokes })), 20).length, "no record is repeated in the next lap");
});

test("nonsense readings are left out rather than written", () => {
  // the monitor reports a pace of a second or two per 500 m either side of a piece
  const strokes = sample.strokes.map((s, i) => i === 0 ? { ...s, pace_s: 1.79 } : s);
  const msgs = read(encode({ ...sample, strokes }));
  const records = of(msgs, 20);
  assert.equal(records[0].f[73], null, "no speed for the nonsense pace");
  assert.ok(records[1].f[73] > 3000 && records[1].f[73] < 8000, "a real pace still becomes a speed");
  const max = of(msgs, 18)[0].f[15];
  assert.ok(max < 8000, `max speed stays human (${max} mm/s)`);
  // a stroke with no curve gets no peak position, and nothing else breaks
  const noCurve = sample.strokes.map(({ force_curve_v2, force_curve, ...rest }) => rest);
  const bare = read(encode({ ...sample, strokes: noCurve }));
  assert.equal(of(bare, 20)[0].dev[DEV_FIELDS.PeakForcePositionAbs.num], null);
  assert.equal(of(bare, 20)[0].dev[DEV_FIELDS.DriveLength.num], Math.round(sample.strokes[0].drive_length_m * 1000));
});

test("heart rate survives the summary the PM5 actually sends", () => {
  // it reports average, minimum and maximum as zero, so they have to come from the strokes
  const summary = { ...sample.summary, avg_hr: 0, max_hr: 0, min_hr: 0 };
  const msgs = read(encode({ ...sample, summary }));
  const hrs = sample.strokes.map(s => s.hr).filter(h => h);
  const session = of(msgs, 18)[0];
  assert.equal(session.f[16], Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length));
  assert.equal(session.f[17], Math.max(...hrs));
  // and the monitor's own numbers win when it sends them
  assert.equal(of(read(encode(sample)), 18)[0].f[16], sample.summary.avg_hr);
});

test("a lap's highest heart rate is never below its average", () => {
  // the monitor averages a split over every second; we sample once a stroke, so its average can
  // sit above every beat we saw, and a maximum below the average is not a readable lap
  const splits = [{ split_number: 1, split_time_s: 200, split_distance_m: 700, end_s: 200, split_hr: 200 }];
  const lap = of(read(encode({ ...sample, splits })), 19)[0];
  assert.equal(lap.f[15], 200);
  assert.equal(lap.f[16], 200);
  for (const l of of(read(encode({ ...sample, splits: [] })), 19)) assert.ok(l.f[16] >= l.f[15]);
});

test("a row with no strokes still writes a valid, empty activity", () => {
  const msgs = read(encode({ started: "2026-09-20_100000", strokes: [], summary: {} }));
  assert.equal(of(msgs, 20).length, 0);
  assert.equal(of(msgs, 18).length, 1);
  assert.equal(of(msgs, 34).length, 1);
});

test("the clock comes from the strokes, and falls back on the row's name", () => {
  const t = startTime(sample);
  assert.equal(Math.round(t), Math.round(sample.strokes[0].t - sample.strokes[0].elapsed_s));
  const named = startTime({ started: "2026-09-18_171111", strokes: [] });
  const d = new Date(named * 1000);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getHours(), 17);
  assert.equal(d.getMinutes(), 11);
});

test("stroke rate falls back on the monitor's own number when the times are missing", () => {
  assert.equal(strokeRate({ drive_time_s: 0.8, recovery_time_s: 1.9 }), 60 / 2.7);
  assert.equal(strokeRate({ spm: 22 }), 22);
  assert.equal(strokeRate({}), null);
});
