import test from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../lib/stats.mjs";
test("benchmark percentiles use nearest-rank without changing raw samples", () => {
  const samples = [10,1,3,2,4,5,6,7,8,9];
  assert.deepEqual(summarize(samples), { n: 10, min: 1, p50: 5, p95: 10, max: 10 });
  assert.equal(samples[0], 10);
  assert.equal(summarize([]), null);
});
