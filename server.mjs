#!/usr/bin/env node
/**
 * desk-mcp — MCP-сервер управления рабочим столом Windows.
 *
 * Транспорт: stdio (как требует MCP). Логика: long-running PowerShell-воркер,
 * общение построчно в base64, чтобы кириллица не ломалась на кодовой странице
 * консоли. Воркер один на весь сессионный жизненный цикл — иначе каждый вызов
 * платил бы ~1.5 с на старт PowerShell и компиляцию Add-Type.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
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
    this.startedAt = Date.now();
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
   * тулы как рабочие.
   *
   * Перезапуски с экспоненциальной паузой: без неё воркер, который падает
   * каждый раз (например, UIA заблокирован), перезапускается в цикле и
   * ест CPU. Счётчик сбрасывается, если воркер успешно проработал 30 с.
   */
  async ensure() {
    if (this.alive) {
      if (this.restarts > 0 && Date.now() - this.startedAt > 30_000) {
        process.stderr.write(`[worker] стабилен, счётчик рестартов сброшен\n`);
        this.restarts = 0;
      }
      return;
    }
    // Жёсткий отказ «канал не восстановить» был ловушкой: если висящее окно
    // (1С, WPF, защищённое приложение) не уходит, шесть попыток — и все
    // инструменты MCP-сервера мертвы до ручного перезапуска. Теперь это просто
    // длинная пауза со сбросом: канал оживает при первой же возможности, даже
    // после многих зависаний подряд.
    if (this.restarts >= 5) {
      this.restarts = 0;
      process.stderr.write("[worker] много зависаний подряд — пауза 30 с и новая попытка\n");
      await new Promise((r) => setTimeout(r, 30_000));
    }
    this.restarts++;
    const delay = Math.min(500 * 2 ** (this.restarts - 1), 8000);
    process.stderr.write(`[worker] перезапуск #${this.restarts} через ${delay} мс\n`);
    await new Promise((r) => setTimeout(r, delay));
    this.start();
    try {
      await this.readyPromise;
    } catch (e) {
      // Воркер не ответил ready за 25 с. Если процесс при этом жив, он
      // становится зомби: alive === true, в stdin пишется, ответа нет, и
      // каждый следующий вызов висит до своего таймаута. Убиваем сразу —
      // ensure() поднимет новый при следующем обращении.
      this.kill();
      throw e;
    }
    this.startedAt = Date.now();
  }

  kill() {
    if (!this.proc) return;
    try {
      this.proc.kill();
    } catch { /* уже мёртв */ }
    this.proc = null;
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
        // Инструмент не ответил — почти всегда это зависший UIA-RPC
        // (типично: приложение 1С или старое WPF). Процесс при этом жив и
        // больше не вернётся, поэтому либо он мёртв для нас, либо через
        // паузу разрешит. Убиваем: ensure() поднимет новый на следующем
        // вызове, иначе канал мёртв до ручного рестарта.
        process.stderr.write(`[worker] '${tool}' не ответил за ${timeoutMs / 1000} с — воркер перезапускается\n`);
        this.kill();
        reject(new Error(`Инструмент '${tool}' не ответил за ${timeoutMs / 1000} с; воркер перезапущен, повтори вызов`));
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
      "например 0.5, чтобы не жечь токены на полноразмерном 2560x1440. " +
      "window — подстрока заголовка: снимок идёт через PrintWindow и работает даже если " +
      "окно перекрыто другим или свёрнуто.",
    inputSchema: {
      region: z.string().optional().describe("'x,y,w,h'. Пусто — весь виртуальный экран"),
      window: z.string().optional().describe("снимок конкретного окна через PrintWindow"),
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
        { type: "text", text: `Снимок ${s.width}x${s.height} (${s.mime}, ${(s.bytes.length / 1024) | 0} КБ, ${s.via}) в области ${s.region.x},${s.region.y} ${s.region.w}x${s.region.h}` },
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
  { title: "Закрыть окно", description: "Закрывает окно по подстроке заголовка. force — убить процесс. Требует confirm: true: действие разрушительное, а с force ещё и теряет несохранённые данные.", inputSchema: { title: z.string(), force: z.boolean().optional().default(false), confirm: z.boolean().optional() } },
  R(async (a) => ok(await worker.call("close_window", a))),
);

server.registerTool(
  "computer_launch",
  { title: "Запустить программу", description: "Запускает исполняемый файл. Путь до .exe обязателен. Требует confirm: true.", inputSchema: {
    path: z.string(), args: z.array(z.string()).optional(), hidden: z.boolean().optional().default(false),
    confirm: z.boolean().optional(),
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
  R(async (a) => ok(await worker.call("read_screen", a, 30_000))),
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
  "computer_bench",
  {
    title: "Тестовый стенд",
    description:
      "Поднимает собственное окно с контролами (кнопки, поле, флажок, выпадающий список, " +
      "список) и ведёт лог событий. Нужен для честных проверок: окно создаёт сам сервер, " +
      "поэтому результат не зависит от того, какие окна открыты у пользователя. " +
      "Виртуальные рабочие столы на этой машине недоступны, это замена им.",
    inputSchema: { action: z.enum(["show", "read", "close"]) },
  },
  R(async (a) => ok(await worker.call("bench", a))),
);

server.registerTool(
  "computer_desktop",
  {
    title: "Виртуальные рабочие столы",
    description:
      "Управление виртуальными рабочими столами Windows (Win+Ctrl+D). Нужен для изоляции: " +
      "можно создать стол, перенести туда нужное окно и работать, не трогая окна пользователя. " +
      "Действия: list, create (+switchTo), switch, close, of_window, move_window.",
    inputSchema: {
      action: z.enum(["list", "create", "switch", "close", "of_window", "move_window"]),
      id: z.string().optional().describe("GUID рабочего стола для switch/close/move_window"),
      title: z.string().optional().describe("подстрока заголовка окна для of_window/move_window"),
      switchTo: z.boolean().optional().describe("переключиться на созданный стол сразу"),
    },
  },
  R(async (a) => ok(await worker.call("desktop", a))),
);

server.registerTool(
  "computer_batch",
  {
    title: "Пачка действий",
    description:
      "Выполняет несколько инструментов подряд за один вызов и возвращает результат каждого. " +
      "Основной инструмент агентного цикла: не нужно делать 10 отдельных вызовов ради " +
      "«открыть, ввести, нажать, снять». Останавливается на первой ошибке, если у шага не " +
      "задано stopOnError: false.",
    inputSchema: {
      steps: z.array(z.object({
        tool: z.string().describe("имя инструмента desk-mcp"),
        args: z.record(z.any()).optional(),
        stopOnError: z.boolean().optional(),
      })).min(1).max(50),
    },
  },
  R(async (a) => ok(await worker.call("batch", a, 120_000))),
);

server.registerTool(
  "computer_ocr",
  {
    title: "Распознать текст на экране",
    description:
      "Читает текст прямо из пикселей через OCR-движок, встроенный в Windows " +
      "(Windows.Media.Ocr, поддерживает русский). Ноль моделей и нулевых зависимостей. Нужен там, " +
      "где нет ни UIA, ни MSAA: игры, видео, GPU-контент, UWP-приложения. " +
      "Возвращает строки и слова с границами — по границе слова можно кликнуть.",
    inputSchema: {
      region: z.string().optional().describe("'x,y,w,h'. По умолчанию — весь экран 2560x1440"),
      lang: z.string().optional().describe("например 'ru-RU' или 'en-US'; по умолчанию — язык профиля"),
    },
  },
  R(async (a) => ok(await worker.call("ocr", a, 45_000))),
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
  R(async (a) => ok(await worker.call("find", a, 30_000))),
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
  R(async (a) => ok(await worker.call("invoke", a, 30_000))),
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
  R(async (a) => ok(await worker.call("set_value", a, 30_000))),
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
  R(async (a) => ok(await worker.call("select_text", a, 30_000))),
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
  R(async (a) => ok(await worker.call("verify", a, 30_000))),
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

// --- Chrome DevTools Protocol ---------------------------------------------------
// UIA и MSAA для Chromium — костыль: Chromium отдаёт обрезанное дерево, обвязанное
// безымянными PANEL'ами. CDP даёт настоящий DOM: стабильные селекторы, текст,
// роли из accessibility tree самого браузера. Это единственный способ работать с
// веб-контентом не по пикселям.
const cdp = {
  port: 9222,
  nextId: 1,
  sockets: new Map(),

  async http(path) {
    const res = await fetch(`http://127.0.0.1:${cdp.port}${path}`, { signal: AbortSignal.timeout(4000) });
    return res.json();
  },

  async version() {
    return cdp.http("/json/version");
  },

  async targets() {
    const list = await cdp.http("/json/list");
    return list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  },

  async socket(target) {
    const key = target.id ?? target.url;
    if (cdp.sockets.has(key)) return cdp.sockets.get(key);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    // Карта pending обязана быть одна и та же у обработчика ответов и у send.
    // Раньше обработчик смотрел в локальную pending, а send писал в
    // client.pending — две разные карты, ответы молча терялись и каждый вызов
    // висел до таймаута.
    const client = { ws, pending: new Map(), send: null };
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("Не удалось подключиться к CDP")), { once: true });
    });
    client.send = (method, params) => cdp.send(client, method, params);
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const entry = client.pending.get(msg.id);
      if (!entry) return;
      client.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else entry.resolve(msg.result);
    });
    ws.addEventListener("close", () => cdp.sockets.delete(key));
    cdp.sockets.set(key, client);
    return client;
  },

  send(client, method, params = {}) {
    const id = cdp.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.pending.delete(id);
        reject(new Error(`CDP: ${method} не ответил за 15 с`));
      }, 15_000);
      client.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      client.ws.send(JSON.stringify({ id, method, params }));
    });
  },

  async evaluate(client, expression) {
    const r = await client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? "JS бросил исключение");
    }
    return r.result?.value;
  },

  async pickTarget(urlHint) {
    const targets = await cdp.targets();
    if (!targets.length) throw new Error("Нет ни одной вкладки — сначала computer_browser_start");
    if (!urlHint) return targets[0];
    const hit = targets.find((t) => t.url.includes(urlHint));
    if (!hit) {
      throw new Error(`Вкладка с '${urlHint}' не найдена. Есть: ${targets.map((t) => t.title).join(" | ")}`);
    }
    return hit;
  },
};

