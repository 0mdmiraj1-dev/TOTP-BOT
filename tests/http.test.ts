import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { handler } from "../src/http.js";
import { VaultService } from "../src/service.js";
import { DisabledCoordinator } from "../src/store.js";
import { BotRouter } from "../src/bot.js";
import type { Transport } from "../src/telegram.js";
test("HTTP rejects unverified sender, cross-origin calls and fails closed on fresh production instances", async () => {
  const db = new DisabledCoordinator(),
    key = randomBytes(32),
    transport: Transport = {
      async upload() {
        throw Error();
      },
      async publish() {
        throw Error();
      },
      async deliver() {
        throw Error();
      },
      async menu() {
        throw Error();
      },
    },
    runtime = {
      local: false,
      simulatedTelegram: false,
      service: new VaultService(db, transport, key, "s".repeat(64)),
      bot: new BotRouter(db, transport, key, "https://example.test"),
    };
  const server = createServer((req, res) => handler(req, res, runtime));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as AddressInfo,
    base = "http://127.0.0.1:" + address.port;
  try {
    const post = (headers: any, body: any, path = "/api") =>
      fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    assert.equal(
      (await post({}, { action: "login", actor: "10001" })).status,
      403,
    );
    assert.equal(
      (
        await post(
          { origin: process.env.APP_ORIGIN ?? "http://127.0.0.1:3000" },
          { action: "login", actor: "10001" },
        )
      ).status,
      503,
    );
    assert.equal(
      (await post({}, { actor: "10001", action: "home" }, "/api?route=bot"))
        .status,
      401,
    );
    const health = await (await fetch(base + "/api")).json();
    assert.equal(health.writesEnabled, false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
