// Decoding of the PM5's rowing-service notifications and assembly of one record per stroke.
// A port of parse(), ForceCurve and Session in pm5_logger.py; tests/decode.test.js checks it
// against the Python output on the same packets. Byte layouts follow Concept2's "PM Bluetooth
// Smart Communication Interface Definition" rev 1.30 (little-endian).

export const uuid = short => `ce06${short.toString(16).padStart(4, "0")}-43e5-11e4-916c-0800200c9a66`;
export const ADVERTISED_SERVICE = uuid(0x0000);
export const DEVICE_INFO_SERVICE = uuid(0x0010);
export const CONTROL_SERVICE = uuid(0x0020);
export const ROWING_SERVICE = uuid(0x0030);
export const DEVICE_INFO = { 0x0011: "model", 0x0012: "serial", 0x0013: "hardware_rev", 0x0014: "firmware_rev", 0x0015: "manufacturer" };
export const CURVE_MATCH_S = 3.0;   // a force curve belongs to the stroke record within this many seconds
export const AFTER_END_S = 75;      // the PM5 re-sends its summary with the recovery heart rate after a minute
export const WORKOUT_STATE = {
  0: "wait_to_begin", 1: "workout_row", 2: "countdown_pause", 3: "interval_rest", 4: "interval_work_time",
  5: "interval_work_distance", 6: "interval_rest_end_to_work_time", 7: "interval_rest_end_to_work_distance",
  8: "interval_work_time_to_rest", 9: "interval_work_distance_to_rest", 10: "workout_end", 11: "terminate",
  12: "workout_logged", 13: "rearm",
};

const DURATION_TYPE = { 0x00: "time", 0x40: "calories", 0x80: "distance", 0xc0: "watt_minutes" };
const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const u24 = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const round3 = t => Math.round(t * 1000) / 1000;

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(2 * i, 2), 16);
  return out;
}
export const bytesToHex = b => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");

/** Decode the characteristics we understand; anything else stays raw only. */
export function parse(short, b) {
  if (short === 0x0031 && b.length >= 19) {
    // bytes 14-16 are the programmed piece's length, in the unit byte 17 names (time in 0.01 s,
    // calories, metres); a Just Row reports 0
    return { elapsed_s: u24(b, 0) / 100, distance_m: u24(b, 3) / 10, workout_type: b[6],
      workout_state: WORKOUT_STATE[b[8]] ?? b[8], rowing_state: b[9], stroke_state: b[10], drag_factor: b[18],
      piece_type: DURATION_TYPE[b[17]] ?? b[17], piece_length: u24(b, 14) / (b[17] === 0 ? 100 : 1) };
  }
  if (short === 0x0032 && b.length >= 16) {
    return { elapsed_s: u24(b, 0) / 100, speed_ms: u16(b, 3) / 1000, stroke_rate: b[5],
      hr: b[6] === 0 || b[6] === 255 ? null : b[6], pace_s: u16(b, 7) / 100, avg_pace_s: u16(b, 9) / 100 };
  }
  if (short === 0x0033 && b.length >= 14) {
    return { elapsed_s: u24(b, 0) / 100, avg_power_w: u16(b, 4), calories_total: u16(b, 6), split_avg_pace_s: u16(b, 8) / 100 };
  }
  if (short === 0x0035 && b.length >= 20) {
    return { elapsed_s: u24(b, 0) / 100, distance_m: u24(b, 3) / 10, drive_length_m: b[6] / 100, drive_time_s: b[7] / 100,
      recovery_time_s: u16(b, 8) / 100, stroke_distance_m: u16(b, 10) / 100, peak_force_lbf: u16(b, 12) / 10,
      avg_force_lbf: u16(b, 14) / 10, work_j: u16(b, 16) / 10, stroke_count: u16(b, 18) };
  }
  if (short === 0x0036 && b.length >= 9) {
    const out = { elapsed_s: u24(b, 0) / 100, power_w: u16(b, 3), cal_per_hr: u16(b, 5), stroke_count: u16(b, 7) };
    if (b.length >= 15) { out.projected_time_s = u24(b, 9); out.projected_distance_m = u24(b, 12); }
    return out;
  }
  if (short === 0x003A && b.length >= 12) {
    return { split_type: b[4], split_size: u16(b, 5), split_count: b[7], calories_total: u16(b, 8), avg_watts: u16(b, 10) };
  }
  if (short === 0x0037 && b.length >= 18) {    // a split or interval just finished (spec rev 0.36)
    return { elapsed_s: u24(b, 0) / 100, distance_m: u24(b, 3) / 10, split_time_s: u24(b, 6) / 10, split_distance_m: u24(b, 9),
      rest_time_s: u16(b, 12), rest_distance_m: u16(b, 14), split_type: b[16], split_number: b[17] };
  }
  if (short === 0x0038 && b.length >= 19) {    // the same split's averages
    return { elapsed_s: u24(b, 0) / 100, split_spm: b[3], split_hr: b[4] === 0 || b[4] === 255 ? null : b[4],
      split_rest_hr: b[5] === 0 || b[5] === 255 ? null : b[5], split_pace_s: u16(b, 6) / 10, split_calories: u16(b, 8),
      split_cal_per_hr: u16(b, 10), split_speed_ms: u16(b, 12) / 1000, split_power_w: u16(b, 14), split_drag: b[16],
      split_number: b[17], machine_type: b[18] };
  }
  if (short === 0x003B && b.length >= 6) {     // the heart-rate monitor the PM5 is paired with
    return { hrm_mfg: b[0], hrm_type: b[1], hrm_id: (b[2] | b[3] << 8 | b[4] << 16 | b[5] << 24) >>> 0 };
  }
  if (short === 0x003E && b.length >= 13) {    // "additional status 3": state, screen, error, battery
    return { op_state: b[0], verification: b[1], screen: u16(b, 2), last_error: u16(b, 4), game_id: b[9], game_score: u16(b, 10), battery_pct: b[12] };
  }
  if (short === 0x0039 && b.length >= 20) {
    return { elapsed_s: u24(b, 4) / 100, distance_m: u24(b, 7) / 10, avg_stroke_rate: b[10], ending_hr: b[11], avg_hr: b[12],
      min_hr: b[13], max_hr: b[14], drag_factor_avg: b[15], recovery_hr: b[16], workout_type: b[17], avg_pace_s: u16(b, 18) / 10 };
  }
  return null;
}

