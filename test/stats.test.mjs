import test from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../lib/stats.mjs";
test("benchmark percentiles use nearest-rank without changing raw samples", () => {
  const samples = [10,1,3,2,4,5,6,7,8,9];
  assert.deepEqual(summarize(samples), { n: 10, min: 1, median: 5.5, p50: 5, p95: 10, max: 10 });
  assert.equal(samples[0], 10);
  assert.equal(summarize([]), null);
});

test("even bimodal samples distinguish midpoint median from nearest-rank p50", () => {
  const samples = Object.freeze([5100, 80, 5090, 70]);
  assert.deepEqual(summarize(samples), { n: 4, min: 70, median: 2585, p50: 80, p95: 5100, max: 5100 });
  assert.deepEqual(samples, [5100, 80, 5090, 70]);
});

test("odd and singleton samples retain their central value without reordering inputs", () => {
  const samples = Object.freeze([201, 115, 178]);
  assert.deepEqual(summarize(samples), { n: 3, min: 115, median: 178, p50: 178, p95: 201, max: 201 });
  assert.deepEqual(samples, [201, 115, 178]);
  assert.deepEqual(summarize([7]), { n: 1, min: 7, median: 7, p50: 7, p95: 7, max: 7 });
});
