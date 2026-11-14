import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { Worker } from "../lib/worker.mjs";

function fixture(options = {}) {
  const children = [];
  const spawnProcess = () => {
    const p = new EventEmitter();
    p.exitCode = p.signalCode = null;
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    p.requests = [];
    p.stdin = new Writable({ write(chunk, encoding, callback) { p.requests.push(JSON.parse(chunk)); callback(); } });
    p.kill = () => { p.exitCode = 1; p.emit("exit", 1); p.emit("close"); };
    p.respond = (msg) => p.stdout.write("B64:" + Buffer.from(JSON.stringify(msg)).toString("base64") + "\n");
    children.push(p);
    return p;
  };
  return { children, worker: new Worker("worker.ps1", { spawnProcess, restartDelayMs: 0, readyTimeoutMs: 200, ...options }) };
}
const tick = () => new Promise((r) => setImmediate(r));

test("concurrent startup creates one worker and waits for readiness", async () => {
  const { worker, children } = fixture();
  const a = worker.call("a", {}, 500), b = worker.call("b", {}, 500);
  await tick();
  assert.equal(children.length, 1);
  assert.equal(children[0].requests.length, 0);
  children[0].respond({ id: 0, data: { ready: true } });
  await tick();
  for (const req of children[0].requests) children[0].respond({ id: req.id, ok: true, data: req.tool });
  assert.deepEqual(await Promise.all([a,b]), ["a", "b"]);
  await worker.stop();
});

test("spawn failure rejects ready immediately with a typed error", async () => {
  const { worker, children } = fixture();
  const ready = worker.start();
  children[0].emit("error", new Error("ENOENT"));
  await assert.rejects(ready, { code: "NotSupported" });
  assert.equal(worker.alive, false);
});

test("startup timeout kills the process and the next call can recover", async () => {
  const { worker, children } = fixture({ readyTimeoutMs: 15 });
  await assert.rejects(worker.start(), { code: "WorkerRestarted" });
  assert.equal(worker.alive, false);
  const next = worker.call("a", {}, 500);
  await tick();
  children[1].respond({ id: 0, data: {} });
  await tick();
  children[1].respond({ id: children[1].requests[0].id, ok: true, data: 42 });
  assert.equal(await next, 42);
  await worker.stop();
});

test("timeout rejects all in-flight calls and ignores late replies from the old process", async () => {
  const { worker, children } = fixture();
  worker.start(); children[0].respond({ id: 0, data: {} });
  const results = Promise.allSettled([worker.call("a", {}, 15), worker.call("b", {}, 500)]);
  const r = await results;
  assert.equal(r[0].reason.code, "Timeout");
  assert.equal(r[1].reason.code, "WorkerRestarted");
  assert.equal(worker.pending.size, 0);
  assert.equal(worker.alive, false);
  const next = worker.call("c", {}, 500);
  await tick(); children[1].respond({ id: 0, data: {} }); await tick();
  const id = children[1].requests[0].id;
  children[0].respond({ id, ok: true, data: "stale" });
  children[1].respond({ id, ok: true, data: "fresh" });
  assert.equal(await next, "fresh");
  await worker.stop();
});

test("a request expiring during startup never executes later", async () => {
  const { worker, children } = fixture();
  await assert.rejects(worker.call("invoke", {}, 10), { code: "Timeout" });
  children[0].respond({ id: 0, data: {} });
  await tick();
  assert.deepEqual(children[0].requests, []);
  await worker.stop();
});

test("broken stdin rejects calls instead of crashing with an unhandled error", async () => {
  const { worker, children } = fixture();
  worker.start(); children[0].respond({ id: 0, data: {} });
  const result = worker.call("a", {}, 500);
  await tick(); children[0].stdin.emit("error", new Error("EPIPE"));
  await assert.rejects(result, { code: "WorkerRestarted" });
  assert.equal(worker.pending.size, 0);
});

test("shutdown cancels pending restart backoff without spawning another worker", async () => {
  const { worker, children } = fixture({ restartDelayMs: 50 });
  const result = worker.call("invoke", {}, 500);
  await worker.stop();
  await assert.rejects(result, { code: "WorkerRestarted" });
  assert.equal(children.length, 0);
});

for (const [diagnostic, code] of [["ScriptContainedMaliciousContent", "SecurityBlocked"], ["AuditUnavailable: denied", "AuditUnavailable"]]) {
  test("startup reports " + code + " instead of a generic worker exit", async () => {
    const { worker, children } = fixture();
    const ready = worker.start();
    children[0].stderr.write(diagnostic);
    children[0].kill();
    await assert.rejects(ready, { code });
    assert.equal(worker.alive, false);
  });
}

test("cancelling during startup never dispatches the action", async () => {
  const { worker, children } = fixture();
  const controller = new AbortController();
  const result = worker.call("invoke", {}, 500, { signal: controller.signal });
  await tick();
  controller.abort();
  await assert.rejects(result, { code: "Cancelled" });
  children[0].respond({ id: 0, data: {} });
  await tick();
  assert.deepEqual(children[0].requests, []);
  await worker.stop();
});

test("cancelling sent work kills its worker and rejects queued work", async () => {
  const { worker, children } = fixture();
  worker.start(); children[0].respond({ id: 0, data: {} });
  const controller = new AbortController();
  const result = Promise.allSettled([
    worker.call("wait", { ms: 1000 }, 500, { signal: controller.signal }),
    worker.call("invoke", {}, 500),
  ]);
  await tick(); controller.abort();
  const responses = await result;
  assert.equal(responses[0].reason.code, "Cancelled");
  assert.equal(responses[1].reason.code, "WorkerRestarted");
  assert.equal(worker.alive, false);
  assert.equal(worker.pending.size, 0);
});
