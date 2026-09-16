// Programming a workout on the PM5 over its control service, the way ErgData does: a port of
// pm5_workouts.py. Frames follow Concept2's "PM CSAFE Communication Definition" rev 0.27
// (multi-byte values big-endian, unlike the rowing data). tests/csafe.test.js checks every
// frame against the Python builder and the spec's worked examples.

export const PM_RECEIVE = 0x0021;   // host -> PM
export const PM_TRANSMIT = 0x0022;  // PM -> host
export const CHUNK = 20;            // the receive characteristic takes up to 20 bytes per write

const EXT_START = 0xf0, START = 0xf1, STOP = 0xf2, STUFF = 0xf3;
const PM_WRAPPER = 0x76;            // CSAFE_SETPMCFG_CMD: "one or more C2 proprietary commands"
const SET_WORKOUTTYPE = 0x01, SET_WORKOUTDURATION = 0x03, SET_RESTDURATION = 0x04, SET_SPLITDURATION = 0x05,
  SET_TARGETPACETIME = 0x06, SET_SCREENSTATE = 0x13, CONFIGURE_WORKOUT = 0x14, SET_INTERVALTYPE = 0x17,
  SET_WORKOUTINTERVALCOUNT = 0x18;
const DUR_TIME = 0x00, DUR_CALORIES = 0x40, DUR_DISTANCE = 0x80;
const WT = { just_row_nosplits: 0, just_row: 1, distance_nosplits: 2, distance: 3, time_nosplits: 4, time: 5,
  time_interval: 6, distance_interval: 7, variable: 8, variable_undefined_rest: 9, calorie: 10, wattminute: 11, calorie_interval: 12 };
const IT = { time: 0, distance: 1, rest: 2, time_undefined_rest: 3, distance_undefined_rest: 4, undefined_rest: 5, calorie: 6, calorie_undefined_rest: 7 };
const SCREEN_WORKOUT = 1, PREPARE_TO_ROW = 1, TERMINATE_WORKOUT = 2;
export const MAX_INTERVALS = 50;
const STATE = { 0: "error", 1: "ready", 2: "idle", 3: "have id", 5: "in use", 6: "pause", 7: "finish", 8: "manual", 9: "off line" };
const PREV = { 0x00: "ok", 0x10: "rejected", 0x20: "bad", 0x30: "not ready" };

export const STOP_FLAG = STOP;

// ---------------------------------------------------------------------------- framing

export function checksum(contents) { let c = 0; for (const b of contents) c ^= b; return c; }

export function stuff(data) {
  const out = [];
  for (const b of data) { if (b >= EXT_START && b <= STUFF) out.push(STUFF, b & 0x03); else out.push(b); }
  return Uint8Array.from(out);
}

export function unstuff(data) {
  const out = [];
  for (let i = 0; i < data.length;) {
    if (data[i] === STUFF && i + 1 < data.length) { out.push(0xf0 | (data[i + 1] & 0x03)); i += 2; }
    else { out.push(data[i]); i += 1; }
  }
  return Uint8Array.from(out);
}

/** A standard CSAFE frame: start flag, stuffed contents and checksum, stop flag. */
export function frame(contents) {
  return Uint8Array.from([START, ...stuff([...contents, checksum(contents)]), STOP]);
}

/** [status byte, command responses] from a response frame; throws on a bad frame. */
export function unframe(raw) {
  if (raw.length < 4 || (raw[0] !== START && raw[0] !== EXT_START) || raw[raw.length - 1] !== STOP) throw new Error(`not a CSAFE frame: ${hex(raw)}`);
  let body = unstuff(raw.slice(1, -1));
  if (raw[0] === EXT_START) body = body.slice(2);   // destination and source addresses
  const contents = body.slice(0, -1), check = body[body.length - 1];
  if (checksum(contents) !== check) throw new Error(`checksum mismatch in ${hex(raw)}`);
  return [contents[0], contents.slice(1)];
}

export const describeStatus = status => `${PREV[status & 0x30] ?? "?"}, state ${STATE[status & 0x0f] ?? status & 0x0f}`;
export const hex = b => Array.from(b, x => x.toString(16).padStart(2, "0")).join(" ");

