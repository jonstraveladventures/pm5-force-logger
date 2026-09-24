// The recorded voice: numbers read the way a rower says them, and every sentence a session can
// speak is on the list the recordings are made from.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as G from "../guided.js";
import { SimRower, simSample } from "../sim.js";
import { words, paceWords, durationWords, say, allSentences, clipId, FIXED } from "../voice.js";

test("numbers, paces and lengths of time in words", () => {
  assert.equal(words(0), "zero");
  assert.equal(words(17), "seventeen");
  assert.equal(words(40), "forty");
  assert.equal(words(151), "one hundred and fifty-one");
  assert.equal(words(200), "two hundred");
  assert.equal(paceWords(132), "two twelve");
  assert.equal(paceWords(128), "two oh eight");
  assert.equal(paceWords(120), "two flat");
  assert.equal(paceWords(131.6), "two twelve", "rounded as the screen shows it");
  assert.equal(durationWords(60), "one minute");
  assert.equal(durationWords(90), "one and a half minutes");
  assert.equal(durationWords(210), "three and a half minutes");
  assert.equal(durationWords(220), "three minutes forty seconds");
  assert.equal(durationWords(45), "forty-five seconds");
  assert.equal(durationWords(1800), "thirty minutes");
  assert.equal(say.ratio(2.5), "Recovery at least two and a half times as long as the drive.");
  assert.equal(say.ratio(2.3), null, "no spoken form: the browser's voice says that cue");
});

test("every recording has a file name of its own", () => {
  const all = allSentences(), ids = all.map(clipId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => /^[a-z0-9-]+$/.test(id)));
  assert.ok(all.length > 1000 && all.length < 2500, `${all.length} sentences`);
});

/** Run a protocol against the simulator and collect everything it said. */
function spoken(protocol, simOpts = {}) {
  const eng = new G.Engine(protocol), sim = new SimRower(simOpts), said = [{ say: [G.titleSay(protocol.kind), FIXED.ready, ...eng.firstSay()] }];
  for (let t = 0; t < eng.total + 600 && !eng.done; t += 1) {
    const target = eng.started ? eng.target(eng.indexAt(t - eng.t0)) : null;
    for (const rec of sim.advance(t, 1, target)) { eng.begin(rec.t); said.push(...eng.stroke(simSample(rec))); }
    said.push(...eng.tick(t, { ...sim.status(), hr: t % 400 < 60 && t > 600 ? null : sim.status().hr }));   // heart rate drops out now and then
  }
  return said;
}

test("everything every protocol says, with its default settings, is recorded", () => {
  const have = new Set(allSentences());
  for (const [kind, def] of Object.entries(G.PROTOCOLS)) {
    const params = Object.fromEntries(def.fields.map(([name, , dflt, type]) => [name, G.parseField(dflt, type)]));
    for (const protocol of [def.build(params), G.withReadiness(def.build(params))]) {
      const said = spoken(protocol, { seed: 4, spmOpt: 17 });
      for (const ev of said) {
        assert.ok(ev.say && ev.say.length, `${kind}: "${ev.text}" has no sentences`);
        for (const s of ev.say) assert.ok(have.has(s), `${kind}: "${s}" is not recorded`);
      }
      for (const s of G.sentencesFor(protocol)) assert.ok(have.has(s), `${kind}: "${s}" is fetched but not recorded`);
      const fetched = new Set(G.sentencesFor(protocol));
      for (const ev of said) for (const s of ev.say) assert.ok(fetched.has(s) || s === FIXED.stopped, `${kind}: "${s}" is said but not fetched before the start`);
    }
  }
});

test("the capped row's steering stays within the sentences fetched for it", () => {
  const protocol = G.hrCap({ ceiling: 140, total_s: 1500, start_pace_s: 125 });   // a ceiling it will press against
  const fetched = new Set(G.sentencesFor(protocol));
  const said = spoken(protocol, { seed: 8, spmOpt: 17, drift: 0.9 });
  const steering = said.filter(ev => /Heart rate|Pace|Ease off/.test(ev.text));
  assert.ok(steering.length > 3, "it steered");
  for (const ev of steering) for (const s of ev.say) assert.ok(fetched.has(s), `"${s}" not fetched`);
});
