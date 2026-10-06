// Бенчмарк desk-mcp: сколько стоит увидеть окно и ответить на вопрос о нём.
//
// Зачем он такой. README продаёт структурное чтение, и это легко превращается в
// рекламу: «дерево дешевле картинки». Здесь ровно наоборот, цифры снимаются с
// живых окон и показывают обе стороны, включая ту, где подход проигрывает.
//
// Метод
//   1. Окна берутся динамически: все видимые окна приличного размера. Никаких
//      заранее выбранных «удобных» приложений.
//   2. Задержка это медиана из BENCH_REPEAT прогонов (по умолчанию 3), потому
//      что один прогон показывает шум, а не скорость. Токены снимаются одним
//      проходом: они детерминированы и повторять их незачем.
//   3. Токены текста считаются как символы / 4, картинки — по формуле Anthropic
//      (ширина * высота / 750) и OpenAI high detail. Это те же формулы, что в
//      bench-tokens.mjs, чтобы два отчёта не спорили друг с другом.
//   4. Ничего не настраивается под результат: если окно не читается, в таблице
//      будет прочерк, а не удобное число.
//
// Что этот бенчмарк НЕ измеряет, написано в последнем разделе отчёта и в README.
// Числа привязаны к машине и к тому, что открыто в момент прогона.
//
// Запуск:  npm run bench:full            все окна
//          node bench-full.mjs Paint     только окна, где есть это слово
//          BENCH_REPEAT=7 node bench-full.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import os from "node:os";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv[2] ?? "";
const REPEAT = Math.max(1, Number(process.env.BENCH_REPEAT ?? 3));

const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(__dirname, "server.mjs")],
  stderr: "pipe",
});
const c = new Client({ name: "bench-full", version: "1.0.0" });
await c.connect(transport);

const textOf = (r) => r.content?.filter((x) => x.type === "text").map((x) => x.text).join("\n") ?? "";
const imageOf = (r) => r.content?.find((x) => x.type === "image") ?? null;

const tokText = (s) => Math.ceil((s ?? "").length / 4);
const tokImageAnthropic = (w, h) => Math.ceil((w * h) / 750);
const tokImageOpenAI = (w, h) => {
  const k = Math.min(1, 2048 / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * k));
  const sh = Math.max(1, Math.round(h * k));
  return 85 + 170 * Math.ceil(sw / 512) * Math.ceil(sh / 512);
};
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// Один вызов с замером. Ошибка не роняет прогон: в таблице она становится
// прочерком, и это тоже результат — «это окно не читается» полезнее падения.
async function call(name, args = {}) {
  const t0 = Date.now();
  try {
    const r = await c.callTool({ name, arguments: args });
    const text = textOf(r);
    const bad = r.isError === true || text.startsWith("Ошибка:");
    return { ok: !bad, ms: Date.now() - t0, text, chars: text.length, img: imageOf(r) };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, text: String(e.message).slice(0, 120), chars: 0, img: null };
  }
}

// Медиана задержки по нескольким прогонам: токены берём из последнего ответа,
// он же самый свежий.
async function timed(name, args = {}, repeat = REPEAT) {
  const runs = [];
  let last = null;
  for (let i = 0; i < repeat; i++) {
    last = await call(name, args);
    runs.push(last.ms);
  }
  return { ...last, median: median(runs), min: Math.min(...runs), max: Math.max(...runs), runs };
}

const num = (v) => (v == null || Number.isNaN(v) ? "-" : String(v));
const table = (head, rows) => {
  const all = [head, ...rows];
  const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? "").length)));
  const line = (r) => r.map((v, i) => String(v ?? "").padEnd(w[i])).join("  ");
  console.log(line(head));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  for (const r of rows) console.log(line(r));
};

const winRes = await call("computer_windows", {});
const windows = JSON.parse(winRes.text).windows ?? [];
let targets = windows.filter((w) => w.visible && w.title && w.rect.w > 300 && w.rect.h > 200);
if (only) targets = targets.filter((w) => w.title.toLowerCase().includes(only.toLowerCase()));

const info = await call("computer_screeninfo", {});
const screen = JSON.parse(info.text).virtual ?? JSON.parse(info.text).screen ?? {};
const host = await call("computer_active_window", {});
const hostTitle = (() => {
  try { return JSON.parse(host.text).title ?? "-"; } catch { return "-"; }
})();