const longCmd = (cmd, data) => [cmd, data.length, ...data];
function wrap(...cmds) {
  const body = cmds.flat();
  if (body.length > 255) throw new Error("workout too long for one frame");
  return [PM_WRAPPER, body.length, ...body];
}
function be(value, n) {
  let v = Math.round(value); const out = new Array(n);
  for (let i = n - 1; i >= 0; i--) { out[i] = v & 0xff; v = Math.floor(v / 256); }
  return out;
}

// ---------------------------------------------------------------------------- workouts

function duration(iv) {
  if ("distance_m" in iv) return [DUR_DISTANCE, ...be(iv.distance_m, 4)];
  if ("calories" in iv) return [DUR_CALORIES, ...be(iv.calories, 4)];
  return [DUR_TIME, ...be(iv.time_s * 100, 4)];   // 0.01 s units
}
function intervalType(iv, undefinedRest) {
  const base = "distance_m" in iv ? "distance" : "calories" in iv ? "calorie" : "time";
  return IT[undefinedRest ? `${base}_undefined_rest` : base];
}

/** Five splits, rounded to a sensible size (the PM5 wants at least 100 m). */
export function defaultSplitM(distanceM) {
  const step = distanceM >= 5000 ? 500 : 100;
  return Math.max(100, Math.round(distanceM / 5 / step) * step || 100);
}
export function defaultSplitS(timeS) {
  const step = timeS >= 600 ? 60 : 30;
  return Math.max(30, Math.round(timeS / 5 / step) * step || 30);
}

/** Fill in defaults and check a workout object. Kinds: just_row, distance, time, calories,
 *  interval (one work/rest pair repeated until stopped), variable (a list, optional repeat). */
export function normalise(spec) {
  let s = { ...spec };
  if (s.just_row || s.kind === "just_row") {
    s = { kind: "just_row", split_m: s.split_m ?? 500 };
  } else if ("intervals" in s) {
    const ivs = [];
    for (let r = 0; r < Math.trunc(s.repeat ?? 1); r++) for (const iv of s.intervals) ivs.push({ ...iv });
    if (!ivs.length) throw new Error("an interval workout needs at least one interval");
    if (ivs.length > MAX_INTERVALS) throw new Error(`the PM5 takes at most ${MAX_INTERVALS} intervals (${ivs.length} given)`);
    for (const iv of ivs) if (!("distance_m" in iv || "time_s" in iv || "calories" in iv)) throw new Error(`interval without distance_m/time_s/calories: ${JSON.stringify(iv)}`);
    s = { kind: "variable", intervals: ivs };
  } else if ("interval" in s) {
    const iv = { ...s.interval };
    if (!("rest_s" in iv)) throw new Error("a repeating interval needs rest_s (or give a count: NxWORK for undefined rest)");
    s = { kind: "interval", interval: iv };
  } else if ("distance_m" in s) {
    const d = Math.trunc(s.distance_m);
    s = { kind: "distance", distance_m: d, split_m: Math.trunc(s.split_m || defaultSplitM(d)) };
  } else if ("time_s" in s) {
    const t = Math.trunc(s.time_s);
    s = { kind: "time", time_s: t, split_s: Math.trunc(s.split_s || defaultSplitS(t)) };
  } else if ("calories" in s) {
    const c = Math.trunc(s.calories);
    s = { kind: "calories", calories: c, split_cal: Math.trunc(s.split_cal || Math.max(1, Math.round(c / 5))) };
  } else {
    throw new Error(`can't make a workout out of ${JSON.stringify(spec)}`);
  }
  if ("pace_s" in spec && (s.kind === "variable" || s.kind === "interval")) {
    for (const iv of (s.kind === "variable" ? s.intervals : [s.interval])) if (!("pace_s" in iv)) iv.pace_s = spec.pace_s;
  }
  return s;
}

