// The guided-session panel: choose a protocol, hear the cues, see the live targets, get the
// report. The engine and analysis are in guided.js; this file is the page around them.
// Adding ?sim (or ?sim=40 for 40× speed) to the address shows "Simulate a rower", which runs a
// session against sim.js with no PM5, for trying the page and checking changes.
import * as G from "./guided.js";
import { SimRower } from "./sim.js";
import * as V from "./vo2.js";

const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } },
};

export class GuidedUI {
  constructor({ $, H, S, render, metrics, DB, isConnected, onResult }) {
    Object.assign(this, { $, H, S, render, metrics, DB, isConnected, onResult });
    this.engine = null; this.timer = null; this.sim = null; this.pendingN = null; this.norms = []; this.cues = [];
    const q = new URLSearchParams(location.search);
    this.simSpeed = q.has("sim") ? Math.max(1, Number(q.get("sim")) || 20) : null;
    this.build();
  }

  // ---------------------------------------------------------------- the controls
  build() {
    const $ = this.$, sel = $("g_kind"), saved = store.get("pm5_guided", {});
    for (const [k, p] of Object.entries(G.PROTOCOLS)) { const o = document.createElement("option"); o.value = k; o.textContent = p.title; sel.appendChild(o); }
    sel.value = saved.kind && G.PROTOCOLS[saved.kind] ? saved.kind : "rate";
    $("g_ready").checked = !!saved.readiness; $("g_voice").checked = saved.voice !== false;
    sel.addEventListener("change", () => { this.fields(); this.save(); });
    for (const id of ["g_ready", "g_voice"]) $(id).addEventListener("change", () => this.save());
    $("g_start").addEventListener("click", () => this.start(false));
    $("g_stop").addEventListener("click", () => this.finish(true));
    if (this.simSpeed) { $("g_sim").hidden = false; $("g_sim").textContent = `Simulate a rower (${this.simSpeed}×)`; $("g_sim").addEventListener("click", () => this.start(true)); }
    this.fields();
  }

  fields() {
    const $ = this.$, kind = $("g_kind").value, def = G.PROTOCOLS[kind], saved = store.get("pm5_guided", {}), vals = (saved.params || {})[kind] || {};
    const fit = store.get("pm5_fitness", {});
    $("g_params").innerHTML = def.fields.map(([name, label, dflt, type]) => {
      let v = vals[name] ?? dflt;
      if (kind === "hrcap" && name === "ceiling" && vals[name] == null && fit.PM5_ZONE_HR) v = fit.PM5_ZONE_HR;
      if (type.startsWith("choice:")) {
        const opts = type.slice(7).split(",").map(x => x.split("=")).map(([k, l]) => `<option value="${k}"${k === v ? " selected" : ""}>${l}</option>`).join("");
        return `<label>${label} <select data-f="${name}">${opts}</select></label>`;
      }
      return `<label>${label} <input type="text" data-f="${name}" value="${v}" size="${type === "list" ? 8 : 5}"></label>`;
    }).join("");
    $("g_params").querySelectorAll("[data-f]").forEach(el => el.addEventListener("change", () => this.save()));
    $("g_about").textContent = def.about + (kind === "readiness" ? "" : " Row a Just Row piece on the monitor.");
  }

  params() {
    const kind = this.$("g_kind").value, def = G.PROTOCOLS[kind], out = {};
    for (const [name, , dflt, type] of def.fields) {
      const el = this.$("g_params").querySelector(`[data-f="${name}"]`);
      out[name] = G.parseField(el ? el.value : dflt, type);
    }
    return out;
  }

  save() {
    const saved = store.get("pm5_guided", {}), kind = this.$("g_kind").value;
    const raw = {}; this.$("g_params").querySelectorAll("[data-f]").forEach(el => { raw[el.dataset.f] = el.value; });
    store.set("pm5_guided", { ...saved, kind, readiness: this.$("g_ready").checked, voice: this.$("g_voice").checked, params: { ...(saved.params || {}), [kind]: raw } });
  }

  // ---------------------------------------------------------------- running
  now() { return this.sim ? this.simStart + (Date.now() / 1000 - this.realStart) * this.simSpeed : Date.now() / 1000; }

