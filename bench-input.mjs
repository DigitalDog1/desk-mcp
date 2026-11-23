import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { summarize } from "./lib/stats.mjs";
import { readClipboardText } from "./lib/clipboard-snapshot.mjs";

// Compare complete addressed-input calls against independently observed GUI state.
// Both implementations use the same fixture, one at a time; elementIds stay local
// to the worker that created them. No model latency is included in this benchmark.
const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(process.env.BENCH_OUTPUT ?? path.join(root, "benchmark-input-results.json"));
const repeat = Number(process.env.BENCH_REPEAT ?? 20);
const warmups = 2;
const runId = randomBytes(4).toString("hex");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cases = [
  { name: "type_selector", inputMode: "type", addressing: "selector" },
  { name: "type_elementId", inputMode: "type", addressing: "elementId" },
  { name: "paste_selector", inputMode: "paste", addressing: "selector" },
  { name: "paste_elementId", inputMode: "paste", addressing: "elementId" },
];
const sourceFiles = [
  "package.json", "package-lock.json", "server.mjs", "worker.ps1", "uia-native.cs",
  "lib/worker.mjs", "lib/batch.mjs", "lib/cdp.mjs", "lib/stats.mjs",
];
const implementations = [];
const report = {
  schemaVersion: 1,
  benchmark: "addressed-input",
  at: new Date().toISOString(),
  runId,
  environment: {
    platform: os.platform(), release: os.release(), arch: os.arch(),
    cpu: os.cpus()[0]?.model, node: process.version,
  },
  repeat, warmups,
  method: {
    latency: "MCP computer_set_value call only; preparation and oracle wait excluded",
    percentiles: "p50/p95 use nearest-rank on successful measured samples; any failure, including a warmup, fails the run",
    median: "Middle sorted sample for odd counts; average of the two middle samples for even counts",
    oracle: "Fixture writes its actual text and foreground HWND independently of UIA",
    order: "Rotate cases each round and alternate baseline/candidate order within each pair",
    startState: "Target B is in the background; fixture A has foreground focus",
    clipboard: "A strict text snapshot is required before input; original text is restored, other formats are not preserved",
    pasteComparison: "Both workers share the clipboard; alternating writers can produce mixed latency distributions that do not represent single-worker paste performance",
    sourceHashFormat: "UTF-8 text with LF line endings (BOM preserved)",
  },
  implementations: [],
  raw: [],
  cleanupErrors: [],
};
let scratch;
let fixture;
let fixtureClosed;
let fixtureError;
let fixtureDiagnostics = "";
let clipboardText;
let clipboardCaptured = false;
let fixtureA;
let fixtureB;

const messageOf = error => error?.message ?? String(error);
function appendDiagnostic(current, data) { return (current + String(data)).slice(-16_000); }
async function hashSources(directory, names) {
  return Object.fromEntries(await Promise.all(names.map(async name => [
    name, createHash("sha256").update((await fs.readFile(path.join(directory, name), "utf8")).replace(/\r\n/g, "\n")).digest("hex"),
  ])));
}

async function bounded(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + " timed out")), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function assertFixtureAlive() {
  if (fixtureError) throw new Error("Fixture process failed: " + fixtureError.message);
  if (fixture && (fixture.exitCode !== null || fixture.signalCode !== null)) {
    throw new Error("Fixture exited: " + fixtureDiagnostics);
  }
}

async function state(label, predicate = () => true, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  let last;
  let readError;
  do {
    assertFixtureAlive();
    try {
      last = JSON.parse(await fs.readFile(path.join(scratch, label + ".json"), "utf8"));
      readError = undefined;
      if (predicate(last)) return last;
    } catch (error) {
      // The fixture replaces its JSON file while its UI thread updates state.
      readError = messageOf(error);
    }
    await sleep(25);
  } while (performance.now() < deadline);
  throw new Error("Fixture " + label + " did not reach the expected state: " + JSON.stringify(last ?? readError));
}

