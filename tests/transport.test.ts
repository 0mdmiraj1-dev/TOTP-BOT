import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Telegram } from "../src/telegram.js";
import { createBackup, digest } from "../src/crypto.js";
// These are mocked HTTP integration tests, not calls to Telegram.
test("Telegram adapter uses document upload, edit/pin publication, and private delivery separately", async () => {
  const original = globalThis.fetch,
    calls: { method: string; body: any }[] = [];
  let failPin = true;
  globalThis.fetch = async (input, init) => {
    const method = String(input).split("/").at(-1)!;
    const body =
      init!.body instanceof FormData
        ? init!.body
        : JSON.parse(init!.body as string);
    calls.push({ method, body });
    if (method === "sendDocument")
      return Response.json({
        ok: true,
        result: { message_id: 10, document: { file_id: "synthetic-file" } },
      });
    if (method === "pinChatMessage" && failPin)
      return Response.json(
        { ok: false, error_code: 400, description: "synthetic failure" },
        { status: 400 },
      );
    if (method === "editMessageText")
      return Response.json(
        {
          ok: false,
          error_code: 400,
          description: "Bad Request: message is not modified",
        },
        { status: 400 },
      );
    return Response.json({ ok: true, result: { message_id: 20 } });
  };
  try {
    const tg = new Telegram("synthetic-token", "-1001", randomBytes(32)),
      made = createBackup(
        { username: "synthetic", records: [] },
        "synthetic master password",
      ),
      uploaded = await tg.upload(made.backup);
    assert.equal(uploaded.fileId, "synthetic-file");
    assert.equal(calls[0].method, "sendDocument");
    const doc = calls[0].body as FormData;
    assert.equal((doc.get("document") as File).name, "vault.encrypted.json");
    assert.ok(!String(doc.get("caption")).includes("synthetic"));
    await assert.rejects(() => tg.publish(made.backup, uploaded, 20));
    failPin = false;
    assert.equal(await tg.publish(made.backup, uploaded, 20), 20);
    await tg.deliver(made.backup, "10001");
    assert.equal(calls.at(-1)!.body.get("chat_id"), "10001");
    const manifest = JSON.parse(
      calls.find((c) => c.method === "editMessageText")!.body.text,
    );
    assert.equal(manifest.manifest.sha256, digest(JSON.stringify(made.backup)));
    assert.equal(manifest.manifest.vaultId, made.backup.vaultId);
    assert.equal(typeof manifest.mac, "string");
  } finally {
    globalThis.fetch = original;
  }
});
test("Pinned manifest tampering fails discovery and retrieval checks file digest", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      ok: true,
      result: {
        pinned_message: {
          text: JSON.stringify({ manifest: { revision: 10 }, mac: "tampered" }),
        },
      },
    });
  try {
    const tg = new Telegram("synthetic-token", "-1001", randomBytes(32));
    await assert.rejects(() => tg.discover(), /signature/);
    globalThis.fetch = async (url) =>
      String(url).endsWith("/getFile")
        ? Response.json({
            ok: true,
            result: { file_path: "documents/synthetic.json" },
          })
        : new Response('{"synthetic":true}');
    await assert.rejects(
      () => tg.retrieve("synthetic-id", "wrong-digest"),
      /digest/,
    );
    assert.deepEqual(
      await tg.retrieve("synthetic-id", digest('{"synthetic":true}')),
      { synthetic: true },
    );
  } finally {
    globalThis.fetch = original;
  }
});
