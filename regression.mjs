import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// Interactive Windows regression suite. All actions target disposable fixture windows.
const root = path.dirname(fileURLToPath(import.meta.url));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-hardening-"));
const fixture = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", path.join(root, "test/fixtures/hardening.ps1"), "-OutputDir", dir], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let diagnostics = "";
fixture.stderr.on("data", d => diagnostics += d);
const c = new Client({ name: "desk-hardening-test", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "server.mjs")], stderr: "pipe", env: { ...process.env, DESK_UIA_DIAG: "1", DESK_UI_TIMEOUT_MS: "15000" } });
transport.stderr.on("data", d => diagnostics += d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function state(label) {
  for (let i = 0; i < 200; i++) {
    try { return JSON.parse(await fs.readFile(path.join(dir, label + ".json"), "utf8")); }
    catch { if (fixture.exitCode !== null) throw new Error(diagnostics); await sleep(25); }
  }
  throw new Error("Fixture did not publish state: " + diagnostics);
}
async function until(label, check) {
  for (let i = 0; i < 100; i++) { const s = await state(label); if (check(s)) return s; await sleep(25); }
  throw new Error("Independent fixture state did not match: " + JSON.stringify(await state(label)));
}
async function call(name, args = {}, options) {
  const result = await c.callTool({ name: "computer_" + name, arguments: args }, undefined, { timeout: 65000, ...options });
  const text = result.content.find(x => x.type === "text")?.text ?? "";
  if (result.isError) return { error: text, code: /code: (\w+)/.exec(text)?.[1] };
  return JSON.parse(text);
}
function success(data) { assert.equal(data.error, undefined, data.error); return data; }
const passed = [];
async function check(name, fn) { await fn(); passed.push(name); console.log("PASS " + name); }
let clipboard;
try {
  await c.connect(transport);
  const A = await state("A"), B = await state("B");
  await check("native UIA compiles and is available", async () => {
    const info = success(await call("selftest"));
    assert.equal(info.nativeUia, true, JSON.stringify(info));
  });
  clipboard = success(await call("clipboard_get"));
  await check("unscoped mutations fail before dispatch", async () => {
    for (const [tool, args] of [["invoke", {}], ["set_value", { value: "UNSAFE" }], ["select", { value: "Beta" }], ["select_text", { text: "seed" }]]) {
      assert.equal((await call(tool, args)).code, "InvalidArgument", tool);
    }
    assert.equal((await state("A")).clicks, 0);
    assert.equal((await state("A")).value, "seed");
  });
  await check("click coordinates move the pointer and trigger the target", async () => {
    success(await call("focus", { hwnd: A.hwnd }));
    await until("A", s => s.foreground === A.hwnd);
    const rect = success(await call("find", { hwnd: A.hwnd, id: "btnOk" })).elements[0].rect;
    success(await call("move", { x: rect.x + 10, y: rect.y + rect.h + 30 }));
    const x = rect.x + Math.floor(rect.w / 2), y = rect.y + Math.floor(rect.h / 2);
    success(await call("click", { x, y }));
    const s = await until("A", s => s.clicks === 1);
    assert.equal(s.cursorX, x); assert.equal(s.cursorY, y);
  });
  await check("focus addresses the chosen hwnd in a multi-window process", async () => {
    const result = success(await call("focus", { hwnd: B.hwnd }));
    assert.equal(result.verified, true);
    await until("B", s => s.foreground === B.hwnd);
  });
  await check("window frames address the selected hwnd", async () => {
    success(await call("window_set_frame", { hwnd: B.hwnd, x: 900, y: 180, width: 700, height: 650 }));
    await until("B", s => s.x === 900 && s.y === 180 && s.width === 700 && s.height === 650);
    assert.equal((await state("A")).x, 80);
  });
  for (const inputMode of ["type", "paste"]) await check(inputMode + " activates and verifies the background target", async () => {
    success(await call("focus", { hwnd: A.hwnd }));
    await until("A", s => s.foreground === A.hwnd);
    const value = inputMode + " Привет 😀";
    const result = success(await call("set_value", { hwnd: B.hwnd, id: "txtMain", inputMode, value }));
    assert.equal(result.verified, true);
    await until("B", s => s.value === value && s.foreground === B.hwnd);
    assert.equal((await state("A")).value, "seed");
  });
  await check("empty paste clears the addressed field", async () => {
    const result = success(await call("set_value", { hwnd: B.hwnd, id: "txtMain", inputMode: "paste", value: "" }));
    assert.equal(result.verified, true);
    await until("B", s => s.value === "");
  });
  await check("read-only input is rejected before sending keys", async () => {
    assert.equal((await call("set_value", { hwnd: B.hwnd, id: "txtReadonly", inputMode: "type", value: "must-not-claim-success" })).code, "PatternUnavailable");
  });
  await check("rejected keyboard input never returns a false success", async () => {
    const outcome = await call("set_value", { hwnd: B.hwnd, id: "txtDigits", inputMode: "type", value: "rejected" });
    assert.equal(outcome.code, "InputNotVerified");
    assert.equal((await state("B")).digits, "");
    assert.equal((await state("A")).value, "seed");
  });
  await check("large lists do not hide neighboring shallow controls", async () => {
    for (const id of ["btnOk", "cmbOptions", "tabsMain"]) {
      assert.equal(success(await call("find", { hwnd: B.hwnd, id })).elements[0].id, id);
    }
  });
  await check("exhausted search does not claim ElementNotFound", async () => {
    assert.equal((await call("find", { hwnd: B.hwnd, id: "missing-deep-control", maxDepth: 1 })).code, "SearchIncomplete");
  });
  await check("table limits bound rows and columns", async () => {
    const result = success(await call("read_table", { hwnd: B.hwnd, id: "lvData", maxRows: 3, maxColumns: 1, headers: false }));
    assert.equal(result.table.rows.length, 3);
    assert.ok(result.table.rows.every(row => row.length === 1));
  });
  await check("full reads preserve the auto baseline", async () => {
    const opts = { hwnd: A.hwnd, backend: "uia", mode: "auto", maxDepth: 5, maxElements: 100 };
    const first = success(await call("read_screen", opts));
    success(await call("read_screen", { ...opts, mode: "full" }));
    assert.equal(success(await call("read_screen", { ...opts, since: first.token })).kind, "diff");
  });
  await check("batch deadline returns partial results and prevents late actions", async () => {
    const before = (await state("B")).value;
    const result = success(await call("batch", { timeoutMs: 200, steps: [
      { tool: "computer_cursor" },
      { tool: "computer_wait", args: { ms: 1000 }, stopOnError: false },
      { tool: "computer_set_value", args: { hwnd: B.hwnd, id: "txtMain", value: "LATE" } },
    ] }));
    assert.equal(result.executed, 2); assert.equal(result.stoppedAt, 1);
    assert.equal(result.steps[0].ok, true); assert.equal(result.steps[1].code, "Timeout");
    await sleep(1100); assert.equal((await state("B")).value, before);
  });
  await check("client cancellation prevents subsequent batch actions", async () => {
    success(await call("cursor"));
    const before = (await state("B")).value;
    const controller = new AbortController();
    const pending = call("batch", { steps: [
      { tool: "computer_wait", args: { ms: 1000 } },
      { tool: "computer_set_value", args: { hwnd: B.hwnd, id: "txtMain", value: "CANCELLED-LATE" } },
    ] }, { signal: controller.signal }).then(() => null, error => error);
    await sleep(200); controller.abort();
    assert.ok(await pending);
    await sleep(1100); assert.equal((await state("B")).value, before);
  });
  await check("closing a secondary hwnd leaves the first window alive", async () => {
    success(await call("focus", { hwnd: A.hwnd }));
    await until("A", s => s.foreground === A.hwnd);
    success(await call("close_window", { hwnd: B.hwnd, confirm: true }));
    await until("A", s => s.otherClosed === true);
  });
  // Restore the clipboard before deliberately blocking the fixture's UI thread.
  if (clipboard) { success(await call("clipboard_set", { text: clipboard.text ?? "" })); clipboard = undefined; }
  await check("native UIA timeout trips the breaker without a PowerShell retry", async () => {
    success(await call("focus", { hwnd: A.hwnd }));
    const button = success(await call("find", { hwnd: A.hwnd, id: "btnHang" })).elements[0].rect;
    success(await call("click", { x: button.x + 20, y: button.y + 10 }));
    await sleep(100);
    const started = performance.now();
    assert.equal((await call("find", { hwnd: A.hwnd, id: "btnOk" })).code, "Timeout");
    assert.ok(performance.now() - started < 10000, "native timeout must not retry the same hung provider");
    assert.equal((await call("find", { hwnd: A.hwnd, id: "btnOk" })).code, "UIABlocked");
  });
  console.log(JSON.stringify({ passed: passed.length, checks: passed }, null, 2));
} catch (error) { console.error(diagnostics); throw error; } finally {
  if (clipboard) await call("clipboard_set", { text: clipboard.text ?? "" }).catch(() => {});
  fixture.kill();
  await c.close();
  await fs.rm(dir, { recursive: true, force: true });
}
