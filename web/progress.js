// Progress on a piece rowed again and again (a 5 km, a 30-minute row): each row's result, mean
// watts, time above your heart-rate ceiling, heart-rate drift and watts at the ceiling, and a
// trend fitted to every finished row, with the scatter about it, so that one good day is read as
// one good day. Rows are grouped by the piece set on the monitor.
import { rowPoint, steadyWindow, wattsAt } from "./vo2.js";

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const mmss1 = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const r0 = x => Math.round(x).toString(), r1 = x => x.toFixed(1);
export const MIN_TREND_ROWS = 3;
export const MIN_HR_COVER = 0.8;

/** The piece a row was: the workout it was set for when the row records one ("5000 m, 1000 m
 *  splits", "30:00"), else a distance that finished on a round 100 m, else a time within 5 s of
 *  a whole minute (the monitor adds a short last split to a timed piece). Null for a row that
 *  just stopped somewhere. */
export function pieceOf(sess) {
  const w = String(sess.workout || "").split(",")[0].trim();
  let m = /^(\d+)\s*m$/.exec(w);
  if (m) return { kind: "distance", target: +m[1], name: `${+m[1]} m` };
  m = /^(\d+):(\d\d)$/.exec(w);
  if (m) { const s = +m[1] * 60 + +m[2]; return { kind: "time", target: s, name: mmss(s) }; }
  const sm = sess.summary || {}, d = sm.distance_m, t = sm.elapsed_s;
  if (d >= 1000 && Math.abs(d - Math.round(d / 100) * 100) < 0.5) { const target = Math.round(d / 100) * 100; return { kind: "distance", target, name: `${target} m` }; }
  if (t >= 600 && Math.abs(t - Math.round(t / 60) * 60) <= 5) { const target = Math.round(t / 60) * 60; return { kind: "time", target, name: mmss(target) }; }
  return null;
}

/** One row's measures. ceiling and hr_rest may be null; the measures that need them are then null. */
export function rowMeasures(sess, { ceiling, hr_rest }) {
  const piece = pieceOf(sess), strokes = sess.strokes || [], sm = sess.summary || {}, last = strokes[strokes.length - 1] || {};
  const seconds = sm.elapsed_s ?? last.elapsed_s ?? null, distance = sm.distance_m ?? last.distance_m ?? null;
  const finished = !piece ? false : piece.kind === "distance" ? distance >= piece.target - 1 : seconds >= piece.target - 5;
  const withHr = strokes.filter(s => s.hr), powered = strokes.filter(s => s.power_w);
  let above = null;
  if (ceiling != null && withHr.length) {
    above = 0;
    for (let i = 1; i < strokes.length; i++) if (strokes[i].hr > ceiling) above += strokes[i].elapsed_s - strokes[i - 1].elapsed_s;
  }
  // drift: power per heart rate, first half of the steady part against the second
  const win = steadyWindow(strokes);
  let decoupling = null;
  if (win.length >= 20) {
    const midT = (win[0].elapsed_s + win[win.length - 1].elapsed_s) / 2, halves = [win.filter(s => s.elapsed_s < midT), win.filter(s => s.elapsed_s >= midT)];
    const ef = h => mean(h.map(s => s.power_w)) / mean(h.map(s => s.hr));
    if (halves.every(h => h.length)) decoupling = 100 * (ef(halves[0]) - ef(halves[1])) / ef(halves[0]);
  }
  const point = rowPoint(sess);
  return { started: sess.started, piece, finished, seconds, distance,
    watts: powered.length ? mean(powered.map(s => s.power_w)) : null, hr: withHr.length ? mean(withHr.map(s => s.hr)) : null,
    hr_cover: strokes.length ? withHr.length / strokes.length : 0, above_s: above, decoupling_pct: decoupling,
    watts_at_ceiling: point && ceiling != null && hr_rest != null && point.hr - hr_rest > 15 ? wattsAt(ceiling, point.watts, point.hr, hr_rest) : null,
    drag: sm.drag_factor_avg ?? null };
}

const days = started => { const [d, t] = started.split("_"); return Date.parse(`${d}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`) / 86400000; };

/** Least squares of y on weeks, and the scatter about the line (residual standard error). */
function fit(points) {
  if (points.length < MIN_TREND_ROWS) return null;
  const xs = points.map(p => p.x / 7), ys = points.map(p => p.y), mx = mean(xs), my = mean(ys);
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (sxx === 0) return null;
  const b = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / sxx;
  const ss = xs.reduce((a, x, i) => a + (ys[i] - (my + b * (x - mx))) ** 2, 0);
  return { n: points.length, per_week: b, scatter: Math.sqrt(ss / (points.length - 2)) };
}