  start(simulate) {
    const $ = this.$;
    if (this.engine) return;
    if (!simulate && !this.isConnected()) { this.say("Connect to the PM5 first.", true); $("g_out").textContent = "Connect to the PM5 first, then start the session."; return; }
    const kind = $("g_kind").value;
    let protocol;
    try {
      protocol = G.PROTOCOLS[kind].build(this.params());
      if ($("g_ready").checked && kind !== "readiness") {
        const rp = ((store.get("pm5_guided", {}).params || {}).readiness || {});
        protocol = G.withReadiness(protocol, { watts: G.parseField(rp.watts ?? 120, "num") || 120 });
      }
      new G.Engine(protocol);                                 // throws on a malformed protocol before anything starts
    } catch (e) { $("g_out").textContent = `Can't build that session: ${e.message}`; return; }
    this.save();
    this.engine = new G.Engine(protocol); this.pendingN = null; this.norms = []; this.cues = [];
    $("g_start").disabled = true; $("g_sim").disabled = true; $("g_stop").hidden = false; $("g_live").hidden = false; $("g_out").textContent = "";
    if (simulate) {
      this.sim = new SimRower({ seed: Date.now() % 100000 }); this.realStart = Date.now() / 1000; this.simStart = this.realStart;
      this.H.reset({ replay: "a simulated rower" }); this.render();
    }
    this.say(`${protocol.title}. ${simulate ? "" : "Start rowing when you're ready. "}${this.engine.firstCue()}`);
    this.lastT = this.now();
    this.timer = setInterval(() => this.tick(), simulate ? Math.max(40, 1000 / this.simSpeed) : 1000);
    this.draw();
  }

  tick() {
    const e = this.engine; if (!e) return;
    const t = this.now();
    let status = this.S.status || {};
    if (this.sim) {
      const target = e.started ? e.target(e.indexAt(t - e.t0)) : null;
      for (const rec of this.sim.advance(t, t - this.lastT, target)) { this.H.stroke(rec); this.addStroke(rec); }
      status = this.sim.status(); this.H.status(status); this.render();
    }
    this.lastT = t;
    for (const ev of e.tick(t, status)) this.say(ev.text);
    this.draw();
    if (e.done) this.finish(false);
  }

  /** Stroke events from the live session (not the simulator, which calls addStroke itself). */
  onEvent(kind, data) {
    if (!this.engine || this.sim || kind !== "stroke") return;
    // a stroke's curve and recovery time arrive after its record, so score the previous stroke now
    if (this.pendingN != null && this.S.strokes.get(this.pendingN)) this.addStroke(this.S.strokes.get(this.pendingN));
    this.pendingN = data.stroke_count;
    if (!this.engine.started) { this.engine.begin(data.t); this.tick(); }
  }

  addStroke(rec) {
    const e = this.engine;
    if (!e.started) e.begin(rec.t);
    const curve = rec.force_curve_v2 || rec.force_curve, m = curve ? this.metrics(curve) : null;
    let rmse = null;
    if (m) {
      if (this.norms.length >= 5) {
        const avg = m.norm.map((_, i) => this.norms.reduce((s, n) => s + n[i], 0) / this.norms.length);
        rmse = 100 * Math.sqrt(m.norm.reduce((s, v, i) => s + (v - avg[i]) ** 2, 0) / m.norm.length);
      }
      this.norms.push(m.norm); if (this.norms.length > 10) this.norms.shift();
    }
    const sample = { t: rec.t, hr: rec.hr, watts: rec.power_w, spm: rec.spm, pace_s: rec.pace_s, peak_lbf: rec.peak_force_lbf,
      a100: m ? m.a100 : null, ratio: rec.recovery_time_s && rec.drive_time_s ? rec.recovery_time_s / rec.drive_time_s : null, rmse };
    this.last = sample; (this.recent = this.recent || []).push(sample); if (this.recent.length > 5) this.recent.shift();
    for (const ev of e.stroke(sample)) this.say(ev.text);
  }