/** The CSAFE frame that programs `spec` and puts the PM5 on its "prepare to row" screen. */
export function build(spec) {
  const s = normalise(spec), kind = s.kind, cmds = [];
  if (kind === "just_row") {
    cmds.push(longCmd(SET_WORKOUTTYPE, [WT.just_row]), longCmd(SET_SPLITDURATION, [DUR_DISTANCE, ...be(s.split_m, 4)]));
  } else if (kind === "distance" || kind === "time" || kind === "calories") {
    const [total, split, ident, scale] = { distance: ["distance_m", "split_m", DUR_DISTANCE, 1], time: ["time_s", "split_s", DUR_TIME, 100],
      calories: ["calories", "split_cal", DUR_CALORIES, 1] }[kind];
    cmds.push(longCmd(SET_WORKOUTTYPE, [WT[kind === "calories" ? "calorie" : kind]]), longCmd(SET_WORKOUTDURATION, [ident, ...be(s[total] * scale, 4)]),
      longCmd(SET_SPLITDURATION, [ident, ...be(s[split] * scale, 4)]));
  } else if (kind === "interval") {
    const iv = s.interval;
    const wt = WT["distance_m" in iv ? "distance_interval" : "calories" in iv ? "calorie_interval" : "time_interval"];
    cmds.push(longCmd(SET_WORKOUTTYPE, [wt]), longCmd(SET_WORKOUTDURATION, duration(iv)), longCmd(SET_RESTDURATION, be(iv.rest_s, 2)));
    if (iv.pace_s) cmds.push(longCmd(SET_TARGETPACETIME, be(iv.pace_s * 100, 4)));
  } else if (kind === "variable") {
    const ivs = s.intervals, undefinedRest = ivs.some(iv => !("rest_s" in iv));
    ivs.forEach((iv, n) => {
      cmds.push(longCmd(SET_WORKOUTINTERVALCOUNT, [n]));
      if (n === 0) cmds.push(longCmd(SET_WORKOUTTYPE, [WT.variable]));
      cmds.push(longCmd(SET_INTERVALTYPE, [intervalType(iv, !("rest_s" in iv))]), longCmd(SET_WORKOUTDURATION, duration(iv)),
        longCmd(SET_RESTDURATION, be(iv.rest_s ?? 0, 2)));
      if (iv.pace_s) cmds.push(longCmd(SET_TARGETPACETIME, be(iv.pace_s * 100, 4)));
      cmds.push(longCmd(CONFIGURE_WORKOUT, [1]));
    });
    if (undefinedRest) {
      // the spec: a variable workout with any undefined rest must set the workout type to "variable,
      // undefined rest" and a zero split distance, or the PM5 treats it as a Biathlon
      cmds.push(longCmd(SET_WORKOUTTYPE, [WT.variable_undefined_rest]), longCmd(SET_SPLITDURATION, [DUR_DISTANCE, ...be(0, 4)]));
    }
    cmds.push(longCmd(SET_SCREENSTATE, [SCREEN_WORKOUT, PREPARE_TO_ROW]));
    return frame(wrap(...cmds));
  }
  if (kind !== "just_row") cmds.push(longCmd(CONFIGURE_WORKOUT, [1]));
  cmds.push(longCmd(SET_SCREENSTATE, [SCREEN_WORKOUT, PREPARE_TO_ROW]));
  return frame(wrap(...cmds));
}

export const terminateFrame = () => frame(wrap(longCmd(SET_SCREENSTATE, [SCREEN_WORKOUT, TERMINATE_WORKOUT])));

// ---------------------------------------------------------------------------- the mini-syntax

const TIME_RE = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/, DIST_RE = /^(\d+(?:\.\d+)?)(m|km)$/, CAL_RE = /^(\d+)cal$/;

