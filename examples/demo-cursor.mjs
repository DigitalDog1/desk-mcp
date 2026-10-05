// Демо с настоящим курсором: тот же результат, что в demo.mjs, но другим
// механизмом. Здесь агент кликает по координатам, поэтому курсор ходит по
// окну. Показывает, что выбор между паттернами и пикселями остаётся за
// вызывающим, и один найденный грабли: WinForms-кнопка отвергает мгновенный
// синтетический клик, ей нужен hoverFirst.
//
// Требуется открытое окно examples/demo-app.ps1 в (60, 60) 940x640:
//   powershell -NoProfile -ExecutionPolicy Bypass -STA -File examples\demo-app.ps1
//
//   node examples/demo-cursor.mjs
//   node examples/demo-cursor.mjs --pause 2200   (для записи видео)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const pause = Number(arg("--pause", 0));
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const started = Date.now();
const step = (n, title) => console.log(`\n--- ${n}. ${title}   (+${((Date.now() - started) / 1000).toFixed(1)}s)`);

// Экранные координаты, окно в (60, 60). Те же прямоугольники, что отдаёт UIA.
const SEARCH = { x: 590, y: 189 };
const REFRESH = { x: 732, y: 189 };
const DELIVER = { x: 894, y: 376 };
const COPY = { x: 679, y: 376 };

const client = new Client({ name: "desk-mcp-demo-cursor", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  command: "node",
  args: [path.join(__dirname, "..", "server.mjs")],
  stderr: "ignore",
}));

const call = async (name, args = {}) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";
  console.log(`    [${name} ${Date.now() - t0} ms] ${text.slice(0, 100).replace(/\n/g, " ")}`);
  if (r.isError || /^Ошибка/.test(text)) throw new Error(text.slice(0, 200));
  try { return JSON.parse(text); } catch { return text; }
};

// Сколько событий окно уже насчитало: читаем счётчик в самой форме.
const eventsSoFar = async () => {
  const r = await call("computer_find", { title: "Parcel Tracker", name: "events:", limit: 1 });
  const n = Number((r.elements?.[0]?.name ?? "").replace(/\D/g, ""));
  return Number.isFinite(n) ? n : -1;
};

step(1, "Вывести окно на передний план: реальному вводу окно должно быть впереди");
await call("computer_focus", { title: "Parcel Tracker" });
await sleep(Math.max(600, pause));

step(2, "Клик по Search БЕЗ hoverFirst: WinForms-кнопка молча его игнорирует");
const before = await eventsSoFar();
await call("computer_click", SEARCH);
await sleep(Math.max(800, pause));
const after = await eventsSoFar();
console.log(`    событий до ${before}, после ${after}${after === before ? "  клик не дошёл" : ""}`);

step(3, "Те же координаты с hoverFirst 250 мс: кнопка нажимается");
await call("computer_click", { ...SEARCH, hoverFirst: true });
await sleep(pause);

step(4, "Refresh list: курсор идёт по окну, список перезагружается");
await call("computer_click", { ...REFRESH, hoverFirst: true });
await sleep(pause);

step(5, "Mark as delivered: статус в окне меняется");
await call("computer_click", { ...DELIVER, hoverFirst: true });
await sleep(pause);

step(6, "Copy tracking number и чтение буфера обмена");
await call("computer_click", { ...COPY, hoverFirst: true });
await sleep(pause);
const clip = await call("computer_clipboard_get", {});
console.log(`    буфер обмена: "${clip.text}"`);

const final = await eventsSoFar();
console.log(`\nсобытий в окне: ${final}, готово за ${((Date.now() - started) / 1000).toFixed(1)} с\n`);
if (final < 4) throw new Error(`окно зафиксировало только ${final} событий, демо снято быть не должно`);
await client.close();
process.exit(0);