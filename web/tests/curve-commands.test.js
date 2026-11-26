// Fetching each stroke's force curve by command (ble.js fetchCurves) against a stand-in PM5 that
// rows: stroke state 2 during each drive, 4 during each recovery, the drive's force samples kept
// until they are read, and stroke data (0x0035) at the end of each drive. Its replies come back
// in 20-byte notifications, as a PM5's do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, fetchCurves } from "../ble.js";
import { uuid, CONTROL_SERVICE, ROWING_SERVICE, CMD_CURVE } from "../decode.js";
import { PM_RECEIVE, PM_TRANSMIT, STOP_FLAG, frame, unstuff, hrBeltQueryFrame } from "../csafe.js";
import { Recorder, rebuild } from "../recorder.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what}: not within ${ms} ms`); })]);
const le = (v, n) => Array.from({ length: n }, (_, i) => (v >> (8 * i)) & 0xff);
const strokeData = (n, cs) => Uint8Array.from([...le(cs, 3), ...le(n * 100, 3), 140, 80, ...le(200, 2), ...le(950, 2), ...le(1000, 2), ...le(500, 2), ...le(4000, 2), ...le(n, 2)]);

/** A PM5 that rows `curves` (one per stroke) once row() is called. Options: silent (never answers
 *  the force-curve commands), stuck (the drive never ends), garble ([stroke, read]: that read's
 *  reply arrives with a bad checksum, its points gone as a real lost reply's would be). */
function rowingPM5({ curves = [], driveMs = 80, recoveryMs = 220, silent = false, stuck = false, garble = null } = {}) {
  const listeners = [], strokeListeners = [], asked = [];
  let pending = [], state = 1, buffer = [], stroke = 0, reads = 0;
  const notify = (fs, bytes) => { for (const f of fs) f({ target: { value: new DataView(Uint8Array.from(bytes).buffer) } }); };
  const reply = bytes => setTimeout(() => { for (let i = 0; i < bytes.length; i += 20) notify(listeners, bytes.slice(i, i + 20)); }, 3);
  const tx = { properties: { notify: true }, addEventListener: (_, f) => listeners.push(f), startNotifications: async () => {} };
  const rx = { writeValueWithResponse: async chunk => {
    pending.push(...chunk);
    if (chunk[chunk.length - 1] !== STOP_FLAG) return;
    const content = unstuff(pending.slice(1, -1)).slice(0, -1); pending = [];   // without the flags and checksum
    if (content[0] === 0x1a) {
      const cmd = content[2]; asked.push(cmd);
      if (silent) return;
      if (cmd === 0xbf) return reply(frame([0x05, 0x1a, 3, 0xbf, 1, state]));
      if (cmd === 0x6b) {
        const take = buffer.splice(0, Math.min(content[4], 32) / 2), data = take.flatMap(v => le(v, 2));
        const out = frame([0x05, 0x1a, 35, 0x6b, 33, 2 * take.length, ...data, ...Array(32 - data.length).fill(0)]);
        reads++;
        if (garble && garble[0] === stroke && garble[1] === reads) { out[out.length - 2] ^= 0x01; }
        return reply(out);
      }
    }
    asked.push(content[0]);
    reply(frame([0x05, content[0], 0]));   // anything else: answered with its own command byte
  } };
  const notifying = { uuid: uuid(0x0035), properties: { notify: true }, addEventListener: (_, f) => strokeListeners.push(f), startNotifications: async () => {} };
  const services = {
    [CONTROL_SERVICE]: { getCharacteristic: async u => (u === uuid(PM_RECEIVE) ? rx : u === uuid(PM_TRANSMIT) ? tx : null) },
    [ROWING_SERVICE]: { getCharacteristics: async () => [notifying] },
  };
  const disconnects = [];
  const device = { name: "PM5 stand-in", addEventListener: (_, f) => disconnects.push(f),
    gatt: { connect: async () => ({ getPrimaryService: async u => { if (!services[u]) throw new Error("no such service"); return services[u]; } }), disconnect() {} } };
  Object.defineProperty(globalThis, "navigator", { value: { bluetooth: { requestDevice: async () => device } }, configurable: true, writable: true });
  return {
    asked,
    async row() {
      for (const curve of curves) {
        stroke++; reads = 0;
        state = 2; await sleep(driveMs);
        if (stuck) return;
        buffer.push(...curve);   // the drive's samples, kept until they are read: the spec says a read returns what was recorded since the last
        state = 4; notify(strokeListeners, strokeData(stroke, stroke * 300));
        await sleep(recoveryMs);
        notify(strokeListeners, strokeData(stroke, stroke * 300));   // the second copy, with the recovery time
      }
      state = 0;
    },
    disconnect() { for (const f of disconnects) f(); },
  };
}

/** A Recorder that keeps its raw log in memory, as the page's would be saved. */
function recorder() {
  let n = 0;
  return new Recorder({ store: { putSession: async () => {}, putRaw: async () => {} }, stamp: () => `row${++n}`, checkpointS: 1e9 });
}

const curve = (n, peak) => Array.from({ length: n }, (_, i) => Math.round(peak * Math.sin(Math.PI * (i + 0.5) / n)));

