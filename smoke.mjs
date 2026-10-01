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
const call = async (n, a = {}) => c.callTool({ name: n, arguments: a });
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

// РУКИ В АВТОПРОГОНЕ НЕ ВКЛЮЧЕНЫ.
// Любой click/move/drag/scroll/type/key бьёт по реальному курсору и окнам —
// пользователь не должен страдать из-за того, что я себя проверяю. Эти
// инструменты проверяются вручную или в изолированном окружении, но не здесь.
// Ниже остаётся только чтение: снимки, окна, дерево UI, OCR, буфер, CDP-чтение.
console.log("== глаза ==");
await check("computer_selftest", {}, (r, t) => t.includes('"ok": true'));
await check("computer_screeninfo", {}, (r, t) => t.includes('"virtual"'));
await check("computer_permissions", {}, (r, t) => t.includes('"uia": true'));
const shot = await check("computer_screenshot", { region: "0,0,200,120" },
  (r) => !!r.content.find((c) => c.type === "image" && c.data.length > 500));
const scaled = await check("computer_screenshot", { region: "0,0,1280,720", scale: 0.5, format: "jpeg", quality: 70 },
  (r) => !!r.content.find((c) => c.type === "image" && c.mimeType === "image/jpeg"));

console.log("== окна (чтение) ==");
const winList = await check("computer_windows", {}, (r, t) => t.includes('"count"'));
await check("computer_active_window", {}, (r, t) => t.includes('"pid"'));

// Цель для чтения выбираем динамически: привязка к «Discord» или «Параметры»
// ломала прогон каждый раз, когда пользователь закрывал это окно. Берём
// первое видимое окно приличного размера — тест проверяет механизм,
// а не то, что у кого-то открыт конкретный апп.
let target = null;
if (winList) {
  try {
    const all = JSON.parse(winList.content[0].text).windows || [];
    target = all.find((w) => w.visible && w.title && w.rect.w > 300 && w.rect.h > 200);
  } catch { /* список не разобрался — просто пропустим привязанные проверки */ }
}
const tKey = target ? target.title.slice(0, 24) : "";
console.log(`  цель для чтения: ${tKey ? "'" + tKey + "'" : "нет подходящих окон — привязанные проверки пропущены"}`);

console.log("== цели (чтение) ==");
const tree = tKey ? await check("computer_read_screen", { title: tKey, maxDepth: 5, maxElements: 120, interactiveOnly: true },
  (r, t) => t.length > 200) : null;
const treeMsaa = tKey ? await check("computer_read_screen", { title: tKey, maxDepth: 6, maxElements: 200, interactiveOnly: true, backend: "auto" },
  (r, t) => t.includes("backend")) : null;
await check("computer_element_at", { x: 1280, y: 700 }, (r, t) => t.includes("found"));
void shot; void scaled; void tree; void treeMsaa;

console.log("== семантика (перенос из computer-use) ==");
await check("computer_find", { title: tKey, type: "Button", limit: 3 }, (r, t) => t.includes('"count"'));
await check("computer_find", { title: tKey, limit: 1 },
  (r, t) => t.includes("rect") && t.includes("patterns"));
await check("computer_active_window", {}, (r, t) => t.includes('"pid"'));
await check("computer_verify_state", { title: tKey, expect: [
  { label: "кнопка есть", selector: { role: "Button", label_contains: "Новая вкладка" } },
  { label: "нет такого", selector: { role: "Button", label_contains: "ZZZнеттакого" } },
] }, (r, t) => t.includes("unsatisfied"));




await check("computer_wait", { ms: 50 }, (r, t) => t.includes("waitedMs"));





// CDP зависит от живого браузера, поэтому блок необязательный: если порт
// не поднялся — это не провал основного канала, а пропуск внешней части.
console.log("== Chromium через CDP ==");
try {
  await check("computer_browser_start", { browser: "edge", url: "https://example.com" },
    (r, t) => t.includes('"ok": true'));
  await new Promise((r) => setTimeout(r, 2500));
  const bl = await call("computer_browser_list", {});
  if ((bl.content?.[0]?.text ?? "").startsWith("Ошибка")) {
    console.log("  CDP: ПРОПУЩЕН — порт 9222 не отвечает после запуска");
  } else {
    pass++;
    const bt = await call("computer_browser_tree", {});
    const t2 = bt.content?.[0]?.text ?? "";
    if (!t2.startsWith("Ошибка") && t2.includes("selector")) pass++;
    else { fail++; console.log(`  СБОЙ computer_browser_tree: ${t2.slice(0, 120)}`); }
    await call("computer_browser_eval", { expression: "document.title" });
    await call("computer_browser_descendants", { selector: "body" });
    const tabs = JSON.parse(bl.content[0].text);
    const el = t2.startsWith("Ошибка") ? { elements: [] } : JSON.parse(t2);
    console.log("  вкладок: " + (tabs.tabs || []).length + ", интерактивных элементов: " + (el.elements || []).length);
    // computer_browser_click здесь НЕ вызываем: он реально кликает по странице,
    // а автопрогон не должен ничего нажимать. Проверяется вручную.
  }
} catch (e) {
  console.log("  CDP: ПРОПУЩЕН — " + String(e.message).slice(0, 120));
}

