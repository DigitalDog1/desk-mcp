#!/usr/bin/env node
// Метрики прогона по файлу транскрипта сессии. Сам транскрипт в контекст не
// попадает, читаются только числа.
// Использование: node bench-session-metrics.mjs <путь-к-messages.jsonl> <метка>
import fs from "node:fs";

const file = process.argv[2];
const label = process.argv[3] ?? "";
const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);

const tools = {};
let calls = 0;
let failed = 0;
let peak = 0;
let comps = null;
let first = 0;
let last = 0;
let cacheReadTotal = 0;
let nonCacheIn = 0;

for (const line of lines) {
  let m;
  try { m = JSON.parse(line); } catch { continue; }
  const msg = m.message ?? m;
  const ts = msg.timestamp ?? 0;
  if (ts) { if (!first) first = ts; last = ts; }
  const u = msg.usage ?? null;
  if (u) {
    const total = u.totalTokens ?? ((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0));
    if (total > peak) { peak = total; cacheReadTotal += u.cacheRead ?? 0; nonCacheIn += u.input ?? 0; }
  }
  if (msg.role === "toolResult" && msg.toolName) {
    calls++;
    const text = String(msg.content?.[0]?.text ?? "");
    if (msg.isError === true || text.startsWith("Ошибка")) failed++;
    const short = msg.toolName
      .replace("mcp__desk-mcp__computer_", "")
      .replace("computer_", "");
    tools[short] = (tools[short] ?? 0) + 1;
  }
}

console.log(JSON.stringify({
  label,
  wallSec: Math.round(((last - first) / 1000) * 10) / 10,
  toolCalls: calls,
  failedCalls: failed,
  peakContextTokens: peak,
  cacheReadTotal,
  billedInputTokens: nonCacheIn + cacheReadTotal,
  transcriptTokensProxy: Math.round(fs.statSync(file).size / 4),
  tools,
}));