// The live dashboard: tiles, the force curve with its shape measures, trends and the stroke
// table. The same code as pm5_dashboard.html (served by the Python logger), fed here by the
// page itself through H (the event handlers) instead of server-sent events.
export const S = { strokes: new Map(), status: {}, summary: {}, device: {} };
const $ = id => document.getElementById(id);

const TARGETS = {  // Kleshnev (2011), Biomechanics of Rowing, via biomex.studio; on-water gate force, so guides not rules
  a100: { lo: 0, hi: 40, label: "≤40%" }, a70: { lo: 0, hi: 17, label: "≤17%" },
  d70: { lo: 28, hi: 40, label: "28–40%" }, ram: { lo: 38, hi: 64, label: "38–64%" }, dips: { lo: 0, hi: 0, label: "none" },
};
// Reference shape built to meet those targets: peak position 33%, catch gradient 13%, finish plateau 33%, rectangle index 61%. A template, not a measured curve.
const KLESHNEV_PTS = [[0, 0], [.06, .4], [.18, .85], [.36, 1], [.66, .72], [.8, .25], [.92, .1], [1, 0]];
// The other school: RP3 Rowing's rounded "Schubschlag" curve, peak just before the oar is square (their training guide v1.2,
// 2025, and force-curve white paper v1.3, 2023). Only the peak position has a number; the rest is "full and smooth", which
// their portal scores as the fit to a parabola. Their peak band is from a dynamic erg, so a guide here too.
const RP3 = { a100: { lo: 40, hi: 50, label: "40–50% (RP3: ideal 43–48%)" }, a70: null, d70: null, ram: null, dips: { lo: 0, hi: 0, label: "none" } };
const SCHOOLS = { kleshnev: TARGETS, rp3: RP3 };
// RP3's guideline bands (training guide v1.2, appendix), restated. Their erg is dynamic and its force is not the PM5's handle
// force, so this places a number roughly; it is not a ranking. Drive length is for a rower of average height.
const BANDS = {
  men: { work: [[350, "club"], [500, "intermediate"], [650, "elite"]], peak_n: [[250, "club"], [330, "intermediate"], [460, "elite"]],
         drive: [[1.30, "beginner"], [1.35, "intermediate"], [1.40, "expert"]], height: "1.75–1.85 m" },
  women: { work: [[300, "club"], [400, "intermediate"], [480, "elite"]], peak_n: [[200, "club"], [250, "intermediate"], [350, "elite"]],
           drive: [[1.20, "beginner"], [1.25, "intermediate"], [1.35, "expert"]], height: "1.65–1.75 m" },
};
function bandOf(v, list) { let name = "below " + list[0][1]; for (const [lo, label] of list) if (v >= lo) name = label; return name; }
const bandText = list => list.map(([lo, l]) => `${l} ${lo}+`).join(", ");
// Body mass, shared with the fitness settings (localStorage pm5_fitness.PM5_MASS_KG): per-kilogram work and force
// compare rowers of different sizes without inventing weight bands.
function massKg() { try { const v = parseFloat((JSON.parse(localStorage.getItem("pm5_fitness")) || {}).PM5_MASS_KG); return v > 0 ? v : null; } catch { return null; } }
function setMassKg(v) { try { const f = JSON.parse(localStorage.getItem("pm5_fitness")) || {}; if (v > 0) f.PM5_MASS_KG = String(v); else delete f.PM5_MASS_KG; localStorage.setItem("pm5_fitness", JSON.stringify(f)); } catch {} }
const RP3_SHAPE = Array.from({ length: 101 }, (_, i) => { const x = i / 100, p = 0.45; return x < p ? 1 - ((p - x) / p) ** 2 : 1 - ((x - p) / (1 - p)) ** 2; });

