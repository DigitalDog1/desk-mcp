import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { cdp } from "../lib/cdp.mjs";

test("CDP replies, remote errors, closure and reconnect are handled without hanging", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  server.on("connection", (ws) => ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.method === "close") ws.close();
    else if (msg.method === "error") ws.send(JSON.stringify({ id: msg.id, error: { message: "bad", code: -1 } }));
    else ws.send(JSON.stringify({ id: msg.id, result: { value: 42 } }));
  }));
  const target = { id: "tab", webSocketDebuggerUrl: "ws://127.0.0.1:" + server.address().port };
  try {
    const client = await cdp.socket(target);
    assert.deepEqual(await client.send("ok"), { value: 42 });
    await assert.rejects(client.send("error"), /bad/);
    await assert.rejects(client.send("close"), /закрыто/);
    assert.equal(client.pending.size, 0);
    const next = await cdp.socket(target);
    assert.notEqual(client, next);
    assert.deepEqual(await next.send("ok"), { value: 42 });
    cdp.setPort(9333);
    assert.equal(cdp.sockets.size, 0);
  } finally {
    cdp.close();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    cdp.setPort(9222);
  }
});
