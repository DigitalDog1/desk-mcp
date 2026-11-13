import test from "node:test";
import assert from "node:assert/strict";
import { resolveArgs } from "../lib/batch.mjs";
const done = [{ index: 0, ok: true, data: { hwnd: 123, enabled: false, элементы: [{ имя: "Поиск" }], points: [[1,2],[3,4]] } }];

test("batch references preserve numeric, boolean and array types", () => {
  const r = resolveArgs({ hwnd: "${steps.0.hwnd}", enabled: "${steps.0.enabled}", points: "${steps.0.points}" }, done);
  assert.equal(r.hwnd, 123); assert.equal(r.enabled, false); assert.deepEqual(r.points, [[1,2],[3,4]]);
});
test("references work inside arrays, interpolated text and Cyrillic paths", () => {
  const r = resolveArgs({ text: "found: ${steps.0.элементы[0].имя}", nested: ["${steps.0.hwnd}"] }, done);
  assert.equal(r.text, "found: Поиск"); assert.deepEqual(r.nested, [123]);
});
test("missing, forward, malformed and prototype references fail closed", () => {
  for (const ref of ["${steps.1.hwnd}", "${steps.0.missing}", "${steps.0.constructor}", "${steps.oops}"]) {
    assert.throws(() => resolveArgs({ text: ref }, done), { code: "InvalidArgument" });
  }
});
test("failed steps cannot supply arguments to a later action", () => {
  assert.throws(() => resolveArgs({ text: "${steps.0.hwnd}" }, [{ index: 0, ok: false, error: "failed" }]), { code: "InvalidArgument" });
});
