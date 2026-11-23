import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readClipboardText } from "../lib/clipboard-snapshot.mjs";

test("clipboard snapshot preserves Unicode, line endings and literal shell characters", async () => {
  const expected = 'Привет 😀\r\nsecond\nlast\r\n"quotes" $value `code` $(literal)\\path';
  const actual = await readClipboardText({ execute: async (file, args, options) => {
    assert.equal(file, "powershell.exe");
    for (const flag of ["-NoProfile", "-NonInteractive", "-STA", "-Command"]) assert.ok(args.includes(flag));
    assert.equal(options.encoding, "utf8");
    assert.equal(options.windowsHide, true);
    assert.ok(Number.isFinite(options.timeout) && options.timeout > 0 && options.timeout <= 30_000);
    assert.ok(Number.isFinite(options.maxBuffer) && options.maxBuffer > 0);
    return { stdout: JSON.stringify({ text: expected }) + "\r\n", stderr: "" };
  } });
  assert.equal(actual, expected);
});

test("a successful empty clipboard is a valid snapshot", async () => {
  assert.equal(await readClipboardText({ execute: async () => ({ stdout: '{"text":""}', stderr: "" }) }), "");
});

test("clipboard process failures cannot turn into an empty successful snapshot", async () => {
  for (const code of [1, "ENOENT", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]) {
    const failure = Object.assign(new Error("Clipboard read failed"), { code });
    await assert.rejects(readClipboardText({ execute: async () => { throw failure; } }), error => error === failure);
  }
});

test("malformed or missing clipboard output is rejected", async () => {
  for (const stdout of ["", "not JSON", '{"text":', '{"text":"ok"}\nextra', undefined, Buffer.from('{"text":"ok"}')]) {
    await assert.rejects(readClipboardText({ execute: async () => ({ stdout }) }), /Clipboard snapshot/);
  }
});

test("clipboard snapshot schema errors are rejected instead of restoring empty text", async () => {
  for (const value of [null, "", [], {}, { text: null }, { text: 123 }, { text: ["one"] }, { text: "", error: "failed" }]) {
    await assert.rejects(readClipboardText({ execute: async () => ({ stdout: JSON.stringify(value) }) }), /Clipboard snapshot/);
  }
});

test("a locked Windows clipboard fails the snapshot without changing its contents", {
  skip: process.platform !== "win32", timeout: 45_000,
}, async (context) => {
  // Establish that the real reader works before asserting a lock-specific error.
  const original = await readClipboardText();
  const holderScript = `
$ErrorActionPreference = 'Stop'
$locked = $false
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
public static class ClipboardLock {
  [DllImport("user32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool OpenClipboard(IntPtr window);
  [DllImport("user32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CloseClipboard();
  public static void WaitForRelease() {
    Task.Factory.StartNew<string>(delegate { return Console.ReadLine(); }).Wait(12000);
  }
}
'@ -ErrorAction Stop
  $deadline = [DateTime]::UtcNow.AddSeconds(3)
  while (-not ($locked = [ClipboardLock]::OpenClipboard([IntPtr]::Zero))) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Could not acquire the clipboard lock' }
    Start-Sleep -Milliseconds 25
  }
  [Console]::Out.WriteLine('locked')
  [Console]::Out.Flush()
  [ClipboardLock]::WaitForRelease()
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($locked) { [void][ClipboardLock]::CloseClipboard() }
}
`;
  const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", holderScript], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  holder.stdin.on("error", () => {});
  let diagnostics = "";
  holder.stderr.on("data", data => { diagnostics = (diagnostics + String(data)).slice(-2000); });
  const closed = new Promise(resolve => holder.once("close", resolve));
  const abort = () => holder.kill();
  context.signal.addEventListener("abort", abort, { once: true });
  let readyTimer;
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      readyTimer = setTimeout(() => reject(new Error("Clipboard lock holder did not become ready")), 6000);
      holder.once("error", reject);
      holder.once("exit", code => reject(new Error("Clipboard lock holder exited: " + code + " " + diagnostics)));
      holder.stdout.on("data", data => {
        output += String(data);
        if (output.split(/\r?\n/).includes("locked")) resolve();
      });
    });
    clearTimeout(readyTimer);
    await assert.rejects(readClipboardText(), error => {
      assert.equal(error.code, 1, "The clipboard read must fail explicitly, not time out");
      assert.match(error.stderr, /\S/, "PowerShell must report the clipboard read error");
      return true;
    });
  } finally {
    clearTimeout(readyTimer);
    holder.stdin.end();
    const killTimer = setTimeout(() => holder.kill(), 1000);
    try { await closed; }
    finally {
      clearTimeout(killTimer);
      context.signal.removeEventListener("abort", abort);
    }
  }
  assert.ok(await readClipboardText() === original, "Clipboard text changed during the failed snapshot");
});
