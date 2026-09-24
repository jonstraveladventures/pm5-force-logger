// The progress report on a repeated piece, from synthetic rows whose answers are known.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pieceOf, rowMeasures, progress, progressReport } from "../progress.js";

/** A steady row: a stroke every 4 s at `watts`, heart rate `hr(t)`, ending at `seconds`. */
function row({ started, seconds, distance, watts = 150, hr = () => 140, workout, drag = 115 }) {
  const strokes = [];
  for (let t = 4, n = 1; t <= seconds; t += 4, n++) strokes.push({ stroke_count: n, elapsed_s: t, distance_m: distance * t / seconds, power_w: watts, hr: hr(t), spm: 15 });
  return { started, workout, strokes, summary: { distance_m: distance, elapsed_s: seconds, drag_factor_avg: drag } };
}
const week = n => `2026-09-${String(1 + 7 * n).padStart(2, "0")}_180000`;

test("a row's piece comes from the workout it was set for, else from a round finish", () => {
  assert.deepEqual(pieceOf(row({ started: week(0), seconds: 1300, distance: 5000, workout: "5000 m, 1000 m splits" })), { kind: "distance", target: 5000, name: "5000 m" });
  assert.deepEqual(pieceOf(row({ started: week(0), seconds: 1300, distance: 5000 })), { kind: "distance", target: 5000, name: "5000 m" });
  assert.deepEqual(pieceOf(row({ started: week(0), seconds: 1626.4, distance: 5988, workout: "30:00, 5:00 splits" })), { kind: "time", target: 1800, name: "30:00" });
  assert.deepEqual(pieceOf(row({ started: week(0), seconds: 1803.7, distance: 6846 })), { kind: "time", target: 1800, name: "30:00" }, "the monitor's short last split");
  assert.equal(pieceOf(row({ started: week(0), seconds: 433, distance: 1234 })), null, "a Just Row that stopped anywhere");
});

test("time above the ceiling, and heart-rate drift over the steady part", () => {
  // 1300 s at 150 W; heart rate 150 from minute 15 on, 140 before
  const m = rowMeasures(row({ started: week(0), seconds: 1300, distance: 5000, hr: t => (t > 900 ? 150 : 140) }), { ceiling: 148, hr_rest: 50 });
  assert.equal(m.above_s, 400);
  assert.ok(m.decoupling_pct > 3, `decoupling ${m.decoupling_pct}`);
  const flat = rowMeasures(row({ started: week(0), seconds: 1300, distance: 5000 }), { ceiling: 148, hr_rest: 50 });
  assert.equal(flat.above_s, 0);
  assert.ok(Math.abs(flat.decoupling_pct) < 1e-9);
  assert.equal(flat.watts, 150);
  assert.ok(Math.abs(flat.watts_at_ceiling - 150 * (148 - 50) / (140 - 50)) < 1e-9);
  assert.equal(flat.finished, true);
});

test("the trend is fitted to every finished row, and the scatter about it is shown", () => {
  const rows = [1300, 1296, 1280, 1284].map((s, i) => row({ started: week(i), seconds: s, distance: 5000, workout: "5000 m" }));
  const p = progress(rows, { ceiling: 148, hr_rest: 50 }), g = p.groups[0];
  assert.equal(g.name, "5000 m");
  assert.equal(g.rows.length, 4);
  assert.ok(Math.abs(g.trend.per_week - -6.4) < 1e-9, `slope ${g.trend.per_week}`);   // least squares through 1300, 1296, 1280, 1284
  assert.ok(g.trend.scatter > 3 && g.trend.scatter < 6, `scatter ${g.trend.scatter}`);
  const text = progressReport(p);
  assert.match(text, /5000 m, 4 rows/);
  assert.match(text, /6\.4 s faster a week/);
  assert.match(text, /scatter/);
  assert.doesNotMatch(text, /NaN|undefined|null/);
});

test("a row that stopped short of its piece is listed but kept out of the trend", () => {
  const rows = [row({ started: week(0), seconds: 1800, distance: 6800, workout: "30:00" }), row({ started: week(1), seconds: 1626.4, distance: 5988, workout: "30:00" }),
    row({ started: week(2), seconds: 1800, distance: 6850, workout: "30:00" }), row({ started: week(3), seconds: 1800, distance: 6900, workout: "30:00" })];
  const g = progress(rows, { ceiling: 148, hr_rest: 50 }).groups[0];
  assert.equal(g.rows.length, 4);
  assert.equal(g.trend.n, 3);
  assert.ok(g.trend.per_week > 0, "metres a week, rising");
  assert.match(progressReport(progress(rows, { ceiling: 148, hr_rest: 50 })), /ended at 27:06 of 30:00/);
});

test("without a ceiling the report says how to set one, and still gives times and watts", () => {
  const rows = [0, 1].map(i => row({ started: week(i), seconds: 1300 - i, distance: 5000 }));
  const text = progressReport(progress(rows, { ceiling: null, hr_rest: null }));
  assert.match(text, /set your zone ceiling/i);
  assert.match(text, /150 W/);
  assert.doesNotMatch(text, /above ceiling|W at|NaN|undefined|null/, "no figures that need a ceiling");
});

test("a piece rowed once has no trend yet, and rows with no piece are left out", () => {
  const p = progress([row({ started: week(0), seconds: 1300, distance: 5000 }), row({ started: week(1), seconds: 433, distance: 1234 })], { ceiling: 148, hr_rest: 50 });
  assert.equal(p.groups.length, 1);
  assert.equal(p.groups[0].trend, null);
  assert.equal(p.skipped, 1);
});
