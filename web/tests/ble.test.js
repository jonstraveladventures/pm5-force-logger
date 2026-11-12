// The Web Bluetooth layer against a stand-in PM5: CSAFE commands go one at a time, each getting
// its own reply, however quickly they are sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../ble.js";
import { uuid, CONTROL_SERVICE, ROWING_SERVICE } from "../decode.js";
import { PM_RECEIVE, PM_TRANSMIT, STOP_FLAG, frame } from "../csafe.js";

/** A PM5 whose control service answers each complete frame, after `delayMs`, with status = the
 *  frame's first content byte, so each reply says which command it answers; it never answers the
 *  bytes in `silent`. */
function standIn({ delayMs = 20, silent = [] } = {}) {
  const written = [], listeners = [];
  let pending = [];
  const tx = { properties: { notify: true }, addEventListener: (_, f) => listeners.push(f), startNotifications: async () => {} };
  const rx = { writeValueWithResponse: async chunk => {
    written.push(Uint8Array.from(chunk)); pending.push(...chunk);
    if (chunk[chunk.length - 1] !== STOP_FLAG) return;
    const tag = pending[1]; pending = [];
    if (silent.includes(tag)) return;
    setTimeout(() => { const v = frame([tag, 0]); for (const f of listeners) f({ target: { value: new DataView(v.buffer) } }); }, delayMs);
  } };
  const services = {
    [CONTROL_SERVICE]: { getCharacteristic: async u => (u === uuid(PM_RECEIVE) ? rx : u === uuid(PM_TRANSMIT) ? tx : null) },
    [ROWING_SERVICE]: { getCharacteristics: async () => [] },
  };
  const device = { name: "PM5 stand-in", addEventListener() {},
    gatt: { connect: async () => ({ getPrimaryService: async u => { if (!services[u]) throw new Error("no such service"); return services[u]; } }) } };
  Object.defineProperty(globalThis, "navigator", { value: { bluetooth: { requestDevice: async () => device } }, configurable: true, writable: true });
  return { written };
}

test("two commands sent together each get their own reply", async () => {
  const pm5 = standIn();
  const pm = await connect({ onNotify() {} });
  const long = frame([0x41, ...Array(30).fill(0x10)]);   // two 20-byte writes
  const [a, b] = await Promise.all([pm.send(long), pm.send(frame([0x42]))]);
  assert.equal(a[0], 0x41, "the first command's reply goes to the first command");
  assert.equal(b[0], 0x42, "and the second's to the second");
  assert.deepEqual(pm5.written.map(w => w.length), [20, long.length - 20, 4], "the second frame is written after the first is answered");
});

test("a command that gets no reply fails on its own and does not hold up the next", async () => {
  standIn({ silent: [0x43] });
  const pm = await connect({ onNotify() {} });
  const first = pm.send(frame([0x43]), 50);
  const second = pm.send(frame([0x44]), 1000);
  await assert.rejects(first, /no reply/);
  assert.equal((await second)[0], 0x44);
});
