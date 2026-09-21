// The force-curve maths, shared by the dashboard and the tests: trimming, resampling to 101
// points, the shape measures, the parabola fit, and optional Savitzky-Golay smoothing.

// Concept2 sends one force-curve point per 3.5/3 of an inch of handle travel on the distance
// channel (0x0043), which is 2.96 cm (Ryan Farrell, Concept2, September 2026).
export const CM_PER_POINT = 3.5 / 3 * 2.54;

export function trim(p) { if (!p || p.length < 3) return null; let a = 0, b = p.length - 1; while (a < b && p[a] <= 0) a++; while (b > a && p[b] <= 0) b--; return b - a >= 2 ? p.slice(a, b + 1) : null; }
export function resample(p, n = 101) { const m = p.length; return Array.from({ length: n }, (_, i) => { const x = i * (m - 1) / (n - 1), j = Math.floor(x), f = x - j; return j + 1 < m ? p[j] * (1 - f) + p[j + 1] * f : p[m - 1]; }); }

export function metrics(points) {
  const tp = trim(points); if (!tp) return null;
  const r = resample(tp); const fmax = Math.max(...r), imax = r.indexOf(fmax); const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const a70 = r.findIndex(v => v >= 0.7 * fmax); let j = imax; while (j < 100 && r[j + 1] >= 0.7 * fmax) j++;
  let dips = 0, runMax = 0, inDip = false, lowest = 0; // a "blip": after force passes 50% of peak, it falls >=8% of peak then recovers >=5%
  for (let i = 0; i < r.length; i++) { const v = r[i]; if (v > runMax) { if (inDip && v - lowest >= 0.05 * fmax) { dips++; inDip = false; } runMax = v; }
    if (runMax >= 0.5 * fmax && runMax - v >= 0.08 * fmax && i < imax + 1) { if (!inDip) { inDip = true; lowest = v; } lowest = Math.min(lowest, v); } }
  return { norm: r.map(v => v / fmax), fmax, a100: imax, a70, d70: j - imax, ram: 100 * mean / fmax, dips, r2: parabolaR2(r) };
}
export function parabolaR2(r) { // least-squares y = a x^2 + b x + c on x in [0, 1]; R^2 is RP3's stroke-quality score (1 = a perfect parabola)
  const n = r.length; let sx = 0, sx2 = 0, sx3 = 0, sx4 = 0, sy = 0, sxy = 0, sx2y = 0;
  for (let i = 0; i < n; i++) { const x = i / (n - 1), y = r[i]; sx += x; sx2 += x * x; sx3 += x ** 3; sx4 += x ** 4; sy += y; sxy += x * y; sx2y += x * x * y; }
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const A = [[sx4, sx3, sx2], [sx3, sx2, sx], [sx2, sx, n]], B = [sx2y, sxy, sy], D = det(A); if (!D) return 0;
  const col = (k) => det(A.map((row, i) => row.map((v, j) => j === k ? B[i] : v))) / D; const [a, b, c] = [col(0), col(1), col(2)];
  const mean = sy / n; let ssr = 0, sst = 0;
  for (let i = 0; i < n; i++) { const x = i / (n - 1), f = a * x * x + b * x + c; ssr += (r[i] - f) ** 2; sst += (r[i] - mean) ** 2; }
  return sst ? Math.max(0, 1 - ssr / sst) : 0;
}
/** Savitzky-Golay smoothing, quadratic, over 5 points (about 15 cm of handle travel on the distance
 *  channel). It fits a parabola through each point and its neighbours, so the hump passes through
 *  and point-to-point ripple is averaged out. Tested the way OpenRowingMonitor tests its own filter,
 *  with known curves plus noise like the PM5's (tests/curve.test.js): it removes nearly all false
 *  dips and keeps real ones as well as the raw curve does. A 7-point window lost a fifth of real
 *  dips, so it isn't offered. It does not steady the peak position: on a flat top the highest
 *  point wanders whatever the smoothing. The ends are reflected about the end point, so the rise
 *  and fall keep their slope. */
const SG5 = [-3, 12, 17, 12, -3].map(c => c / 35);
export function savgol(p) {
  if (!p || p.length < 5) return p;
  const n = p.length, at = i => (i < 0 ? 2 * p[0] - p[-i] : i >= n ? 2 * p[n - 1] - p[2 * (n - 1) - i] : p[i]);
  return p.map((_, i) => { let v = 0; for (let k = -2; k <= 2; k++) v += SG5[k + 2] * at(i + k); return Math.max(0, v); });
}
/** The curve to analyse: the raw points, or those smoothed after trimming the zeros at each end. */
export function smoothed(raw, on) {
  if (!on || !raw) return raw;
  const t = trim(raw); return t ? savgol(t) : raw;
}
