// Бенчмарк: сколько контекста съедает структурированное чтение против картинки.
//
// Замер идёт через настоящий MCP-клиент и настоящий сервер, окна берутся
// живые (те, что сейчас открыты), поэтому цифры зависят от машины. Это
// ровно то, что нужно: README должен показывать правду, а не красивые максимумы.
//
// Формулы токенов:
//   текст        ~ chars / 4 (грубо, но для JSON с ASCII-ключами сходится)
//   картинка     Anthropic: w * h / 750
//   картинка     OpenAI high detail: 85 + 170 * (число плиток 512x512 после
//                вписывания в 2048x2048)
//
// Запуск:  node bench-tokens.mjs            (по всем приличным окнам)
//          node bench-tokens.mjs "Заметки"  (по одному окну)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv[2];

const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(__dirname, "server.mjs")],
  stderr: "pipe",
});
const client = new Client({ name: "bench-tokens", version: "1.0.0" });
await client.connect(transport);

const textOf = (r) => r.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";
const imageOf = (r) => r.content?.find((c) => c.type === "image") ?? null;

const tokensText = (s) => Math.ceil(s.length / 4);
const tokensImageAnthropic = (w, h) => Math.ceil((w * h) / 750);
const tokensImageOpenAI = (w, h) => {
  const k = Math.min(1, 2048 / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * k));
  const sh = Math.max(1, Math.round(h * k));
  const tiles = Math.ceil(sw / 512) * Math.ceil(sh / 512);
  return 85 + 170 * tiles;
};

// Размеры снимка: сервер кладёт их в текст ответа, но на разных путях формат
// разный, поэтому приоритет у геометрии окна из списка окон.
const dimsOf = (txt, rect) => {
  try {
    const j = JSON.parse(txt);
    const w = j.width ?? j.w ?? j.size?.w ?? j.image?.w;
    const h = j.height ?? j.h ?? j.size?.h ?? j.image?.h;
    if (w && h) return { w, h, from: "answer" };
  } catch { /* ответ не JSON — берём геометрию окна */ }
  return { w: rect?.w ?? 0, h: rect?.h ?? 0, from: "window rect" };
};

const winRes = await client.callTool({ name: "computer_windows", arguments: {} });
const all = JSON.parse(textOf(winRes)).windows ?? [];
let targets = all.filter((w) => w.visible && w.title && w.rect.w > 300 && w.rect.h > 200);
if (only) targets = targets.filter((w) => w.title.toLowerCase().includes(only.toLowerCase()));
if (!targets.length) {
  console.error("Нет подходящих окон. Открой что-нибудь и повтори.");
  await client.close();
  process.exit(1);
}

const rows = [];
for (const w of targets.slice(0, 6)) {
  const title = w.title.slice(0, 34);
  const row = { title, px: `${w.rect.w}x${w.rect.h}` };

  // 1. Структурированное чтение, как его зовёт агент по умолчанию.
  let t0 = Date.now();
  try {
    const r = await client.callTool({
      name: "computer_read_screen",
      arguments: { title: w.title, maxDepth: 6, maxElements: 300 },
    });
    const s = textOf(r);
    row.treeChars = s.length;
    row.treeTokens = tokensText(s);
    row.treeMs = Date.now() - t0;
  } catch (e) { row.treeMs = -1; row.treeErr = e.message.slice(0, 60); }

  // 2. То же, но экономно: только интерактивное и неглубоко.
  t0 = Date.now();
  try {
    const r = await client.callTool({
      name: "computer_read_screen",
      arguments: { title: w.title, maxDepth: 4, maxElements: 120, interactiveOnly: true },
    });
    const s = textOf(r);
    row.leanChars = s.length;
    row.leanTokens = tokensText(s);
    row.leanMs = Date.now() - t0;
  } catch (e) { row.leanMs = -1; }

  // 3. Поиск одного элемента. Это и есть рабочий режим агента: окно
  // целиком читать не нужно, нужен один элемент по имени и роли.
  t0 = Date.now();
  try {
    const r = await client.callTool({
      name: "computer_find",
      arguments: { title: w.title, type: "Button", limit: 1 },
    });
    const s = textOf(r);
    row.findChars = s.length;
    row.findTokens = tokensText(s);
    row.findMs = Date.now() - t0;
  } catch (e) { row.findMs = -1; }

  // 4. Скриншот окна в PNG и в JPEG с половинным масштабом.
  for (const [key, args] of [
    ["png", { window: w.title, format: "png" }],
    ["jpeg", { window: w.title, format: "jpeg", scale: 0.5, quality: 70 }],
  ]) {
    t0 = Date.now();
    try {
      const r = await client.callTool({ name: "computer_screenshot", arguments: args });
      const img = imageOf(r);
      if (!img) { row[key + "Bytes"] = 0; continue; }
      row[key + "Bytes"] = Math.round((img.data.length * 3) / 4);
      row[key + "Ms"] = Date.now() - t0;
      if (key === "png") {
        const d = dimsOf(textOf(r), w.rect);
        row.shotW = d.w; row.shotH = d.h; row.dimFrom = d.from;
      }
    } catch (e) { row[key + "Ms"] = -1; }
  }

  if (row.shotW) {
    row.pngTokensA = tokensImageAnthropic(row.shotW, row.shotH);
    row.pngTokensO = tokensImageOpenAI(row.shotW, row.shotH);
  }
  if (row.shotW) {
    row.jpegTokensA = tokensImageAnthropic(Math.round(row.shotW / 2), Math.round(row.shotH / 2));
  }
  rows.push(row);
  // Дерево бывает огромным, поэтому печатаем только сводку.
  console.error(`снято: ${title} (дерево ${row.treeChars ?? 0} симв.)`);
}

