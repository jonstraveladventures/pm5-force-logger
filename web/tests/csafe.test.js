// CSAFE framing and workout building against the Python module (whose own tests hold the
// spec's worked examples) plus the framing cases from tests/test_workouts.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as C from "../csafe.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/frames.json", import.meta.url), "utf8"));
const named = C.namedWorkouts(fx.named);
const hx = s => Uint8Array.from(s.replace(/ /g, "").match(/../g).map(x => parseInt(x, 16)));
const hex = b => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");

test("stuffing round trip and a checksum that needs stuffing", () => {
  const raw = Uint8Array.from([0x01, 0xf0, 0xf1, 0xf2, 0xf3, 0x7f]);
  const stuffed = C.stuff(raw);
  assert.deepEqual([...stuffed], [0x01, 0xf3, 0x00, 0xf3, 0x01, 0xf3, 0x02, 0xf3, 0x03, 0x7f]);
  assert.deepEqual([...C.unstuff(stuffed)], [...raw]);
  assert.equal(C.checksum([0x76, 0x84]), 0xf2);
  assert.deepEqual([...C.frame([0x76, 0x84])], [0xf1, 0x76, 0x84, 0xf3, 0x02, 0xf2]);
});

test("a response frame unframes to its status and body", () => {
  const [status, body] = C.unframe(hx("F1 81 76 02 01 13 E7 F2"));
  assert.equal(status, 0x81);
  assert.equal(hex(body), "76020113");
  assert.equal(C.describeStatus(0x81), "ok, state ready");
  assert.throws(() => C.unframe(hx("F1 81 76 02 01 13 E6 F2")), /checksum/);
  assert.throws(() => C.unframe(hx("01 02 03")), /not a CSAFE frame/);
});

test("every workout spec parses, describes and builds exactly as the Python module", () => {
  for (const f of fx.frames) {
    const spec = C.parseSpec(f.text, named);
    assert.deepEqual(spec, f.spec, `parse ${f.text}`);
    assert.deepEqual(C.normalise(spec), f.normalised, `normalise ${f.text}`);
    assert.equal(C.describe(spec), f.description, `describe ${f.text}`);
    assert.equal(hex(C.build(spec)), f.hex, `frame ${f.text}`);
  }
  assert.equal(hex(C.terminateFrame()), fx.terminate_hex);
});

test("bad specs are refused with a reason", () => {
  for (const text of fx.bad) assert.throws(() => C.build(C.parseSpec(text, named)), Error, text);
});

test("default splits follow the Python rules", () => {
  assert.equal(C.defaultSplitM(2000), 400);
  assert.equal(C.defaultSplitM(5000), 1000);
  assert.equal(C.defaultSplitM(100), 100);
  assert.equal(C.defaultSplitS(1200), 240);
  assert.equal(C.defaultSplitS(300), 60);
});

test("heart-rate monitor: the query, the answer and the pairing command", () => {
  // query: start flag, 0x7E wrapper of 3 bytes holding 0x57 with one byte (user 0), checksum 0x2B, stop flag
  assert.equal(hex(C.hrBeltQueryFrame()), "f17e035701002bf2");
  // an answer laid out as the spec gives it: status, then 0x7E 9 0x57 7 user mfg type id (most significant first)
  const [status, body] = C.unframe(C.frame([0x81, 0x7e, 9, 0x57, 7, 0, 1, 120, 0x12, 0x34, 0x56, 0x78]));
  assert.equal(status, 0x81);
  assert.deepEqual(C.parseHrBelt(body), { user: 0, mfg: 1, type: 120, id: 0x12345678 });
  assert.equal(C.parseHrBelt(Uint8Array.from([0x7e, 3, 0x56, 1, 0])), null, "a different command's answer");
  // pairing sends the same seven bytes back, in the 0x77 wrapper with 0x39; a command frame has no
  // status byte, so what unframe calls the status is the wrapper's first byte
  const [first, rest] = C.unframe(C.hrBeltPairFrame({ mfg: 1, type: 120, id: 0x12345678 }));
  assert.equal(hex([first, ...rest]), "770939070001781234" + "5678");
  // a belt ID with its top bit set comes out as a positive number, both ways
  const big = C.unframe(C.frame([0x81, 0x7e, 9, 0x57, 7, 0, 1, 120, 0xf2, 0x00, 0x00, 0x01]))[1];
  assert.equal(C.parseHrBelt(big).id, 0xf2000001);
  const [f2, r2] = C.unframe(C.hrBeltPairFrame({ mfg: 1, type: 120, id: 0xf2000001 }));
  assert.equal(hex([f2, ...r2]).slice(-8), "f2000001");
});
