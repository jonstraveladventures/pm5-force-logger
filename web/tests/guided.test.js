// Guided sessions against a simulated rower whose heart rate is known: each protocol has to
// recover what the simulator built in (the best stroke rate, the drift, the heart-rate slope…).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as G from "../guided.js";
import { SimRower, simSample } from "../sim.js";

function run(protocol, simOpts = {}, ctx = { hr_rest: 50 }) {
  const eng = new G.Engine(protocol), sim = new SimRower(simOpts), events = [];
  for (let t = 0; t < eng.total + 600 && !eng.done; t += 1) {
    const target = eng.started ? eng.target(eng.indexAt(t - eng.t0)) : null;
    for (const rec of sim.advance(t, 1, target)) { eng.begin(rec.t); events.push(...eng.stroke(simSample(rec))); }
    events.push(...eng.tick(t, sim.status()));
  }
  return { eng, r: eng.result(ctx), events, text: G.report(eng.result(ctx)) };
}
const noJunk = text => assert.ok(!/NaN|undefined|null/.test(text), text);

test("pace and power convert as Concept2 does", () => {
  assert.ok(Math.abs(G.wattsFromPace(132) - 152.2) < 0.1);
  assert.ok(Math.abs(G.paceFromWatts(G.wattsFromPace(127.3)) - 127.3) < 1e-9);
  assert.equal(G.fmtPace(131.6), "2:12");
  assert.equal(G.parseField("2:12", "pace"), 132);
  assert.deepEqual(G.parseField("14, 17,20", "list"), [14, 17, 20]);
});

test("the rate test rows each rate twice in a palindrome", () => {
  const p = G.rateTest();
  assert.deepEqual(p.blocks.filter(b => b.role === "test").map(b => b.key), [14, 17, 20, 20, 17, 14]);
  const eng = new G.Engine(p);
  assert.equal(eng.total, 300 + 6 * 210 + 60);
  // every rate's two blocks are centred on the same time, so a steady drift is shared equally
  const mids = k => eng.blocks.filter(b => b.key === k).map(b => (b.start + b.end) / 2);
  const centre = k => (mids(k)[0] + mids(k)[1]) / 2;
  assert.equal(centre(14), centre(17));
  assert.equal(centre(17), centre(20));
});

test("the rate test finds the simulator's best rate despite heart-rate drift", () => {
  for (const [spmOpt, drift] of [[17, 0.4], [17, 0.9], [14, 0.4], [20, 0.4]]) {
    const { r, text } = run(G.rateTest(), { spmOpt, drift, seed: spmOpt * 7 + drift * 10 });
    assert.equal(r.groups.best, spmOpt, `best rate for spmOpt ${spmOpt}, drift ${drift}\n${text}`);
    assert.ok(Math.abs(r.groups.drift_bpm_min - drift) < 0.25, `drift estimate ${r.groups.drift_bpm_min} vs ${drift}`);
    for (const g of r.groups.groups) assert.equal(g.blocks.length, 2);
    noJunk(text);
  }
});

test("cues come at every block change, ten seconds before, and at the end", () => {
  const { eng, events } = run(G.rateTest());
  const texts = events.map(e => e.text);
  assert.equal(texts.filter(t => /strokes a minute, pace 2:12, for 3 and a half minutes/.test(t)).length, 6);
  assert.equal(texts.filter(t => t.startsWith("In ten seconds")).length, eng.blocks.length - 1);
  assert.ok(texts.some(t => /Stop rowing/.test(t)));
  assert.equal(texts[texts.length - 1], "Session complete. End the piece on the monitor when you're ready.");
  assert.ok(eng.done);
});

test("the drag sweep finds the damper setting the simulator likes", () => {
  const { r, text } = run(G.dragSweep(), { dragOpt: 120, spmOpt: 16, seed: 3 });   // damper 5 is drag 120 in the simulator
  assert.equal(r.groups.best, 5, text);
  assert.ok(Math.abs(r.groups.groups.find(g => g.key === 7).drag - 144) < 2);
  noJunk(text);
});

test("the capped row holds heart rate at the ceiling and reports the watts there", () => {
  const sim = { seed: 5, spmOpt: 17, drift: 0.4 };
  const { r, eng, text } = run(G.hrCap({ ceiling: 148, minutes: 25, start_pace_s: 140 }), sim);
  const h = r.hrcap;
  assert.ok(h.over_frac < 0.2, `time over the ceiling ${h.over_frac}`);
  assert.ok(h.last.hr > 142 && h.last.hr < 149.5, `last-10-minute heart rate ${h.last.hr}`);
  // what the simulator can hold at 148 bpm in the middle of that window (minute 20 of the row): easy rate 16, drift 0.4
  const trueW = (148 - 50 - 0.4 * 20) / (0.55 * (1 + 0.004 * 1));
  assert.ok(Math.abs(h.watts_at_ceiling - trueW) < 12, `watts at ceiling ${h.watts_at_ceiling} vs ${trueW}\n${text}`);
  assert.ok(eng.controlLog.length > 40);
  assert.ok(r.recovery.drop > 20, `recovery drop ${r.recovery.drop}`);
  noJunk(text);
});

