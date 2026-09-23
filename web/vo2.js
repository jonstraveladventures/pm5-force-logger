// Watts at a fixed heart rate, and a VO2max estimate, from a row's steady window. A port of
// pm5_vo2.py, whose docstring sets out the method and its assumptions; tests/vo2.test.js checks
// the numbers against the Python code on the same rows.

export const SKIP_S = 300, TAIL_S = 60;          // the steady window: after the first 5 min, before the last 1 min
export const MIN_WINDOW_S = 240, MIN_STROKES = 40;
const SPRINT_FACTOR = 1.3, PAUSE_FACTOR = 0.5;
export const VO2_REST = 3.5;                      // ml/kg/min, the resting oxygen uptake (one MET)
const O2_KJ_PER_L = 20.9;                         // energy released per litre of oxygen
export const DEFAULT_EFFICIENCY = 0.21;
export const POOL_MIN_ROWS = 3, POOL_MIN_SPREAD_W = 40;
const HR_MARGIN = 15;                             // a window this close to resting heart rate can't be extrapolated

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
function median(xs) { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }

/** The estimate's inputs from {PM5_MASS_KG, PM5_HRMAX, PM5_AGE, PM5_HR_REST, PM5_ZONE_HR, PM5_NET_EFFICIENCY}
 *  (strings or numbers), or null when mass or maximum heart rate is missing. */
export function settings(env) {
  const num = key => {
    const v = env[key];
    if (v === undefined || v === null || v === "") return null;
    const n = typeof v === "number" ? v : parseFloat(v);
    if (Number.isNaN(n)) throw new Error(`${key}=${JSON.stringify(v)} is not a number`);
    return n;
  };
  const mass = num("PM5_MASS_KG"), notes = [];
  let hrmax = num("PM5_HRMAX");
  if (hrmax === null && num("PM5_AGE") !== null) {
    hrmax = 220 - num("PM5_AGE");
    notes.push(`HRmax ${hrmax.toFixed(0)} is 220 - age; set PM5_HRMAX to a measured maximum if you have one`);
  }
  if (mass === null || hrmax === null) return null;
  let rest = num("PM5_HR_REST");
  if (rest === null) { rest = 60; notes.push("PM5_HR_REST not set; using a resting heart rate of 60"); }
  if (!(rest < hrmax)) throw new Error(`PM5_HR_REST ${rest} must be below PM5_HRMAX ${hrmax}`);
  const zone = num("PM5_ZONE_HR") || Math.round(0.75 * hrmax);
  const eff = num("PM5_NET_EFFICIENCY") || DEFAULT_EFFICIENCY;
  return { mass_kg: mass, hrmax, hr_rest: rest, zone_hr: zone, efficiency: eff, notes };
}

/** Strokes with power and heart rate after the warm-up and before the finish, sprints and pauses dropped. */
export function steadyWindow(strokes, skipS = SKIP_S, tailS = TAIL_S) {
  const usable = strokes.filter(s => s.power_w && s.hr && s.hr !== 255);
  if (!usable.length) return [];
  const end = Math.max(...usable.map(s => s.elapsed_s)) - tailS;
  const window = usable.filter(s => s.elapsed_s >= skipS && s.elapsed_s <= end);
  if (!window.length) return [];
  const med = median(window.map(s => s.power_w));
  return window.filter(s => s.power_w >= PAUSE_FACTOR * med && s.power_w <= SPRINT_FACTOR * med);
}

/** One row's steady window as mean power and heart rate, or null when the row is too short. */
export function rowPoint(sess) {
  const window = steadyWindow(sess.strokes || []);
  if (window.length < MIN_STROKES || window[window.length - 1].elapsed_s - window[0].elapsed_s < MIN_WINDOW_S) return null;
  const spm = window.map(s => s.spm).filter(Boolean);
  return { watts: mean(window.map(s => s.power_w)), hr: mean(window.map(s => s.hr)), spm: spm.length ? mean(spm) : null,
    strokes: window.length, from_s: window[0].elapsed_s, to_s: window[window.length - 1].elapsed_s,
    drag: (sess.summary || {}).drag_factor_avg ?? null };
}

/** Oxygen uptake in ml/kg/min at a steady power: rest plus the work above it at the net efficiency. */
/** A guided step test's stages as points, or null for any other row. Each stage's mean power
 *  and heart rate over its last minute and a half; a steady window across the whole row would
 *  average the stages together and throw away the spread in power. Same as pm5_vo2.py. */
export function stepPoints(sess) {
  const g = sess.guided || {};
  if (g.kind !== "step") return null;
  return ((g.step || {}).stages || []).filter(st => st.watts && st.hr).map(st => ({ watts: st.watts, hr: st.hr }));
}

export const vo2 = (watts, massKg, efficiency = DEFAULT_EFFICIENCY) => VO2_REST + watts * 60 / (efficiency * O2_KJ_PER_L) / massKg;

/** Power at heart rate hr on the line through (0 W, resting heart rate) and the row's mean. */
export const wattsAt = (hr, wattsMean, hrMean, hrRest) => wattsMean * (hr - hrRest) / (hrMean - hrRest);

