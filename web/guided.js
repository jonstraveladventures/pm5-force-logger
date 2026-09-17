// Guided sessions: protocols that tell the rower what to do and when, a session engine that
// keeps time and steers, and the analysis of what happened. No DOM here, so tests/guided.test.js
// runs every protocol against a simulated rower (sim.js) whose heart rate responds in a known way.
//
// Times inside the engine are seconds from the first stroke. A protocol is a list of blocks,
// each with a role (warmup, test, readiness, drill, easy, recovery), a length, optional targets
// (stroke rate, pace or watts, damper setting, a technique drill) and the part of the block that
// counts for the analysis (the end of it, once heart rate has settled after the change).
import * as V from "./vo2.js";

export const wattsFromPace = p => 2.8 / (p / 500) ** 3;              // Concept2's pace-power relation
export const paceFromWatts = w => (w > 0 ? 500 * (2.8 / w) ** (1 / 3) : null);
export const fmtPace = p => { if (p == null) return "—"; const s = Math.round(p); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
export const fmtClock = s => (s == null ? "—" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`);
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r1 = x => (x == null ? "—" : x.toFixed(1));
const r0 = x => (x == null ? "—" : Math.round(x).toString());

export const CONTROL_S = 20;          // the heart-rate-capped row re-steers the pace this often
export const DEFAULT_REST = 60;       // resting heart rate when the fitness settings don't give one

// ---------------------------------------------------------------------------- protocols

function minutesWords(s) {
  if (s === 60) return "one minute";
  const m = Math.floor(s / 60), half = s % 60 === 30;
  return half ? `${m} and a half minutes` : s % 60 ? `${Math.round(s)} seconds` : `${m} minutes`;
}
function targetWords(t) {
  const parts = [];
  if (t.damper != null) parts.push(`damper on ${t.damper}`);
  if (t.rate != null) parts.push(`${t.rate} strokes a minute`);
  if (t.pace_s != null) parts.push(`pace ${fmtPace(t.pace_s)}`);
  else if (t.watts != null) parts.push(`${Math.round(t.watts)} watts`);
  return parts.join(", ");
}
const recovery = () => ({ label: "Recovery heart rate", short: "recovery heart rate", role: "recovery", s: 60,
  cue: "Stop rowing and sit still for one minute, for your recovery heart rate." });
const warmup = (s, t = {}) => ({ label: "Warm-up", short: "warm-up", role: "warmup", s, ...t,
  cue: `Warm up for ${minutesWords(s)}${targetWords(t) ? ", " + targetWords(t) : ", easy"}.` });

export function readinessBlock({ watts = 120, s = 300, count_s = 120 } = {}) {
  return { label: `Readiness check, ${watts} W`, short: "readiness check", role: "readiness", s, count_s, watts,
    cue: `Readiness check: ${watts} watts for ${minutesWords(s)}, any rate.` };
}

/** Heart rate at a fixed pace across stroke rates, rows in a palindrome (14, 17, 20, 20, 17, 14)
 *  so that steady drift lands equally on every rate and cancels in each rate's average. */
export function rateTest({ rates = [14, 17, 20], pace_s = 132, block_s = 210, count_s = 120, warm_s = 300, warm_rate = 16 } = {}) {
  const order = [...rates, ...[...rates].reverse()];
  return { kind: "rate", title: `Best stroke rate at ${fmtPace(pace_s)}`, params: { rates, pace_s, block_s, count_s },
    blocks: [warmup(warm_s, { rate: warm_rate, pace_s }),
      ...order.map(r => ({ label: `${r} strokes a minute`, short: `${r} strokes a minute`, role: "test", key: r, rate: r, pace_s, s: block_s, count_s,
        cue: `${r} strokes a minute, pace ${fmtPace(pace_s)}, for ${minutesWords(block_s)}.` })),
      recovery()] };
}

/** The same design across damper settings at a fixed pace; the PM5 measures the drag factor. */
export function dragSweep({ dampers = [3, 5, 7], pace_s = 132, block_s = 210, count_s = 120, warm_s = 300 } = {}) {
  const order = [...dampers, ...[...dampers].reverse()];
  return { kind: "drag", title: `Drag sweep at ${fmtPace(pace_s)}`, params: { dampers, pace_s, block_s, count_s },
    blocks: [warmup(warm_s, { pace_s }),
      ...order.map(d => ({ label: `damper ${d}`, short: `damper ${d}`, role: "test", key: d, damper: d, pace_s, s: block_s, count_s,
        cue: `Set the damper to ${d}, then pace ${fmtPace(pace_s)} for ${minutesWords(block_s)}.` })),
      recovery()] };
}

/** A row steered to keep heart rate under a ceiling: the pace target rises while there is
 *  headroom and eases as heart rate reaches the ceiling. */
export function hrCap({ ceiling = 148, minutes = 25, start_pace_s = 135, warm_s = 300 } = {}) {
  const s = Math.max(60, minutes * 60 - warm_s);
  return { kind: "hrcap", title: `Capped at ${ceiling} bpm`, params: { ceiling, minutes, start_pace_s },
    blocks: [warmup(warm_s, { pace_s: start_pace_s }),
      { label: `Capped row, ceiling ${ceiling}`, short: "the capped row", role: "test", key: "cap", control: "hrcap", ceiling, pace_s: start_pace_s, s,
        cue: `Now I'll steer the pace to keep your heart rate under ${ceiling}. Start at ${fmtPace(start_pace_s)}.` },
      recovery()] };
}