console.log("=".repeat(78));
console.log("БЕНЧМАРК desk-mcp");
console.log("=".repeat(78));
console.log(`узел            : ${os.version()} ${os.arch()}, Node ${process.version}`);
console.log(`процессоров     : ${os.cpus().length} шт., ${os.cpus()[0]?.model?.trim() ?? "?"}`);
console.log(`экран           : ${screen.w ?? "?"}x${screen.h ?? "?"}`);
console.log(`окно на переднем: ${hostTitle}`);
console.log(`прогонов на замер: ${REPEAT}, токены текста = символы / 4`);
console.log(`окон в отчёте   : ${targets.length}`);

// --- 1. сколько стоит увидеть окно ---------------------------------------------
console.log("\n1. Стоимость одного чтения окна (медиана задержки, токены за проход)");
console.log("-".repeat(78));

const perWindow = [];
for (const w of targets) {
  const rect = w.rect;
  const region = `${rect.x},${rect.y},${rect.w},${rect.h}`;

  const full = await timed("computer_read_screen", { title: w.title, maxDepth: 8, maxElements: 400 });
  const compact = await timed("computer_read_screen", { title: w.title, maxDepth: 8, maxElements: 400, compact: true });
  const lean = await timed("computer_read_screen", { title: w.title, maxDepth: 4, maxElements: 200, interactiveOnly: true, compact: true });

  // Дельта по протоколу: каждый ответ возвращает новый токен, и следующий вызов
  // обязан нести именно его. Повтор со старым токеном дельтой не является, и
  // сервер честно отказывается сравнивать с базой, которой у агента больше нет.
  const autoArgs = { title: w.title, maxDepth: 8, maxElements: 400, mode: "auto" };
  const base1 = await call("computer_read_screen", autoArgs);
  let tok = null;
  try { tok = JSON.parse(base1.text).token ?? null; } catch { /* не JSON — дельты не будет */ }
  const firstTok = tok;
  let delta = { ok: false, text: "", chars: 0, ms: 0 };
  const deltaRuns = [];
  for (let i = 0; i < REPEAT && tok; i++) {
    const d = await call("computer_read_screen", { ...autoArgs, since: tok });
    deltaRuns.push(d.ms);
    delta = d;
    try { tok = JSON.parse(d.text).token ?? tok; } catch { /* ответ не JSON, токен прежний */ }
  }
  delta = { ...delta, median: median(deltaRuns) };
  // Тот же вызов со старым токеном: должен стоить как полный вид, и это не баг.
  const stale = firstTok
    ? await call("computer_read_screen", { ...autoArgs, since: firstTok })
    : { ok: false, text: "", chars: 0, ms: 0 };
  let staleKind = "-";
  try { staleKind = JSON.parse(stale.text).kind ?? "-"; } catch { /* не JSON */ }

  const shot = await timed("computer_screenshot", { window: w.title });
  const shotHalf = await timed("computer_screenshot", { window: w.title, scale: 0.5, format: "jpeg", quality: 80 });
  const ocr = await timed("computer_ocr", { region, lang: "ru-RU" });
  const find = await timed("computer_find", { title: w.title, type: "Button", limit: 1 });

  const shotTokens = tokImageAnthropic(rect.w, rect.h);
  // Адресуемость: сколько элементов вообще можно назвать и по ним кликнуть.
  // Снимок не адресует ничего, поэтому сравнение токенов без этого числа
  // сравнивает разные вещи: карту с картинкой.
  let addressable = 0;
  const countNamed = (nodes) => {
    let n = 0;
    for (const node of nodes ?? []) {
      if (node && node.name) n++;
      if (node && node.children) n += countNamed(node.children);
    }
    return n;
  };
  try { addressable = countNamed(JSON.parse(full.text).windows); } catch { /* не JSON */ }

  perWindow.push({
    title: w.title, rect, addressable,
    full: { ms: full.median, ok: full.ok, tokens: tokText(full.text) },
    compact: { ms: compact.median, ok: compact.ok, tokens: tokText(compact.text) },
    lean: { ms: lean.median, ok: lean.ok, tokens: tokText(lean.text) },
    delta: { ms: delta.median, ok: delta.ok, tokens: tokText(delta.text) },
    stale: { ms: stale.ms, kind: staleKind, tokens: tokText(stale.text) },
    shot: { ms: shot.median, ok: shot.ok, tokens: shotTokens, got: !!shot.img },
    shotHalf: { ms: shotHalf.median, ok: shotHalf.ok, tokens: Math.ceil(shotTokens / 4) },
    ocr: { ms: ocr.median, ok: ocr.ok, tokens: tokText(ocr.text) },
    find: { ms: find.median, ok: find.ok, tokens: tokText(find.text) },
  });
}