test("each stroke's curve is fetched by command, lands on its stroke, and the raw log rebuilds it", async t => {
  const curves = [curve(20, 110), curve(32, 120), curve(7, 90), curve(45, 241)];   // 241 needs CSAFE stuffing
  const pm5 = rowingPM5({ curves });
  const rec = recorder();
  const pm = await connect({ onNotify: (t, short, b) => rec.packet(t, short, b) });
  rec.start();
  const fetching = fetchCurves(pm, { onReply: (t, raw) => rec.packet(t, 0x0022, raw), pollMs: 10 });
  t.after(() => fetching.stop());
  await pm5.row();
  await sleep(50);
  assert.equal(await fetching.stop(), "stopped");
  const live = rec.session.sortedStrokes();
  assert.deepEqual(live.map(s => s.stroke_count), [1, 2, 3, 4]);
  live.forEach((s, i) => assert.deepEqual(s[CMD_CURVE], curves[i], `stroke ${i + 1}`));
  assert.equal(pm5.asked.filter(c => c === 0x6b).length, 2 + 3 + 1 + 3, "reads until a short one: 20, 32 (16+16+0), 7 and 45 points");
  const out = await rec.finish();
  const again = rebuild(out.id, out.lines);
  assert.deepEqual(again.strokes.map(s => s[CMD_CURVE]), curves, "the raw log rebuilds the same curves");
  assert.ok(out.lines.filter(l => l.uuid === "0022").length < pm5.asked.length, "a stroke-state reply is logged only when the state changes");
});

test("a monitor that never answers the commands: the page stops asking, says so, and other commands still go", async t => {
  const pm5 = rowingPM5({ curves: [curve(20, 100), curve(20, 100)], silent: true });
  const rec = recorder(), notes = [];
  const pm = await connect({ onNotify: (t, short, b) => rec.packet(t, short, b) });
  rec.start();
  const fetching = fetchCurves(pm, { onReply: (t, raw) => rec.packet(t, 0x0022, raw), onNote: (t, text) => notes.push(text), pollMs: 5, timeoutMs: 30, giveUpAfter: 3 });
  t.after(() => fetching.stop());
  const rowing = pm5.row();
  assert.equal(await within(fetching.finished, 1000, "giving up"), "no answer");
  assert.match(notes.join(), /no answer to 3 stroke-state requests/);
  assert.deepEqual(pm5.asked.filter(c => c === 0xbf).length, 3);
  assert.ok(!pm5.asked.includes(0x6b), "no force-plot read without a stroke state");
  const [, resp] = await pm.send(hrBeltQueryFrame(), 500);
  assert.equal(resp[0], 0x7e, "the heart-rate query still gets its own reply");
  await rowing;
  assert.equal(rec.session.strokes.size, 2);
  assert.ok(rec.session.sortedStrokes().every(s => !(CMD_CURVE in s)));
});

test("a stroke that never reaches recovery: no force-plot read, and the queue stays free", async t => {
  const pm5 = rowingPM5({ curves: [curve(20, 100)], stuck: true });
  const replies = [];
  const pm = await connect({ onNotify() {} });
  const fetching = fetchCurves(pm, { onReply: (t, raw) => replies.push(raw), pollMs: 10 });
  t.after(() => fetching.stop());
  await pm5.row();
  await sleep(150);
  const started = Date.now();
  const [, resp] = await pm.send(hrBeltQueryFrame(), 500);
  assert.equal(resp[0], 0x7e);
  assert.ok(Date.now() - started < 100, "another command waits at most one request");
  assert.equal(await fetching.stop(), "stopped");
  assert.ok(pm5.asked.filter(c => c === 0xbf).length >= 5, "the stroke state is asked for throughout");
  assert.ok(!pm5.asked.includes(0x6b), "the force plot is never read");
  assert.equal(replies.length, 1, "one reply logged: the state, which never changed");
});

test("a lost reply mid-curve gives that stroke no curve and leaves the next stroke's intact", async t => {
  const curves = [curve(40, 100), curve(40, 130)];
  const pm5 = rowingPM5({ curves, garble: [1, 2] });
  const rec = recorder();
  const pm = await connect({ onNotify: (t, short, b) => rec.packet(t, short, b) });
  rec.start();
  const fetching = fetchCurves(pm, { onReply: (t, raw) => rec.packet(t, 0x0022, raw), pollMs: 10 });
  t.after(() => fetching.stop());
  await pm5.row();
  await sleep(50);
  await fetching.stop();
  const [first, second] = rec.session.sortedStrokes();
  assert.ok(!(CMD_CURVE in first), "a curve with a gap is not kept");
  assert.deepEqual(second[CMD_CURVE], curves[1], "the rest of the first was read off, so the second starts clean");
  assert.deepEqual(rebuild("x", rec.lines()).strokes.map(s => s[CMD_CURVE] ?? null), [null, curves[1]]);
});

test("fetching stops when the PM5 disconnects", async t => {
  const pm5 = rowingPM5();
  const pm = await connect({ onNotify() {} });
  const fetching = fetchCurves(pm, { onReply() {}, pollMs: 10 });
  t.after(() => fetching.stop());
  await sleep(40);
  pm5.disconnect();
  assert.equal(await within(fetching.finished, 500, "stopping"), "stopped");
});