/** Fixed power for a long row; heart rate per watt in the two halves gives the aerobic decoupling. */
export function driftTest({ watts = 140, minutes = 35, warm_s = 300 } = {}) {
  const s = Math.max(120, minutes * 60 - warm_s);
  return { kind: "drift", title: `Drift test at ${watts} W`, params: { watts, minutes },
    blocks: [warmup(warm_s, { watts }),
      { label: `Hold ${watts} W`, short: `${watts} watts`, role: "test", key: "hold", watts, s,
        cue: `Hold ${watts} watts, pace ${fmtPace(paceFromWatts(watts))}, for ${minutesWords(s)}.` },
      recovery()] };
}

/** Stages of rising power; heart rate at the end of each gives the heart-rate-against-power line. */
export function stepTest({ start_w = 110, step_w = 20, stages = 4, stage_s = 240, count_s = 90, warm_s = 300 } = {}) {
  const blocks = [warmup(warm_s, { watts: start_w })];
  for (let i = 0; i < stages; i++) {
    const w = start_w + i * step_w;
    blocks.push({ label: `Stage ${i + 1}, ${w} W`, short: `stage ${i + 1}, ${w} watts`, role: "test", key: w, watts: w, s: stage_s, count_s,
      cue: `Stage ${i + 1}: ${w} watts, pace ${fmtPace(paceFromWatts(w))}, for ${minutesWords(stage_s)}.` });
  }
  blocks.push(recovery());
  return { kind: "step", title: `Step test from ${start_w} W`, params: { start_w, step_w, stages, stage_s, count_s }, blocks };
}

export function readinessCheck({ watts = 120 } = {}) {
  return { kind: "readiness", title: `Readiness check at ${watts} W`, params: { watts }, blocks: [readinessBlock({ watts }), recovery()] };
}

export const DRILLS = {
  peak: { label: "peak position", unit: "%", default: 45, better: "lower",
    cue: t => `Drill: peak force by ${t} per cent of the drive. Push with the legs early.`, text: t => `peak position at or before ${t}%` },
  ratio: { label: "drive : recovery", unit: "×", default: 2.5, better: "higher",
    cue: t => `Drill: recovery at least ${t} times as long as the drive. Slow the slide.`, text: t => `recovery at least ${t} × the drive` },
  consistency: { label: "consistency", unit: "%", default: 8, better: "lower",
    cue: () => "Drill: make every stroke the same shape.", text: t => `shape within ${t}% of your last ten strokes` },
};
export function drillHit(sample, drill) {
  if (!drill) return false;
  const v = drill.kind === "peak" ? sample.a100 : drill.kind === "ratio" ? sample.ratio : sample.rmse;
  if (v == null) return false;
  return DRILLS[drill.kind].better === "lower" ? v <= drill.target : v >= drill.target;
}