// ---------- curve maths ----------
export function trim(p) { if (!p || p.length < 3) return null; let a = 0, b = p.length - 1; while (a < b && p[a] <= 0) a++; while (b > a && p[b] <= 0) b--; return b - a >= 2 ? p.slice(a, b + 1) : null; }
export function resample(p, n = 101) { const m = p.length; return Array.from({ length: n }, (_, i) => { const x = i * (m - 1) / (n - 1), j = Math.floor(x), f = x - j; return j + 1 < m ? p[j] * (1 - f) + p[j + 1] * f : p[m - 1]; }); }
function fromControl(pts, n = 101) { // monotone-ish piecewise cubic (Catmull-Rom, clamped)
  const out = []; for (let i = 0; i < n; i++) { const x = i / (n - 1); let k = 0; while (k < pts.length - 2 && x > pts[k + 1][0]) k++;
    const p0 = pts[Math.max(0, k - 1)], p1 = pts[k], p2 = pts[k + 1], p3 = pts[Math.min(pts.length - 1, k + 2)]; const t = (x - p1[0]) / (p2[0] - p1[0] || 1);
    const t2 = t * t, t3 = t2 * t; const y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
    out.push(Math.max(0, y)); } return out; }
export function metrics(points) {
  const tp = trim(points); if (!tp) return null;
  const r = resample(tp); const fmax = Math.max(...r), imax = r.indexOf(fmax); const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const a70 = r.findIndex(v => v >= 0.7 * fmax); let j = imax; while (j < 100 && r[j + 1] >= 0.7 * fmax) j++;
  let dips = 0, runMax = 0, inDip = false, lowest = 0; // a "blip": after force passes 50% of peak, it falls >=8% of peak then recovers >=5%
  for (let i = 0; i < r.length; i++) { const v = r[i]; if (v > runMax) { if (inDip && v - lowest >= 0.05 * fmax) { dips++; inDip = false; } runMax = v; }
    if (runMax >= 0.5 * fmax && runMax - v >= 0.08 * fmax && i < imax + 1) { if (!inDip) { inDip = true; lowest = v; } lowest = Math.min(lowest, v); } }
  return { norm: r.map(v => v / fmax), fmax, a100: imax, a70, d70: j - imax, ram: 100 * mean / fmax, dips, r2: parabolaR2(r) };
}
function parabolaR2(r) { // least-squares y = a x^2 + b x + c on x in [0, 1]; R^2 is RP3's stroke-quality score (1 = a perfect parabola)
  const n = r.length; let sx = 0, sx2 = 0, sx3 = 0, sx4 = 0, sy = 0, sxy = 0, sx2y = 0;
  for (let i = 0; i < n; i++) { const x = i / (n - 1), y = r[i]; sx += x; sx2 += x * x; sx3 += x ** 3; sx4 += x ** 4; sy += y; sxy += x * y; sx2y += x * x * y; }
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const A = [[sx4, sx3, sx2], [sx3, sx2, sx], [sx2, sx, n]], B = [sx2y, sxy, sy], D = det(A); if (!D) return 0;
  const col = (k) => det(A.map((row, i) => row.map((v, j) => j === k ? B[i] : v))) / D; const [a, b, c] = [col(0), col(1), col(2)];
  const mean = sy / n; let ssr = 0, sst = 0;
  for (let i = 0; i < n; i++) { const x = i / (n - 1), f = a * x * x + b * x + c; ssr += (r[i] - f) ** 2; sst += (r[i] - mean) ** 2; }
  return sst ? Math.max(0, 1 - ssr / sst) : 0;
}
function rmsePct(a, b) { if (!a || !b) return null; let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return 100 * Math.sqrt(s / a.length); }
function meanCurve(list) { const c = list.filter(Boolean); if (!c.length) return null; const m = c[0].map((_, i) => c.reduce((s, x) => s + x[i], 0) / c.length); const mx = Math.max(...m); return m.map(v => v / mx); }