table(
  ["окно", "дерево", "compact", "интеракт.", "дельта", "снимок", "снимок 0.5", "OCR", "find"],
  perWindow.map((r) => [
    r.title.slice(0, 26),
    r.full.ok ? `${r.full.tokens} т / ${r.full.ms} мс` : "прочерк",
    r.compact.ok ? `${r.compact.tokens} т / ${r.compact.ms} мс` : "прочерк",
    r.lean.ok ? `${r.lean.tokens} т / ${r.lean.ms} мс` : "прочерк",
    r.delta.ok ? `${r.delta.tokens} т / ${r.delta.ms} мс` : "прочерк",
    r.shot.ok && r.shot.got ? `${r.shot.tokens} т / ${r.shot.ms} мс` : "прочерк",
    r.shotHalf.ok ? `${r.shotHalf.tokens} т / ${r.shotHalf.ms} мс` : "прочерк",
    r.ocr.ok ? `${r.ocr.tokens} т / ${r.ocr.ms} мс` : "прочерк",
    r.find.ok ? `${r.find.tokens} т / ${r.find.ms} мс` : "прочерк",
  ]),
);

console.log("\nТо же в токенах OpenAI high detail для картинок:");
table(
  ["окно", "снимок", "структура (compact)", "выигрыш структуры"],
  perWindow.map((r) => [
    r.title.slice(0, 26),
    String(tokImageOpenAI(r.rect.w, r.rect.h)),
    r.compact.ok ? String(r.compact.tokens) : "прочерк",
    r.compact.ok && r.compact.tokens > 0
      ? `${(tokImageOpenAI(r.rect.w, r.rect.h) / r.compact.tokens).toFixed(1)}x`
      : "прочерк",
  ]),
);

// Токены сами по себе сравнивают разные вещи: снимок не адресует ни одного
// элемента, дерево адресует все. Без этой строки выигрыш структуры выглядит
// как проигрыш, а отсеянное дерево — как победа.
console.log("\n1b. За что платим: токены на один адресуемый элемент");
console.log("-".repeat(78));
table(
  ["окно", "дерево целиком", "с фильтром", "элементов", "т/элемент", "снимок", "элементов у снимка"],
  perWindow.map((r) => [
    r.title.slice(0, 26),
    r.full.ok ? `${r.full.tokens} т` : "прочерк",
    r.lean.ok ? `${r.lean.tokens} т` : "прочерк",
    r.full.ok ? String(r.addressable) : "-",
    r.full.ok && r.addressable > 0 ? `${(r.full.tokens / r.addressable).toFixed(0)}` : "-",
    r.shot.ok ? `${r.shot.tokens} т` : "прочерк",
    "0",
  ]),
);

console.log("\n1c. Дельта и её протокол");
console.log("-".repeat(78));
console.log("Каждый ответ дельты возвращает новый токен, и следующий вызов обязан");
console.log("нести именно его. Старый токен означает «сравнивать не с чем»: сервер");
console.log("отдаёт полный вид и честно пишет об этом в note.\n");
table(
  ["окно", "повтор со свежим токеном", "тот же вызов со старым токеном", "во сколько раз дороже"],
  perWindow.map((r) => [
    r.title.slice(0, 26),
    r.delta.ok ? `${r.delta.tokens} т / ${r.delta.ms} мс` : "прочерк",
    `${r.stale.kind}: ${r.stale.tokens} т / ${r.stale.ms} мс`,
    r.delta.ok && r.stale.tokens > 0 ? `${(r.stale.tokens / Math.max(1, r.delta.tokens)).toFixed(0)}x` : "-",
  ]),
);

// --- 2. когда координаты уже известны ------------------------------------------
console.log("\n2. Ответ на вопрос, если координаты уже известны");
console.log("-".repeat(78));
console.log("Структурное чтение окна и OCR того же куска экрана: кто дешевле,");
console.log("если нужно одно поле, а не карта интерфейса.\n");