/** sessions -> {groups: [{name, kind, target, rows, trend, watts_trend}], skipped, ceiling}. */
export function progress(sessions, { ceiling = null, hr_rest = null } = {}) {
  const rows = sessions.map(s => rowMeasures(s, { ceiling, hr_rest })), groups = new Map();
  for (const r of rows.filter(r => r.piece)) {
    if (!groups.has(r.piece.name)) groups.set(r.piece.name, { ...r.piece, rows: [] });
    groups.get(r.piece.name).rows.push(r);
  }
  const out = [...groups.values()].map(g => {
    g.rows.sort((a, b) => a.started.localeCompare(b.started));
    const done = g.rows.filter(r => r.finished);
    g.trend = fit(done.map(r => ({ x: days(r.started), y: g.kind === "distance" ? r.seconds : r.distance })));
    g.watts_trend = fit(done.filter(r => r.watts_at_ceiling != null).map(r => ({ x: days(r.started), y: r.watts_at_ceiling })));
    return g;
  }).sort((a, b) => b.rows.length - a.rows.length);
  return { groups: out, skipped: rows.filter(r => !r.piece).length, ceiling };
}

export function progressReport(p) {
  if (!p.groups.length) return "No piece has been rowed yet that the report can recognise: set a distance or a time on the monitor, and row it again to compare.";
  const L = [];
  if (p.ceiling == null) L.push("Set your zone ceiling in the fitness settings to see the time spent above it and the watts you hold at it.");
  for (const g of p.groups) {
    L.push(`${g.name}, ${g.rows.length} row${g.rows.length === 1 ? "" : "s"}${p.ceiling != null ? ` (ceiling ${p.ceiling} bpm)` : ""}:`);
    for (const r of g.rows) {
      const bits = [r.started.slice(0, 10), g.kind === "distance" ? mmss1(r.seconds) : `${r0(r.distance)} m`];
      if (r.watts != null) bits.push(`${r0(r.watts)} W`);
      if (r.hr != null) bits.push(`${r0(r.hr)} bpm`);
      if (r.above_s != null) bits.push(`above ceiling ${mmss(r.above_s)}`);
      if (r.decoupling_pct != null) bits.push(`drift ${r1(r.decoupling_pct)}%`);
      if (r.watts_at_ceiling != null) bits.push(`${r0(r.watts_at_ceiling)} W at ${p.ceiling}`);
      if (r.drag != null) bits.push(`drag ${r.drag}`);
      if (r.hr != null && r.hr_cover < MIN_HR_COVER) bits.push(`(heart rate on ${r0(100 * r.hr_cover)}% of strokes)`);
      if (!r.finished) bits.push(`(ended at ${g.kind === "distance" ? `${r0(r.distance)} m of ${g.name}` : `${mmss(r.seconds)} of ${g.name}`}: left out of the trend)`);
      L.push("  " + bits.join("  "));
    }
    const t = g.trend;
    if (t) {
      const v = t.per_week, better = g.kind === "distance" ? v < 0 : v > 0;
      const size = g.kind === "distance" ? `${r1(Math.abs(v))} s ${better ? "faster" : "slower"}` : `${r0(Math.abs(v))} m ${better ? "further" : "shorter"}`;
      const sc = g.kind === "distance" ? `${r1(t.scatter)} s` : `${r0(t.scatter)} m`;
      L.push(`  ${g.kind === "distance" ? "Time" : "Distance"}: ${size} a week over ${t.n} finished rows (a straight line through all of them); rows scatter about ±${sc} around that line.`);
    } else L.push(`  A trend needs ${MIN_TREND_ROWS} finished rows of this piece.`);
    if (g.watts_trend) L.push(`  Watts at ${p.ceiling} bpm: ${g.watts_trend.per_week >= 0 ? "+" : "-"}${r1(Math.abs(g.watts_trend.per_week))} W a week; scatter ±${r1(g.watts_trend.scatter)} W.`);
  }
  if (p.skipped) L.push(`${p.skipped} row${p.skipped === 1 ? " was" : "s were"} not a set piece (a Just Row stopped at no round number) and ${p.skipped === 1 ? "is" : "are"} left out.`);
  return L.join("\n");
}