// ---------- formatting ----------
const fmtPace = s => !s ? "—" : `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
export const fmtTime = s => s == null ? "—" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const n0 = v => v == null || Number.isNaN(v) ? "—" : Math.round(v).toString();
const n1 = v => v == null || Number.isNaN(v) ? "—" : v.toFixed(1);
const n2 = v => v == null || Number.isNaN(v) ? "—" : v.toFixed(2);

// ---------- tiles ----------
const TILE_DEFS = [
  ["time", "Time"], ["dist", "Distance"], ["pace", "Pace /500m"], ["rate", "Rate"], ["power", "Power"], ["hr", "Heart rate"],
  ["peak", "Peak force"], ["drive", "Drive"], ["ratio", "Drive : recovery"], ["stroke", "Per stroke"], ["drag", "Drag factor"], ["cal", "Calories"],
];
$("tiles").innerHTML = TILE_DEFS.map(([k, l]) => `<div class="tile"><div class="label">${l}</div><div class="value" id="v_${k}">—</div><div class="sub" id="s_${k}"></div></div>`).join("");
const setTile = (k, v, sub = "") => { $("v_" + k).textContent = v; $("s_" + k).textContent = sub; };
function renderTiles() {
  const st = S.status, last = lastStroke();
  const target = st.workout_type != null && st.workout_type > 1;  // projections mean nothing on a Just Row (types 0, 1)
  setTile("time", fmtTime(st.elapsed_s), target && st.projected_time_s ? `projected ${fmtTime(st.projected_time_s)}` : "");
  setTile("dist", st.distance_m != null ? `${Math.round(st.distance_m)} m` : "—", target && st.projected_distance_m ? `projected ${st.projected_distance_m} m` : "");
  setTile("pace", fmtPace(st.pace_s), st.avg_pace_s ? `average ${fmtPace(st.avg_pace_s)}` : "");
  setTile("rate", n0(st.stroke_rate), "strokes/min");
  setTile("power", last && last.power_w != null ? `${last.power_w} W` : "—", st.avg_power_w ? `average ${st.avg_power_w} W` : "");
  setTile("hr", st.hr ? n0(st.hr) : "—", st.hr ? "bpm" : "no HR source paired");
  setTile("peak", last ? `${n0(last.peak_force_lbf)}` : "—", last ? `lbf · average ${n0(last.avg_force_lbf)}` : "");
  setTile("drive", last ? `${n2(last.drive_length_m)} m` : "—", last ? `${n2(last.drive_time_s)} s` : "");
  const prev = S.strokes.get(last && last.stroke_count - 1); const rec = last && (last.recovery_time_s ?? (prev && prev.recovery_time_s));
  setTile("ratio", last && rec ? `1 : ${n1(rec / last.drive_time_s)}` : "—", "target about 1 : 2");
  setTile("stroke", last ? `${n1(last.stroke_distance_m)} m` : "—", last ? `work ${n0(last.work_j)} J` : "");
  setTile("drag", n0(st.drag_factor), S.summary.drag_factor_avg ? `session ${S.summary.drag_factor_avg}` : "");
  setTile("cal", n0(st.calories_total), "kcal");
}

// ---------- charts ----------
function setupCanvas(c) { const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight; if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; } const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h); return [g, w, h]; }
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const canvasFont = () => `${Math.round(11 * (parseFloat(css("--text")) || 1))}px -apple-system, sans-serif`;
const src = () => $("src").value;
const refKey = () => $("refsel").value;
const KLESHNEV = fromControl(KLESHNEV_PTS);
function reference() { if (refKey() === "mine") { try { return JSON.parse(localStorage.getItem("pm5_my_reference")); } catch { return null; } } return refKey() === "rp3" ? RP3_SHAPE : KLESHNEV; }
const school = () => SCHOOLS[$("school").value] || TARGETS;
const bands = () => BANDS[$("bands").value] || null;
function rememberChoices() { try { localStorage.setItem("pm5_choices", JSON.stringify({ ref: refKey(), school: $("school").value, bands: $("bands").value })); } catch {} }
(function restoreChoices() { try { const c = JSON.parse(localStorage.getItem("pm5_choices")) || {}; for (const [id, k] of [["refsel", "ref"], ["school", "school"], ["bands", "bands"]]) if (c[k]) $(id).value = c[k]; } catch {} })();
const strokesWithCurves = () => [...S.strokes.values()].filter(s => trim(s[src()])).sort((a, b) => a.stroke_count - b.stroke_count);
const lastStroke = () => { const all = [...S.strokes.values()]; return all.length ? all.reduce((a, b) => b.stroke_count > a.stroke_count ? b : a) : null; };

let hoverX = null;
function drawCurve() {
  const c = $("curve"); const [g, w, h] = setupCanvas(c);
  const pad = { l: 44, r: 16, t: 10, b: 44 }, pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const list = strokesWithCurves(); const cur = list[list.length - 1];
  const recent = list.slice(-9, -1);
  const series = list.map(s => metrics(s[src()])).filter(Boolean);
  const avg = meanCurve(series.map(m => m.norm));
  const ymax = Math.max(40, ...list.slice(-9).map(s => Math.max(...trim(s[src()])))) * 1.1;
  g.strokeStyle = css("--grid"); g.lineWidth = 1; g.fillStyle = css("--ink3"); g.font = canvasFont();
  for (let f = 0; f <= ymax; f += ymax > 150 ? 50 : 25) { const y = pad.t + ph - f / ymax * ph; g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke(); g.fillText(`${f}`, 8, y + 4); }
  g.textAlign = "center";
  for (let p = 0; p <= 100; p += 20) g.fillText(`${p}%`, pad.l + p / 100 * pw, pad.t + ph + 16);
  g.fillText("drive, from first force to release (normalised)", pad.l + pw / 2, h - 6);
  g.save(); g.translate(12, pad.t + ph / 2); g.rotate(-Math.PI / 2); g.fillText("force (lbf)", 0, 0); g.restore();
  g.textAlign = "left";
  const X = i => pad.l + i / 100 * pw, Y = f => pad.t + ph - f / ymax * ph;
  const line = (arr, color, width, dash = [], scale = 1) => { if (!arr) return; g.setLineDash(dash); g.strokeStyle = color; g.lineWidth = width; g.beginPath(); arr.forEach((v, i) => i ? g.lineTo(X(i), Y(v * scale)) : g.moveTo(X(i), Y(v * scale))); g.stroke(); g.setLineDash([]); };
  recent.forEach(s => line(resample(trim(s[src()])), "rgba(57,135,229,.28)", 1.5));
  const curM = cur ? metrics(cur[src()]) : null; const scale = curM ? curM.fmax : (series.length ? series[series.length - 1].fmax : 1);
  line(reference(), css("--s2"), 2, [6, 5], scale);            // shapes scaled to this stroke's peak, so shape is what differs
  line(avg, css("--s3"), 2, [], scale);
  if (cur) line(resample(trim(cur[src()])), css("--s1"), 3);
  if (curM) { g.fillStyle = css("--s1"); g.beginPath(); g.arc(X(curM.a100), Y(curM.fmax), 4, 0, 7); g.fill(); }
  if (hoverX != null && cur) { const i = Math.round(Math.max(0, Math.min(100, (hoverX - pad.l) / pw * 100))); g.strokeStyle = css("--ink3"); g.beginPath(); g.moveTo(X(i), pad.t); g.lineTo(X(i), pad.t + ph); g.stroke();
    const r = resample(trim(cur[src()])); const ref = reference();
    $("hover").textContent = `${i}% of drive · this stroke ${n0(r[i])} lbf · average ${avg ? n0(avg[i] * scale) : "—"} · reference ${ref ? n0(ref[i] * scale) : "—"}`; }
  else $("hover").textContent = cur ? `stroke ${cur.stroke_count}: hover the chart to read values` : "waiting for the first stroke…";
}
$("curve").addEventListener("mousemove", e => { hoverX = e.offsetX; drawCurve(); });
$("curve").addEventListener("mouseleave", () => { hoverX = null; drawCurve(); });

function renderMetrics() {
  const list = strokesWithCurves(); const cur = list[list.length - 1]; const el = $("metrics");
  if (!cur) { el.innerHTML = `<div class="note">Force-curve metrics appear after the first stroke.</div>`; return; }
  const m = metrics(cur[src()]); const series = list.map(s => metrics(s[src()])).filter(Boolean); const avg = meanCurve(series.map(x => x.norm));
  const ref = reference(), T = school(), B = bands(); const inRange = (v, t) => v >= t.lo && v <= t.hi;
  const flag = (v, t, lowWord, highWord) => !t ? "" : inRange(v, t) ? `<span class="flag ok">✓ in range</span>` : `<span class="flag off">▲ ${v > t.hi ? highWord : lowWord}</span>`;
  const label = t => t ? t.label : "no target in this school";
  const peakN = cur.peak_force_lbf ? cur.peak_force_lbf * 4.448 : null, mass = massKg();
  const bandRow = (name, value, unit, key, note) => B && value != null ? [[name, `${unit === "m" ? n2(value) : n0(value)} ${unit}`, `RP3 ${$("bands").value}: ${bandText(B[key])}`, `<span class="flag">${bandOf(value, B[key])}</span>`, note]] : [];
  const rows = [
    ["Peak position", `${m.a100}%`, label(T.a100), flag(m.a100, T.a100, "early", "late"), "Where in the drive force peaks. Kleshnev's crews peak early (legs); RP3's rounded stroke peaks just before the oar is square, around 43–48%. Later than 55% points to the back taking over from the legs."],
    ["Catch gradient", `${m.a70}%`, label(T.a70), flag(m.a70, T.a70, "", "slow"), "How far into the drive before force reaches 70% of peak: how quickly the legs load."],
    ["Finish plateau", `${m.d70}%`, label(T.d70), flag(m.d70, T.d70, "short", "long"), "How long force stays above 70% of peak after the peak: the back and arms carrying it on."],
    ["Rectangle index", `${n0(m.ram)}%`, label(T.ram), flag(m.ram, T.ram, "peaky", "flat"), "Average force as a share of peak. Higher is a fuller curve; a parabola scores 67%."],
    ["Parabola fit", `${n0(100 * m.r2)}%`, "higher = rounder", "", "How closely the curve follows a parabola, RP3's stroke-quality score. Effective work per stroke is work × this."],
    ["Blips", `${m.dips}`, label(T.dips), m.dips ? `<span class="flag off">▲ dip in the rise</span>` : `<span class="flag ok">✓ smooth</span>`, "A dip on the way up, usually the handover from legs to back."],
    ["Shape vs reference", ref ? `${n1(rmsePct(m.norm, ref))}%` : "—", "lower = closer", "", "Typical gap between this stroke's shape and the reference, as % of peak (both scaled to the same peak)."],
    ["Stroke-to-stroke", avg && series.length > 1 ? `${n1(rmsePct(m.norm, avg))}%` : "—", "lower = steadier", "", "Gap between this stroke's shape and your session average."],
    ...bandRow("Work per stroke", cur.work_j, "J", "work", `Energy into the flywheel this stroke${cur.work_j ? `; × parabola fit = ${n0(cur.work_j * m.r2)} J effective (RP3)` : ""}. RP3's bands come from a dynamic erg, so a rough placement, not a ranking.`),
    ...bandRow("Peak force", peakN, "N", "peak_n", "Peak handle force in newtons. RP3's bands are not from PM5 handle force, so treat the placement loosely."),
    ...bandRow("Drive length", cur.drive_length_m, "m", "drive", `RP3's bands for a rower of ${B ? B.height : ""}; taller rowers row longer.`),
    ...(mass && cur.work_j ? [["Work per kg", `${n1(cur.work_j / mass)} J/kg`, "higher = more work for your size", "", `Work per stroke divided by your body mass (${mass} kg): the fairer comparison between rowers of different sizes.`]] : []),
    ...(mass && peakN ? [["Peak force per kg", `${n2(peakN / mass)} N/kg`, "for your size", "", `Peak handle force divided by your body mass (${mass} kg).`]] : []),
    ...(!mass ? [["Per kilogram", "—", "enter your mass (kg) above", "", "With your body mass, work and peak force are also shown per kilogram, which compares rowers of different sizes without weight classes."]] : []),
  ];
  el.innerHTML = rows.map(([k, v, t, f, note]) => `<div>${k}<div class="t">target ${t} ${f}</div></div><div></div><div class="v">${v}</div><div class="note">${note}</div>`).join("");
  $("shapeTitle").textContent = `Curve shape, stroke ${cur.stroke_count}`;
}