test("the drift test measures decoupling, and none when the heart rate doesn't drift", () => {
  const withDrift = run(G.driftTest({ watts: 140, minutes: 35 }), { drift: 0.4, seed: 9 }).r.drift.decoupling_pct;
  assert.ok(withDrift > 3 && withDrift < 6, `decoupling ${withDrift}`);
  const none = run(G.driftTest({ watts: 140, minutes: 35 }), { drift: 0, seed: 9 }).r.drift.decoupling_pct;
  assert.ok(Math.abs(none) < 1, `decoupling without drift ${none}`);
});

test("the step test recovers the heart-rate slope and gives a VO2max estimate", () => {
  const cfg = { mass_kg: 94, hrmax: 195, hr_rest: 42, zone_hr: 148, efficiency: 0.21, notes: [] };
  const { r, text } = run(G.stepTest(), { drift: 0.4, seed: 11 }, { hr_rest: 42, cfg });
  assert.equal(r.step.stages.length, 4);
  // the simulator's slope is 0.55 × (1 + 0.004) plus the drift across a 4-minute, 20-watt step (0.08)
  assert.ok(r.step.line.b > 0.52 && r.step.line.b < 0.72, `slope ${r.step.line.b}`);
  assert.ok(Number.isFinite(r.step.estimate.vo2max));
  assert.match(text, /VO2max estimate/);
  noJunk(text);
});

test("the readiness check adjusts to its power and compares with earlier checks", () => {
  const history = [{ target_w: 120, adj_hr: 121 }, { target_w: 120, adj_hr: 122 }, { target_w: 150, adj_hr: 140 }];
  const { r, text } = run(G.readinessCheck({ watts: 120 }), { seed: 13 }, { hr_rest: 50, history });
  const x = r.readiness;
  assert.ok(x.adj_hr > 113 && x.adj_hr < 122, `adjusted ${x.adj_hr}`);
  assert.equal(x.n_history, 2);                       // the 150 W check is a different test
  assert.equal(x.usual, 121.5);
  assert.match(text, /below it/);
  noJunk(text);
});

test("a readiness check can replace any protocol's warm-up", () => {
  const p = G.withReadiness(G.rateTest(), { watts: 115 });
  assert.equal(p.blocks[0].role, "readiness");
  assert.equal(p.blocks.filter(b => b.role === "warmup").length, 0);
  const { r } = run(p, { seed: 17 });
  assert.equal(r.readiness.target_w, 115);
  assert.equal(r.groups.best, 17);
});

test("drill blocks score better than the easy blocks between them", () => {
  const { r, events, text } = run(G.drillSession({ drill: "peak", target: 45 }), { a100: 50, fatigueAt: 1e9, seed: 19 });
  assert.ok(r.drill.drill_blocks.mean > r.drill.easy_blocks.mean + 0.4, text);
  assert.ok(events.some(e => /^\d+ of 10\.$/.test(e.text)));
  const c = run(G.drillSession({ drill: "consistency" }), { fatigueAt: 1e9, seed: 23 }).r.drill;
  assert.ok(c.drill_blocks.mean > c.easy_blocks.mean);
  noJunk(text);
});

test("fatigue onset is found when peak position moves later and stays, and not otherwise", () => {
  const strokes = (fn) => Array.from({ length: 400 }, (_, i) => ({ t: i * 4, a100: fn(i * 4) + ((i * 7919) % 5 - 2) * 0.6 }));
  const f = G.fatigueOnset(strokes(t => 38 + Math.max(0, t - 600) * 0.6 / 60));
  assert.ok(f.onset_s > 1150 && f.onset_s < 1400, `onset ${f.onset_s}`);
  assert.equal(G.fatigueOnset(strokes(() => 38)).onset_s, null);
  // a brief excursion that returns is not fatigue
  assert.equal(G.fatigueOnset(strokes(t => (t > 800 && t < 860 ? 50 : 38))).onset_s, null);
  assert.equal(G.fatigueOnset([{ t: 200, a100: 40 }]), null);
});

test("stopping early still gives a report on the blocks that were rowed", () => {
  const eng = new G.Engine(G.rateTest()), sim = new SimRower({ seed: 29 });
  for (let t = 0; t < 900; t++) {
    const target = eng.started ? eng.target(eng.indexAt(t - eng.t0)) : null;
    for (const rec of sim.advance(t, 1, target)) { eng.begin(rec.t); eng.stroke(simSample(rec)); }
    eng.tick(t, sim.status());
  }
  const r = eng.result({ hr_rest: 50 }), text = G.report(r);
  assert.equal(r.completed, false);
  assert.equal(r.groups.groups.length, 2);             // 14 and 17 were reached
  assert.match(text, /stopped early/);
  noJunk(text);
});

test("every menu entry builds a protocol from its default fields", () => {
  for (const [kind, def] of Object.entries(G.PROTOCOLS)) {
    const params = Object.fromEntries(def.fields.map(([name, , dflt, type]) => [name, G.parseField(dflt, type)]));
    const p = def.build(params);
    assert.equal(p.kind, kind);
    assert.ok(new G.Engine(p).total > 300);
    for (const b of p.blocks) assert.ok(b.cue && !/NaN|undefined/.test(b.cue), `${kind}: ${b.cue}`);
  }
});