/** Drill blocks with easy rowing between; the easy blocks score the same target as a baseline. */
export function drillSession({ drill = "peak", target = null, repeats = 3, drill_s = 180, easy_s = 120, warm_s = 300 } = {}) {
  const d = { kind: drill, target: target ?? DRILLS[drill].default };
  const blocks = [warmup(warm_s)];
  for (let i = 0; i < repeats; i++) {
    blocks.push({ label: `Drill ${i + 1}: ${DRILLS[drill].label}`, short: `drill ${i + 1}`, role: "drill", key: "drill", drill: d, s: drill_s, cue: DRILLS[drill].cue(d.target) });
    blocks.push({ label: "Easy rowing", short: "easy rowing", role: "easy", key: "easy", drill: d, s: easy_s, cue: "Easy rowing. Relax." });
  }
  return { kind: "drill", title: `Drill: ${DRILLS[drill].text(d.target)}`, params: { drill, target: d.target, repeats }, blocks };
}

/** Put the readiness check in place of a protocol's warm-up. */
export function withReadiness(protocol, opts = {}) {
  const blocks = [...protocol.blocks], rb = readinessBlock(opts);
  if (blocks[0] && blocks[0].role === "warmup") blocks[0] = rb; else blocks.unshift(rb);
  return { ...protocol, blocks, params: { ...protocol.params, readiness_w: rb.watts } };
}

// ---------------------------------------------------------------------------- the engine

const cue = text => ({ type: "cue", text });

export class Engine {
  constructor(protocol) {
    this.p = protocol;
    let at = 0;
    this.blocks = protocol.blocks.map(b => { const o = { ...b, start: at, end: at + b.s }; at += b.s; return o; });
    this.total = at;
    this.t0 = null; this.strokes = []; this.status = []; this.idx = -1; this.done = false; this.warned = new Set();
    this.pace = null; this.lastCtl = null; this.spokenPace = null; this.lastWarn = -Infinity; this.controlLog = [];
    this.drill = { hits: 0, n: 0 };
  }
  get started() { return this.t0 !== null; }
  begin(t0) { if (this.t0 === null) this.t0 = t0; }
  /** The first block's cue, spoken before the first stroke; the engine won't repeat it. */
  firstCue() { this.idx = 0; return this.blocks[0] ? this.blocks[0].cue : ""; }
  indexAt(rel) { for (let i = 0; i < this.blocks.length; i++) if (rel < this.blocks[i].end) return i; return this.blocks.length; }

  /** What the rower should be doing in block i. */
  target(i = this.idx) {
    const b = this.blocks[i];
    if (!b) return null;
    const pace = b.control === "hrcap" && this.pace != null ? this.pace : b.pace_s ?? (b.watts ? paceFromWatts(b.watts) : null);
    return { role: b.role, rate: b.rate ?? null, damper: b.damper ?? null, drill: b.role === "drill" ? b.drill : null,
      rowing: b.role !== "recovery", pace_s: pace, watts: pace ? wattsFromPace(pace) : null, ceiling: b.ceiling ?? null };
  }

  /** Call about once a second with the monitor's latest status; returns cues to speak. */
  tick(t, status = {}) {
    if (this.t0 === null || this.done) return [];
    const rel = t - this.t0, ev = [];
    this.status.push({ t: rel, hr: status.hr ?? null, drag: status.drag_factor ?? null, watts: status.power_w ?? null });
    const i = this.indexAt(rel);
    if (i !== this.idx) {
      this.idx = i; this.drill = { hits: 0, n: 0 };
      if (i >= this.blocks.length) { this.done = true; ev.push(cue("Session complete. End the piece on the monitor when you're ready.")); return ev; }
      ev.push(cue(this.blocks[i].cue));
    }
    const b = this.blocks[i];
    if (b.control === "hrcap" && this.pace == null) { this.pace = b.pace_s; this.spokenPace = b.pace_s; this.lastCtl = rel; }
    const next = this.blocks[i + 1];
    if (next && b.end - rel <= 10 && !this.warned.has(i)) { this.warned.add(i); ev.push(cue(`In ten seconds: ${next.short || next.label}.`)); }
    if (b.control === "hrcap" && rel - this.lastCtl >= CONTROL_S) ev.push(...this._steer(b, rel));
    return ev;
  }

