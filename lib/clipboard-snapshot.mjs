import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const snapshotScript = `
$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
  $value = [System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText)
  if ($null -eq $value) { $value = '' }
  if ($value -isnot [string]) { throw 'Clipboard did not return a text value' }
  $json = ConvertTo-Json -Compress -InputObject @{ text = $value }
  [Console]::Out.Write($json)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

// Benchmark setup must fail before changing the clipboard if its original text
// cannot be read. The public clipboard_get tool currently masks read errors,
// so it cannot serve as a trustworthy backup for later restoration.
export async function readClipboardText({ execute = executeFile } = {}) {
  const result = await execute("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-STA", "-Command", snapshotScript,
  ], {
    encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (typeof result?.stdout !== "string") {
    throw new Error("Clipboard snapshot did not return UTF-8 text");
  }
  let snapshot;
  try { snapshot = JSON.parse(result.stdout); }
  catch (cause) { throw new Error("Clipboard snapshot returned invalid JSON", { cause }); }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
      typeof snapshot.text !== "string" || Object.keys(snapshot).length !== 1) {
    throw new Error("Clipboard snapshot must contain only a text string");
  }
  return snapshot.text;
}
