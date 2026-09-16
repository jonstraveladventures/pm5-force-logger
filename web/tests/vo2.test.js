// The fitness estimate against pm5_vo2.py on the same synthetic rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as V from "../vo2.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/vo2.json", import.meta.url), "utf8"));
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const closeObj = (a, b, msg) => {
  if (a === null || b === null) return assert.equal(a, b, msg);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${msg} keys`);
  for (const k of Object.keys(b)) typeof b[k] === "number" ? close(a[k], b[k], `${msg}.${k}`) : assert.deepEqual(a[k], b[k], `${msg}.${k}`);
};

test("oxygen cost and the line through rest match the Python arithmetic", () => {
  close(V.vo2(300, 85), fx.vo2_300w_85kg, "vo2");
  close(V.wattsAt(148, 150, 146, 42), fx.watts_at, "wattsAt");
});

test("each row's steady window, point and estimate agree with Python", () => {
  for (const [name, sess] of fx.rows) {
    closeObj(V.rowPoint(sess), fx.points[name], `point ${name}`);
    closeObj(V.estimate(sess, fx.cfg), fx.estimates[name], `estimate ${name}`);
  }
});

test("the pooled fit and the report text agree with Python", () => {
  const points = fx.rows.map(([, s]) => V.estimate(s, fx.cfg)).filter(e => e && !e.error);
  closeObj(V.pooled(points, fx.cfg), fx.pooled, "pooled");
  assert.equal(V.report(fx.rows, fx.cfg), fx.report);
  assert.equal(V.report(fx.rows.slice(0, 2), { ...fx.cfg, notes: ["HRmax is 220 - age"] }), fx.report_two);
});

test("settings: defaults, the age fallback and missing inputs", () => {
  for (const { env, expected } of fx.settings) closeObj(V.settings(env), expected, JSON.stringify(env));
  assert.throws(() => V.settings({ PM5_MASS_KG: "eighty", PM5_HRMAX: "190" }), /not a number/);
  assert.throws(() => V.settings({ PM5_MASS_KG: "80", PM5_HRMAX: "150", PM5_HR_REST: "160" }), /below/);
});
