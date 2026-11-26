// The PM5 over Web Bluetooth (Chrome and Edge; Safari and Firefox don't offer it).
// Mirrors what pm5_logger.py and pm5_workouts.py do with bleak: subscribe to every notifying
// characteristic on the rowing service, read the device information, and write CSAFE frames
// to the control service in 20-byte pieces with the reply collected from its notifications.
import { uuid, ADVERTISED_SERVICE, DEVICE_INFO_SERVICE, CONTROL_SERVICE, ROWING_SERVICE, DEVICE_INFO } from "./decode.js";
import { PM_RECEIVE, PM_TRANSMIT, CHUNK, STOP_FLAG, unframe, strokeStateFrame, forcePlotFrame, curveReply, FORCEPLOT_BLOCK, STROKE_RECOVERY } from "./csafe.js";

export const supported = () => typeof navigator !== "undefined" && !!navigator.bluetooth;

const copy = dv => new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Ask the user for a PM5 and connect. onNotify(t, short, bytes) gets every rowing notification. */
export async function connect({ onNotify, onDisconnect, log = () => {} }) {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: "PM5" }, { services: [ADVERTISED_SERVICE] }],
    optionalServices: [ADVERTISED_SERVICE, DEVICE_INFO_SERVICE, CONTROL_SERVICE, ROWING_SERVICE],
  });
  const pm = { device, info: { name: device.name }, subscribed: [], control: null, connected: false };
  device.addEventListener("gattserverdisconnected", () => { pm.connected = false; onDisconnect?.(pm); });
  log(`connecting to ${device.name}…`);
  const server = await device.gatt.connect();
  pm.connected = true;
  try {   // model, serial, firmware
    const svc = await server.getPrimaryService(DEVICE_INFO_SERVICE);
    for (const [short, key] of Object.entries(DEVICE_INFO)) {
      try {
        const ch = await svc.getCharacteristic(uuid(Number(short)));
        pm.info[key] = new TextDecoder().decode(await ch.readValue()).replace(/\0+$/, "").trim();
      } catch { /* not every firmware exposes every field */ }
    }
  } catch { /* no device-information service */ }
  const rowing = await server.getPrimaryService(ROWING_SERVICE);
  for (const ch of await rowing.getCharacteristics()) {   // everything that notifies, including characteristics newer than the spec
    if (!ch.properties.notify) continue;
    const short = parseInt(ch.uuid.slice(4, 8), 16);
    ch.addEventListener("characteristicvaluechanged", e => onNotify(Date.now() / 1000, short, copy(e.target.value)));
    await ch.startNotifications();   // one GATT operation at a time, so no Promise.all here
    pm.subscribed.push(short);
  }
  try {
    const cs = await server.getPrimaryService(CONTROL_SERVICE);
    const control = { rx: await cs.getCharacteristic(uuid(PM_RECEIVE)), tx: await cs.getCharacteristic(uuid(PM_TRANSMIT)), buf: [], pending: null, notifies: false };
    if (control.tx.properties.notify) {
      control.tx.addEventListener("characteristicvaluechanged", e => {
        const b = copy(e.target.value);
        control.buf.push(...b);
        if (b[b.length - 1] === STOP_FLAG && control.pending) { const got = Uint8Array.from(control.buf); control.buf = []; control.pending(got); control.pending = null; }
      });
      await control.tx.startNotifications();
      control.notifies = true;
    }
    pm.control = control;
  } catch { /* no control service: recording still works, programming doesn't */ }
  pm.disconnect = () => { try { device.gatt.disconnect(); } catch { /* already gone */ } };
  // one CSAFE command at a time: a second one sent while the first waits for its reply would
  // empty the reply buffer and take the first one's reply (the monitor check on connecting and a
  // workout sent straight after it, say)
  let queue = Promise.resolve();
  pm.request = (frame, timeoutMs = 3000) => {   // the reply frame as it came
    const run = queue.then(() => exchange(pm, frame, timeoutMs));
    queue = run.catch(() => {});
    return run;
  };
  pm.send = async (frame, timeoutMs) => unframe(await pm.request(frame, timeoutMs));   // [status, responses]
  log(`subscribed: ${pm.subscribed.map(s => s.toString(16).padStart(4, "0")).join(" ")}`);
  return pm;
}

