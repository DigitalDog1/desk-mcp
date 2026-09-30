import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const t = new StdioClientTransport({ command: "node", args: [path.join(__dirname, "server.mjs")], stderr: "pipe" });
const c = new Client({ name: "smoke", version: "1.0.0" });
await c.connect(t);

const tools = await c.listTools();
console.log(`тулов: ${tools.tools.length}\n`);

let pass = 0, fail = 0;
const check = async (name, args, verify) => {
  const t0 = Date.now();
  try {
    const r = await c.callTool({ name, arguments: args });
    const txt = r.content?.[0]?.text ?? "";
    const bad = r.isError === true || txt.startsWith("Ошибка:");
    const ok = verify ? verify(r, txt) : !bad;
    if (ok) { pass++; console.log(`  ОК   ${name} (${Date.now() - t0} мс)`); }
    else { fail++; console.log(`  СБОЙ ${name} (${Date.now() - t0} мс): ${txt.slice(0, 160)}`); }
    return r;
  } catch (e) {
    fail++;
    console.log(`  ОШИБКА ${name}: ${e.message.slice(0, 200)}`);
    return null;
  }
};

console.log("== глаза ==");
await check("computer_selftest", {}, (r, t) => t.includes('"ok": true'));
await check("computer_screeninfo", {}, (r, t) => t.includes('"virtual"'));
await check("computer_permissions", {}, (r, t) => t.includes('"uia": true'));
const shot = await check("computer_screenshot", { region: "0,0,200,120" },
  (r) => !!r.content.find((c) => c.type === "image" && c.data.length > 500));
const scaled = await check("computer_screenshot", { region: "0,0,1280,720", scale: 0.5, format: "jpeg", quality: 70 },
  (r) => !!r.content.find((c) => c.type === "image" && c.mimeType === "image/jpeg"));

console.log("== окна ==");
await check("computer_windows", { filter: "Microsoft" }, (r, t) => !t.includes("Ошибка"));
await check("computer_focus", { title: "Microsoft" }, (r, t) => t.includes('"ok": true'));
await check("computer_wait_window", { title: "Microsoft", timeoutSec: 5 }, (r, t) => !t.includes("Ошибка"));
await check("computer_launch", { path: "notepad.exe", hidden: true }, (r, t) => t.includes('"ok": true'));

console.log("== цели ==");
const tree = await check("computer_read_screen", { title: "Microsoft", maxDepth: 5, maxElements: 80, interactiveOnly: true },
  (r, t) => t.length > 200);
const treeMsaa = await check("computer_read_screen", { title: "Microsoft", maxDepth: 6, maxElements: 200, interactiveOnly: true, backend: "auto" },
  (r, t) => t.includes("backend"));
await check("computer_element_at", { x: 1280, y: 700 }, (r, t) => t.includes("found"));

console.log("== руки ==");
await check("computer_move", { x: 1280, y: 700 });
await check("computer_click", { x: 1280, y: 1180, hoverFirst: true });
await check("computer_scroll", { x: 1280, y: 700, dy: -3 });
await check("computer_drag", { fromX: 400, fromY: 400, toX: 600, toY: 600, steps: 8, stepMs: 5 });
await check("computer_type", { text: "desk-mcp" });
await check("computer_key", { keys: "ctrl+a" });
await check("computer_key", { keys: "escape" });
await check("computer_launch", { path: "notepad.exe", args: ["C:\\test.txt"] });

console.log("== семантика (перенос из computer-use) ==");
await check("computer_find", { title: "Microsoft", type: "Button", limit: 3 }, (r, t) => t.includes('"count"'));
await check("computer_find", { title: "Microsoft", name: "Адресная строка", type: "Edit", limit: 1 },
  (r, t) => t.includes("ValuePattern"));