const regionRows = [];
for (const w of targets) {
  const rect = w.rect;
  // Кусок берётся не с потолка: верхняя полоса окна, потом следующие полосы,
  // пока не найдётся строка с текстом. Нет текста — честный прочерк.
  const strips = [
    [rect.x + 8, rect.y + 8, Math.min(420, rect.w - 16), 40],
    [rect.x + 8, rect.y + Math.round(rect.h * 0.25), Math.min(420, rect.w - 16), 40],
    [rect.x + 8, rect.y + Math.round(rect.h * 0.5), Math.min(420, rect.w - 16), 40],
    [rect.x + 8, rect.y + Math.round(rect.h * 0.75), Math.min(420, rect.w - 16), 40],
  ];
  let hit = null;
  for (const [x, y, w2, h2] of strips) {
    if (w2 <= 0 || h2 <= 0) continue;
    const o = await call("computer_ocr", { region: `${x},${y},${w2},${h2}`, lang: "ru-RU" });
    let lines = 0;
    try { lines = JSON.parse(o.text).lineCount ?? 0; } catch { /* не JSON */ }
    if (lines > 0) { hit = { o, x, y, w2, h2, lines }; break; }
  }
  if (!hit) {
    regionRows.push([w.title.slice(0, 26), "текст не нашёлся", "-", "-", "-"]);
    continue;
  }
  const struct = await timed("computer_read_screen", { title: w.title, maxDepth: 4, maxElements: 120, interactiveOnly: true, compact: true });
  const regionShot = await timed("computer_screenshot", { region: `${hit.x},${hit.y},${hit.w2},${hit.h2}` });
  const imgTok = tokImageAnthropic(hit.w2, hit.h2);
  regionRows.push([
    w.title.slice(0, 26),
    `${hit.lines} стр. ${hit.w2}x${hit.h2}`,
    struct.ok ? `${tokText(struct.text)} т / ${struct.ms} мс` : "прочерк",
    `${tokText(hit.o.text)} т / ${hit.o.ms} мс`,
    regionShot.ok ? `${imgTok} т / ${regionShot.ms} мс` : "прочерк",
  ]);
}
table(["окно", "полоса", "структура", "OCR полосы", "снимок полосы"], regionRows);

// --- 3. задержки по инструментам ------------------------------------------------
console.log("\n3. Задержка инструментов (медиана из", REPEAT, "прогонов)");
console.log("-".repeat(78));
const first = targets[0];
if (first) {
  const lat = [];
  const add = async (label, name, args) => {
    const r = await timed(name, args);
    lat.push([label, r.ok ? `${r.median} мс` : `отказ, ${r.median} мс`, `${r.min}-${r.max} мс`]);
  };
  await add("screeninfo", "computer_screeninfo", {});
  await add("windows", "computer_windows", {});
  await add("active_window", "computer_active_window", {});
  await add("cursor", "computer_cursor", {});
  await add("wait 10 мс", "computer_wait", { ms: 10 });
  await add("find (кнопка)", "computer_find", { title: first.title, type: "Button", limit: 1 });
  await add("element_at", "computer_element_at", { x: 100, y: 100 });
  await add("read_screen compact", "computer_read_screen", { title: first.title, maxDepth: 5, maxElements: 150, compact: true });
  await add("снимок окна 0.4", "computer_screenshot", { window: first.title, scale: 0.4 });
  await add("OCR полосы", "computer_ocr", { region: `${first.rect.x},${first.rect.y},400,60`, lang: "ru-RU" });
  await add("wait_element state", "computer_wait_element", {
    title: first.title, name: "ZZZнеттакого", mode: "appear", timeoutMs: 400,
  });
  await add("select отказ", "computer_select", { title: first.title, name: "ZZZнеттакой", value: "x" });
  await add("read_table отказ", "computer_read_table", { title: first.title, name: "ZZZнеттакойтаблицы" });
  table(["инструмент", "медиана", "разброс"], lat);
  console.log(`\n(на окне «${first.title}»)`);
} else {
  console.log("окон нет, раздел пропущен");
}

// --- 4. где desk-mcp проигрывает -------------------------------------------------
console.log("\n4. Где desk-mcp проигрывает");
console.log("-".repeat(78));
const losses = [];