/** Write one CSAFE frame to the PM5 and return its reply frame. */
async function exchange(pm, data, timeoutMs) {
  const c = pm.control;
  if (!c) throw new Error("this PM5 offers no control service, so a workout can't be programmed from here");
  let reply;
  if (c.notifies) {
    reply = new Promise((resolve, reject) => {
      c.buf = []; c.pending = resolve;
      setTimeout(() => { if (c.pending === resolve) { c.pending = null; reject(new Error(`no reply from the PM5 within ${timeoutMs / 1000} s`)); } }, timeoutMs);
    });
  }
  try {
    for (let i = 0; i < data.length; i += CHUNK) {
      const chunk = data.slice(i, i + CHUNK);
      if (c.rx.writeValueWithResponse) await c.rx.writeValueWithResponse(chunk); else await c.rx.writeValue(chunk);
    }
  } catch (e) { c.pending = null; throw e; }   // the write failed (the PM5 gone): no reply to wait for
  if (!c.notifies) {   // older firmware: the reply is read back from the characteristic
    const deadline = Date.now() + timeoutMs;
    let got = new Uint8Array();
    while (Date.now() < deadline) {
      await sleep(200);
      got = copy(await c.tx.readValue());
      if (got.length && got[got.length - 1] === STOP_FLAG) break;
    }
    return got;
  }
  return reply;
}

/** Fetch each stroke's force curve by command, for a PM5 that doesn't send it (Concept2's "Get
 *  Force Curve" example, spec rev 0.36): ask for the stroke state every `pollMs`; when the stroke
 *  enters recovery, read the force-plot data until a read comes back short. Every request goes
 *  through the queue above, so a workout or the heart-rate pairing waits at most one request.
 *  onReply(t, frame) gets each force-plot reply and each stroke-state reply that differs from the
 *  last: the page logs them (uuid 0022) and its Session turns them into force_curve_cmd. If the
 *  PM5 leaves `giveUpAfter` stroke-state requests running unanswered, it stops and says so through
 *  onNote(t, text). Returns {stop(), finished}; it also stops when the PM5 disconnects. */
export function fetchCurves(pm, { onReply, onNote = () => {}, pollMs = 100, timeoutMs = 1000, giveUpAfter = 5, maxReads = 16, now = () => Date.now() / 1000 } = {}) {
  let running = true;
  const ask = async frame => { try { const raw = await pm.request(frame, timeoutMs); return [raw, curveReply(raw)]; } catch { return [null, null]; } };
  const finished = (async () => {
    let last = null, read = false, misses = 0;
    while (running && pm.connected) {
      const [raw, r] = await ask(strokeStateFrame());
      if (!running) break;
      if (!r || !("state" in r)) {
        if (++misses >= giveUpAfter) {
          onNote(now(), `stopped asking for force curves: no answer to ${misses} stroke-state requests running`);
          return "no answer";
        }
      } else {
        misses = 0;
        if (r.state !== last) { onReply(now(), raw); last = r.state; }
        if (r.state !== STROKE_RECOVERY) read = false;
        else if (!read) {   // once per recovery
          read = true;
          // after a read that gets no good reply, the rest is still read off, so that it doesn't
          // open the next stroke's curve, but not passed on: the curve would have a gap, and the
          // Session drops a curve that never got its short read
          let lost = 0;
          for (let k = 0; k < maxReads && running; k++) {
            const [raw2, r2] = await ask(forcePlotFrame());
            if (!r2 || !("bytes" in r2)) { if (++lost >= 2) break; continue; }
            if (!lost) onReply(now(), raw2);
            if (r2.bytes < FORCEPLOT_BLOCK) break;
          }
        }
      }
      await sleep(pollMs);
    }
    return "stopped";
  })();
  return { stop() { running = false; return finished; }, finished };
}