async function call(implementation, name, args = {}) {
  const started = performance.now();
  let ms;
  try {
    const result = await implementation.client.callTool(
      { name: "computer_" + name, arguments: args }, undefined, { timeout: 65_000 },
    );
    ms = performance.now() - started;
    const text = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    if (result.isError) throw new Error(text);
    return { data: JSON.parse(text), ms, textBytes: Buffer.byteLength(text) };
  } catch (error) {
    const failure = new Error(messageOf(error));
    failure.ms = ms ?? performance.now() - started;
    throw failure;
  }
}

function verifyElement(element, expected, reference, sameReference) {
  assert.ok(element && typeof element === "object", "Missing final element metadata");
  assert.equal(element.id, "txtMain", "Returned a different control");
  assert.equal(element.type, "Edit");
  assert.equal(element.hwnd, fixtureB.hwnd, "Returned a different window");
  assert.equal(element.value, expected, "Returned value does not match the requested input");
  assert.equal(element.enabled, true);
  assert.equal(element.readOnly, false);
  assert.equal(typeof element.name, "string");
  assert.equal(typeof element.class, "string");
  assert.equal(typeof element.offscreen, "boolean");
  assert.ok(Array.isArray(element.patterns) && element.patterns.includes("ValuePattern"));
  assert.ok(typeof element.elementId === "string" && element.elementId.length > 0);
  if (sameReference) assert.equal(element.elementId, reference.elementId, "The addressed reference changed");
  for (const key of ["x", "y", "w", "h"]) {
    assert.ok(Number.isFinite(element.rect?.[key]), "Missing rectangle coordinate " + key);
  }
  assert.ok(element.rect.w > 0 && element.rect.h > 0, "Returned an empty rectangle");
  assert.deepEqual(element.rect, reference.rect, "Target rectangle changed unexpectedly");
}

async function measure(implementation, testCase, round, position) {
  const value = "Привет 😀 " + runId + " " + testCase.name + " " + String(round + warmups).padStart(3, "0") + " " + implementation.index;
  const sample = {
    implementation: implementation.name, case: testCase.name,
    round, warmup: round < 0, position, sequence: report.raw.length,
    ok: false, phase: "prepare", expected: value,
  };
  report.raw.push(sample);
  let oracleStarted;
  try {
    assertFixtureAlive();
    // The focus call and the independent readiness check are outside the timer.
    const focused = (await call(implementation, "focus", { hwnd: fixtureA.hwnd })).data;
    assert.equal(focused.verified, true, "Could not prepare the background-target scenario");
    await state("A", current => current.foreground === fixtureA.hwnd && current.value === fixtureA.value);
    const target = testCase.addressing === "elementId"
      ? { elementId: implementation.reference.elementId }
      : { hwnd: fixtureB.hwnd, id: "txtMain" };
    sample.phase = "call";
    const result = await call(implementation, "set_value", { ...target, inputMode: testCase.inputMode, value });
    sample.ms = result.ms;
    sample.textBytes = result.textBytes;
    sample.phase = "response";
    assert.equal(result.data.ok, true);
    assert.equal(result.data.verified, true, "The server did not verify the input");
    assert.equal(result.data.via, testCase.inputMode);
    assert.equal(result.data.value, value);
    verifyElement(result.data.element, value, implementation.reference, testCase.addressing === "elementId");
    sample.phase = "oracle";
    oracleStarted = performance.now();
    const actual = await state("B", current => current.value === value && current.foreground === fixtureB.hwnd);
    const untouched = await state("A");
    assert.equal(untouched.value, fixtureA.value, "Input modified the wrong window");
    sample.oracleWaitMs = performance.now() - oracleStarted;
    sample.actual = actual.value;
    sample.foreground = actual.foreground;
    sample.ok = true;
    sample.phase = "complete";
  } catch (error) {
    if (sample.phase === "call" && Number.isFinite(error.ms)) sample.ms = error.ms;
    if (oracleStarted !== undefined) sample.oracleWaitMs = performance.now() - oracleStarted;
    sample.error = messageOf(error);
    console.error("FAIL " + implementation.name + " " + testCase.name + " round " + round + ": " + sample.error);
  }
}