  async finish(stopped) {
    const e = this.engine; if (!e) return;
    clearInterval(this.timer); this.timer = null;
    if (!e.started) { this.reset(); this.$("g_out").textContent = "Stopped before the first stroke."; return; }
    const fit = store.get("pm5_fitness", {}), rest = parseFloat(fit.PM5_HR_REST);
    let cfg = null; try { cfg = V.settings(fit); } catch { cfg = null; }
    let history = [];
    try {
      history = (await this.DB.listSessions()).filter(s => s.guided && s.guided.readiness).sort((a, b) => a.started.localeCompare(b.started))
        .map(s => ({ target_w: s.guided.readiness.target_w, adj_hr: s.guided.readiness.adj_hr }));
    } catch { /* no storage */ }
    const result = e.result({ hr_rest: rest > 0 ? rest : undefined, cfg, history });
    result.simulated = !!this.sim;
    if (stopped) this.say("Session stopped.");
    this.$("g_out").textContent = (this.sim ? "Simulated rower, not saved.\n" : "") + G.report(result);
    if (!this.sim) this.onResult(result);
    this.reset();
  }

  reset() {
    const $ = this.$;
    this.engine = null; this.sim = null; this.recent = []; this.last = null;
    $("g_start").disabled = false; $("g_sim").disabled = false; $("g_stop").hidden = true; $("g_live").hidden = true;
  }

  // ---------------------------------------------------------------- output
  say(text, quiet = false) {
    this.cues.push(text); if (this.cues.length > 4) this.cues.shift();
    this.$("g_said").textContent = this.cues.slice().reverse().join("  ·  ");
    if (quiet || this.sim || !this.$("g_voice").checked || !("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text); u.rate = 1.05; window.speechSynthesis.speak(u);
  }

  draw() {
    const e = this.engine, $ = this.$; if (!e) return;
    const v = e.view(this.now()), b = v.block, tg = v.target || {};
    const big = [];
    if (tg.rate != null) big.push(`${tg.rate} s/m`);
    if (tg.pace_s != null) big.push(G.fmtPace(tg.pace_s));
    if (tg.damper != null) big.push(`damper ${tg.damper}`);
    if (tg.ceiling != null) big.push(`HR ≤ ${tg.ceiling}`);
    if (b.role === "drill") big.push(G.DRILLS[b.drill.kind].text(b.drill.target));
    if (b.role === "recovery") big.push("sit still");
    if (!big.length) big.push(b.role === "easy" || b.role === "warmup" ? "easy" : "row");
    $("g_block").textContent = v.waiting ? `Waiting for your first stroke · ${b.label}` : `${v.i + 1} of ${e.blocks.length} · ${b.label}`;
    $("g_big").textContent = big.join("  ·  ");
    $("g_left").textContent = v.waiting ? "" : `${G.fmtClock(v.remaining)} left`;
    $("g_barfill").style.width = v.waiting ? "0%" : `${Math.min(100, 100 * v.rel / v.total)}%`;
    $("g_next").textContent = v.next ? `Next: ${v.next.label}` : "";
    const checks = [], r = this.recent || [];
    if (r.length && b.role !== "recovery") {
      const spm = r[r.length - 1].spm, w = r.reduce((s, x) => s + x.watts, 0) / r.length;
      if (tg.rate != null) checks.push(`<span class="${Math.abs(spm - tg.rate) <= 1 ? "ok" : "off"}">rate ${spm}</span>`);
      else checks.push(`<span>rate ${spm}</span>`);
      if (tg.watts != null) checks.push(`<span class="${Math.abs(w - tg.watts) / tg.watts <= 0.05 ? "ok" : "off"}">${Math.round(w)} W (${G.fmtPace(G.paceFromWatts(w))})</span>`);
      if (b.role === "drill" && v.drill) checks.push(`<span>${v.drill.hits} of ${v.drill.n} on target</span>`);
    }
    const hr = (this.sim ? this.sim.status() : this.S.status || {}).hr;
    if (hr) checks.push(`<span class="${tg.ceiling != null && hr > tg.ceiling ? "off" : ""}">HR ${hr}</span>`);
    $("g_check").innerHTML = checks.join("");
  }
}