/** Least-squares HR = a + b W through per-row means; null without 3 rows spanning 40 W or a rising slope. */
export function fitLine(points) {
  if (points.length < POOL_MIN_ROWS) return null;
  const ws = points.map(p => p.watts), hs = points.map(p => p.hr);
  if (Math.max(...ws) - Math.min(...ws) < POOL_MIN_SPREAD_W) return null;
  const mw = mean(ws), mh = mean(hs);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < ws.length; i++) { sxy += (ws[i] - mw) * (hs[i] - mh); sxx += (ws[i] - mw) ** 2; }
  const b = sxy / sxx, a = mh - b * mw;
  if (b <= 0) return null;
  return { a, b, rows: points.length, watts_min: Math.min(...ws), watts_max: Math.max(...ws) };
}

/** Per-row: watts at the zone heart rate and a VO2max estimate; null when the row is too short. */
export function estimate(sess, cfg) {
  const p = rowPoint(sess);
  if (p === null) return null;
  if (p.hr - cfg.hr_rest < HR_MARGIN) return { ...p, error: `mean heart rate ${p.hr.toFixed(0)} is too close to resting ${cfg.hr_rest}` };
  const wZone = wattsAt(cfg.zone_hr, p.watts, p.hr, cfg.hr_rest), wMax = wattsAt(cfg.hrmax, p.watts, p.hr, cfg.hr_rest);
  return { ...p, watts_at_zone: wZone, watts_at_hrmax: wMax, vo2max: vo2(wMax, cfg.mass_kg, cfg.efficiency) };
}

/** The across-rows fit, with the same two numbers read off it. */
export function pooled(points, cfg) {
  const line = fitLine(points);
  if (line === null) return null;
  const wZone = (cfg.zone_hr - line.a) / line.b, wMax = (cfg.hrmax - line.a) / line.b;
  return { ...line, watts_at_zone: wZone, watts_at_hrmax: wMax, vo2max: vo2(wMax, cfg.mass_kg, cfg.efficiency) };
}

export const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const f0 = x => x.toFixed(0);

/** Text for a list of [name, session]: a per-row block each, then the pooled fit. Same wording as pm5_vo2.py. */
export function report(sessions, cfg) {
  const lines = [], points = [];
  let nRows = 0, nTests = 0, nStages = 0;
  for (const [name, sess] of sessions) {
    const stages = stepPoints(sess);
    if (stages !== null) {
      lines.push(`${name}: step test, ` + (stages.map(p => `${f0(p.watts)} W at ${f0(p.hr)} bpm`).join(", ") || "no stage finished"));
      const own = pooled(stages, cfg);
      if (own) lines.push(`   its own line: HR = ${f0(own.a)} + ${own.b.toFixed(2)} x W;  watts at ${f0(cfg.zone_hr)} bpm: ${f0(own.watts_at_zone)};  VO2max ~${f0(own.vo2max)} ml/kg/min`);
      else if (stages.length) lines.push(`   too few stages for a line of its own (${POOL_MIN_ROWS} spanning ${POOL_MIN_SPREAD_W} W); they still count in the fit across rows`);
      points.push(...stages);
      nTests += stages.length ? 1 : 0;
      nStages += stages.length;
      continue;
    }
    const est = estimate(sess, cfg);
    if (est === null) {
      lines.push(`${name}: too short for a steady window (${Math.floor(MIN_WINDOW_S / 60)} min needed after the first ${Math.floor(SKIP_S / 60)}, with heart rate)`);
      continue;
    }
    let head = `${name}: steady ${mmss(est.from_s)}-${mmss(est.to_s)}, ${est.strokes} strokes, ${f0(est.watts)} W at ${f0(est.hr)} bpm`;
    if (est.spm) head += `, ${est.spm.toFixed(1)} spm`;
    if (est.drag) head += `, drag ${est.drag}`;
    lines.push(head);
    if (est.error) { lines.push(`   no estimate: ${est.error}`); continue; }
    points.push(est);
    nRows++;
    lines.push(`   watts at ${f0(cfg.zone_hr)} bpm: ${f0(est.watts_at_zone)}   VO2max ~${f0(est.vo2max)} ml/kg/min (${f0(est.watts_at_hrmax)} W at HRmax ${f0(cfg.hrmax)}, line through resting ${f0(cfg.hr_rest)})`);
  }
  const fit = pooled(points, cfg);
  if (fit && nRows + nTests > 1) {   // one step test alone has already given its own line above
    const what = [nRows ? `${nRows} rows` : "", nTests ? `${nStages} stages of ${nTests} step test${nTests > 1 ? "s" : ""}` : ""].filter(Boolean).join(" and ");
    lines.push(`fit across ${what} (${f0(fit.watts_min)}-${f0(fit.watts_max)} W): HR = ${f0(fit.a)} + ${fit.b.toFixed(2)} x W;  watts at ${f0(cfg.zone_hr)} bpm: ${f0(fit.watts_at_zone)};  VO2max ~${f0(fit.vo2max)} ml/kg/min`);
  } else if (!fit && points.length > 1 && nRows + nTests > 1) {
    lines.push(`no fit across rows yet: it needs ${POOL_MIN_ROWS} or more rows whose steady power spans ${POOL_MIN_SPREAD_W} W, or a guided step test, which spans that on its own`);
  }
  for (const note of cfg.notes) lines.push(`note: ${note}`);
  return lines.join("\n");
}