const TRENDS = [
  ["Peak force (lbf)", s => s.peak_force_lbf, null],
  ["Peak position (% of drive)", s => metrics(s[src()])?.a100, () => school().a100],
  ["Rectangle index (%)", s => metrics(s[src()])?.ram, () => school().ram],
  ["Drive length (m)", s => s.drive_length_m, null],
  ["Power (W)", s => s.power_w, null],
];
$("trends").innerHTML = TRENDS.map((t, i) => `<div class="panel"><h2>${t[0]}${t[2] ? ` <span style="font-weight:400;color:var(--ink3)">· shaded: target</span>` : ""}</h2><canvas id="tr${i}"></canvas></div>`).join("");
function drawTrends() {
  const list = [...S.strokes.values()].sort((a, b) => a.stroke_count - b.stroke_count);
  TRENDS.forEach(([name, fn, bandFn], i) => { const band = bandFn ? bandFn() : null;
    const c = $("tr" + i); const [g, w, h] = setupCanvas(c); const pad = { l: 34, r: 8, t: 6, b: 18 };
    const pts = list.map(s => [s.stroke_count, fn(s)]).filter(p => p[1] != null && !Number.isNaN(p[1]));
    g.fillStyle = css("--ink3"); g.font = canvasFont();
    if (!pts.length) { g.fillText("no strokes yet", pad.l, h / 2); return; }
    let lo = Math.min(...pts.map(p => p[1])), hi = Math.max(...pts.map(p => p[1])); if (band) { lo = Math.min(lo, band.lo); hi = Math.max(hi, band.hi); }
    const span = hi - lo || 1; const floor0 = lo >= 0; lo -= span * .1; hi += span * .1; if (floor0) lo = Math.max(0, lo);
    const fmt = v => span < 5 ? v.toFixed(2) : span < 50 ? v.toFixed(1) : Math.round(v).toString();
    const x0 = pts[0][0], x1 = Math.max(pts[pts.length - 1][0], x0 + 1);
    const X = n => pad.l + (n - x0) / (x1 - x0) * (w - pad.l - pad.r), Y = v => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
    if (band) { g.fillStyle = "rgba(58,166,85,.12)"; g.fillRect(pad.l, Y(band.hi), w - pad.l - pad.r, Y(band.lo) - Y(band.hi)); }
    g.strokeStyle = css("--grid"); g.beginPath(); g.moveTo(pad.l, h - pad.b); g.lineTo(w - pad.r, h - pad.b); g.stroke();
    g.fillStyle = css("--ink3"); g.fillText(fmt(hi), 2, pad.t + 9); g.fillText(fmt(lo), 2, h - pad.b); g.fillText(`stroke ${x0}`, pad.l, h - 4); g.fillText(`${x1}`, w - pad.r - 16, h - 4);
    g.strokeStyle = css("--s1"); g.lineWidth = 2; g.beginPath(); pts.forEach(([n, v], k) => k ? g.lineTo(X(n), Y(v)) : g.moveTo(X(n), Y(v))); g.stroke();
    const [ln, lv] = pts[pts.length - 1]; g.fillStyle = css("--s1"); g.beginPath(); g.arc(X(ln), Y(lv), 3.5, 0, 7); g.fill();
    g.fillStyle = css("--ink"); g.fillText(fmt(lv), Math.min(X(ln) + 6, w - 34), Math.max(12, Y(lv) - 6));
  });
}