/** Reassemble a force curve sent across several notifications (0x003D, and 0x0043 alike):
 *  byte 0 = (total packets << 4) | 16-bit points in this packet, byte 1 = sequence number. */
export class ForceCurve {
  constructor() { this.parts = []; this.expected = null; }
  add(b) {
    if (b.length < 2) return null;
    const total = b[0] >> 4, words = b[0] & 0x0f;
    if (b[1] === 0) { this.parts = []; this.expected = total; }   // a new curve always starts at sequence 0
    if (this.expected === null) return null;                       // joined mid-curve; wait for the next one
    const pts = [];
    for (let k = 0; k < words; k++) if (3 + 2 * k < b.length) pts.push(u16(b, 2 + 2 * k));
    this.parts.push(pts);
    if (this.parts.length >= this.expected) {
      const curve = this.parts.flat();
      this.parts = []; this.expected = null;
      return curve;
    }
    return null;
  }
}

const CURVES = { 0x003d: "force_curve", 0x0043: "force_curve_v2" };

/** Turns a stream of (arrival time, characteristic, bytes) into one record per stroke.
 *  Same rules as the Python Session: stroke data arrives twice per stroke, records are keyed on
 *  stroke count, count 0 is dropped, a count that goes backwards means a new piece started on the
 *  monitor (newPieceAt is set and further strokes are ignored), and emit(kind, data) feeds the page. */
export class Session {
  constructor(emit) {
    this.strokes = new Map(); this.unmatched = []; this.summary = {}; this.status = {}; this.splits = new Map();
    this.fc = { 0x003d: new ForceCurve(), 0x0043: new ForceCurve() };
    this.maxCount = 0; this.lastStrokeT = null; this.endAt = null; this.newPieceAt = null;
    this.emit = emit || (() => {});
  }