const head = "| Window | Pixels | Find 1 button: chars / tokens / ms | Full tree: chars / tokens / ms | PNG KB / tokens / ms |";
const sep = "| --- | ---: | ---: | ---: | ---: |";
const body = rows.map((r) =>
  `| ${r.title} | ${r.shotW ?? "-"}x${r.shotH ?? "-"} | ${r.findChars ?? "-"} / ${r.findTokens ?? "-"} / ${r.findMs ?? "-"} | ` +
  `${r.treeChars ?? "-"} / ${r.treeTokens ?? "-"} / ${r.treeMs ?? "-"} | ` +
  `${r.pngBytes ? (r.pngBytes / 1024).toFixed(1) + " KB" : "-"} / ${r.pngTokensA ?? "-"} / ${r.pngMs ?? "-"} |`);

const headLean = "| Window | Lean tree chars | Lean tokens | Lean ms | Lean tree vs PNG tokens | Find vs PNG tokens |";
const bodyLean = rows.map((r) =>
  `| ${r.title} | ${r.leanChars ?? "-"} | ${r.leanTokens ?? "-"} | ${r.leanMs ?? "-"} | ` +
  (r.leanTokens && r.pngTokensA
    ? (r.leanTokens < r.pngTokensA
      ? `${(r.pngTokensA / r.leanTokens).toFixed(1)}x cheaper`
      : `${(r.leanTokens / r.pngTokensA).toFixed(1)}x MORE expensive`)
    : "-") +
  " | " +
  (r.findTokens && r.pngTokensA
    ? (r.findTokens < r.pngTokensA
      ? `${(r.pngTokensA / r.findTokens).toFixed(1)}x cheaper`
      : `${(r.findTokens / r.pngTokensA).toFixed(1)}x MORE expensive`)
    : "-") + " |");

console.log(`\nСнимок окна взят попиксельно: ${rows[0]?.shotW ?? "?"}x${rows[0]?.shotH ?? "?"} (${rows[0]?.dimFrom ?? "?"})\n`);
console.log("### Полное дерево против скриншота\n");
console.log(head);
console.log(sep);
console.log(body.join("\n"));
console.log("\n### Экономный режим: maxDepth 4, maxElements 120, interactiveOnly\n");
console.log(headLean);
console.log("| --- | ---: | ---: | ---: | --- | --- |");
console.log(bodyLean.join("\n"));
console.log("\nТокены картинки: Anthropic w*h/750, OpenAI high 85+170*tiles of 512x512. Текст ~ chars/4.");
console.log("Размер снимка взят из геометрии окна, это граница +/- бордюр. Замеры на этой машине, окна живые.\n");

await client.close();
process.exit(0);