const PROBE_JS = `(() => {
  window.__deskProbe = [];
  if (!window.__deskProbeHooked) {
    window.__deskProbeHooked = true;
    document.addEventListener("click", (e) => {
      const el = e.target;
      window.__deskProbe.push({
        tag: el.tagName,
        text: (el.innerText || el.value || el.getAttribute("aria-label") || "").toString().slice(0, 120),
        id: el.id || null,
        testid: el.getAttribute("data-testid"),
        trusted: e.isTrusted
      });
    }, true);
  }
  return "armed";
})()`;

const READ_PROBE_JS = `JSON.stringify(window.__deskProbe || [])`;

const TREE_JS = `(() => {
  const SEL = 'a,button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=combobox],[contenteditable=true],[onclick]';
  // a:nth-of-type(9) вне контекста родителя не находит ничего — индекс
  // считается среди соседей конкретного родителя. Поэтому строим абсолютный
  // путь вверх через :nth-child, он работает в document.querySelector.
  const pathOf = (el) => {
    const parts = [];
    let cur = el;
    for (let i = 0; cur && cur.nodeType === 1 && i < 6; i++) {
      const parent = cur.parentElement;
      if (!parent) { parts.unshift(cur.tagName.toLowerCase()); break; }
      const idx = [...parent.children].indexOf(cur) + 1;
      parts.unshift(cur.tagName.toLowerCase() + ":nth-child(" + idx + ")");
      if (cur === document.body) break;
      cur = parent;
    }
    return parts.join(" > ");
  };
  const out = [];
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.bottom < 0 || r.top > innerHeight) continue;
    const testid = el.getAttribute("data-testid");
    const selector = el.id
      ? "#" + CSS.escape(el.id)
      : (testid ? '[data-testid="' + testid.replace(/"/g, '\\\\"') + '"]' : pathOf(el));
    out.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || null,
      text: (el.innerText || el.value || el.getAttribute("aria-label") || el.title || "").toString().trim().slice(0, 120),
      selector,
      matches: document.querySelectorAll(selector).length,
      id: el.id || null,
      testid: testid || null,
      name: el.getAttribute("name") || null,
      value: (el.value ?? null),
      checked: el.checked ?? null,
      disabled: !!el.disabled,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    });
    if (out.length >= 400) break;
  }
  return JSON.stringify(out);
})()`;

