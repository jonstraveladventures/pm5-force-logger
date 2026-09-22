// Writing a row out as a Garmin FIT activity file, so it can go into Garmin Connect,
// intervals.icu, Strava or anything else that reads FIT.
//
// The rowing detail rides in FIT developer fields under the application UUID of the draft
// Rowing Data Standard (github.com/MoveLab-Studio/rowing-data-standard), the shared convention
// Concept2, RP3, CrewNerd, Rowsandall and OpenRowingMonitor are working towards. A reader that
// knows nothing about it still gets a normal indoor-rowing activity; one that does gets drive
// length, drive and recovery time, drag factor, average and peak force, work per stroke, a
// stroke rate to 0.01 spm and where in the handle's travel the force peaked.
//
// The standard is a draft: field numbers may be renumbered before it is ratified, and in-stroke
// force curves (IDs 60-89) have no agreed allocation yet, so the curves themselves stay in the
// session JSON for now. Message and field numbers below are from the Garmin FIT profile (21.214).

import { trim, CM_PER_POINT } from "./curve.js";

const FIT_EPOCH = 631065600;                    // 1989-12-31 00:00:00 UTC, in Unix seconds
const LBF_TO_N = 4.4482216152605;
const MM_PER_POINT = CM_PER_POINT * 10;
export const APP_UUID = "89e86158-6d47-5c98-9d46-7d29437f27b9";   // uuid5(DNS, "rowingdata")
const UUID_BYTES = APP_UUID.replace(/-/g, "").match(/../g).map(h => parseInt(h, 16));

const MESG = { file_id: 0, file_creator: 49, device_info: 23, event: 21, record: 20, lap: 19, session: 18, activity: 34,
  field_description: 206, developer_data_id: 207 };
const SPORT_ROWING = 15, SUB_INDOOR_ROWING = 14, MFG_DEVELOPMENT = 255, MFG_CONCEPT2 = 40;

// base types: the id that goes in a definition message, the size, and the value that means "absent"
const T = {
  enum:    { id: 0x00, size: 1, invalid: 0xff },
  uint8:   { id: 0x02, size: 1, invalid: 0xff },
  uint16:  { id: 0x84, size: 2, invalid: 0xffff },
  uint32:  { id: 0x86, size: 4, invalid: 0xffffffff },
  uint32z: { id: 0x8c, size: 4, invalid: 0 },
  byte:    { id: 0x0d, size: 1, invalid: 0xff },
  string:  { id: 0x07, size: 1, invalid: 0 },
};

/** The rowing developer fields we can fill from a PM5. Numbers, scales and units are the draft's. */
export const DEV_FIELDS = {
  DriveLength:           { num: 0,  type: "uint16", scale: 1,   units: "mm" },
  StrokeDriveTime:       { num: 1,  type: "uint16", scale: 1,   units: "ms" },
  DragFactor:            { num: 2,  type: "uint16", scale: 1,   units: "" },
  StrokeRecoveryTime:    { num: 3,  type: "uint16", scale: 1,   units: "ms" },
  AverageDriveForceN:    { num: 6,  type: "uint16", scale: 10,  units: "N" },
  PeakDriveForceN:       { num: 7,  type: "uint16", scale: 10,  units: "N" },
  PeakForcePositionNorm: { num: 17, type: "uint16", scale: 1,   units: "" },
  PeakForcePositionAbs:  { num: 18, type: "uint16", scale: 1,   units: "mm" },
  StrokeWork:            { num: 19, type: "uint16", scale: 1,   units: "J" },
  StrokeRate:            { num: 93, type: "uint16", scale: 100, units: "spm" },
  RecordingStrategy:     { num: 10, type: "uint8",  scale: 1,   units: "" },   // on the session message
};
const STROKE_FIELDS = ["DriveLength", "StrokeDriveTime", "DragFactor", "StrokeRecoveryTime", "AverageDriveForceN",
  "PeakDriveForceN", "PeakForcePositionNorm", "PeakForcePositionAbs", "StrokeWork", "StrokeRate"];

// ---------- the byte-level writer ----------
const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];

/** FIT's CRC-16, a nibble at a time. */
export function crc16(bytes, crc = 0) {
  for (const b of bytes) {
    for (const nibble of [b & 0x0f, (b >> 4) & 0x0f]) {
      const tmp = CRC_TABLE[crc & 0x0f];
      crc = ((crc >> 4) & 0x0fff) ^ tmp ^ CRC_TABLE[nibble];
    }
  }
  return crc & 0xffff;
}

