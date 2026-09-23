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
  assert.equal(eng.total, 1800 + 60);                  // 30 minutes of rowing, then the recovery minute
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
  assert.equal(texts.filter(t => /strokes a minute, pace 2:12, for 3 minutes 40 seconds/.test(t)).length, 6);
  assert.equal(texts.filter(t => t.startsWith("In ten seconds")).length, eng.blocks.length - 1);
  assert.ok(texts.some(t => /Stop rowing/.test(t)));
  assert.equal(texts[texts.length - 1], "Session complete. End the piece on the monitor when you're ready.");
  assert.ok(eng.done);
});

test("a session fills the rowing time it is given, and the blocks share it evenly", () => {
  for (const total of [26, 30, 42]) {                  // 20 minutes is refused, see the next test
    const p = G.rateTest({ total_s: total * 60 }), rowing = p.blocks.filter(b => b.role !== "recovery").reduce((a, b) => a + b.s, 0);
    assert.equal(rowing, total * 60, `${total} min`);
    const tests = p.blocks.filter(b => b.role === "test").map(b => b.s);
    assert.equal(new Set(tests).size, 1, "all six blocks the same length");
    assert.ok(tests[0] % 5 === 0);
    assert.ok(p.blocks[0].s >= 480, "any spare seconds go to the warm-up");
  }
  for (const [kind, def] of Object.entries(G.PROTOCOLS)) {
    if (kind === "readiness") continue;
    const params = Object.fromEntries(def.fields.map(([name, , dflt, type]) => [name, G.parseField(dflt, type)]));
    params.total = 33;
    const p = def.build(params), rowing = p.blocks.filter(b => b.role !== "recovery").reduce((a, b) => a + b.s, 0);
    assert.equal(rowing, 33 * 60, `${kind} fills 33 minutes`);
  }
});

test("too short a session warns, and far too short is refused with the length that would do", () => {
  assert.deepEqual(G.rateTest({ total_s: 1800 }).warnings, []);
  const w = G.rateTest({ total_s: 25 * 60 }).warnings;                 // (25 - 8) min over 6 blocks = 2:50 each
  assert.equal(w.length, 1);
  assert.match(w[0], /only 2:50/);
  assert.match(w[0], /About 26 minutes/);
  assert.throws(() => G.rateTest({ total_s: 20 * 60 }), /too short.*at least 26 minutes/);
  assert.throws(() => G.hrCap({ total_s: 8 * 60 }), G.TooShort);
  assert.equal(G.driftTest({ total_s: 20 * 60 }).warnings.length, 1);
  assert.equal(G.stepTest().warnings.length, 0, "the default 25 minutes gives each of six stages 3:20");
  assert.equal(G.stepTest({ total_s: 21 * 60 }).warnings.length, 1);
});

test("the session length comes from the piece on the monitor", () => {
  assert.deepEqual(G.pieceSeconds({ piece_type: "time", piece_length: 1800 }, {}), { s: 1800, note: "fitted to the 30:00 piece on the monitor" });
  const d = G.pieceSeconds({ piece_type: "distance", piece_length: 5000 }, { pace: 132 });
  assert.equal(d.s, 1320);
  assert.match(d.note, /5000 m piece.*22:00 at 2:12/);
  assert.equal(G.pieceSeconds({ piece_type: "distance", piece_length: 5000 }, {}), null, "no fixed pace, no estimate");
  assert.equal(G.pieceSeconds({ piece_type: "distance", piece_length: 0 }, { pace: 132 }), null, "a Just Row has no length");
  assert.equal(G.pieceSeconds({}, {}), null);
});

test("a readiness check in place of the warm-up keeps the total", () => {
  const p = G.withReadiness(G.rateTest({ total_s: 1800 }), { watts: 115 });
  assert.equal(p.blocks.filter(b => b.role !== "recovery").reduce((a, b) => a + b.s, 0), 1800);
  assert.equal(p.blocks[0].s, 480);
});

test("the drag sweep finds the damper setting the simulator likes", () => {
  const { r, text } = run(G.dragSweep(), { dragOpt: 120, spmOpt: 16, seed: 3 });   // damper 5 is drag 120 in the simulator
  assert.equal(r.groups.best, 5, text);
  assert.ok(Math.abs(r.groups.groups.find(g => g.key === 7).drag - 144) < 2);
  noJunk(text);
});

test("the capped row holds heart rate at the ceiling and reports the watts there", () => {
  const sim = { seed: 5, spmOpt: 17, drift: 0.4 };
  const { r, eng, text } = run(G.hrCap({ ceiling: 148, total_s: 1500, start_pace_s: 140 }), sim);
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
  const withDrift = run(G.driftTest({ watts: 140, total_s: 2100 }), { drift: 0.4, seed: 9 }).r.drift.decoupling_pct;
  assert.ok(withDrift > 3 && withDrift < 6, `decoupling ${withDrift}`);
  const none = run(G.driftTest({ watts: 140, total_s: 2100 }), { drift: 0, seed: 9 }).r.drift.decoupling_pct;
  assert.ok(Math.abs(none) < 1, `decoupling without drift ${none}`);
});