const DESCENDANTS_JS = (selector) => `(() => {
  const root = document.querySelector(${JSON.stringify(selector)});
  if (!root) return "NULL";
  const out = [];
  for (const el of root.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    const text = (el.innerText || "").toString().trim().slice(0, 80);
    if (r.width < 2 || r.height < 2) continue;
    out.push({ tag: el.tagName.toLowerCase(), role: el.getAttribute("role") || null, text, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
    if (out.length >= 200) break;
  }
  return JSON.stringify({ root: { tag: root.tagName.toLowerCase(), text: (root.innerText || "").toString().trim().slice(0, 300) }, children: out });
})()`;

server.registerTool(
  "computer_browser_start",
  {
    title: "Запустить браузер с CDP",
    description:
      "Поднимает Chrome или Edge в debug-режиме с отдельным профилем и портом 9222, " +
      "чтобы читать DOM через Chrome DevTools Protocol. Основной профиль не трогается. " +
      "Если браузер уже запущен с debug-портом, просто подключится к нему.",
    inputSchema: {
      browser: z.enum(["auto", "chrome", "edge"]).optional().default("auto"),
      port: z.number().int().min(1024).max(65535).optional().default(9222),
      url: z.string().optional().describe("открыть адрес сразу после подъёма"),
      exe: z.string().optional().describe("явный путь к браузеру, если автоопределение не сработало"),
    },
  },
  R(async (a) => {
    cdp.port = a.port ?? 9222;
    try {
      const v = await cdp.version();
      return ok({ ok: true, alreadyRunning: true, browser: v.Browser, port: cdp.port });
    } catch { /* нужно поднимать */ }
    const pf86 = process.env[["ProgramFiles", "(x86)"].join("")] ?? "C:\\Program Files (x86)";
    const candidates = {
      chrome: [
        `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      ],
      edge: [
        `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      ],
    };
    const order = a.browser === "auto" ? ["chrome", "edge"] : [a.browser];
    let exe = a.exe ?? null;
    const tried = [];
    if (!exe) {
      for (const k of order) {
        for (const p of candidates[k] ?? []) {
          tried.push(`${p} [${existsSync(p) ? "да" : "нет"}]`);
          if (existsSync(p)) { exe = p; break; }
        }
        if (exe) break;
        // последний рубеж: спрашиваем сам Windows, где лежит браузер
        for (const bin of k === "chrome" ? ["chrome.exe", "msedge.exe"] : ["msedge.exe"]) {
          try {
            const r = spawnSync("where.exe", [bin], { encoding: "utf8" });
            const hit = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
            if (hit && existsSync(hit)) { exe = hit; tried.push(`${bin} через where -> ${hit}`); break; }
          } catch { /* where может отсутствовать в PATH */ }
        }
        if (exe) break;
      }
    }
    if (!exe) throw new Error(`Не найден ни Chrome, ни Edge. Проверено: ${tried.join(" | ")}`);

    const profile = path.join(tmpdir(), "desk-mcp-cdp-profile");
    mkdirSync(profile, { recursive: true });
    const args = [
      `--remote-debugging-port=${cdp.port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ];
    if (a.url) args[args.length - 1] = a.url;
    const child = spawn(exe, args, { detached: true, stdio: "ignore" });
    child.unref();

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const v = await cdp.version();
        return ok({ ok: true, started: true, browser: v.Browser, port: cdp.port, profile });
      } catch { /* ждём */ }
    }
    throw new Error(`CDP не поднялся за 12 с на порту ${cdp.port}`);
  }),
);

server.registerTool(
  "computer_browser_list",
  {
    title: "Вкладки CDP",
    description: "Список вкладок браузера с CDP: заголовок, URL, id. Плюс версия браузера.",
    inputSchema: {},
  },
  R(async () => {
    const [v, t] = [await cdp.version(), await cdp.targets()];
    return ok({ browser: v.Browser, port: cdp.port, tabs: t.map((x) => ({ id: x.id, title: x.title, url: x.url })) });
  }),
);

server.registerTool(
  "computer_browser_tree",
  {
    title: "DOM-дерево вкладки",
    description:
      "Настоящее DOM-дерево: интерактивные элементы с готовым CSS-селектором, текстом, " +
      "role, value, checked и границами. В отличие от UIA/MSAA для Chromium это точные " +
      "данные без прокладок. Селектор сразу годится для computer_browser_click.",
    inputSchema: { url: z.string().optional().describe("подстрока URL вкладки; пусто — первая") },
  },
  R(async (a) => {
    const target = await cdp.pickTarget(a.url);
    const client = await cdp.socket(target);
    const raw = await cdp.evaluate(client, TREE_JS);
    const items = JSON.parse(raw);
    return ok({ url: target.url, title: target.title, count: items.length, elements: items });
  }),
);

server.registerTool(
  "computer_browser_descendants",
  {
    title: "Поддерево элемента",
    description: "Содержимое контейнера по CSS-селектору: до 200 потомков с границами. " +
      "Нужен, чтобы понять структуру блока, списка или модалки перед кликом.",
    inputSchema: { selector: z.string(), url: z.string().optional() },
  },
  R(async (a) => {
    const target = await cdp.pickTarget(a.url);
    const client = await cdp.socket(target);
    const raw = await cdp.evaluate(client, DESCENDANTS_JS(a.selector));
    if (raw === "NULL") throw new Error(`Селектор не найден: ${a.selector}`);
    return ok({ url: target.url, ...JSON.parse(raw) });
  }),
);

server.registerTool(
  "computer_browser_click",
  {
    title: "Клик по элементу страницы",
    description:
      "Кликает по CSS-селектору ЧЕРЕЗ CDP и проверяет результат: перед кликом в страницу " +
      "ставится проба, которая ловит событие, после клика читается, что именно приняло удар. " +
      "Возвращает verified true только если событие дошло до элемента.",
    inputSchema: {
      selector: z.string(),
      url: z.string().optional(),
      button: z.enum(["left", "middle", "right"]).optional().default("left"),
      clickCount: z.number().int().min(1).max(3).optional().default(1),
    },
  },
  R(async (a) => {
    const target = await cdp.pickTarget(a.url);
    const client = await cdp.socket(target);

    const locate = () => cdp.evaluate(client, `(() => {
        const el = document.querySelector(${JSON.stringify(a.selector)});
        if (!el) return "NULL";
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()`);

    const strike = async () => {
      for (let i = 0; i < a.clickCount; i++) {
        await client.send("Input.dispatchMouseEvent", {
          type: "mousePressed", x: BOX.x, y: BOX.y, button: a.button, clickCount: 1,
        });
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseReleased", x: BOX.x, y: BOX.y, button: a.button, clickCount: 1,
        });
        if (i + 1 < a.clickCount) await new Promise((r) => setTimeout(r, 60));
      }
    };

    await cdp.evaluate(client, PROBE_JS);
    const before = await cdp.evaluate(client, "location.href");

    // Без bringToFront Chrome отбрасывает синтетический ввод, если вкладка не
    // на переднем плане: Input.dispatchMouseEvent молча уходит в никуда, а
    // модель получает verified:false и гадает почему.
    try {
      await client.send("Page.enable");
      await client.send("Page.bringToFront");
      await new Promise((r) => setTimeout(r, 250));
    } catch { /* браузер может быть в другой вкладке — не критично */ }

    let raw = await locate();
    if (raw === "NULL") throw new Error(`Селектор не найден: ${a.selector}`);
    let BOX = JSON.parse(raw);
    await strike();
    await new Promise((r) => setTimeout(r, 350));
    let hits = JSON.parse(await cdp.evaluate(client, READ_PROBE_JS));
    let after = await cdp.evaluate(client, "location.href");
    let navigated = before !== after;
    let retried = false;

    // Промах по координате после плавной прокрутки — обычное дело: элемент
    // уехал между замером и кликом. Один ретрай с перезамером дешевле, чем
    // выдавать модели ложь verified:false.
    if (hits.length === 0 && !navigated) {
      retried = true;
      raw = await locate();
      if (raw !== "NULL") {
        BOX = JSON.parse(raw);
        await strike();
        await new Promise((r) => setTimeout(r, 400));
        hits = JSON.parse(await cdp.evaluate(client, READ_PROBE_JS));
        after = await cdp.evaluate(client, "location.href");
        navigated = before !== after;
      }
    }

    return ok({
      ok: true,
      selector: a.selector,
      verified: hits.length > 0 || navigated,
      via: hits.length > 0 ? "probe" : navigated ? "navigation" : "none",
      retried,
      hit: hits[0] ?? null,
      urlBefore: before,
      urlAfter: after,
    });
  }),
);

server.registerTool(
  "computer_browser_eval",
  {
    title: "Выполнить JS на странице",
    description:
      "Выполняет произвольный JS в контексте страницы (await поддерживается) и возвращает " +
      "значение. Для чтения того, что не отдаёт DOM-дерево, и для проверок в консоли.",
    inputSchema: { expression: z.string(), url: z.string().optional() },
  },
  R(async (a) => {
    const target = await cdp.pickTarget(a.url);
    const client = await cdp.socket(target);
    return ok({ url: target.url, value: await cdp.evaluate(client, a.expression) });
  }),
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