class Buf {
  constructor() { this.a = []; }
  u8(v) { this.a.push(v & 0xff); }
  u16(v) { this.u8(v); this.u8(v >> 8); }
  u32(v) { this.u16(v & 0xffff); this.u16((v >>> 16) & 0xffff); }
  str(s, size) { const b = new TextEncoder().encode(s); for (let i = 0; i < size; i++) this.u8(i < b.length ? b[i] : 0); }
  raw(bytes) { for (const b of bytes) this.u8(b); }
}

const size = f => f.size ?? T[f.type].size;

function writeValue(buf, f, v) {
  const t = T[f.type], n = size(f);
  if (f.type === "string") { buf.str(v == null ? "" : String(v), n); return; }
  if (f.type === "byte") { const bytes = v == null ? Array(n).fill(t.invalid) : v; for (let i = 0; i < n; i++) buf.u8(bytes[i] ?? t.invalid); return; }
  const raw = v == null || !Number.isFinite(v) ? t.invalid : Math.max(0, Math.min(t.invalid === 0 ? 0xffffffff : t.invalid - 1, Math.round(v * (f.scale ?? 1))));
  if (n === 1) buf.u8(raw); else if (n === 2) buf.u16(raw); else buf.u32(raw);
}

/** One definition message followed by its data messages. `fields` and `dev` name where each value
 *  lives in a row object; a missing value is written as the base type's invalid value. */
function messages(buf, local, global, fields, dev, rows) {
  buf.u8(0x40 | local | (dev.length ? 0x20 : 0));
  buf.u8(0); buf.u8(0); buf.u16(global);
  buf.u8(fields.length);
  for (const f of fields) { buf.u8(f.num); buf.u8(size(f)); buf.u8(T[f.type].id); }
  if (dev.length) { buf.u8(dev.length); for (const d of dev) { buf.u8(d.num); buf.u8(T[d.type].size); buf.u8(0); } }
  for (const row of rows) {
    buf.u8(local);
    for (const f of fields) writeValue(buf, f, row[f.key]);
    for (const d of dev) writeValue(buf, d, row[d.key]);
  }
}

// ---------- turning a session into the numbers FIT wants ----------
const stamp = t => t == null ? null : Math.max(0, Math.round(t - FIT_EPOCH));
const last = a => a[a.length - 1];

/** When the piece began, in Unix seconds: each stroke carries both its arrival time and the
 *  monitor's elapsed clock, so the difference is the start. Falls back on the row's own name. */
export function startTime(sess) {
  const s = (sess.strokes || []).find(x => x.t > 1e9 && x.elapsed_s != null);
  if (s) return s.t - s.elapsed_s;
  const m = /^(\d{4})-(\d\d)-(\d\d)_(\d\d)(\d\d)(\d\d)$/.exec(sess.started || "");
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() / 1000;
  return Date.now() / 1000;
}

/** Where in the handle's travel force peaked, from the distance-axis curve: ten-thousandths of
 *  the drive, and millimetres from the catch. Only 0x0043 has a distance axis; 0x003D is time.
 *  The fraction comes from the curve; the millimetres are that fraction of the drive length the
 *  monitor itself reports, so the two fields describe the same drive. The curve's own spacing
 *  (one point per 2.96 cm) runs about a tenth short of the reported drive length, so it is only
 *  the fallback for a stroke whose drive length is missing. */
export function peakPosition(stroke) {
  const t = trim(stroke.force_curve_v2);
  if (!t || t.length < 2) return { abs: null, norm: null };
  const i = t.indexOf(Math.max(...t)), frac = i / (t.length - 1);
  const mm = stroke.drive_length_m > 0 ? frac * stroke.drive_length_m * 1000 : i * MM_PER_POINT;
  return { abs: mm, norm: 10000 * frac };
}

/** Stroke rate for this stroke alone: the PM5 reports drive and recovery to 10 ms, and their sum
 *  is the stroke's period, which is finer than the whole-number spm the monitor displays. */
export function strokeRate(s) {
  const cycle = (s.drive_time_s ?? 0) + (s.recovery_time_s ?? 0);
  return cycle > 0.5 ? 60 / cycle : (s.spm || null);
}

// The monitor reports a nonsense pace for a stroke or two either side of a piece (1.8 s per 500 m
// on the row of 18 September). Anything outside a human range is dropped rather than written.
const PACE_MIN = 60, PACE_MAX = 1200;                   // seconds per 500 m
const speed = s => s.pace_s >= PACE_MIN && s.pace_s <= PACE_MAX ? 500 / s.pace_s : null;