/** "500m", "2.5km", "4:00", "1:00:00", "100cal" -> {distance_m|time_s|calories: value}. */
export function parseAmount(text) {
  const t = text.trim().toLowerCase();
  let m;
  if ((m = DIST_RE.exec(t))) return { distance_m: Math.round(parseFloat(m[1]) * (m[2] === "km" ? 1000 : 1)) };
  if ((m = TIME_RE.exec(t))) { const [h, mi, s] = [m[1], m[2], m[3]].map(x => (x ? parseInt(x, 10) : 0)); return { time_s: h * 3600 + mi * 60 + s }; }
  if ((m = CAL_RE.exec(t))) return { calories: parseInt(m[1], 10) };
  throw new Error(`'${text}' is not a distance (500m, 2.5km), a time (4:00, 1:00:00) or calories (100cal)`);
}
function parseTimeS(text) {
  const v = parseAmount(text);
  if (!("time_s" in v)) throw new Error(`'${text}' should be a time like 3:00`);
  return v.time_s;
}
function parseInterval(text) {
  const t = text.trim();
  if (t.includes("/")) {
    const i = t.indexOf("/"), work = t.slice(0, i), rest = t.slice(i + 1).trim();
    if (!rest.toLowerCase().endsWith("r")) throw new Error(`'${text}': rest must end in r, e.g. 4:00/3:00r`);
    return { ...parseAmount(work), rest_s: parseTimeS(rest.slice(0, -1)) };
  }
  return parseAmount(t);
}

/** The typed syntax -> a workout object for normalise(). A name in `named` wins over the syntax. */
export function parseSpec(text, named = {}) {
  text = text.trim();
  if (named[text] !== undefined) return named[text];
  if (["just_row", "justrow", "jr"].includes(text.toLowerCase())) return { just_row: true };
  let pace = null;
  if (text.includes("@")) { const i = text.indexOf("@"); pace = parseTimeS(text.slice(i + 1)); text = text.slice(0, i); }
  const withPace = o => (pace ? { ...o, pace_s: pace } : o);
  const parts = text.split(",").map(p => p.trim()).filter(Boolean);
  if (parts.length > 1) return withPace({ intervals: parts.map(parseInterval) });
  const p = parts[0] ?? "";
  let m;
  if ((m = /^(\d+)\s*[x×]\s*(.+)$/i.exec(p))) return withPace({ intervals: [parseInterval(m[2])], repeat: parseInt(m[1], 10) });
  if (p.toLowerCase().endsWith("r") && p.includes("/")) return withPace({ interval: parseInterval(p) });
  if (p.includes("/")) {
    const i = p.indexOf("/"), work = parseAmount(p.slice(0, i)), sp = parseAmount(p.slice(i + 1));
    const key = Object.keys(work)[0];
    if (Object.keys(sp)[0] !== key) throw new Error(`the split in '${p}' must be the same kind as the piece`);
    const splitKey = { distance_m: "split_m", time_s: "split_s", calories: "split_cal" }[key];
    return withPace({ ...work, [splitKey]: Object.values(sp)[0] });
  }
  return withPace(parseAmount(p));
}

/** The named workouts of a workouts.json object (keys starting with _ are comments). */
export const namedWorkouts = data => Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith("_")));

export function fmtTime(s) {
  const p2 = n => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}` : `${Math.floor(s / 60)}:${p2(s % 60)}`;
}
function fmtIv(iv) {
  const work = "distance_m" in iv ? `${iv.distance_m} m` : "calories" in iv ? `${iv.calories} cal` : fmtTime(iv.time_s);
  const rest = "rest_s" in iv ? `${fmtTime(iv.rest_s)} rest` : "rest until you row";
  const pace = iv.pace_s ? ` @ ${fmtTime(Math.trunc(iv.pace_s))}/500m` : "";
  return `${work} / ${rest}${pace}`;
}
const canonical = o => JSON.stringify(Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]])));

export function describe(spec) {
  const s = normalise(spec), k = s.kind;
  if (k === "just_row") return `Just Row, ${s.split_m} m splits`;
  if (k === "distance") return `${s.distance_m} m, ${s.split_m} m splits`;
  if (k === "time") return `${fmtTime(s.time_s)}, ${fmtTime(s.split_s)} splits`;
  if (k === "calories") return `${s.calories} cal, ${s.split_cal} cal splits`;
  if (k === "interval") return `intervals of ${fmtIv(s.interval)} until stopped`;
  const ivs = s.intervals;
  if (new Set(ivs.map(canonical)).size === 1) return `${ivs.length} x ${fmtIv(ivs[0])}`;
  return `${ivs.length} intervals: ` + ivs.map(fmtIv).join(", ");
}
