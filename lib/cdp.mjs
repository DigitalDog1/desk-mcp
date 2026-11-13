import WebSocket from "ws";

export const cdp = {
  port: 9222,
  setPort(port) {
    if (port === this.port) return;
    for (const client of this.sockets.values()) client.ws.close();
    this.sockets.clear();
    this.port = port;
  },
  close() {
    for (const client of this.sockets.values()) client.ws.close();
    this.sockets.clear();
  },
  nextId: 1,
  sockets: new Map(),

  async http(path) {
    const res = await fetch(`http://127.0.0.1:${cdp.port}${path}`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`CDP: HTTP ${res.status}`);
    return res.json();
  },

  async version() {
    return cdp.http("/json/version");
  },

  async targets() {
    const list = await cdp.http("/json/list");
    return list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  },

  // Документ может ещё грузиться, и тогда querySelectorAll вернёт пустоту без
  // всякой ошибки: страница открылась, а дерева ноль. Наблюдалось на свеже
  // поднятом Chrome. Поэтому перед разбором DOM ждём готовности.
  async waitReady(client, timeoutMs) {
    const deadline = Date.now() + Math.max(0, Math.min(10_000, timeoutMs));
    for (;;) {
      let state = "";
      try {
        state = await cdp.evaluate(client, "document.readyState");
      } catch {
        return { ready: false, state: "unreachable" };
      }
      if (state !== "loading") return { ready: true, state: state || "unknown" };
      if (Date.now() >= deadline) return { ready: false, state: state };
      await new Promise((r) => setTimeout(r, 100));
    }
  },

  // Открыть адрес в уже работающей вкладке. Запасной путь для /json/new: если
  // браузер отвечает, но вкладку создать не дал (он умирает прямо на глазах,
  // либо порт занят чужим процессом), навигация первой вкладки всё ещё работает.
  async navigate(url) {    const pages = await cdp.targets();
    if (!pages.length) return null;
    const s = await cdp.socket(pages[0]);
    await s.send("Page.enable", {});
    await s.send("Page.navigate", { url });
    return { id: pages[0].id, title: pages[0].title, url };
  },

  // /json/new требует именно PUT: на GET современные Chrome и Edge отвечают
  // 405. Метод держим здесь, а не в вызывающем коде, потому что забыть про PUT
  // — это молчаливое «вкладка не открылась».
  async newTab(url) {
    const res = await fetch(`http://127.0.0.1:${cdp.port}/json/new?${encodeURIComponent(url)}`, {
      method: "PUT",
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`CDP не смог открыть вкладку: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    return res.json();
  },

  async socket(target) {
    const key = `${cdp.port}|${target.webSocketDebuggerUrl}`;
    if (cdp.sockets.has(key)) return cdp.sockets.get(key);
    const ws = new WebSocket(target.webSocketDebuggerUrl, { handshakeTimeout: 4000 });
    const client = { ws, pending: new Map(), send: null };
    const closePending = () => {
      if (cdp.sockets.get(key) === client) cdp.sockets.delete(key);
      for (const entry of client.pending.values()) entry.reject(new Error("CDP: соединение закрыто"));
      client.pending.clear();
    };
    ws.addEventListener("close", closePending);
    ws.addEventListener("error", closePending);
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const entry = client.pending.get(msg.id);
      if (!entry) return;
      client.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message + " (" + msg.error.code + ")"));
      else entry.resolve(msg.result);
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("Не удалось подключиться к CDP")), { once: true });
      ws.addEventListener("close", () => reject(new Error("CDP закрыл соединение при запуске")), { once: true });
    });
    client.send = (method, params) => cdp.send(client, method, params);
    cdp.sockets.set(key, client);
    return client;
  },

  send(client, method, params = {}) {
    if (client.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("CDP: соединение закрыто"));
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
      try { client.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { client.pending.delete(id); clearTimeout(timer); reject(e); }
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
    // Ищем и по URL, и по заголовку: параметр называется url, но вызывающий
    // почти всегда знает именно заголовок вкладки. Раньше поиск шёл только по
    // URL, и на подсказку «Вкладка не найдена» выводился список заголовков,
    // в котором нужная вкладка была — выглядит как поломка поиска.
    const lower = String(urlHint).toLowerCase();
    const hit =
      targets.find((t) => t.url.includes(urlHint))
      ?? targets.find((t) => (t.title ?? "").toLowerCase().includes(lower));
    if (!hit) {
      throw new Error(
        `Вкладка с '${urlHint}' не найдена (ищем по URL и по заголовку). ` +
          `Есть: ${targets.map((t) => `${t.title} <${t.url.slice(0, 60)}>`).join(" | ")}`,
      );
    }
    return hit;
  },
};

