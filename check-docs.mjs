import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(root, name), "utf8").replace(/\r\n/g, "\n");
const en = read("README.md"), ru = read("README.ru.md"), src = read("server.mjs");
const unique = (text, re) => [...new Set(text.match(re) || [])].sort();
const registered = [...src.matchAll(/reg\(\s*"(computer_[a-z_]+)"/g)].map((m) => m[1]).sort();
for (const [name, text] of [["README.md", en], ["README.ru.md", ru]]) {
  assert.deepEqual(unique(text, /computer_[a-z_]+/g), registered, name + ": tool inventory drift");
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|#)/.test(target)) continue;
    assert(fs.existsSync(path.join(root, target.split("#")[0])), name + ": missing link " + target);
  }
}
assert.deepEqual(unique(en, /DESK_[A-Z_]+/g), unique(ru, /DESK_[A-Z_]+/g), "environment variables differ");
const fence = String.fromCharCode(96).repeat(3);
const blocks = (s) => [...s.matchAll(new RegExp(fence + "(?:json|powershell)\\n([\\s\\S]*?)" + fence, "g"))].map((m) => m[1].trim());
assert(blocks(en).length >= 5, "runnable examples missing");
assert.deepEqual(blocks(en), blocks(ru), "runnable examples differ");
const media = (s) => [...s.matchAll(/docs\/[^\s)"<>]+\.(?:gif|mp4|webm|png)/g)].map((m) => m[0]).sort();
assert.deepEqual(media(en), media(ru), "demo links differ");
const pkg = JSON.parse(read("package.json"));
assert(src.includes('version: "' + pkg.version + '"'), "server version differs");
assert.equal(JSON.parse(read("mcpb/manifest.json")).version, pkg.version, "bundle version differs");
assert.equal(JSON.parse(read("package-lock.json")).version, pkg.version, "lockfile version differs");
assert.equal(fs.readFileSync(path.join(root, "worker.ps1")).subarray(0, 3).toString("hex"), "efbbbf", "worker.ps1 must preserve UTF-8 BOM");
console.log("README EN/RU: tools, environment, examples, links, demos, versions and BOM OK");
