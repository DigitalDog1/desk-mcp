import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("../server.mjs", import.meta.url));

test("MCP schemas, canonical disabled aliases and dry-run hold through batch", { skip: process.platform !== "win32", timeout: 40_000 }, async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [script], stderr: "pipe",
    env: { ...process.env, DESK_DRY_RUN: "1", DESK_DISABLE_TOOLS: "computer_window_set_frame,computer_verify_state" } });
  const client = new Client({ name: "regression", version: "1" });
  try {
    await client.connect(transport);
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return { result, data: JSON.parse(result.content[0].text) };
    };
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert(!names.includes("computer_window_set_frame"));
    for (const tool of ["set_frame", "computer_set_frame", "verify"]) {
      const { data } = await call("computer_batch", { steps: [{ tool, args: {} }] });
      assert.equal(data.allOk, false); assert.match(data.steps[0].error, /DESK_DISABLE_TOOLS/);
    }
    for (const [tool, args] of [["wait", { ms: -1 }], ["key_down", {}], ["read_screen", { maxDepth: 999 }]]) {
      const { data } = await call("computer_batch", { steps: [{ tool, args }] });
      assert.equal(data.steps[0].code, "InvalidArgument");
    }
    const { data: typed } = await call("computer_batch", { steps: [
      { tool: "wait", args: { ms: 1 } }, { tool: "wait", args: { ms: "${steps.0.waitedMs}" } }
    ] });
    assert.equal(typed.allOk, true);
    const { data: plans } = await call("computer_batch", { steps: [
      { tool: "polyline", args: { points: [[0,0],[1,1]] } },
      { tool: "clipboard_set", args: { text: "must not reach clipboard" } },
      { tool: "type", args: { text: "must not reach active window", inputMode: "paste" } },
      { tool: "select", args: { title: "test", value: "item" } }
    ] });
    assert.equal(plans.allOk, true);
    assert(plans.steps.every((s) => s.data.dryRun === true));
    for (const [tool, args] of [["computer_browser_start", { exe: "Z:/missing.exe" }], ["computer_browser_click", { selector: "body" }], ["computer_browser_eval", { expression: "document.body.remove()" }]]) {
      assert.equal((await call(tool, args)).data.dryRun, true);
    }
  } finally { await client.close(); }
});

test("invalid browser executable returns a tool error without crashing the server", { skip: process.platform !== "win32", timeout: 40_000 }, async () => {
  const client = new Client({ name: "browser-spawn", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [script], stderr: "pipe" }));
    const r = await client.callTool({ name: "computer_browser_start", arguments: { exe: "Z:/desk-mcp-missing/browser.exe", port: 65531 } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /NotSupported/);
    assert.equal((await client.listTools()).tools.length, 46);
  } finally { await client.close(); }
});