  _steer(b, rel) {
    this.lastCtl = rel;
    const recent = this.status.filter(s => s.t > rel - CONTROL_S && s.hr).map(s => s.hr);
    if (!recent.length) return [];
    const hr = mean(recent), c = b.ceiling;
    // faster (lower pace) with headroom, hold near the ceiling, back off above it
    const d = hr > c ? 2 : hr < c - 6 ? -1 : hr < c - 3 ? -0.5 : 0;
    this.pace = clamp(this.pace + d, b.pace_s - 20, b.pace_s + 40);
    this.controlLog.push({ t: Math.round(rel), hr: Math.round(hr * 10) / 10, pace_s: this.pace });
    if (hr > c && rel - this.lastWarn >= 30) {
      this.lastWarn = rel; this.spokenPace = this.pace;
      return [cue(`Heart rate ${Math.ceil(hr)}. Ease off to ${fmtPace(this.pace)}.`)];
    }
    // small steps are shown on the page, not spoken
    if (Math.abs(this.pace - this.spokenPace) >= 2) { this.spokenPace = this.pace; return [cue(`Pace ${fmtPace(this.pace)}.`)]; }
    return [];
  }

  /** Call for each finished stroke: {t, hr, watts, spm, pace_s, peak_lbf, a100, ratio, rmse}. */
  stroke(sample) {
    if (this.t0 === null || this.done) return [];
    const rel = sample.t - this.t0, s = { ...sample, t: rel };
    this.strokes.push(s);
    const b = this.blocks[this.indexAt(rel)], ev = [];
    if (b && b.role === "drill") {
      this.drill.n++; if (drillHit(s, b.drill)) this.drill.hits++;
      if (this.drill.n === 10) { ev.push(cue(`${this.drill.hits} of 10.`)); this.drill = { hits: 0, n: 0 }; }
    }
    return ev;
  }

  view(t) {
    if (this.t0 === null) return { waiting: true, block: this.blocks[0], i: 0, next: this.blocks[1], total: this.total, target: this.target(0) };
    const rel = t - this.t0, i = Math.min(this.indexAt(rel), this.blocks.length - 1), b = this.blocks[i];
    return { rel, i, block: b, remaining: Math.max(0, b.end - rel), next: this.blocks[i + 1], total: this.total, target: this.target(i), drill: this.drill };
  }

  result(ctx = {}) { return analyse(this, ctx); }
}

// ---------------------------------------------------------------------------- analysis

/** Mean power, heart rate and stroke rate over the strokes in [from, to]. */
export function stats(strokes, from, to) {
  const w = strokes.filter(s => s.t >= from && s.t <= to && s.watts > 0 && s.hr);
  if (!w.length) return null;
  const pick = k => mean(w.filter(s => s[k] != null).map(s => s[k]));
  return { n: w.length, watts: pick("watts"), hr: pick("hr"), spm: pick("spm"), peak_lbf: pick("peak_lbf"), a100: pick("a100"), from, to };
}
const windowOf = b => [b.end - (b.count_s ?? b.s), b.end];
const reached = (eng, b) => eng.status.length > 0 && eng.status[eng.status.length - 1].t >= b.end - 1;   // a block stopped partway isn't analysed

/** Heart rate moved to a common power on the line through resting heart rate, so that small
 *  slips off the target pace don't pass for a difference between settings. */
export const hrAdj = (hr, watts, targetW, rest = DEFAULT_REST) => rest + (hr - rest) * (targetW / watts);