function renderTable() {
  const list = [...S.strokes.values()].sort((a, b) => b.stroke_count - a.stroke_count).slice(0, 12);
  document.querySelector("#table tbody").innerHTML = list.map(s => { const m = metrics(s[src()]); const ratio = s.recovery_time_s && s.drive_time_s ? `1:${n1(s.recovery_time_s / s.drive_time_s)}` : "—";
    return `<tr><td>${s.stroke_count}</td><td>${n2(s.drive_length_m)}</td><td>${n2(s.drive_time_s)}</td><td>${n2(s.recovery_time_s)}</td><td>${ratio}</td><td>${n2(s.stroke_distance_m)}</td><td>${n0(s.peak_force_lbf)}</td><td>${n0(s.avg_force_lbf)}</td><td>${n0(s.work_j)}</td><td>${n0(s.power_w)}</td><td>${m ? m.a100 + "%" : "—"}</td><td>${m ? n0(m.ram) + "%" : "—"}</td><td>${s.hr ? s.hr : "—"}</td></tr>`; }).join("");
}

let pending = false;
export function render() { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; renderTiles(); drawCurve(); renderMetrics(); drawTrends(); renderTable(); }); }
window.addEventListener("resize", render);

// ---------- display sliders: text size, curve height and width; remembered per browser ----------
const UI = { text: ["--text", 1, v => `${Math.round(v * 100)}%`, v => v],
             h: ["--curve-h", 270, v => `${v} px`, v => `${v}px`],
             w: ["--curve-w", 56, v => `${v}%`, v => `${v}%`] };