/** The laps: the PM5's own splits when it sent them, otherwise the whole piece as one. */
function laps(sess, totalS, totalM) {
  const sp = (sess.splits || []).filter(s => s.split_time_s > 0);
  if (!sp.length) return [{ start_s: 0, end_s: totalS, distance_m: totalM }];
  return sp.map(s => ({ start_s: Math.max(0, (s.end_s ?? 0) - s.split_time_s), end_s: s.end_s ?? 0,
    distance_m: s.split_distance_m, hr: s.split_hr, spm: s.split_spm, power_w: s.split_power_w,
    calories: s.split_calories, speed_ms: s.split_speed_ms }));
}

/**
 * Encode one saved row as a FIT activity file.
 * @param {object} sess a session as the logger saves it: summary, strokes, splits, device
 * @returns {Uint8Array} the file's bytes
 */
export function encode(sess) {
  const strokes = (sess.strokes || []).filter(s => s.elapsed_s != null);
  const sm = sess.summary || {}, dev = sess.device || {};
  const t0 = startTime(sess);
  const tail = last(strokes) || {};
  const totalS = sm.elapsed_s ?? tail.elapsed_s ?? 0;
  const totalM = sm.distance_m ?? tail.distance_m ?? 0;
  const cycles = tail.stroke_count ?? strokes.length;
  const drag = sm.drag_factor_avg ?? (sess.last_status || {}).drag_factor ?? null;
  const work = strokes.reduce((a, s) => a + (s.work_j || 0), 0);
  const maxPower = strokes.reduce((a, s) => Math.max(a, s.power_w || 0), 0) || null;
  // The PM5's end-of-workout summary reports average, minimum and maximum heart rate as zero
  // (seen on every row so far), so they come from the strokes instead when it does.
  const hrs = strokes.map(s => s.hr).filter(h => h);
  const avgHr = sm.avg_hr || (hrs.length ? hrs.reduce((a, b) => a + b, 0) / hrs.length : null);
  const maxHr = sm.max_hr || (hrs.length ? Math.max(...hrs) : null);
  const maxSpeed = strokes.reduce((a, s) => Math.max(a, speed(s) || 0), 0) || null;
  const endT = t0 + totalS;

  const buf = new Buf();
  const F = (num, type, key, scale, extra) => ({ num, type, key, scale, ...extra });

  messages(buf, 0, MESG.file_id,
    [F(0, "enum", "type"), F(1, "uint16", "manufacturer"), F(2, "uint16", "product"), F(3, "uint32z", "serial"),
      F(4, "uint32", "created"), F(8, "string", "product_name", 1, { size: 21 })],
    [], [{ type: 4, manufacturer: MFG_DEVELOPMENT, product: 0, serial: serialOf(dev), created: stamp(t0),
      product_name: "pm5-force-logger" }]);

  messages(buf, 1, MESG.file_creator, [F(0, "uint16", "sw")], [], [{ sw: 100 }]);

  // the namespace the rowing fields live in, then one description per field so any reader can
  // name, scale and unit them without knowing the standard
  messages(buf, 2, MESG.developer_data_id,
    [F(1, "byte", "app_id", 1, { size: 16 }), F(3, "uint8", "index")], [], [{ app_id: UUID_BYTES, index: 0 }]);

  const used = [...STROKE_FIELDS, "RecordingStrategy"];
  const nameSize = Math.max(...used.map(n => n.length)) + 1;
  const unitSize = Math.max(...used.map(n => DEV_FIELDS[n].units.length)) + 1;
  messages(buf, 3, MESG.field_description,
    [F(0, "uint8", "index"), F(1, "uint8", "num"), F(2, "uint8", "base"), F(6, "uint8", "scale"),
      F(3, "string", "name", 1, { size: nameSize }), F(8, "string", "units", 1, { size: unitSize })],
    [], used.map(name => { const d = DEV_FIELDS[name];
      return { index: 0, num: d.num, base: T[d.type].id, scale: d.scale, name, units: d.units }; }));

  messages(buf, 4, MESG.device_info,
    [F(253, "uint32", "timestamp"), F(0, "uint8", "device_index"), F(2, "uint16", "manufacturer"),
      F(3, "uint32z", "serial"), F(25, "enum", "source"), F(27, "string", "product_name", 1, { size: 21 })],
    [], [{ timestamp: stamp(t0), device_index: 0, manufacturer: MFG_CONCEPT2, serial: serialOf(dev),
      source: 3, product_name: (dev.model || "PM5").slice(0, 20) }]);

  const eventFields = [F(253, "uint32", "timestamp"), F(0, "enum", "event"), F(1, "enum", "event_type")];
  messages(buf, 5, MESG.event, eventFields, [], [{ timestamp: stamp(t0), event: 0, event_type: 0 }]);

  // One record per stroke, dated when the monitor reported it. FIT dates a record to the second,
  // so above about 40 spm two strokes can share a timestamp; they are still written, because
  // moving one would be a lie about when it happened.
  const recFields = [F(253, "uint32", "timestamp"), F(5, "uint32", "distance", 100), F(4, "uint8", "cadence"),
    F(53, "uint8", "fractional_cadence", 128), F(3, "uint8", "hr"), F(7, "uint16", "power"),
    F(73, "uint32", "speed", 1000), F(19, "uint32", "cycles"), F(87, "uint16", "stroke_distance", 100)];
  const recDev = STROKE_FIELDS.map(n => ({ ...DEV_FIELDS[n], key: n }));
  const recs = strokes.map(s => {
    const rate = strokeRate(s), peak = peakPosition(s);
    return { timestamp: stamp(t0 + s.elapsed_s), distance: s.distance_m, cadence: rate == null ? null : Math.floor(rate),
      fractional_cadence: rate == null ? null : rate - Math.floor(rate), hr: s.hr, power: s.power_w,
      speed: speed(s), cycles: s.stroke_count, stroke_distance: s.stroke_distance_m,
      DriveLength: s.drive_length_m == null ? null : s.drive_length_m * 1000,
      StrokeDriveTime: s.drive_time_s == null ? null : s.drive_time_s * 1000,
      DragFactor: drag,
      StrokeRecoveryTime: s.recovery_time_s == null ? null : s.recovery_time_s * 1000,
      AverageDriveForceN: s.avg_force_lbf == null ? null : s.avg_force_lbf * LBF_TO_N,
      PeakDriveForceN: s.peak_force_lbf == null ? null : s.peak_force_lbf * LBF_TO_N,
      PeakForcePositionNorm: peak.norm, PeakForcePositionAbs: peak.abs,
      StrokeWork: s.work_j, StrokeRate: rate, elapsed_s: s.elapsed_s };
  });

  const lapFields = [F(254, "uint16", "message_index"), F(253, "uint32", "timestamp"), F(0, "enum", "event"),
    F(1, "enum", "event_type"), F(2, "uint32", "start_time"), F(7, "uint32", "total_elapsed_time", 1000),
    F(8, "uint32", "total_timer_time", 1000), F(9, "uint32", "total_distance", 100), F(10, "uint32", "total_cycles"),
    F(11, "uint16", "total_calories"), F(13, "uint16", "avg_speed", 1000), F(15, "uint8", "avg_heart_rate"),
    F(16, "uint8", "max_heart_rate"), F(17, "uint8", "avg_cadence"), F(19, "uint16", "avg_power"),
    F(20, "uint16", "max_power"), F(24, "enum", "lap_trigger"), F(25, "enum", "sport"), F(39, "enum", "sub_sport")];

  const lapList = laps(sess, totalS, totalM);
  let recDefined = false, lapDefined = false, cyclesBefore = 0;
  lapList.forEach((lap, i) => {
    const mine = recs.filter(r => r.elapsed_s > lap.start_s - 1e-6 && (i === lapList.length - 1 || r.elapsed_s <= lap.end_s + 1e-6));
    if (mine.length) {
      if (!recDefined) { messages(buf, 6, MESG.record, recFields, recDev, mine); recDefined = true; }
      else for (const row of mine) { buf.u8(6); for (const f of recFields) writeValue(buf, f, row[f.key]); for (const d of recDev) writeValue(buf, d, row[d.key]); }
    }
    const lapHrs = mine.map(r => r.hr).filter(h => h), powers = mine.map(r => r.power).filter(p => p);
    const lapAvgHr = lap.hr ?? (lapHrs.length ? lapHrs.reduce((a, b) => a + b, 0) / lapHrs.length : null);
    const tail2 = last(mine) || {};
    const lapCycles = (tail2.cycles ?? cyclesBefore) - cyclesBefore;
    const dur = lap.end_s - lap.start_s;
    const row = { message_index: i, timestamp: stamp(t0 + lap.end_s), event: 9, event_type: 1,
      start_time: stamp(t0 + lap.start_s), total_elapsed_time: dur, total_timer_time: dur,
      total_distance: lap.distance_m, total_cycles: lapCycles || null, total_calories: lap.calories ?? (lapList.length === 1 ? sm.calories_total : null),
      avg_speed: lap.speed_ms ?? (dur > 0 && lap.distance_m ? lap.distance_m / dur : null),
      avg_heart_rate: lapAvgHr,
      // the monitor averages the split over every second while we sample once a stroke, so its
      // average can sit above the highest beat we saw; the maximum is at least the average
      max_heart_rate: lapHrs.length || lapAvgHr ? Math.max(...lapHrs, lapAvgHr || 0) : null,
      avg_cadence: lap.spm ?? (mine.length ? mine.reduce((a, r) => a + (r.StrokeRate || 0), 0) / mine.length : null),
      avg_power: lap.power_w ?? (powers.length ? powers.reduce((a, b) => a + b, 0) / powers.length : null),
      max_power: powers.length ? Math.max(...powers) : null,
      lap_trigger: lapList.length === 1 ? 7 : 8, sport: SPORT_ROWING, sub_sport: SUB_INDOOR_ROWING };
    if (!lapDefined) { messages(buf, 7, MESG.lap, lapFields, [], [row]); lapDefined = true; }
    else { buf.u8(7); for (const f of lapFields) writeValue(buf, f, row[f.key]); }
    cyclesBefore = tail2.cycles ?? cyclesBefore;
  });

  messages(buf, 5, MESG.event, eventFields, [], [{ timestamp: stamp(endT), event: 0, event_type: 4 }]);

  messages(buf, 8, MESG.session,
    [F(254, "uint16", "message_index"), F(253, "uint32", "timestamp"), F(0, "enum", "event"), F(1, "enum", "event_type"),
      F(2, "uint32", "start_time"), F(5, "enum", "sport"), F(6, "enum", "sub_sport"),
      F(7, "uint32", "total_elapsed_time", 1000), F(8, "uint32", "total_timer_time", 1000),
      F(9, "uint32", "total_distance", 100), F(10, "uint32", "total_cycles"), F(11, "uint16", "total_calories"),
      F(14, "uint16", "avg_speed", 1000), F(15, "uint16", "max_speed", 1000), F(16, "uint8", "avg_heart_rate"),
      F(17, "uint8", "max_heart_rate"), F(18, "uint8", "avg_cadence"), F(20, "uint16", "avg_power"),
      F(21, "uint16", "max_power"), F(25, "uint16", "first_lap_index"), F(26, "uint16", "num_laps"),
      F(28, "enum", "trigger"), F(42, "uint16", "avg_stroke_distance", 100), F(48, "uint32", "total_work")],
    [{ ...DEV_FIELDS.RecordingStrategy, key: "RecordingStrategy" }],
    [{ message_index: 0, timestamp: stamp(endT), event: 8, event_type: 1, start_time: stamp(t0),
      sport: SPORT_ROWING, sub_sport: SUB_INDOOR_ROWING, total_elapsed_time: totalS, total_timer_time: totalS,
      total_distance: totalM, total_cycles: cycles, total_calories: sm.calories_total,
      avg_speed: totalS > 0 ? totalM / totalS : null, max_speed: maxSpeed,
      avg_heart_rate: avgHr, max_heart_rate: maxHr,
      avg_cadence: sm.avg_stroke_rate || null, avg_power: sm.avg_watts || null, max_power: maxPower,
      first_lap_index: 0, num_laps: lapList.length, trigger: 0,
      avg_stroke_distance: cycles ? totalM / cycles : null, total_work: work || null,
      RecordingStrategy: 1 }]);   // one record per stroke

  messages(buf, 9, MESG.activity,
    [F(253, "uint32", "timestamp"), F(0, "uint32", "total_timer_time", 1000), F(1, "uint16", "num_sessions"),
      F(2, "enum", "type"), F(3, "enum", "event"), F(4, "enum", "event_type"), F(5, "uint32", "local_timestamp")],
    [], [{ timestamp: stamp(endT), total_timer_time: totalS, num_sessions: 1, type: 0, event: 26, event_type: 1,
      local_timestamp: stamp(endT - new Date(endT * 1000).getTimezoneOffset() * 60) }]);

  return finish(buf.a);
}

function serialOf(dev) {
  const n = parseInt(String(dev.serial || "").replace(/\D/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Header, body, file CRC. The header carries its own CRC over its first 12 bytes. */
function finish(body) {
  const h = new Buf();
  h.u8(14); h.u8(0x20); h.u16(2314); h.u32(body.length); h.raw([0x2e, 0x46, 0x49, 0x54]);   // ".FIT"
  h.u16(crc16(h.a));
  const all = [...h.a, ...body], c = crc16(all);
  all.push(c & 0xff, (c >> 8) & 0xff);
  return Uint8Array.from(all);
}

/** The name to save it under: the row's own stamp, so it sorts beside its JSON. */
export const fileName = sess => `${(sess.started || "row").replace(/[^\w-]/g, "_")}.fit`;