function grouped(eng, rest) {
  const rows = eng.blocks.filter(b => b.role === "test" && reached(eng, b)).map(b => {
    const [from, to] = windowOf(b), st = stats(eng.strokes, from, to);
    if (!st) return null;
    const targetW = b.pace_s ? wattsFromPace(b.pace_s) : b.watts;
    const withRate = eng.strokes.filter(s => s.t >= from && s.t <= to && s.spm);
    const drag = median(eng.status.filter(s => s.t >= from && s.t <= to && s.drag).map(s => s.drag));
    return { key: b.key, mid: (from + to) / 2, ...st, target_w: targetW, adj_hr: hrAdj(st.hr, st.watts, targetW, rest),
      on_rate: b.rate != null && withRate.length ? withRate.filter(s => Math.abs(s.spm - b.rate) <= 1).length / withRate.length : null, drag };
  }).filter(Boolean);
  const keys = [...new Set(rows.map(r => r.key))];
  const groups = keys.map(k => {
    const rs = rows.filter(r => r.key === k), adj = rs.map(r => r.adj_hr);
    return { key: k, blocks: rs, adj_hr: mean(adj), spread: adj.length > 1 ? Math.max(...adj) - Math.min(...adj) : null,
      watts: mean(rs.map(r => r.watts)), peak_lbf: mean(rs.map(r => r.peak_lbf).filter(v => v != null)), drag: median(rs.map(r => r.drag).filter(v => v != null)) };
  });
  const paired = groups.filter(g => g.blocks.length >= 2).map(g => {
    const [a, b] = [g.blocks[0], g.blocks[g.blocks.length - 1]];
    return (b.adj_hr - a.adj_hr) / ((b.mid - a.mid) / 60);
  });
  const sorted = [...groups].sort((a, b) => a.adj_hr - b.adj_hr);
  return { groups, best: sorted[0] ? sorted[0].key : null, margin: sorted.length > 1 ? sorted[1].adj_hr - sorted[0].adj_hr : null,
    drift_bpm_min: paired.length ? mean(paired) : null };
}

function recoveryOf(eng) {
  const b = eng.blocks.find(x => x.role === "recovery");
  if (!b) return null;
  const at = (from, to) => mean(eng.status.filter(s => s.t >= from && s.t <= to && s.hr).map(s => s.hr));
  const start = at(b.start - 5, b.start), end = at(b.end - 5, b.end);
  if (start == null || end == null || eng.status[eng.status.length - 1].t < b.end - 1) return null;
  return { start_hr: start, end_hr: end, drop: start - end };
}

function readinessOf(eng, ctx) {
  const b = eng.blocks.find(x => x.role === "readiness");
  if (!b || !reached(eng, b)) return null;
  const [from, to] = windowOf(b), st = stats(eng.strokes, from, to);
  if (!st) return null;
  const adj = hrAdj(st.hr, st.watts, b.watts, ctx.hr_rest);
  const history = (ctx.history || []).filter(h => Math.abs(h.target_w - b.watts) <= 5).map(h => h.adj_hr).slice(-10);
  const usual = median(history);
  return { target_w: b.watts, hr: st.hr, watts: st.watts, adj_hr: adj, usual, n_history: history.length, diff: usual == null ? null : adj - usual };
}

function drillOf(eng) {
  const frac = role => {
    const per = eng.blocks.filter(b => b.role === role).map(b => {
      const ss = eng.strokes.filter(s => s.t >= b.start + 20 && s.t <= b.end);
      return ss.length ? ss.filter(s => drillHit(s, b.drill)).length / ss.length : null;
    }).filter(v => v != null);
    return { per_block: per, mean: mean(per) };
  };
  const d = eng.blocks.find(b => b.role === "drill");
  return d ? { drill: d.drill, drill_blocks: frac("drill"), easy_blocks: frac("easy") } : null;
}

/** When peak position starts moving later and stays there: the rolling median of 20 strokes
 *  reaching the median of minutes 3 to 6 plus `rise` points, holding within 2 points of that for
 *  the next two minutes. `strokes` are {t (s from the start of the row), a100}. */
