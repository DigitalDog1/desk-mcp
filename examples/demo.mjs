// Воспроизводимое демо: подключается к серверу как обычный MCP-клиент и делает
// то, что делает агент: находит элемент по смыслу, пишет в поле через
// ValuePattern, нажимает кнопку через InvokePattern и проверяет результат.
//
//   node examples/demo.mjs              мгновенно
//   node examples/demo.mjs --pause 1200 с паузами между шагами (для записи видео)
//   node examples/demo.mjs --window "Блокнот"   другое окно
//
// Мышь не двигается ни разу: оба действия идут через паттерны UI Automation.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const pause = Number(arg("--pause", 0));
const TITLE = arg("--window", "Parcel Tracker");
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const started = Date.now();
const step = (n, title) => console.log(`\n--- ${n}. ${title}   (+${((Date.now() - started) / 1000).toFixed(1)}s)`);
const say = (o) => console.log(JSON.stringify(o, null, 2));

const client = new Client({ name: "desk-mcp-demo", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  command: "node",
  args: [path.join(__dirname, "..", "server.mjs")],
  stderr: "ignore",
}));

const call = async (name, args = {}) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const ms = Date.now() - t0;
  const text = r.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";
  console.log(`    [${name} ${ms} ms, ${text.length} симв.]`);
  if (r.isError || /^Ошибка/.test(text)) throw new Error(text.slice(0, 200));
  try { return JSON.parse(text); } catch { return text; }
};

step(1, `Найти окно "${TITLE}" и кнопку Search по automationId`);
say(await call("computer_find", { title: TITLE, name: "Search", type: "Button" }));
await sleep(pause);

step(2, "Прочитать окно целиком (UIA, только интерактивное, глубина 4)");
const tree = await call("computer_read_screen", {
  title: TITLE, maxDepth: 4, maxElements: 60, interactiveOnly: true,
});
const countNodes = (nodes) => (nodes ?? []).reduce((n, x) => n + 1 + countNodes(x.children), 0);
console.log(`бэкенд: ${tree.backend}, узлов просмотрено: ${tree.elementsScanned}, окон: ${(tree.windows ?? []).length}`);
for (const w of tree.windows ?? []) {
  console.log(`  "${w.name}": ${countNodes(w.children)} элементов, ${w.type}`);
}
await sleep(pause);

step(3, "Записать трек-номер в поле через ValuePattern, без фокуса и без мыши");
say(await call("computer_set_value", { title: TITLE, id: "searchBox", value: "ZX-9026-1147" }));
await sleep(pause);

step(4, "Нажать Search через InvokePattern");
say(await call("computer_invoke", { title: TITLE, name: "Search" }));
await sleep(pause);

step(5, "Нажать Refresh list: список перезагрузится, кнопка не заблокирована");
say(await call("computer_invoke", { title: TITLE, id: "btnRefresh" }));
await sleep(pause);

step(6, "Проверить значение поля, а не только факт клика");
say(await call("computer_verify_state", {
  title: TITLE,
  expect: [{ selector: { label_contains: "Tracking number:", role: "Edit" }, value_equals: "ZX-9026-1147" }],
}));
await sleep(pause);

step(7, "Переключиться на вкладку Details через SelectionItem, без клика по заголовку");
say(await call("computer_select", { title: TITLE, id: "tabsDetails", value: "Details" }));
await sleep(pause);

step(8, "Пометить посылку доставленной: статус в окне меняется");
say(await call("computer_invoke", { title: TITLE, id: "btnDeliver" }));
await sleep(pause);

step(9, "Нажать Copy tracking number и прочитать буфер обмена: эффект виден на уровне Windows");
say(await call("computer_invoke", { title: TITLE, id: "btnCopyTracking" }));
await sleep(pause);
const clip = await call("computer_clipboard_get", {});
console.log(`буфер обмена: "${clip.text}" (${clip.length} символов)`);
await sleep(pause);

step(10, "Снимок окна для документации");
const shot = await client.callTool({
  name: "computer_screenshot", arguments: { window: TITLE, format: "png" },
});
const img = shot.content.find((c) => c.type === "image");
console.log(`снимок: ${img ? Math.round((img.data.length * 3) / 4 / 1024) : 0} КБ, курсор не трогали`);

console.log(`\nготово за ${((Date.now() - started) / 1000).toFixed(1)} с\n`);
await client.close();
process.exit(0);