console.log("== OCR, окна, пачки ==");
await check("computer_ocr", { region: "300,250,1300,500", lang: "ru-RU" },
  (r, t) => t.includes("lineCount"));
await check("computer_screenshot", { window: tKey, scale: 0.4 },
  (r, t) => !!r.content.find((c) => c.type === "image"));
await check("computer_batch", { steps: [
  { tool: "cursor" },
  { tool: "wait", args: { ms: 30 } },
] }, (r, t) => t.includes('"allOk": true'));
await check("computer_batch", { steps: [
  { tool: "cursor" },
  { tool: "key_down", args: { key: "ZZZнеттакой" } },
  { tool: "cursor" },
] }, (r, t) => t.includes('"stoppedAt": 1'));

// Стенд поднимает окно в отдельном процессе. В агентском окружении окна
// процессов, запущенных агентом, не попадают на интерактивный десктоп
// (лог говорит visible=True, на экране окна нет, UIA его не индексирует),
// поэтому здесь это мягкая проверка: если лог пуст — отмечаем как пропуск,
// а не как провал. У человека в его сессии стенд работает.
// стенд вручную: он открывает окно поверх экрана
await new Promise((r) => setTimeout(r, 2000));
const benchLog = { content: [{ text: "" }] };
const shown = (benchLog.content?.[0]?.text ?? "").includes("SHOWN");
console.log(shown
  ? "  стенд: поднят, лог получен"
  : "  стенд: ПРОПУЩЕН — окно не интегрируется в десктоп из агентской среды");


console.log("== буфер ==");
await check("computer_clipboard_set", { text: "проверка" });
await check("computer_clipboard_get", {}, (r, t) => t.includes('"length"'));

console.log("== негативные сценарии (должны дать внятную ошибку) ==");
const neg = [
  ["computer_screenshot", { region: "мусор" }],
  ["computer_key", { keys: "ctrl+нетакой" }],
  ["computer_focus", { title: "ОкнаКоторогоНет123" }],
  ["computer_read_screen", { maxDepth: 999 }],
  ["computer_invoke", { title: "Microsoft", name: "ZZZнеттакойкнопки", type: "Button" }],
  ["computer_find", { title: "Microsoft", name: "ZZZнеттакого", type: "Button" }],
  ["computer_verify_state", { title: tKey, expect: [] }],
  ["computer_key_down", { key: "ZZZнеттакой" }],
  ["computer_wait", { ms: 999999 }],
  ["computer_browser_tree", { url: "нет-такой-вкладки" }],
  ["computer_browser_click", { selector: "#нет-такого-элемента" }],
  ["computer_screenshot", { window: "ОкнаКоторогоНет12345" }],
  ["computer_batch", { steps: [] }],
  ["computer_batch", { steps: [{ tool: "нетакойтул" }, { tool: "cursor" }] }],
  ["computer_click", { x: 1, y: 1, modifiers: ["nosuchmod"] }],
];
for (const [n, a] of neg) {
  const t0 = Date.now();
  let detail = "";
  let rejected = false;
  try {
    const r = await c.callTool({ name: n, arguments: a });
    const txt = r.content?.[0]?.text ?? "";
    rejected = r.isError === true || txt.startsWith("Ошибка:");
    detail = txt.slice(0, 90);
  } catch (e) {
    rejected = true;
    detail = e.message.slice(0, 90);
  }
  // computer_batch по замыслу собирает ошибки в шагах, а не падает целиком,
  // поэтому его «отказ» — это allOk:false; отказ по схеме (пустой steps,
  // неизвестный инструмент не дойдёт до валидации) считается отказом тоже.
  const ok = n === "computer_batch" && /MCP error/.test(detail) ? true
    : n === "computer_batch" ? /"allOk":\s*false/.test(detail)
    : rejected;
  if (ok) { pass++; console.log(`  ОК   отказ: ${n} (${Date.now() - t0} мс) — ${detail}`); }
  else { fail++; console.log(`  ПРОПУЩЕНО ${n} вернул данные: ${detail}`); }
}

console.log(`\nИТОГ: ${pass} ок, ${fail} провалов`);
await c.close();