export function fatigueOnset(strokes, { from = 180, to = 360, rise = 6, hold_s = 120, win = 20 } = {}) {
  const pts = strokes.filter(s => s.a100 != null).sort((a, b) => a.t - b.t);
  const base = pts.filter(s => s.t >= from && s.t <= to).map(s => s.a100);
  if (base.length < 15) return null;
  const baseline = median(base);
  const roll = [];
  for (let i = win - 1; i < pts.length; i++) if (pts[i].t > to) roll.push({ t: pts[i].t, m: median(pts.slice(i + 1 - win, i + 1).map(p => p.a100)) });
  for (let i = 0; i < roll.length; i++) {
    if (roll[i].m < baseline + rise) continue;
    if (roll[roll.length - 1].t < roll[i].t + hold_s) break;          // not enough row left to confirm it
    if (roll.filter(r => r.t >= roll[i].t && r.t <= roll[i].t + hold_s).every(r => r.m >= baseline + rise - 2))
      return { baseline, onset_s: roll[i].t, rise };
  }
  return { baseline, onset_s: null, rise };
}

export function analyse(eng, ctx = {}) {
  const rest = ctx.hr_rest ?? DEFAULT_REST;
  const out = { kind: eng.p.kind, title: eng.p.title, params: eng.p.params, rest_hr: rest, notes: [],
    completed: eng.done, rowed_s: eng.status.length ? Math.round(eng.status[eng.status.length - 1].t) : 0 };
  if (ctx.hr_rest == null) out.notes.push(`resting heart rate not set in the fitness settings; ${DEFAULT_REST} used`);
  const k = eng.p.kind;
  if (k === "rate" || k === "drag") out.groups = grouped(eng, rest);
  if (k === "hrcap") {
    const b = eng.blocks.find(x => x.control === "hrcap"), c = b.ceiling;
    const inBlock = eng.status.filter(s => s.t >= b.start && s.t <= b.end && s.hr);
    const last = stats(eng.strokes, Math.max(b.start, b.end - 600), b.end);
    out.hrcap = { ceiling: c, over_frac: inBlock.length ? inBlock.filter(s => s.hr > c).length / inBlock.length : null,
      last: last, watts_at_ceiling: last && last.hr - rest > 15 ? V.wattsAt(c, last.watts, last.hr, rest) : null,
      final_pace_s: eng.pace, control: eng.controlLog };
  }
  if (k === "drift") {
    const b = eng.blocks.find(x => x.role === "test"), mid = (b.start + b.end) / 2;
    const h1 = stats(eng.strokes, b.start, mid), h2 = stats(eng.strokes, mid, b.end);
    const ef = h => (h ? h.watts / h.hr : null);
    out.drift = { first: h1, second: h2, decoupling_pct: h1 && h2 ? 100 * (ef(h1) - ef(h2)) / ef(h1) : null };
  }
  if (k === "step") {
    const stages = eng.blocks.filter(b => b.role === "test" && reached(eng, b)).map(b => { const [f, t] = windowOf(b), st = stats(eng.strokes, f, t); return st ? { key: b.key, ...st } : null; }).filter(Boolean);
    const line = V.fitLine(stages.map(s => ({ watts: s.watts, hr: s.hr })));
    out.step = { stages, line, estimate: line && ctx.cfg ? V.pooled(stages.map(s => ({ watts: s.watts, hr: s.hr })), ctx.cfg) : null };
  }
  if (k === "drill") out.drill = drillOf(eng);
  out.readiness = readinessOf(eng, { ...ctx, hr_rest: rest });
  out.recovery = recoveryOf(eng);
  out.fatigue = fatigueOnset(eng.strokes);
  return out;
}

// ---------------------------------------------------------------------------- the report

