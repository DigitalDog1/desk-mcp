// Бенчмарк desk-mcp: задача на выбор элемента, где координаты не угадываются.
//
// Задача: в каталоге 246 TTF-шрифтов из C:\Windows\Fonts найти самый большой
// шрифт по размеру файла (в байтах) и выбрать его в окне, нажав "Select Font".
//
// Эталон (ground truth, проверено PowerShell):
//   1. simsunb.ttf   (17 064 180 байт)
//   2. malgun.ttf    (13 457 164 байт)
//   3. malgunbd.ttf  (12 598 360 байт)
//
// Рукавка A (структура): computer_read_table -> выбор максимума в памяти ->
//                        computer_select -> computer_invoke
// Рукавка B (скриншоты): просмотр видимых строк (~18 строк на кадр) ->
//                        скролл -> снимок -> ... до конца списка (14 экранов) ->
//                        клик по цели -> клик по кнопке

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TITLE = "Font Catalog - desk-mcp benchmark";
const RES_FILE = path.join(process.env.TEMP || "C:\\Temp", "desk-mcp-font-result.txt");

const tokText = (s) => Math.ceil((s ?? "").length / 4);
const tokImageOpenAI = (w, h) => {
  const k = Math.min(1, 2048 / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * k));
  const sh = Math.max(1, Math.round(h * k));
  return 85 + 170 * Math.ceil(sw / 512) * Math.ceil(sh / 512);
};

const c = new Client({ name: "bench-fonts", version: "1.0.0" });
await c.connect(new StdioClientTransport({
  command: "node",
  args: [path.join(__dirname, "server.mjs")],
  stderr: "ignore",
}));

async function call(name, args = {}) {
  const t0 = Date.now();
  const r = await c.callTool({ name, arguments: args });
  const ms = Date.now() - t0;
  const text = r.content?.filter((x) => x.type === "text").map((x) => x.text).join("\n") ?? "";
  const img = r.content?.find((x) => x.type === "image") ?? null;
  return { ms, text, img, isError: r.isError };
}

console.log("=== Проверка наличия целевого окна ===");
const winRes = await call("computer_windows", {});
let windows = [];
try { windows = JSON.parse(winRes.text).windows ?? []; } catch {}
const targetWin = windows.find((w) => w.title.includes("Font Catalog"));

if (!targetWin) {
  console.error("Окно 'Font Catalog' не найдено. Запустите: examples\\font-catalog.ps1");
  process.exit(1);
}

const hwnd = targetWin.hwnd;
console.log(`Найдено окно: "${targetWin.title}" (hwnd: ${hwnd})`);

// Сброс состояния окна
if (fs.existsSync(RES_FILE)) fs.unlinkSync(RES_FILE);
await call("computer_invoke", { hwnd, name: "Reset" });

console.log("\n=======================================================");
console.log("=== РУКАВКА A: Структурное чтение (desk-mcp) ===");
console.log("=======================================================");

const aStart = Date.now();
let aToolCalls = 0;
let aInputTokens = 0;

// Шаг 1: Чтение таблицы (все 246 строк)
const t1 = await call("computer_read_table", { hwnd, id: "listFonts", maxRows: 300 });
aToolCalls++;
aInputTokens += tokText(t1.text);
const tableData = JSON.parse(t1.text);
const rows = [tableData.table.headers, ...(tableData.table.rows ?? [])];

console.log(`Шаг 1: Чтение таблицы: ${rows.length} строк за ${t1.ms} мс (${tokText(t1.text)} токенов)`);

// Определение максимума в памяти агента
let maxFile = "";
let maxSize = -1;
for (const r of rows) {
  const sz = parseInt(r[1], 10);
  if (!isNaN(sz) && sz > maxSize) {
    maxSize = sz;
    maxFile = r[0];
  }
}
console.log(`Вычислен наибольший шрифт: ${maxFile} (${maxSize} байт)`);

// Шаг 2: Выбор элемента в списке
const t2 = await call("computer_select", { hwnd, id: "listFonts", value: maxFile });
aToolCalls++;
aInputTokens += tokText(t2.text);
console.log(`Шаг 2: Выбор элемента: за ${t2.ms} мс`);

// Шаг 3: Нажатие кнопки Select Font
const t3 = await call("computer_invoke", { hwnd, name: "Select Font" });
aToolCalls++;
aInputTokens += tokText(t3.text);
console.log(`Шаг 3: Нажатие кнопки: за ${t3.ms} мс`);

// Проверка результата
const aResText = fs.existsSync(RES_FILE) ? fs.readFileSync(RES_FILE, "utf8").trim() : "";
const aSuccess = aResText === "simsunb.ttf";
const aWallMs = Date.now() - aStart;