await check("computer_active_window", {}, (r, t) => t.includes('"pid"'));
await check("computer_verify_state", { title: "Microsoft", expect: [
  { label: "кнопка есть", selector: { role: "Button", label_contains: "Новая вкладка" } },
  { label: "нет такого", selector: { role: "Button", label_contains: "ZZZнеттакого" } },
] }, (r, t) => t.includes("unsatisfied"));
await check("computer_select_text", { title: "Microsoft", name: "Адресная строка", type: "Edit" }, (r, t) => t.includes("ok"));

await check("computer_key_down", { key: "shift" }, (r, t) => t.includes('"down": true'));
await check("computer_key_up", { key: "shift" }, (r, t) => t.includes('"up": true'));
await check("computer_wait", { ms: 50 }, (r, t) => t.includes("waitedMs"));
await check("computer_mouse_button", { button: "left", down: true }, (r, t) => t.includes("pressed"));
await check("computer_mouse_button", { button: "left", down: false });
await check("computer_cursor", {}, (r, t) => t.includes('"x"'));
await check("computer_click", { x: 1300, y: 720, modifiers: ["ctrl"] }, (r, t) => t.includes("ctrl"));

console.log("== Chromium через CDP ==");
const bs = await check("computer_browser_start", { browser: "edge", url: "https://example.com" },
  (r, t) => t.includes('"ok": true'));
await new Promise((r) => setTimeout(r, 2000));
const bl = await check("computer_browser_list", {}, (r, t) => t.includes("tabs"));
const bt = await check("computer_browser_tree", {}, (r, t) => t.includes('"selector"'));
await check("computer_browser_eval", { expression: "document.title" }, (r, t) => t.includes("value"));
await check("computer_browser_descendants", { selector: "body" }, (r, t) => t.includes("children"));
const tabs = JSON.parse(bl ? bl.content[0].text : "{}");
const el = JSON.parse(bt ? bt.content[0].text : "{}");
if ((el.elements || []).length) {
  await check("computer_browser_click", { selector: el.elements[0].selector },
    (r, t) => t.includes('"verified": true'));
}
console.log("  вкладок: " + (tabs.tabs || []).length + ", интерактивных элементов: " + (el.elements || []).length);
void bs;

console.log("== буфер ==");
await check("computer_clipboard_set", { text: "проверка" });
await check("computer_clipboard_get", {}, (r, t) => t.includes("проверка"));

console.log("== негативные сценарии (должны дать внятную ошибку) ==");
const neg = [
  ["computer_screenshot", { region: "мусор" }],
  ["computer_key", { keys: "ctrl+нетакой" }],
  ["computer_focus", { title: "ОкнаКоторогоНет123" }],
  ["computer_read_screen", { maxDepth: 999 }],
  ["computer_invoke", { title: "Microsoft", name: "ZZZнеттакойкнопки", type: "Button" }],
  ["computer_find", { title: "Microsoft", name: "ZZZнеттакого", type: "Button" }],
  ["computer_verify_state", { title: "Microsoft", expect: [] }],
  ["computer_key_down", { key: "ZZZнеттакой" }],
  ["computer_wait", { ms: 999999 }],
  ["computer_browser_tree", { url: "нет-такой-вкладки" }],
  ["computer_browser_click", { selector: "#нет-такого-элемента" }],
  ["computer_click", { x: 1, y: 1, modifiers: ["nosuchmod"] }],
];
for (const [n, a] of neg) {
  const t0 = Date.now();
  try {
    const r = await c.callTool({ name: n, arguments: a });
    const txt = r.content?.[0]?.text ?? "";
    const rejected = r.isError === true || txt.startsWith("Ошибка:");
    console.log(rejected ? `  ОК   отказ: ${n} (${Date.now() - t0} мс) — ${txt.slice(0, 90)}` : `  ПРОПУЩЕНО ${n} вернул данные`);
    if (rejected) pass++; else fail++;
  } catch (e) {
    console.log(`  ОК   отказ (протокол): ${n} — ${e.message.slice(0, 90)}`);
    pass++;
  }
}

console.log(`\nИТОГ: ${pass} ок, ${fail} провалов`);
await c.close();