  feed(t, short, b) {
    if (short in CURVES) {
      const curve = this.fc[short].add(b);
      if (curve) this._attachCurve(t, CURVES[short], curve);
      return;
    }
    const p = parse(short, b);
    if (!p) return;
    if (short === 0x0035) { this._stroke(t, p); return; }
    if (short === 0x0036) {
      if (this.strokes.has(p.stroke_count) && this.newPieceAt === null) {
        this.strokes.get(p.stroke_count).power_w = p.power_w;
        this.emit("stroke_update", { stroke_count: p.stroke_count, power_w: p.power_w });
      }
      Object.assign(this.status, { power_w: p.power_w, projected_time_s: p.projected_time_s ?? null, projected_distance_m: p.projected_distance_m ?? null });
    } else if (short === 0x0032) {
      Object.assign(this.status, { hr: p.hr, stroke_rate: p.stroke_rate, pace_s: p.pace_s, avg_pace_s: p.avg_pace_s, elapsed_s: p.elapsed_s });
    } else if (short === 0x0031) {
      Object.assign(this.status, { drag_factor: p.drag_factor, workout_state: p.workout_state, workout_type: p.workout_type, elapsed_s: p.elapsed_s, distance_m: p.distance_m,
        piece_type: p.piece_type, piece_length: p.piece_length });
    } else if (short === 0x0033) {
      Object.assign(this.status, { avg_power_w: p.avg_power_w, calories_total: p.calories_total });
    } else if (short === 0x0037 || short === 0x0038) {
      if (this.newPieceAt === null && p.split_number) {
        const sp = this.splits.get(p.split_number) || { split_number: p.split_number };
        const { elapsed_s, ...rest } = p;
        Object.assign(sp, rest, { end_s: elapsed_s });
        this.splits.set(p.split_number, sp);
        this.emit("split", sp);
      }
      return;
    } else if (short === 0x003b) {
      Object.assign(this.status, p);
    } else if (short === 0x003e) {
      Object.assign(this.status, { battery_pct: p.battery_pct, screen: p.screen, last_error: p.last_error, op_state: p.op_state });
    } else if (short === 0x003a) {
      Object.assign(this.summary, p);
      this.emit("summary", this.summary);
      return;
    } else if (short === 0x0039) {
      Object.assign(this.summary, p);
      if (this.summary.received_at === undefined) this.summary.received_at = round3(t);   // the Logbook dates a row by its end
      this.endAt = this.endAt ?? t;
      this.emit("summary", this.summary);
      return;
    }
    this.emit("status", this.status);
  }

  _stroke(t, p) {
    const n = p.stroke_count;
    if (n === 0 || this.newPieceAt !== null) return;
    this.lastStrokeT = t;
    if (this.strokes.has(n)) {
      if (n < this.maxCount - 1) {   // counts went backwards: the PM5 started a new piece
        this.newPieceAt = t;
        this.emit("new_piece", { t: round3(t) });
        return;
      }
      this.strokes.get(n).recovery_time_s = p.recovery_time_s;
      this.emit("stroke_update", { stroke_count: n, recovery_time_s: p.recovery_time_s });
      return;
    }
    this.maxCount = Math.max(this.maxCount, n);
    const s = { t: round3(t), ...p, hr: this.status.hr ?? null, spm: this.status.stroke_rate ?? null,
      pace_s: this.status.pace_s ?? null, recovery_time_s: null };   // filled by this stroke's second copy
    this.strokes.set(n, s);
    for (const c of [...this.unmatched]) {   // a curve that arrived just before its stroke record
      if (!(c.kind in s) && Math.abs(c.t - t) < CURVE_MATCH_S) {
        s[c.kind] = c.points;
        this.unmatched.splice(this.unmatched.indexOf(c), 1);
      }
    }
    this.emit("stroke", s);
  }

  _attachCurve(t, key, points) {
    if (this.newPieceAt !== null) return;
    // each curve arrives just after its drive, beside that stroke's first 0x0035
    const free = [...this.strokes.values()].filter(s => !(key in s) && Math.abs(s.t - t) < CURVE_MATCH_S);
    if (free.length) {
      const s = free.reduce((a, b) => Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a);
      s[key] = points;
      this.emit("curve", { stroke_count: s.stroke_count, key, points });
    } else {
      this.unmatched.push({ kind: key, t: round3(t), points });
    }
  }

  sortedStrokes() { return [...this.strokes.keys()].sort((a, b) => a - b).map(k => this.strokes.get(k)); }
  snapshot() { return { status: this.status, summary: this.summary, strokes: this.sortedStrokes(), splits: [...this.splits.values()].sort((a, b) => a.split_number - b.split_number) }; }
  result(meta) {
    return { ...meta, last_status: this.status, summary: this.summary, strokes: this.sortedStrokes(),
      splits: [...this.splits.keys()].sort((a, b) => a - b).map(k => this.splits.get(k)),
      unmatched_curves: this.unmatched, new_piece_started: this.newPieceAt !== null };
  }
}

/** Parse a raw log (the JSONL the Python logger writes, or this app exports) into meta and events. */
export function readRaw(text) {
  const meta = {}, events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if ("device" in r) meta.device = r.device;
    if ("workout" in r) { if (r.workout) meta.workout = r.workout; else delete meta.workout; }
    if ("uuid" in r) events.push([r.t, parseInt(r.uuid, 16), hexToBytes(r.hex)]);
  }
  return { meta, events };
}