test("the step test goes up and back down, so drift doesn't steepen the line", () => {
  const cfg = { mass_kg: 94, hrmax: 195, hr_rest: 42, zone_hr: 148, efficiency: 0.21, notes: [] };
  const p = G.stepTest();
  assert.deepEqual(p.blocks.filter(b => b.role === "test").map(b => b.watts), [110, 140, 170, 170, 140, 110]);
  assert.equal(p.blocks[4].cue, "Stage 4 of 6: stay at 170 watts, pace 2:07, for 3 minutes 20 seconds, then back down the same steps.");
  // the simulator's true slope is 0.55 x (1 + 0.004 for rowing at 16 rather than 17 strokes a minute)
  const truth = 0.55 * 1.004;
  const { r, text } = run(p, { drift: 0.4, seed: 11 }, { hr_rest: 42, cfg });
  assert.equal(r.step.stages.length, 6);
  assert.equal(r.step.balanced, true);
  assert.ok(Math.abs(r.step.line.b - truth) < 0.02, `slope ${r.step.line.b} against ${truth}`);
  assert.ok(Math.abs(r.step.drift_bpm_min - 0.4) < 0.15, `drift ${r.step.drift_bpm_min}`);
  assert.ok(Number.isFinite(r.step.estimate.vo2max));
  assert.match(text, /VO2max estimate/);
  assert.match(text, /drifted about 0\.\d bpm a minute/);
  assert.doesNotMatch(text, /reads your fitness low/);
  noJunk(text);

  // What going back down buys: drift no longer moves the answer. Rowed upwards only, as the step
  // test used to be, the line steepens with drift (about +0.095 at the 0.95 bpm a minute of a real
  // 30-minute row on 22 September 2026); up and down it stays put. The small shortfall that
  // remains, about -0.016 at any drift, is heart rate not quite settling within each stage.
  const up = { ...p, blocks: [p.blocks[0], ...p.blocks.filter(b => b.role === "test").slice(0, 3), p.blocks[p.blocks.length - 1]] };
  const slope = (proto, drift) => run(proto, { drift, seed: 11 }, { hr_rest: 42, cfg }).r.step.line.b;
  const [still, drifting] = [slope(p, 0), slope(p, 0.95)];
  assert.ok(Math.abs(drifting - still) < 0.01, `up and down: ${still} without drift, ${drifting} with`);
  assert.ok(slope(up, 0.95) - truth > 0.06, `upwards only: ${slope(up, 0.95)} against ${truth}`);
});

test("a step test stopped on the way down says its line reads low", () => {
  const cfg = { mass_kg: 94, hrmax: 195, hr_rest: 42, zone_hr: 148, efficiency: 0.21, notes: [] };
  const eng = new G.Engine(G.stepTest()), sim = new SimRower({ drift: 0.4, seed: 11 });
  const stopAt = eng.blocks.filter(b => b.role === "test")[3].end + 30;   // just after the second 170 W stage
  for (let t = 0; t < stopAt; t += 1) {
    const target = eng.started ? eng.target(eng.indexAt(t - eng.t0)) : null;
    for (const rec of sim.advance(t, 1, target)) { eng.begin(rec.t); eng.stroke(simSample(rec)); }
    eng.tick(t, sim.status());
  }
  const r = eng.result({ hr_rest: 42, cfg });
  assert.equal(r.step.balanced, false);
  assert.equal(r.step.stages.length, 4);
  assert.match(G.report(r), /stopped before every power had been rowed on the way back down/);
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
  for (let t = 0; t < 1000; t++) {                     // warm-up 8:00, then 14 to 11:40 and 17 to 15:20
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

test("the plan reads as plain words", () => {
  assert.equal(G.describePlan(G.rateTest({ total_s: 1800 })), "30:00 of rowing: 8:00 warm-up, then 6 blocks of 3:40, then a minute sitting still.");
  assert.equal(G.describePlan(G.hrCap({ total_s: 1500 })), "25:00 of rowing: 5:00 warm-up, then 20:00 of the capped row, then a minute sitting still.");
  assert.match(G.describePlan(G.drillSession({ total_s: 1200, repeats: 3 })), /^20:00 of rowing: 5:00 warm-up, then 3 × \(3:00 drill \+ 2:00 easy\)\.$/);
  assert.match(G.describePlan(G.withReadiness(G.rateTest({ total_s: 1800 }))), /8:00 readiness check/);
});