// 4.1 Координаты известны: чтение целого дерева вместо куска pixels.
// Числа берутся из раздела 2, где тот же вопрос решался тремя способами.
for (const row of regionRows) {
  const win = targets.find((t) => t.title.slice(0, 26) === row[0]);
  if (!win) continue;
  const structTok = Number(String(row[2]).split(" ")[0]) || 0;
  const ocrTok = Number(String(row[3]).split(" ")[0]) || 0;
  if (structTok > 0 && ocrTok > 0 && ocrTok < structTok) {
    losses.push([
      "координаты известны",
      win.title.slice(0, 22),
      `OCR полосы ${ocrTok} т против чтения окна ${structTok} т`,
      `дешевле в ${(structTok / ocrTok).toFixed(1)}x`,
    ]);
  }
}
// 4.2 Нефильтрованное дерево дороже снимка того же окна.
for (const r of perWindow) {
  if (r.full.ok && r.shot.ok && r.shot.tokens > 0 && r.full.tokens > r.shot.tokens) {
    losses.push([
      "без фильтра",
      r.title.slice(0, 22),
      `дерево ${r.full.tokens} т против снимка ${r.shot.tokens} т`,
      `дороже в ${(r.full.tokens / r.shot.tokens).toFixed(1)}x`,
    ]);
  }
}
// 4.3 Обход дерева дороже снимка даже на спокойных окнах.
for (const r of perWindow) {
  if (r.full.ok && r.shot.ok && r.shot.ms > 0 && r.full.ms > r.shot.ms * 2) {
    losses.push([
      "обход дерева",
      r.title.slice(0, 22),
      `дерево ${r.full.ms} мс против снимка ${r.shot.ms} мс`,
      `медленнее в ${(r.full.ms / r.shot.ms).toFixed(1)}x`,
    ]);
  }
}
// 4.4 Дельта не помогает, если токен устарел или окно перерисовывается само.
for (const r of perWindow) {
  if (r.delta.ok && r.stale.tokens > r.delta.tokens * 2) {
    losses.push([
      "устаревший токен",
      r.title.slice(0, 22),
      `дельта ${r.delta.tokens} т, тот же вызов со старым токеном ${r.stale.tokens} т (${r.stale.kind})`,
      `дороже в ${(r.stale.tokens / Math.max(1, r.delta.tokens)).toFixed(0)}x`,
    ]);
  }
}
if (losses.length) table(["случай", "окно", "сравнение", "исход"], losses);
else console.log("в этом прогоне ни один случай не проиграл: так бывает на спокойных окнах");

console.log("\nСлучаи, которые этот прогон не измерял, но где подход проигрывает заведомо:");
console.log("  - эксклюзивный полноэкранный режим: снимок чёрный, читать нечего;");
console.log("    дерево там обычно тоже пустое, помогает только OCR по кадру ввода");
console.log("  - визуальный вопрос («какого цвета кнопка», «съехала ли вёрстка»):");
console.log("    в структуре ответа нет вообще, есть только снимок");
console.log("  - таблица без строки заголовка: у TablePatternInformation в .NET нет");
console.log("    признака «эта строка заголовок», поэтому первая строка читается как");
console.log("    заголовок по соглашению и может оказаться данными");
console.log("  - приложение перерисовывает каждый кадр: дельта схлопывается в full,");
console.log("    и тогда повторное чтение стоит как первое");

// --- 5. пределы измерения ---------------------------------------------------------
console.log("\n5. Пределы этого бенчмарка");
console.log("-".repeat(78));
for (const line of [
  "  - числа привязаны к этой машине и к тем окнам, что открыты сейчас; на другой",
  "    машине и с другими окнами таблица будет другой, порядок величин тоже",
  "  - измеряется стоимость и задержка чтения, а не качество решения агента:",
  "    насколько агент верно выберет инструмент, по этим числам не судить",
  "  - окна не нагружаются искусственно: параллельной работы приложений,",
  "    сворачивания, смены мониторов и многомониторного DPI здесь нет",
  "  - токены текста считаются формулой символы / 4: для русского текста с",
  "    кириллицей реальная цена выше, и обе стороны проигрывают одинаково",
  "  - картинки считаются по формулам Anthropic и OpenAI, реальная цена",
  "    зависит от модели и от того, как клиент режет картинку на плитки",
]) console.log(line);

const out = {
  at: new Date().toISOString(),
  node: process.version,
  os: os.version(),
  repeat: REPEAT,
  screens: perWindow.map((r) => ({
    title: r.title, rect: r.rect,
    tree: r.full, compact: r.compact, lean: r.lean, delta: r.delta,
    screenshotTokens: r.shot.tokens, screenshotMs: r.shot.ms,
    ocr: r.ocr, find: r.find,
  })),
  losses,
};
writeFileSync(path.join(__dirname, "bench-last.json"), JSON.stringify(out, null, 2));
console.log("\nСырые числа: bench-last.json");
await c.close();
process.exit(0);