function summarizeReport() {
  report.summary = Object.fromEntries(implementations.map(implementation => [implementation.name,
    Object.fromEntries(cases.map(testCase => {
      const samples = report.raw.filter(sample => sample.implementation === implementation.name && sample.case === testCase.name && !sample.warmup);
      const passed = samples.filter(sample => sample.ok);
      return [testCase.name, {
        passed: passed.length, failed: samples.length - passed.length,
        latencyMs: summarize(passed.map(sample => sample.ms)),
        oracleWaitMs: summarize(passed.map(sample => sample.oracleWaitMs)),
        textBytes: summarize(passed.map(sample => sample.textBytes)),
      }];
    })),
  ]));
  if (implementations.length === 2) {
    report.comparison = Object.fromEntries(cases.map(testCase => {
      const baseline = report.summary.baseline[testCase.name].latencyMs;
      const candidate = report.summary.candidate[testCase.name].latencyMs;
      return [testCase.name, baseline && candidate ? {
        baselineMedianMs: baseline.median, candidateMedianMs: candidate.median,
        baselineP50Ms: baseline.p50, candidateP50Ms: candidate.p50,
        baselineP95Ms: baseline.p95, candidateP95Ms: candidate.p95,
        medianSavedMs: baseline.median - candidate.median,
        medianSpeedup: candidate.median > 0 ? baseline.median / candidate.median : null,
        p50SavedMs: baseline.p50 - candidate.p50,
        p50Speedup: candidate.p50 > 0 ? baseline.p50 / candidate.p50 : null,
      } : null];
    }));
  }
  report.passed = !report.fatalError && report.cleanupErrors.length === 0 &&
    report.raw.length === implementations.length * cases.length * (repeat + warmups) &&
    report.raw.every(sample => sample.ok);
}

