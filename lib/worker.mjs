import { spawn } from "node:child_process";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const error = (message, code = "WorkerRestarted") => Object.assign(new Error(message), { code });

// One process and one startup promise, even when multiple MCP calls arrive together.
export class Worker {
  constructor(file, { spawnProcess = spawn, readyTimeoutMs = 25_000, restartDelayMs = 500 } = {}) {
    this.file = file;
    this.spawnProcess = spawnProcess;
    this.readyTimeoutMs = readyTimeoutMs;
    this.restartDelayMs = restartDelayMs;
    this.proc = null;
    this.stopped = false;
    this.stopSignal = new AbortController();
    this.pending = new Map();
    this.nextId = 1;
    this.restarts = 0;
    this.startedAt = Date.now();
    this.readyPromise = null;
    this.starting = null;
  }

  get alive() {
    return !!this.proc && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  start() {
    if (this.stopped) return Promise.reject(error("Сервер остановлен"));
    if (this.alive) return this.readyPromise;
    const proc = this.spawnProcess("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-File", this.file],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    const lines = readline.createInterface({ input: proc.stdout });
    let settleReady;
    this.readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        settleReady(error("Воркер не поднялся за отведённое время"));
        if (this.proc === proc) this.kill();
      }, this.readyTimeoutMs);
      settleReady = (err, data) => {
        clearTimeout(timer);
        err ? reject(err) : resolve(data);
      };
    });
    // Startup can fail before a client has attached a rejection handler.
    this.readyPromise.catch(() => {});
    const fail = (err) => {
      if (this.proc !== proc) return;
      settleReady(err);
      this.kill(err);
    };
    proc.once("error", (e) => fail(error("Не удалось запустить PowerShell: " + e.message, "NotSupported")));
    proc.once("exit", () => fail(error("Воркер неожиданно завершился")));
    proc.stdin.on("error", (e) => fail(error("Канал воркера закрыт: " + e.message)));
    proc.stderr.on("data", (d) => {
      const s = String(d).trim();
      if (s) process.stderr.write("[worker] " + s + "\n");
    });
    lines.on("line", (line) => {
      if (this.proc !== proc || !line.startsWith("B64:")) return;
      let msg;
      try { msg = JSON.parse(Buffer.from(line.slice(4), "base64").toString("utf8")); }
      catch { return; }
      if (msg.id === 0) { settleReady(null, msg.data); return; }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.data);
      else entry.reject(error(msg.error || "Ошибка в воркере", msg.code || "WorkerError"));
    });
    proc.once("close", () => lines.close());
    this.cancelReady = (err) => settleReady(err);
    return this.readyPromise;
  }

  async ensure() {
    if (this.starting) return this.starting;
    if (this.alive) return this.readyPromise;
    this.starting = (async () => {
      if (Date.now() - this.startedAt > 30_000) this.restarts = 0;
      const waitMs = Math.min(this.restartDelayMs * 2 ** Math.min(this.restarts++, 4), 8000);
      if (waitMs) await delay(waitMs, undefined, { signal: this.stopSignal.signal }).catch(() => {});
      if (this.stopped) throw error("Сервер остановлен");
      const ready = await this.start();
      this.startedAt = Date.now();
      return ready;
    })();
    try { return await this.starting; }
    finally { this.starting = null; }
  }

  kill(err = error("Воркер перезапущен")) {
    const proc = this.proc;
    this.proc = null;
    this.cancelReady?.(err);
    this.cancelReady = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    if (proc) { try { proc.kill(); } catch { /* already exited */ } }
  }

  call(tool, args, timeoutMs = 30_000) {
    // This budget includes startup. An expired request must never be sent later.
    return new Promise((resolve, reject) => {
      let settled = false;
      let sent = false;
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        const err = error("Инструмент '" + tool + "' не ответил за " + timeoutMs / 1000 + " с", "Timeout");
        reject(err);
        if (sent) this.kill(error("Воркер перезапущен после таймаута другого вызова"));
      }, timeoutMs);
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      this.ensure().then(() => {
        if (settled) return;
        const proc = this.proc;
        if (!this.alive) throw error("Воркер не запущен");
        const payload = JSON.stringify({ id, tool, args: args ?? {} });
        this.pending.set(id, { timer, resolve: (v) => finish(resolve, v), reject: (e) => finish(reject, e) });
        sent = true;
        proc.stdin.write(payload + "\n", (err) => {
          if (err && this.proc === proc) this.kill(error("Запись в воркер не удалась: " + err.message));
        });
      }).catch((e) => finish(reject, e));
    });
  }

  async stop() {
    this.stopped = true;
    this.stopSignal.abort();
    this.kill(error("Сервер остановлен"));
  }
}