export function report(r) {
  const L = [];
  const g = r.groups;
  if (g) {
    const pace = r.params.pace_s, w = wattsFromPace(pace);
    L.push(`${r.title} (${Math.round(w)} W). Heart rate in the last ${Math.round(r.params.count_s / 60 * 10) / 10} minutes of each block, adjusted to ${Math.round(w)} W:`);
    for (const x of g.groups) {
      const name = r.kind === "rate" ? `${x.key} s/m` : `damper ${x.key}${x.drag ? ` (drag ${Math.round(x.drag)})` : ""}`;
      const blocks = x.blocks.map(b => r1(b.adj_hr)).join(" and ");
      const rate = r.kind === "rate" && x.blocks.some(b => b.on_rate != null) ? `, on rate ${r0(100 * mean(x.blocks.map(b => b.on_rate)))}%` : "";
      L.push(`  ${name}: ${r1(x.adj_hr)} bpm (blocks ${blocks}${rate}), peak force ${r0(x.peak_lbf)} lbf`);
    }
    if (g.best != null) {
      const what = r.kind === "rate" ? `${g.best} strokes a minute` : `damper ${g.best}`;
      L.push(g.margin != null && g.margin < 1.5
        ? `Lowest: ${what}, but only ${r1(g.margin)} bpm below the next, which one session can't separate. Repeat on another day and compare.`
        : `Lowest: ${what}, ${r1(g.margin)} bpm below the next best.`);
    }
    if (g.drift_bpm_min != null) L.push(`Heart rate drifted about ${r1(g.drift_bpm_min)} bpm a minute; the order of the blocks cancels a steady drift.`);
  }
  if (r.hrcap) {
    const h = r.hrcap;
    if (h.last) L.push(`Capped at ${h.ceiling} bpm: over the last ${fmtClock(h.last.to - h.last.from)} you held ${r0(h.last.watts)} W at ${r1(h.last.hr)} bpm, ` +
      `above the ceiling ${r0(100 * (h.over_frac || 0))}% of the capped time. Final pace ${fmtPace(h.final_pace_s)}.`);
    if (h.watts_at_ceiling) L.push(`Watts at ${h.ceiling} bpm: ${r0(h.watts_at_ceiling)}.`);
  }
  if (r.drift) {
    const d = r.drift;
    if (d.first && d.second) L.push(`Drift test: first half ${r0(d.first.watts)} W at ${r1(d.first.hr)} bpm, second half ${r0(d.second.watts)} W at ${r1(d.second.hr)} bpm. ` +
      `Decoupling ${r1(d.decoupling_pct)}%${d.decoupling_pct < 5 ? ", under the 5% usually taken to mean the pace is sustainable" : ", above the 5% usually taken to mean the pace is sustainable"}.`);
  }
  if (r.step) {
    for (const s of r.step.stages) L.push(`  stage at ${s.key} W: ${r0(s.watts)} W, ${r1(s.hr)} bpm`);
    if (r.step.line) L.push(`Heart rate = ${r0(r.step.line.a)} + ${r.step.line.b.toFixed(2)} x watts.`);
    const e = r.step.estimate;
    if (e) L.push(`Watts at your zone heart rate: ${r0(e.watts_at_zone)}; VO2max estimate ~${r0(e.vo2max)} ml/kg/min (${r0(e.watts_at_hrmax)} W at maximum heart rate).`);
    else if (r.step.line) L.push("Enter mass and maximum heart rate in the fitness settings for the VO2max estimate.");
  }
  if (r.drill) {
    const d = r.drill, text = DRILLS[d.drill.kind].text(d.drill.target);
    L.push(`Drill, ${text}: ${r0(100 * (d.drill_blocks.mean ?? 0))}% of strokes in the drill blocks, against ${r0(100 * (d.easy_blocks.mean ?? 0))}% in the easy blocks.`);
  }
  if (r.readiness) {
    const x = r.readiness;
    L.push(`Readiness: ${r1(x.hr)} bpm at ${r0(x.watts)} W, ${r1(x.adj_hr)} adjusted to ${x.target_w} W. ` +
      (x.usual == null ? "This is the first readiness check; later ones will compare against it."
        : `Your usual is ${r1(x.usual)} (median of ${x.n_history}); today is ${r1(Math.abs(x.diff))} ${x.diff >= 0 ? "above" : "below"} it${x.diff >= 4 ? ", which can mean fatigue or illness" : ""}.`));
  }
  if (r.recovery) L.push(`Recovery: ${r0(r.recovery.start_hr)} to ${r0(r.recovery.end_hr)} bpm in one minute, a drop of ${r0(r.recovery.drop)}.`);
  if (r.fatigue) L.push(r.fatigue.onset_s != null
    ? `Peak position started drifting later at ${fmtClock(r.fatigue.onset_s)}, from ${r0(r.fatigue.baseline)}% at the start.`
    : `No lasting drift in peak position (it stayed near ${r0(r.fatigue.baseline)}%).`);
  if (!r.completed) L.push("The session was stopped early; blocks not reached are left out.");
  for (const n of r.notes) L.push(`note: ${n}`);
  return L.join("\n");
}