try {
  if (process.platform !== "win32") throw new Error("This benchmark needs an unlocked interactive Windows desktop");
  if (!Number.isInteger(repeat) || repeat < 5 || repeat > 100) throw new Error("BENCH_REPEAT must be an integer in 5..100");
  for (const key of ["DESK_DRY_RUN", "DESK_DISABLE_TOOLS", "DESK_ALLOW_TITLES"]) {
    if (process.env[key]) throw new Error("Unset " + key + " before benchmarking");
  }
  const directories = [];
  if (process.env.BENCH_BASELINE_ROOT) directories.push({ name: "baseline", root: await fs.realpath(path.resolve(process.env.BENCH_BASELINE_ROOT)) });
  directories.push({ name: "candidate", root: await fs.realpath(root) });
  if (directories.length === 2 && directories[0].root.toLowerCase() === directories[1].root.toLowerCase()) {
    throw new Error("BENCH_BASELINE_ROOT must point to a separate baseline checkout");
  }
  report.harnessSourceSha256 = await hashSources(root, ["bench-input.mjs", "test/fixtures/hardening.ps1", "lib/stats.mjs", "lib/clipboard-snapshot.mjs"]);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "desk-input-bench-"));
  fixture = spawn("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File",
    path.join(root, "test/fixtures/hardening.ps1"), "-OutputDir", scratch,
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  fixture.stderr.on("data", data => { fixtureDiagnostics = appendDiagnostic(fixtureDiagnostics, data); });
  fixture.on("error", error => { fixtureError = error; });
  fixtureClosed = new Promise(resolve => fixture.once("close", resolve));
  fixtureA = await state("A", current => Number.isInteger(current.hwnd) && current.hwnd > 0, 20_000);
  fixtureB = await state("B", current => Number.isInteger(current.hwnd) && current.hwnd > 0, 20_000);
  assert.notEqual(fixtureA.hwnd, fixtureB.hwnd);
  report.fixture = { process: fixture.pid, hwndA: fixtureA.hwnd, hwndB: fixtureB.hwnd, initialAValue: fixtureA.value };

  for (const [index, directory] of directories.entries()) {
    const implementation = { ...directory, index, diagnostics: "", connected: false };
    implementations.push(implementation);
    const meta = {
      name: directory.name,
      version: JSON.parse(await fs.readFile(path.join(directory.root, "package.json"), "utf8")).version,
      sourceSha256: await hashSources(directory.root, sourceFiles),
    };
    report.implementations.push(meta);
    implementation.client = new Client({ name: "desk-input-benchmark-" + directory.name, version: "1" });
    implementation.transport = new StdioClientTransport({
      command: process.execPath, args: [path.join(directory.root, "server.mjs")],
      cwd: directory.root, stderr: "pipe", env: { ...process.env },
    });
    implementation.transport.stderr.on("data", data => { implementation.diagnostics = appendDiagnostic(implementation.diagnostics, data); });
    const started = performance.now();
    await implementation.client.connect(implementation.transport);
    meta.startupMs = performance.now() - started;
    implementation.connected = true;
    const selftest = (await call(implementation, "selftest")).data;
    assert.equal(selftest.nativeUia, true, "Native UIA is unavailable: " + selftest.nativeUiaError);
    if (!clipboardCaptured) {
      // clipboard_get historically converts read failures to empty text. A
      // benchmark must not overwrite a clipboard it could not back up.
      clipboardText = await readClipboardText();
      clipboardCaptured = true;
    }
    const found = (await call(implementation, "find", { hwnd: fixtureB.hwnd, id: "txtMain", requireUnique: true })).data;
    assert.equal(found.count, 1, "Fixture input was not found uniquely");
    implementation.reference = found.elements[0];
    verifyElement(implementation.reference, fixtureB.value, implementation.reference, true);
  }

  for (let round = -warmups; round < repeat; round++) {
    const offset = (round + warmups) % cases.length;
    const orderedCases = cases.slice(offset).concat(cases.slice(0, offset));
    for (let caseIndex = 0; caseIndex < orderedCases.length; caseIndex++) {
      const testCase = orderedCases[caseIndex];
      // Use the original case index: using its rotated position would cancel
      // the round parity and always put the same implementation first per case.
      const orderedImplementations = (round + warmups + cases.indexOf(testCase)) % 2
        ? [...implementations].reverse() : implementations;
      for (const [position, implementation] of orderedImplementations.entries()) {
        await measure(implementation, testCase, round, position);
      }
    }
    console.log("Completed " + (round < 0 ? "warmup " + (round + warmups + 1) : "round " + (round + 1)) + " of " + (round < 0 ? warmups : repeat));
  }
} catch (error) {
  report.fatalError = messageOf(error);
  console.error(report.fatalError);
} finally {
  // Restore only data captured before the benchmark's first paste operation.
  if (clipboardCaptured) {
    let restored = false;
    let restoreError;
    for (const implementation of [...implementations].reverse().filter(item => item.connected)) {
      try { await call(implementation, "clipboard_set", { text: clipboardText }); restored = true; break; }
      catch (error) { restoreError = messageOf(error); }
    }
    if (!restored) report.cleanupErrors.push("Clipboard text could not be restored: " + restoreError);
  }
  for (const implementation of [...implementations].reverse()) {
    try { if (implementation.client) await bounded(implementation.client.close(), 5000, "MCP client close"); }
    catch (error) { report.cleanupErrors.push(implementation.name + ": " + messageOf(error)); }
    try { if (implementation.transport) await bounded(implementation.transport.close(), 5000, "MCP transport close"); }
    catch (error) { report.cleanupErrors.push(implementation.name + ": " + messageOf(error)); }
  }
  if (fixture) {
    try {
      if (fixture.exitCode === null && fixture.signalCode === null) fixture.kill();
      await bounded(fixtureClosed, 5000, "Fixture shutdown");
    } catch (error) { report.cleanupErrors.push(messageOf(error)); }
  }
  if (scratch) {
    try { await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error) { report.cleanupErrors.push("Fixture files: " + messageOf(error)); }
  }
  summarizeReport();
  if (!report.passed) {
    process.exitCode = 1;
    report.diagnostics = {
      fixture: fixtureDiagnostics,
      implementations: Object.fromEntries(implementations.map(item => [item.name, item.diagnostics])),
    };
  }
  report.finishedAt = new Date().toISOString();
  try {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.table(Object.entries(report.summary).flatMap(([implementation, summaries]) =>
      Object.entries(summaries).map(([name, summary]) => ({
        implementation, case: name, passed: summary.passed, failed: summary.failed,
        median: summary.latencyMs?.median.toFixed(1),
        p50: summary.latencyMs?.p50.toFixed(1), p95: summary.latencyMs?.p95.toFixed(1),
      }))));
    console.log("Raw results: " + output);
  } catch (error) {
    process.exitCode = 1;
    console.error("Could not save benchmark report: " + messageOf(error));
  }
}