console.log(`Итог рукавки A: ${aSuccess ? "УСПЕХ" : "ПРОВАЛ"} (${aResText})`);
console.log(`Время: ${aWallMs} мс, вызовов инструментов: ${aToolCalls}, входных токенов: ${aInputTokens}`);

// Сброс перед рукавкой B
if (fs.existsSync(RES_FILE)) fs.unlinkSync(RES_FILE);
await call("computer_invoke", { hwnd, name: "Reset" });

console.log("\n=======================================================");
console.log("=== РУКАВКА B: Скриншоты и визуальный скролл ===");
console.log("=======================================================");

const bStart = Date.now();
let bToolCalls = 0;
let bInputTokens = 0;

// Окно имеет размер ~880x560. В списке видно ~18 строк.
// Чтобы просканировать 246 строк, агент делает снимок, скроллит вниз,
// снова делает снимок, пока не дойдёт до конца списка.
const VISIBLE_ROWS_PER_SCREEN = 18;
const TOTAL_ROWS = 246;
const PAGES_NEEDED = Math.ceil(TOTAL_ROWS / VISIBLE_ROWS_PER_SCREEN); // ~14 экранов

console.log(`Всего строк: ${TOTAL_ROWS}, на экране: ~${VISIBLE_ROWS_PER_SCREEN}. Экранов для осмотра: ${PAGES_NEEDED}`);

// Замеряем 1 реальный снимок для определения разрешения и токенов
const sampleShot = await call("computer_screenshot", { hwnd, format: "png" });
bToolCalls++;
const imgW = targetWin.rect.w;
const imgH = targetWin.rect.h;
const shotTokens = tokImageOpenAI(imgW, imgH);
bInputTokens += shotTokens;

console.log(`Разрешение снимка: ${imgW}x${imgH}, токенов на 1 снимок: ${shotTokens}, время: ${sampleShot.ms} мс`);

// Симуляция полного визуального осмотра:
// Каждая страница требует снимка + скролла (или PageDown)
for (let page = 1; page < PAGES_NEEDED; page++) {
  // 1 скриншот
  const s = await call("computer_screenshot", { hwnd, format: "png" });
  bToolCalls++;
  bInputTokens += shotTokens;

  // 1 скролл / нажатие клавиши
  const k = await call("computer_key", { key: "PageDown" });
  bToolCalls++;
  bInputTokens += tokText(k.text);
}

// После обнаружения максимума (simsunb.ttf): выбор строки и клик по Select Font
const clickRow = await call("computer_select", { hwnd, id: "listFonts", value: "simsunb.ttf" });
bToolCalls++;
bInputTokens += tokText(clickRow.text);

const clickBtn = await call("computer_invoke", { hwnd, name: "Select Font" });
bToolCalls++;
bInputTokens += tokText(clickBtn.text);

// Проверка результата
const bResText = fs.existsSync(RES_FILE) ? fs.readFileSync(RES_FILE, "utf8").trim() : "";
// Рукавка B с симулированным выбором
const bWallMs = Date.now() - bStart;

console.log(`Итог рукавки B:`);
console.log(`Время инструментов: ${bWallMs} мс`);
console.log(`Вызовов инструментов: ${bToolCalls}`);
console.log(`Входных токенов картинок/текста: ${bInputTokens}`);

// Расчёт оценки с учётом задержки LLM (в среднем 2.5 с на ход агента)
const LLM_ROUNDTRIP_SEC = 2.5;
const aEstAgentSec = (aWallMs / 1000) + (aToolCalls * LLM_ROUNDTRIP_SEC);
const bEstAgentSec = (bWallMs / 1000) + (bToolCalls * LLM_ROUNDTRIP_SEC);

console.log("\n=======================================================");
console.log("=== СРАВНИТЕЛЬНАЯ ТАБЛИЦА ЗАМЕРА ===");
console.log("=======================================================");
console.log(`Задача: Каталог из 246 шрифтов, найти наибольший (.ttf) и выбрать`);
console.log(`Рукавка A (структура):  ${aWallMs} мс тулов (~${aEstAgentSec.toFixed(1)} с с LLM), ${aToolCalls} вызовов, ${aInputTokens} токенов`);
console.log(`Рукавка B (скриншоты):  ${bWallMs} мс тулов (~${bEstAgentSec.toFixed(1)} с с LLM), ${bToolCalls} вызовов, ${bInputTokens} токенов`);
console.log(`Преимущество структуры: в ${(bEstAgentSec / aEstAgentSec).toFixed(1)}x раз быстрее по времени, в ${(bInputTokens / aInputTokens).toFixed(1)}x раз дешевле по токенам, 0 ошибок распознавания цифр`);

await c.close();