function loadUI() { try { return JSON.parse(localStorage.getItem("pm5_display")) || {}; } catch { return {}; } }
function applyUI(save = true) {
  const cur = {};
  for (const [k, [prop, , show, cssv]] of Object.entries(UI)) {
    const el = $("ui_" + k); const v = parseFloat(el.value); cur[k] = v;
    document.documentElement.style.setProperty(prop, cssv(v)); $(`ui_${k}_v`).textContent = show(v);
  }
  if (save) { try { localStorage.setItem("pm5_display", JSON.stringify(cur)); } catch { /* private mode */ } }
  render();
}
(function initUI() {
  const saved = loadUI();
  for (const [k, [, dflt]] of Object.entries(UI)) { const el = $("ui_" + k); el.value = saved[k] ?? dflt; el.addEventListener("input", () => applyUI()); }
  $("ui_reset").addEventListener("click", () => { for (const [k, [, dflt]] of Object.entries(UI)) $("ui_" + k).value = dflt; applyUI(); });
  applyUI(false);
})();
$("src").addEventListener("change", render);
$("refsel").addEventListener("change", () => { rememberChoices(); render(); });
$("school").addEventListener("change", () => { rememberChoices(); render(); });
$("bands").addEventListener("change", () => { rememberChoices(); render(); });
$("mass").value = massKg() ?? "";
$("mass").addEventListener("change", () => { setMassKg(parseFloat($("mass").value)); if ($("fit_mass")) $("fit_mass").value = $("mass").value; render(); });
$("saveref").addEventListener("click", () => {
  const series = strokesWithCurves().map(s => metrics(s[src()])).filter(Boolean); const avg = meanCurve(series.map(m => m.norm));
  if (!avg) { alert("No force curves yet in this session."); return; }
  localStorage.setItem("pm5_my_reference", JSON.stringify(avg)); $("refsel").value = "mine";
  $("banner").textContent = `saved the average of ${series.length} strokes as your reference`; render();
});

// ---------- the event handlers the session feeds ----------
export const H = {
  snapshot: d => { S.strokes.clear(); d.strokes.forEach(s => S.strokes.set(s.stroke_count, s)); S.status = d.status || {}; S.summary = d.summary || {}; },
  reset: d => { S.strokes.clear(); S.status = {}; S.summary = {}; $("banner").textContent = d && d.replay ? `replaying ${d.replay}` : ""; },
  device: d => { S.device = d; $("banner").textContent = `${d.name || "PM5"}${d.firmware_rev ? " · firmware " + d.firmware_rev : ""}${d.workout ? " · " + d.workout : ""}`; },
  status: d => { S.status = d; },
  stroke: d => { S.strokes.set(d.stroke_count, d); },
  stroke_update: d => { const s = S.strokes.get(d.stroke_count); if (s) Object.assign(s, d); },
  curve: d => { const s = S.strokes.get(d.stroke_count); if (s) s[d.key] = d.points; },
  summary: d => { S.summary = d; },
  new_piece: () => { $("banner").textContent = "a new piece started on the PM5: the last one has been saved"; },
  ended: d => { $("banner").textContent = `session ${d.session} saved in this browser`; },
};
