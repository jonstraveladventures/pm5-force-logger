// A simulated rower for testing guided sessions without a PM5. Its heart rate follows a known
// model, so a protocol can be checked by whether its analysis recovers what the model built in:
//
//   steady-state HR = rest + k·W·(1 + c·(spm − spmOpt)² + dragC·(drag − dragOpt)²) + drift·minutes
//
// approached with a first-order lag (time constant tau). Power and rate follow the targets with
// a few seconds' lag and some noise; peak position starts moving later after `fatigueAt`.
import { paceFromWatts } from "./guided.js";

function prng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export class SimRower {
  constructor(opts = {}) {
    Object.assign(this, { rest: 50, k: 0.55, spmOpt: 17, c: 0.004, drift: 0.4, tau: 40, dragOpt: 120, dragC: 0.0001,
      a100: 38, fatigueAt: 600, fatigueRate: 0.6, easyW: 120, easySpm: 16, drillSkill: 0.7, seed: 1, recoveryHr: 10 }, opts);
    this.rand = prng(this.seed);
    this.hr = this.rest + 15; this.w = this.easyW; this.spm = this.easySpm; this.drag = this.dragOpt;
    this.next = null; this.count = 0; this.dist = 0; this.elapsed = 0; this.last = null; this.rowing = true;
  }
  noise(sd) { const u = this.rand() || 1e-9, v = this.rand(); return sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  dragFor(damper) { return 60 + 12 * damper; }

  /** Advance to time t (seconds) by dt, following `target` (the engine's target, or null for easy
   *  rowing). Returns the strokes finished in the step, shaped like the logger's stroke records. */
  advance(t, dt, target) {
    this.elapsed += dt;
    this.rowing = !target || target.rowing !== false;
    const tw = target && target.watts ? target.watts : this.easyW, ts = target && target.rate ? target.rate : this.easySpm;
    if (target && target.damper != null) this.drag = this.dragFor(target.damper);
    if (this.rowing) { this.w += (tw - this.w) * Math.min(1, dt / 6); this.spm += (ts - this.spm) * Math.min(1, dt / 4); }
    const load = this.rowing ? this.k * this.w * (1 + this.c * (this.spm - this.spmOpt) ** 2 + this.dragC * (this.drag - this.dragOpt) ** 2) : this.recoveryHr;
    const ss = this.rest + load + this.drift * this.elapsed / 60;
    this.hr += (ss - this.hr) * (1 - Math.exp(-dt / this.tau));
    const out = [];
    if (!this.rowing) { this.next = null; return out; }
    if (this.next === null) this.next = t;
    while (this.next <= t) { out.push(this._stroke(this.next, target)); this.next += 60 / this.spm; }
    return out;
  }

  _stroke(t, target) {
    const spm = Math.max(10, Math.round(this.spm + this.noise(0.3)));
    const watts = Math.max(20, Math.round(this.w * (1 + this.noise(0.03))));
    let a100 = this.a100 + Math.max(0, this.elapsed - this.fatigueAt) * this.fatigueRate / 60 + this.noise(2);
    const drill = target && target.drill;
    let driveT = 0.8, rmse = Math.abs(this.noise(6)) + 4;
    if (drill && this.rand() < this.drillSkill) {
      if (drill.kind === "peak") a100 = Math.min(a100, drill.target - 1 - this.rand() * 4);
      if (drill.kind === "consistency") rmse = drill.target * this.rand();
    }
    let recT = Math.max(0.6, 60 / spm - driveT);
    if (drill && drill.kind === "ratio" && this.rand() < this.drillSkill) { driveT = Math.min(driveT, recT / (drill.target + 0.2)); }
    const drive = 1.45, work = watts * 60 / spm, avgLbf = work / drive / 4.448, peakLbf = avgLbf / 0.62;
    const p = Math.min(0.8, Math.max(0.2, a100 / 100)), a = 1.8, b = a * (1 - p) / p;
    const curve = Array.from({ length: 30 }, (_, i) => { const x = (i + 0.5) / 30; return Math.max(0, Math.round(peakLbf * (x / p) ** a * ((1 - x) / (1 - p)) ** b)); });
    this.count += 1; this.dist += watts ** (1 / 3) * 0.7;
    this.last = { stroke_count: this.count, t, elapsed_s: Math.round(this.elapsed * 100) / 100, distance_m: Math.round(this.dist * 10) / 10,
      drive_length_m: drive, drive_time_s: Math.round(driveT * 100) / 100, recovery_time_s: Math.round(recT * 100) / 100, stroke_distance_m: 10,
      peak_force_lbf: Math.round(peakLbf * 10) / 10, avg_force_lbf: Math.round(avgLbf * 10) / 10, work_j: Math.round(work), power_w: watts,
      hr: Math.round(this.hr + this.noise(0.7)), spm, pace_s: Math.round(paceFromWatts(watts) * 100) / 100, force_curve_v2: curve,
      _a100: a100, _rmse: rmse };
    return this.last;
  }

  status() {
    return { hr: Math.round(this.hr), stroke_rate: this.rowing ? Math.round(this.spm) : 0, power_w: this.rowing ? Math.round(this.w) : 0,
      pace_s: this.rowing ? paceFromWatts(this.w) : 0, drag_factor: Math.round(this.drag), elapsed_s: this.elapsed, distance_m: this.dist };
  }
}

/** A stroke record as the engine's sample. The page computes a100 and rmse from the force curve;
 *  the simulator knows them directly. */
export const simSample = rec => ({ t: rec.t, hr: rec.hr, watts: rec.power_w, spm: rec.spm, pace_s: rec.pace_s, peak_lbf: rec.peak_force_lbf,
  a100: rec._a100, ratio: rec.recovery_time_s / rec.drive_time_s, rmse: rec._rmse });
