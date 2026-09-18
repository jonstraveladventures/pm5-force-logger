// The screen wake lock against a stand-in for the browser's API: taken when asked and in view,
// retaken when the page comes back into view, released when no longer wanted, and a refusal
// reported rather than thrown.
import { test } from "node:test";
import assert from "node:assert/strict";

const listeners = {};
let visible = "visible", refuse = false, requests = 0;
class FakeLock {
  constructor() { this.handlers = []; this.released = false; }
  addEventListener(kind, fn) { if (kind === "release") this.handlers.push(fn); }
  async release() { if (this.released) return; this.released = true; this.handlers.forEach(fn => fn()); }
}
let current = null;
globalThis.document = { get visibilityState() { return visible; }, addEventListener: (k, fn) => { listeners[k] = fn; } };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { wakeLock: {
  request: async kind => { assert.equal(kind, "screen"); requests++; if (refuse) throw new Error("NotAllowedError"); current = new FakeLock(); return current; } } } });

const Wake = await import("../wake.js");
const states = [];
Wake.onStatus(s => states.push(s));
const tick = () => new Promise(r => setTimeout(r, 0));

test("takes the lock when asked, and lets it go when not wanted", async () => {
  assert.ok(Wake.supported());
  Wake.keepAwake(true); await tick();
  assert.equal(states.at(-1), "on");
  assert.equal(requests, 1);
  Wake.keepAwake(true); await tick();
  assert.equal(requests, 1, "asking again while held doesn't take a second lock");
  const held = current;
  Wake.keepAwake(false); await tick();
  assert.ok(held.released);
  assert.equal(states.at(-1), "off");
});

test("takes it again when the page comes back into view", async () => {
  Wake.keepAwake(true); await tick();
  const first = current;
  visible = "hidden"; await first.release(); await tick();      // the browser drops it when the tab is hidden
  assert.equal(states.at(-1), "paused");
  listeners.visibilitychange(); await tick();
  assert.equal(current, first, "no request while hidden");
  visible = "visible"; listeners.visibilitychange(); await tick();
  assert.notEqual(current, first);
  assert.equal(states.at(-1), "on");
  Wake.keepAwake(false); await tick();
});

test("waits while hidden, and doesn't retake it once it isn't wanted", async () => {
  visible = "hidden"; const before = requests;
  Wake.keepAwake(true); await tick();
  assert.equal(requests, before, "no request while hidden");
  Wake.keepAwake(false); visible = "visible"; listeners.visibilitychange(); await tick();
  assert.equal(requests, before, "not wanted any more, so not taken on return");
});

test("a refusal is reported, not thrown", async () => {
  refuse = true;
  Wake.keepAwake(true); await tick();
  assert.equal(states.at(-1), "refused");
  refuse = false; Wake.keepAwake(false); await tick();
});
