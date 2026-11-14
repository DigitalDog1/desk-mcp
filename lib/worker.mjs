import { spawn } from "node:child_process";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const error = (message, code = "WorkerRestarted") => Object.assign(new Error(message), { code });

// One process and one startup promise, even when multiple MCP calls arrive together.
export class Worker {
  constructor(file, { spawnProcess = spawn, readyTimeoutMs = 60_000, restartDelayMs = 500 } = {}) {
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
    let startupDiagnostics = "";
    proc.once("exit", () => {
      const blocked = /ScriptContainedMaliciousContent|malicious content|antivirus software/i.test(startupDiagnostics);
      const audit = /AuditUnavailable/.test(startupDiagnostics);
      fail(error(blocked
        ? "Windows заблокировала PowerShell-воркер (AMSI/антивирус). Проверь журнал защиты; не отключай защиту. " + startupDiagnostics.slice(-2000)
        : audit ? startupDiagnostics.slice(-2000) : "Воркер неожиданно завершился" + (startupDiagnostics ? ": " + startupDiagnostics.slice(-2000) : ""),
        blocked ? "SecurityBlocked" : audit ? "AuditUnavailable" : "WorkerRestarted"));
    });
    proc.stdin.on("error", (e) => fail(error("Канал воркера закрыт: " + e.message)));
    proc.stderr.on("data", (d) => {
      const s = String(d).trim();
      startupDiagnostics = (startupDiagnostics + s).slice(-8000);
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

  call(tool, args, timeoutMs = 30_000, { signal } = {}) {
    // Startup and queueing share the deadline. Expired/cancelled work is never sent later.
    return new Promise((resolve, reject) => {
      let settled = false, sent = false;
      const id = this.nextId++;
      let timer;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(id);
        fn(value);
      };
      const interrupt = (err) => {
        if (settled) return;
        finish(reject, err);
        // A queued request cannot be removed from PowerShell's stdin safely.
        if (sent) this.kill(error("Воркер перезапущен после отмены или таймаута другого вызова"));
      };
      const abort = () => interrupt(error("Вызов отменён клиентом", "Cancelled"));
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => interrupt(error("Инструмент '" + tool + "' не ответил за " + timeoutMs / 1000 + " с", "Timeout")), timeoutMs);
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