// ---------------------------------------------------------------------------- the menu

export const PROTOCOLS = {
  rate: { title: "Best stroke rate at a fixed pace", build: p => rateTest({ rates: p.rates, pace_s: p.pace, block_s: p.block * 60 }),
    fields: [["rates", "rates", "14,17,20", "list"], ["pace", "pace", "2:12", "pace"], ["block", "block (min)", 3.5, "num"]],
    about: "Rows each rate twice, in a palindrome, at one pace. Heart rate at the end of each block, adjusted to the target power, finds the rate that costs you least." },
  hrcap: { title: "Heart-rate-capped row", build: p => hrCap({ ceiling: p.ceiling, minutes: p.minutes, start_pace_s: p.pace }),
    fields: [["ceiling", "ceiling (bpm)", 148, "num"], ["minutes", "minutes", 25, "num"], ["pace", "starting pace", "2:15", "pace"]],
    about: "Steers the pace to keep heart rate under the ceiling, and reports the watts you held there. Rowed weekly, the number should rise." },
  drift: { title: "Drift test", build: p => driftTest({ watts: p.watts, minutes: p.minutes }),
    fields: [["watts", "watts", 140, "num"], ["minutes", "minutes", 35, "num"]],
    about: "Fixed power for a long row. Heart rate per watt in the second half against the first gives the aerobic decoupling." },
  step: { title: "Step test", build: p => stepTest({ start_w: p.start, step_w: p.step, stages: p.stages, stage_s: p.stage * 60 }),
    fields: [["start", "first stage (W)", 110, "num"], ["step", "step (W)", 20, "num"], ["stages", "stages", 4, "num"], ["stage", "stage (min)", 4, "num"]],
    about: "Stages of rising power, all below zone 3. Heart rate at the end of each gives the heart-rate-against-power line and, with your fitness settings, a VO2max estimate." },
  drag: { title: "Drag sweep", build: p => dragSweep({ dampers: p.dampers, pace_s: p.pace, block_s: p.block * 60 }),
    fields: [["dampers", "damper settings", "3,5,7", "list"], ["pace", "pace", "2:12", "pace"], ["block", "block (min)", 3.5, "num"]],
    about: "The same palindrome across damper settings. You move the damper when told; the monitor measures the drag factor." },
  readiness: { title: "Readiness check", build: p => readinessCheck({ watts: p.watts }),
    fields: [["watts", "watts", 120, "num"]],
    about: "Five easy minutes at a fixed power. Heart rate well above your usual can mean fatigue or illness. Tick the box to use it as any session's warm-up." },
  drill: { title: "Technique drill", build: p => drillSession({ drill: p.drill, target: p.target === "" || p.target == null ? null : p.target, repeats: p.repeats }),
    fields: [["drill", "drill", "peak", "choice:peak=peak position,ratio=drive : recovery,consistency=consistency"], ["target", "target (blank for default)", "", "num"], ["repeats", "repeats", 3, "num"]],
    about: "Three-minute drill blocks with easy rowing between. Every ten drill strokes you hear how many hit the target." },
};

export function parseField(value, type) {
  const v = String(value ?? "").trim();
  if (type === "list") return v.split(",").map(x => parseFloat(x)).filter(x => !Number.isNaN(x));
  if (type === "pace") { const m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(v); return m ? parseInt(m[1], 10) * 60 + parseFloat(m[2]) : parseFloat(v); }
  if (type.startsWith("choice")) return v;
  return v === "" ? "" : parseFloat(v);
}
