// Row names come from files a person picks, so only a start time is accepted as one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRowId } from "../store.js";

test("only a start time is a row's name", () => {
  assert.ok(isRowId("2026-09-22_164718"));
  for (const bad of ['<img src=x onerror="alert(1)">', '2026-09-22_164718"><b>', "2026-09-22_164718 ", "replay", "", null, 20260922])
    assert.equal(isRowId(bad), false, String(bad));
});
