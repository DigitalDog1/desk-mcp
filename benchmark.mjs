import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { summarize } from "./lib/stats.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const repeat = Number(process.env.BENCH_REPEAT ?? 20);
if (!Number.isInteger(repeat) || repeat < 5 || repeat > 100) throw new Error("BENCH_REPEAT must be an integer in 5..100");
if (process.platform !== "win32") throw new Error("This benchmark needs an interactive Windows desktop");
for (const key of ["DESK_DRY_RUN", "DESK_DISABLE_TOOLS", "DESK_ALLOW_TITLES"]) {
  if (process.env[key]) throw new Error("Unset " + key + " before benchmarking");
}
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "desk-mcp-bench-"));
const resultFile = path.join(scratch, "selection.txt");
const filesDir = path.join(process.env.WINDIR ?? "C:/Windows", "Fonts");
const oracle = await Promise.all((await fs.readdir(filesDir)).filter((n) => /\.ttf$/i.test(n)).map(async (name) => ({ name, bytes: (await fs.stat(path.join(filesDir,name))).size })));
oracle.sort((a,b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
if (!oracle.length) throw new Error("No TTF fonts found");
const expected = oracle[0];
const fixture = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", path.join(root, "examples/font-catalog.ps1"), "-ResultPath", resultFile], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let fixtureError = "";
fixture.stderr.on("data", (d) => fixtureError += d);
fixture.on("error", (e) => fixtureError += e.message);
const client = new Client({ name: "desk-mcp-benchmark", version: "1" });
const raw = [];
const report = { schemaVersion: 1, at: new Date().toISOString(), version: JSON.parse(await fs.readFile(path.join(root,"package.json"),"utf8")).version,
  environment: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, node: process.version },
  repeat, warmups: 2, oracle: { rowCount: oracle.length, largest: expected }, raw };
const sleep = (ms) => new Promise((r) => setTimeout(r,ms));
async function call(name, args = {}) {
  const start = performance.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 130_000 });
  const ms = performance.now() - start;
  const text = r.content.filter((v) => v.type === "text").map((v) => v.text).join("\n");
  if (r.isError) throw new Error(text);
  const image = r.content.find((v) => v.type === "image");
  let data; try { data = JSON.parse(text); } catch { data = null; }
  const bytes = Buffer.byteLength(text);
  return { ms, data, textBytes: bytes, imageBytes: image ? Buffer.from(image.data,"base64").length : 0, image };
}
report.sourceSha256 = Object.fromEntries(await Promise.all(["server.mjs", "worker.ps1", "uia-native.cs", "lib/worker.mjs", "lib/cdp.mjs", "lib/batch.mjs", "lib/stats.mjs", "package-lock.json", "benchmark.mjs", "examples/font-catalog.ps1"].map(async (name) => [name, createHash("sha256").update(await fs.readFile(path.join(root,name))).digest("hex")])));
let hwnd;
try {
  const start = performance.now();
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root,"server.mjs")], stderr: "pipe" }));
  report.startupMs = performance.now() - start;
  for (let attempt=0; attempt<100; attempt++) {
    const windows = (await call("computer_windows")).data.windows;
    const win = windows.find((w) => w.process === fixture.pid && w.title.includes("Font Catalog"));
    if (win) { hwnd = win.hwnd; break; }
    if (fixture.exitCode !== null) throw new Error("Fixture exited: " + fixtureError);
    await sleep(100);
  }
  if (!hwnd) throw new Error("Fixture not visible on this desktop: " + fixtureError);
  const meta = (await call("computer_selftest")).data;
  if (!meta.nativeUia) throw new Error("Native UIA unavailable: " + meta.nativeUiaError);
  report.nativeUia = true;
  const cases = [
    ["find_uncached", async () => { await sleep(1250); return call("computer_find", { hwnd, id: "btnSelect", requireUnique: true }); }, (r) => r.data.count === 1],
    ["find_cached", async () => { await call("computer_find", { hwnd, id: "btnReset", requireUnique: true }); return call("computer_find", { hwnd, id: "btnReset", requireUnique: true }); }, (r) => r.data.count === 1],
    ["tree_filtered", () => call("computer_read_screen", { hwnd, maxDepth: 4, maxElements: 3000, interactiveOnly: true, compact: true }), (r) => !r.data.degraded],
    ["table", () => call("computer_read_table", { hwnd, id: "listFonts", maxRows: 2000, headers: false }), (r) => {
      const rows = r.data.table?.rows ?? [];
      return rows.length === oracle.length && oracle.every((f) => rows.some((row) => row[0] === f.name && Number(row[1]) === f.bytes));
    }],
    ["screenshot", () => call("computer_screenshot", { hwnd, format: "png" }), (r) => !!r.image && r.imageBytes > 100]
  ];
  for (let round=-2; round<repeat; round++) {
    // Rotate order to avoid always rewarding the first/last method.
    const ordered = cases.slice(round < 0 ? 0 : round % cases.length).concat(cases.slice(0, round < 0 ? 0 : round % cases.length));
    for (const [name, fn, verify] of ordered) {
      try {
        const r = await fn();
        const sample = { case: name, round, warmup: round < 0, ok: verify(r), ms: r.ms, textBytes: r.textBytes, imageBytes: r.imageBytes };
        if (r.image?.mimeType === "image/png") {
          const image = Buffer.from(r.image.data,"base64"); sample.width = image.readUInt32BE(16); sample.height = image.readUInt32BE(20);
        }
        raw.push(sample);
      } catch (e) { raw.push({ case: name, round, warmup: round < 0, ok: false, error: e.message }); }
    }
  }
  // Complete task: read all rows, compute maximum without the oracle, select, submit.
  // The result file is written by the GUI's click handler and read independently.
  for (let round=-2; round<repeat; round++) {
    await call("computer_invoke", { hwnd, id: "btnReset" });
    for (let i=0; i<50 && await fs.stat(resultFile).then(() => true, () => false); i++) await sleep(10);
    if (await fs.stat(resultFile).then(() => true, () => false)) throw new Error("Reset did not remove the previous result");
    const start = performance.now();
    let calls = 0;
    try {
      const table = await call("computer_read_table", { hwnd, id: "listFonts", maxRows: 2000, headers: false }); calls++;
      const rows = table.data.table.rows;
      if (rows.length !== oracle.length) throw new Error("Incomplete table");
      const candidates = rows.map((row) => ({ name: row[0], bytes: Number(row[1]) })).sort((a,b) => b.bytes-a.bytes || a.name.localeCompare(b.name));
      const choice = candidates[0];
      await call("computer_select", { hwnd, id: "listFonts", value: choice.name }); calls++;
      await call("computer_invoke", { hwnd, id: "btnSelect" }); calls++;
      let actual = "";
      for (let i=0;i<50;i++) { actual = await fs.readFile(resultFile,"utf8").catch(() => ""); if (actual) break; await sleep(10); }
      raw.push({ case: "task_select_largest", round, warmup: round < 0, ok: actual === expected.name && choice.bytes === expected.bytes, ms: performance.now()-start, calls, selected: actual });
    } catch (e) { raw.push({ case: "task_select_largest", round, warmup: round < 0, ok: false, ms: performance.now()-start, calls, error: e.message }); }
  }
  report.summary = Object.fromEntries([...new Set(raw.map((r) => r.case))].map((name) => {
    const samples = raw.filter((r) => r.case === name && !r.warmup);
    const passed = samples.filter((r) => r.ok);
    return [name, { passed: passed.length, failed: samples.length-passed.length, latencyMs: summarize(passed.map((r) => r.ms)), textBytes: summarize(passed.filter((r) => r.textBytes !== undefined).map((r) => r.textBytes)), imageBytes: summarize(passed.filter((r) => r.imageBytes).map((r) => r.imageBytes)) }];
  }));
  const output = path.resolve(process.env.BENCH_OUTPUT ?? path.join(root,"benchmark-results.json"));
  await fs.writeFile(output, JSON.stringify(report,null,2)+"\n");
  console.table(Object.entries(report.summary).map(([name,s]) => ({ case: name, passed: s.passed, failed: s.failed, p50: s.latencyMs?.p50.toFixed(1), p95: s.latencyMs?.p95.toFixed(1) })));
  console.log("Raw results: " + output);
  if (raw.some((r) => !r.ok)) process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  fixture.kill();
  await fs.rm(scratch, { recursive: true, force: true });
}
