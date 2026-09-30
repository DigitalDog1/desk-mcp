#!/usr/bin/env node
/**
 * desk-mcp — MCP-сервер управления рабочим столом Windows.
 *
 * Транспорт: stdio (как требует MCP). Логика: long-running PowerShell-воркер,
 * общение построчно в base64, чтобы кириллица не ломалась на кодовой странице
 * консоли. Воркер один на весь сессионный жизненный цикл — иначе каждый вызов
 * платил бы ~1.5 с на старт PowerShell и компиляцию Add-Type.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, "worker.ps1");
const CALL_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 25_000;

// --- воркер -------------------------------------------------------------------

class Worker {
  constructor() {
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.readyPromise = null;
    this.restarts = 0;
  }

  get alive() {
    return !!this.proc && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  start() {
    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-File", WORKER],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.proc = proc;

    proc.stdout.setEncoding("utf8");
    const lines = readline.createInterface({ input: proc.stdout });
    lines.on("line", (line) => this.#onLine(line));

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d) => {
      const s = String(d).trim();
      if (s) process.stderr.write(`[worker] ${s}\n`);
    });

    // Без этого Node падает с «Unhandled 'error' event» и голым стектрейсом,
    // если powershell.exe не найден (битый PATH). Проверено ревьюером.
    proc.on("error", (e) => {
      process.stderr.write(`[worker] ошибка запуска: ${e.message}\n`);
      this.#rejectAll(new Error(`Не удалось запустить PowerShell: ${e.message}`));
    });

    proc.on("exit", (code, signal) => {
      if (this.proc !== proc) return;
      process.stderr.write(`[worker] вышел (code=${code}, signal=${signal ?? "-"})`);
      this.#rejectAll(new Error("Воркер неожиданно завершился"));
    });

    this.readyPromise = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Воркер не поднялся за 25 с")), READY_TIMEOUT_MS);
      this.#onReady = (data) => {
        clearTimeout(t);
        this.#onReady = null;
        resolve(data);
      };
    });
  }

  #onReady = null;

  #rejectAll(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  #onLine(line) {
    if (!line.startsWith("B64:")) return;
    let msg;
    try {
      msg = JSON.parse(Buffer.from(line.slice(4), "base64").toString("utf8"));
    } catch {
      return;
    }
    if (msg.id === 0 && this.#onReady) {
      this.#onReady(msg.data);
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.data);
    else entry.reject(new Error(msg.error || "Ошибка в воркере"));
  }

  /**
   * Воркер — единая точка отказа. Один зависший UIA-RPC в зависшее окно
   * (классика UI Automation) убивает процесс, и без перезапуска канал мёртв
   * до рестарта клиента, при том что MCP-сервер продолжает рекламировать все
   * 19 тулов как рабочие.
   */
  async ensure() {
    if (this.alive) return;
    if (this.restarts > 5) {
      throw new Error(`Воркер падает ${this.restarts} раз подряд — канал не восстановить`);
    }
    this.restarts++;
    process.stderr.write(`[worker] перезапуск #${this.restarts}\n`);
    this.start();
    await this.readyPromise;
  }

  async call(tool, args, timeoutMs = CALL_TIMEOUT_MS) {
    await this.ensure();
    const proc = this.proc;
    if (!this.alive) {
      return Promise.reject(new Error("Воркер не запущен"));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, tool, args: args ?? {} });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Инструмент '${tool}' не ответил за ${timeoutMs / 1000} с`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(payload + "\n", (err) => {
        if (!err) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`Запись в воркер не удалась: ${err.message}`));
      });
    });
  }

  async stop() {
    if (!this.proc) return;
    this.proc.stdin.end();
    this.proc.kill();
  }
}

const worker = new Worker();
worker.start();

function text(s) {
  return { content: [{ type: "text", text: String(s) }] };
}
function fail(e) {
  return {
    isError: true,
    content: [{ type: "text", text: `Ошибка: ${e?.message ?? e}` }],
  };
}
const R = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return fail(e);
  }
};

// --- сервер -------------------------------------------------------------------

const server = new McpServer({ name: "desk-mcp", version: "1.0.0" });

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

server.registerTool(
  "computer_screenshot",
  {
    title: "Снимок экрана",
    description:
      "Снимает экран и возвращает картинку, которую модель видит. region — 'x,y,w,h' " +
      "(по умолчанию весь виртуальный экран). format: png | jpeg. scale — уменьшение, " +
      "например 0.5, чтобы не жечь токены на полноразмерном 2560x1440.",
    inputSchema: {
      region: z.string().optional().describe("'x,y,w,h'. Пусто — весь виртуальный экран"),
      format: z.enum(["png", "jpeg"]).optional().default("png"),
      scale: z.number().min(0.1).max(2).optional().describe("1 = как есть, 0.5 = вдвое меньше"),
      quality: z.number().int().min(1).max(100).optional().default(80),
    },
  },
  R(async (a) => {
    const s = await worker.call("screenshot", a);
    return {
      content: [
        { type: "image", data: s.bytes, mimeType: s.mime },
        { type: "text", text: `Снимок ${s.width}x${s.height} (${s.mime}, ${(s.bytes.length / 1024) | 0} КБ) в области ${s.region.x},${s.region.y} ${s.region.w}x${s.region.h}` },
      ],
    };
  }),
);

server.registerTool(
  "computer_screeninfo",
  {
    title: "Информация об экранах",
    description: "Границы виртуального экрана и всех подключённых мониторов.",
    inputSchema: {},
  },
  R(async () => ok(await worker.call("screeninfo", {}))),
);

server.registerTool(
  "computer_permissions",
  {
    title: "Проверка прав",
    description:
      "Проверяет, доступны ли UI Automation, буфер обмена и окна. Возвращает список " +
      "конкретных проблем вместо того, чтобы молча падать позже.",
    inputSchema: {},
  },
  R(async () => ok(await worker.call("permissions", {}))),
);

server.registerTool(
  "computer_click",
  {
    title: "Клик мышью",
    description:
      "Кликает в точку. hoverFirst — навести и подождать 250 мс перед кликом: " +
      "обязателен для кнопок, которые рисуются только под курсором, иначе клик уходит в пустоту.",
    inputSchema: {
      x: z.number().int(),
      y: z.number().int(),
      button: z.enum(["left", "right", "middle"]).optional().default("left"),
      count: z.number().int().min(1).max(5).optional().default(1),
      hoverFirst: z.boolean().optional().default(false),
      modifiers: z.array(z.enum(["ctrl", "shift", "alt", "win"])).optional()
        .describe("удержать модификаторы во время клика: ctrl+click закрывает вкладку, shift+click расширяет выбор"),
    },
  },
  R(async (a) => ok(await worker.call("click", a))),
);

server.registerTool(
  "computer_move",
  { title: "Навести мышь", description: "Перемещает курсор в точку, ничего не нажимая.", inputSchema: { x: z.number().int(), y: z.number().int() } },
  R(async (a) => ok(await worker.call("move", a))),
);

server.registerTool(
  "computer_drag",
  { title: "Перетащить", description: "Зажимает левую кнопку в одной точке и тянет в другую (слайдеры, DnD, перемещение окон).", inputSchema: {
    fromX: z.number().int(), fromY: z.number().int(), toX: z.number().int(), toY: z.number().int(),
    steps: z.number().int().min(2).max(500).optional().default(25),
    stepMs: z.number().int().min(0).max(200).optional().default(12),
  } },
  R(async (a) => ok(await worker.call("drag", a))),
);

server.registerTool(
  "computer_scroll",
  { title: "Колесо мыши", description: "Прокручивает колесом. Положительный dy — вниз, как везде. Укажи x,y чтобы навести на нужный элемент.", inputSchema: {
    x: z.number().int().optional(), y: z.number().int().optional(),
    dx: z.number().int().optional().default(0), dy: z.number().int().optional().default(0),
  } },
  R(async (a) => ok(await worker.call("scroll", a))),
);

server.registerTool(
  "computer_type",
  {
    title: "Ввести текст",
    description:
      "Печатает текст в то, что сейчас в фокусе, посимвольно через SendInput + KEYEVENTF_UNICODE. " +
      "Кириллица работает, в отличие от SendKeys. Поле может содержать чужой черновик — " +
      "этот инструмент его не чистит, сначала выдели всё (ctrl+a) и удали.",
    inputSchema: { text: z.string() },
  },
  R(async (a) => ok(await worker.call("type", a))),
);

server.registerTool(
  "computer_key",
  {
    title: "Нажать клавиши",
    description:
      "Комбинации клавиш: 'ctrl+c', 'return', 'escape', 'tab', 'f5', 'alt+tab', 'a', 'shift+enter'. " +
      "Имена: return/enter, escape/esc, tab, backspace, delete, insert, space, home, end, pageup, " +
      "pagedown, up/down/left/right, f1-f24, ctrl, shift, alt, win, capsLock, printScreen.",
    inputSchema: { keys: z.string().describe("например ctrl+c или return") },
  },
  R(async (a) => ok(await worker.call("key", a))),
);

server.registerTool(
  "computer_windows",
  { title: "Список окон", description: "Верхнеуровневые окна: заголовок, pid, класс, границы, видимость.", inputSchema: { filter: z.string().optional().describe("подстрока заголовка") } },
  R(async (a) => ok(await worker.call("windows", a))),
);

server.registerTool(
  "computer_focus",
  {
    title: "Перевести фокус на окно",
    description:
      "Поднимает окно по подстроке заголовка и делает его активным. Пытается обойти " +
      "отказ SetForegroundWindow через AttachThreadInput — иначе фокус уезжает в никуда молча.",
    inputSchema: { title: z.string() },
  },
  R(async (a) => ok(await worker.call("focus", a))),
);

server.registerTool(
  "computer_wait_window",
  {
    title: "Дождаться окна",
    description: "Ждёт появления окна по подстроке заголовка. Бросает ошибку по таймауту, а не висит молча.",
    inputSchema: { title: z.string(), timeoutSec: z.number().int().min(1).max(300).optional().default(20) },
  },
  R(async (a) => ok(await worker.call("wait_window", a, a.timeoutSec * 1000 + 5000))),
);

server.registerTool(
  "computer_close_window",
  { title: "Закрыть окно", description: "Закрывает окно по подстроке заголовка. force — убить процесс.", inputSchema: { title: z.string(), force: z.boolean().optional().default(false) } },
  R(async (a) => ok(await worker.call("close_window", a))),
);

server.registerTool(
  "computer_launch",
  { title: "Запустить программу", description: "Запускает исполняемый файл. Путь до .exe обязателен.", inputSchema: {
    path: z.string(), args: z.array(z.string()).optional(), hidden: z.boolean().optional().default(false),
  } },
  R(async (a) => ok(await worker.call("launch", a))),
);

server.registerTool(
  "computer_read_screen",
  {
    title: "Прочитать дерево UI",
    description:
      "Отдаёт дерево Accessibility (UI Automation) окон: имена, роли, id, границы, " +
      "включённость. Это точное попадание вместо угадывания координат по пикселям. " +
      "interactiveOnly — оставить только кликабельное и вводимое.",
    inputSchema: {
      title: z.string().optional().describe("подстрока заголовка окна; пусто — все видимые"),
      maxDepth: z.number().int().min(1).max(30).optional().default(6),
      maxElements: z.number().int().min(1).max(3000).optional().default(300),
      interactiveOnly: z.boolean().optional().default(false),
      backend: z.enum(["auto", "uia", "msaa"]).optional().default("auto")
        .describe("auto пробует UIA и при пустом дереве откатывается на MSAA. " +
                  "UIA не работает для Discord/Chrome/VSCode, пока они не запущены с --force-renderer-accessibility"),
    },
  },
  R(async (a) => ok(await worker.call("read_screen", a, 60_000))),
);

server.registerTool(
  "computer_element_at",
  {
    title: "Что в этой точке",
    description:
      "Возвращает цепочку UI-элементов под точкой (от мелкого к окну) с ролями и границами. " +
      "Вызывай перед кликом, если координаты взяты из скриншота.",
    inputSchema: { x: z.number().int(), y: z.number().int() },
  },
  R(async (a) => ok(await worker.call("element_at", a))),
);

server.registerTool(
  "computer_clipboard_get",
  { title: "Прочитать буфер", description: "Текст из буфера обмена. ВНИМАНИЕ: Get-Clipboard -Path ложит файл, а не текст — здесь только текст.", inputSchema: {} },
  R(async (a) => ok(await worker.call("clipboard_get", a))),
);

server.registerTool(
  "computer_clipboard_set",
  { title: "Записать в буфер", description: "Кладёт текст в буфер обмена.", inputSchema: { text: z.string() } },
  R(async (a) => ok(await worker.call("clipboard_set", a))),
);

server.registerTool(
  "computer_selftest",
  {
    title: "Самопроверка",
    description:
      "Проверяет канал целиком: снимок непустой, SendInput отвечает, UI Automation жива, окна видны. " +
      "Пустой PNG и «канал сломан» выглядят одинаково — поэтому проверять надо явно.",
    inputSchema: {},
  },
  R(async () => ok(await worker.call("selftest", {}))),
);

server.registerTool(
  "computer_find",
  {
    title: "Найти элемент",
    description:
      "Ищет элемент по имени, роли или automationId и возвращает его описание: границы, " +
      "поддерживаемые паттерны (Invoke/Value/Toggle/SelectionItem), текущее значение, enabled. " +
      "Это то, что потом используют computer_invoke и computer_set_value — клик по смыслу, " +
      "а не по координатам, которые успевают устареть между снимком и кликом.",
    inputSchema: {
      title: z.string().optional().describe("подстрока заголовка окна; пусто — все видимые"),
      name: z.string().optional().describe("подстрока имени элемента"),
      type: z.string().optional().describe("ControlType: Button, Edit, CheckBox, Hyperlink..."),
      id: z.string().optional().describe("точный AutomationId"),
      maxDepth: z.number().int().min(1).max(20).optional().default(8),
      limit: z.number().int().min(1).max(50).optional().default(20),
    },
  },
  R(async (a) => ok(await worker.call("find", a, 60_000))),
);

server.registerTool(
  "computer_invoke",
  {
    title: "Нажать элемент",
    description:
      "Находит элемент по имени/роли/id и нажимает его через UIA InvokePattern — БЕЗ захвата " +
      "мыши и без перевода окна на передний план. Если InvokePattern недоступен, падает обратно " +
      "на клик по центру границ элемента (тогда окно получит фокус).",
    inputSchema: {
      title: z.string().optional(),
      name: z.string().optional(),
      type: z.string().optional(),
      id: z.string().optional(),
      maxDepth: z.number().int().min(1).max(20).optional().default(8),
    },
  },
  R(async (a) => ok(await worker.call("invoke", a, 60_000))),
);

server.registerTool(
  "computer_set_value",
  {
    title: "Записать значение поля",
    description:
      "Ставит значение через UIA ValuePattern, без фокуса и без эмуляции клавиш. " +
      "Не сработает там, где приложение держит значение только в своём обработчике — " +
      "проверяй результат через computer_verify_state, а не по факту вызова.",
    inputSchema: {
      title: z.string().optional(),
      name: z.string().optional(),
      type: z.string().optional(),
      id: z.string().optional(),
      value: z.string(),
      maxDepth: z.number().int().min(1).max(20).optional().default(8),
    },
  },
  R(async (a) => ok(await worker.call("set_value", a, 60_000))),
);

server.registerTool(
  "computer_select_text",
  {
    title: "Выделить текст поля",
    description: "Кликает по полю и выделяет всё содержимое (Ctrl+A).", inputSchema: {
      title: z.string().optional(), name: z.string().optional(),
      type: z.string().optional(), id: z.string().optional(),
      maxDepth: z.number().int().min(1).max(20).optional().default(8),
    },
  },
  R(async (a) => ok(await worker.call("select_text", a, 60_000))),
);

server.registerTool(
  "computer_verify_state",
  {
    title: "Проверить состояние",
    description:
      "Проверяет 1-8 предикатов: элемент существует, значение равно, enabled, selected. " +
      "Возвращает satisfied/unsatisfied/unknown по каждому. unknown — это НЕ успех: значит " +
      "состояние не удалось прочитать, и утверждать успех на его основании нельзя.",
    inputSchema: {
      title: z.string().optional().describe("подстрока заголовка окна для поиска элементов"),
      expect: z.array(z.object({
        label: z.string().optional(),
        window: z.object({ exists: z.boolean().optional() }).optional(),
        selector: z.object({
          role: z.string().optional(),
          label_contains: z.string().optional(),
        }).optional(),
        value_equals: z.string().optional(),
        enabled: z.boolean().optional(),
        selected: z.boolean().optional(),
      })).min(1).max(8),
    },
  },
  R(async (a) => ok(await worker.call("verify", a, 60_000))),
);

server.registerTool(
  "computer_window_set_frame",
  {
    title: "Передвинуть/изменить размер окна",
    description:
      "MoveWindow по подстроке заголовка. Для перемещения не передавай width/height — размер " +
      "сохранится. Возвращает запрошенную и фактическую геометрию, чтобы проверить результат.",
    inputSchema: {
      title: z.string(),
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      width: z.number().int().min(1).optional(),
      height: z.number().int().min(1).optional(),
    },
  },
  R(async (a) => ok(await worker.call("set_frame", a))),
);

server.registerTool(
  "computer_active_window",
  { title: "Активное окно", description: "Какое окно сейчас в фокусе: pid, процесс, заголовок.", inputSchema: {} },
  R(async () => ok(await worker.call("active_window", {}))),
);

server.registerTool(
  "computer_key_down",
  {
    title: "Зажать клавишу",
    description:
      "Нажимает клавишу и НЕ отпускает. Нужен для удержания: красться в игре, тянуть ползунок " +
      "с зажатым Shift, комбинации с несколькими одновременными клавишами. " +
      "Обязательно отпусти через computer_key_up — иначе клавиша останется зажатой.",
    inputSchema: { key: z.string().describe("shift, ctrl, e, w, space...") },
  },
  R(async (a) => ok(await worker.call("key_down", a))),
);

server.registerTool(
  "computer_key_up",
  { title: "Отпустить клавишу", description: "Отпускает ранее зажатую через computer_key_down.", inputSchema: { key: z.string() } },
  R(async (a) => ok(await worker.call("key_up", a))),
);

server.registerTool(
  "computer_wait",
  {
    title: "Пауза",
    description: "Ждёт указанное число миллисекунд (0..120000). Нужна после запуска приложения, " +
      "перед кликом по элементу, который ещё перерисовывается, или между шагами в игре.",
    inputSchema: { ms: z.number().int().min(0).max(120000).optional().default(1000) },
  },
  R(async (a) => ok(await worker.call("wait", a))),
);

server.registerTool(
  "computer_mouse_button",
  {
    title: "Зажать/отпустить кнопку мыши",
    description: "Отдельное нажатие и отпускание кнопки — для составных жестов, которые нельзя " +
      "собрать одним computer_drag (например, нажать, подвинуть, отпустить через паузу).",
    inputSchema: {
      button: z.enum(["left", "right", "middle"]).optional().default("left"),
      down: z.boolean().describe("true — нажать и держать, false — отпустить"),
    },
  },
  R(async (a) => ok(await worker.call("mouse_button", a))),
);

server.registerTool(
  "computer_cursor",
  { title: "Позиция курсора", description: "Где сейчас курсор мыши.", inputSchema: {} },
  R(async () => ok(await worker.call("cursor", {}))),
);

// --- запуск -------------------------------------------------------------------

async function main() {
  const ready = await worker.readyPromise;
  process.stderr.write(`[desk-mcp] воркер готов: pid ${ready.pid}, PowerShell ${ready.powershell}\n`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[desk-mcp] MCP-сервер слушает stdio\n");
}

process.on("SIGINT", () => worker.stop().finally(() => process.exit(0)));
process.on("SIGTERM", () => worker.stop().finally(() => process.exit(0)));

main().catch((e) => {
  process.stderr.write(`[desk-mcp] запуск не удался: ${e?.stack ?? e}\n`);
  process.exit(1);
});
