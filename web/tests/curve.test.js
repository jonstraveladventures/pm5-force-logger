// Smoothing tested the way OpenRowingMonitor tests its filter: known curves plus noise, and a
// check that what should survive does. The curves are shaped like a PM5 force-against-distance
// stroke: about 45 points, a quick catch, a long flat top, a falling finish.
import { test } from "node:test";
import assert from "node:assert/strict";
import { savgol, smoothed, metrics, trim } from "../curve.js";

function prng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = r => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

/** A flat-topped stroke of n points peaking near 110 lbf; optionally a dip on the rise. */
function stroke(n = 45, { dipAt = null, dipDepth = 0, dipWidth = 2, noise = 0, seed = 1 } = {}) {
  const r = prng(seed), out = [];
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    let f = 110 * Math.min(1, x / 0.12) * (x < 0.7 ? 1 : Math.max(0, 1 - (x - 0.7) / 0.3) ** 1.3);
    if (dipAt != null) f -= dipDepth * 110 * Math.exp(-((((x - dipAt) * n) / dipWidth) ** 2));
    out.push(Math.max(0, Math.round(f + noise * 110 * gauss(r))));
  }
  return [0, ...out.map(v => v || 1), 0];
}
const sd = a => { const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };

test("smoothing leaves a parabola exactly as it was, away from the ends", () => {
  const p = Array.from({ length: 30 }, (_, i) => 50 + 3 * i - 0.1 * i * i);
  const q = savgol(p);
  for (let i = 2; i < 28; i++) assert.ok(Math.abs(q[i] - p[i]) < 1e-9, `point ${i}`);
});

test("with smoothing off, the curve is untouched", () => {
  const p = stroke(45, { noise: 0.025 });
  assert.equal(smoothed(p, false), p);
  assert.equal(smoothed(null, true), null);
});

test("with noise like the PM5's, smoothing removes nearly all false dips and keeps the real ones", () => {
  let rawFalse = 0, smFalse = 0, rawReal = 0, smReal = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const clean = stroke(45, { noise: 0.025, seed });
    const dipped = stroke(45, { dipAt: 0.3, dipDepth: 0.15, dipWidth: 3, noise: 0.025, seed });
    rawFalse += metrics(clean).dips > 0; smFalse += metrics(smoothed(clean, true)).dips > 0;
    rawReal += metrics(dipped).dips > 0; smReal += metrics(smoothed(dipped, true)).dips > 0;
  }
  assert.ok(smFalse <= rawFalse * 0.2, `false dips: raw ${rawFalse}/400, smoothed ${smFalse}/400`);
  assert.ok(smReal >= rawReal * 0.97, `real dips found: raw ${rawReal}/400, smoothed ${smReal}/400`);
});

test("smoothing keeps the stroke's length, so the handle-travel axis is unchanged", () => {
  const p = stroke(45, { noise: 0.025 });
  assert.equal(smoothed(p, true).length, trim(p).length);
});
