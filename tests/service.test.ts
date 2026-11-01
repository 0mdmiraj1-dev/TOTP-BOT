import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { VaultService } from "../src/service.js";
import {
  TestCoordinator,
  DisabledCoordinator,
  LocalCoordinator,
} from "../src/store.js";
import { BotRouter, verifyForward } from "../src/bot.js";
import { validateInitData, type Transport } from "../src/telegram.js";
import { decrypt, createBackup } from "../src/crypto.js";
class MockTelegram implements Transport {
  uploads = 0;
  publications = 0;
  deliveries = 0;
  failPublish = false;
  failDelivery = false;
  menus: any[] = [];
  async upload() {
    this.uploads++;
    return { fileId: "synthetic-file", messageId: 42 };
  }
  async publish() {
    this.publications++;
    if (this.failPublish) throw Error();
    return 100;
  }
  async deliver() {
    this.deliveries++;
    if (this.failDelivery) throw Error();
  }
  async menu(actor: string, text: string, keyboard: unknown) {
    this.menus.push({ actor, text, keyboard });
  }
}
async function fixture() {
  let now = 1000000;
  const db = new TestCoordinator(),
    tg = new MockTelegram(),
    key = randomBytes(32),
    setupToken = "s".repeat(64);
  const service = new VaultService(db, tg, key, setupToken, 60000, () => now);
  const c = { actor: "10001", session: "" };
  const setup = await service.request(
    "setup",
    {
      token: setupToken,
      username: "synthetic",
      password: "synthetic master password",
    },
    c,
  );
  c.session = setup.token;
  await service.request("ack", { confirm: true }, c);
  return {
    service,
    db,
    tg,
    key,
    c,
    recovery: setup.recovery,
    clock: (n: number) => (now = n),
    now: () => now,
  };
}
const saveBody = (revision: number, requestId = crypto.randomUUID()) => ({
  revision,
  requestId,
  record: {
    type: "password",
    name: "Synthetic",
    url: "https://example.com",
    username: "synthetic",
    password: "synthetic",
    notes: "",
    favorite: false,
  },
});
test("Single account setup cannot reopen, acknowledgement gate and no caller ID trust", async () => {
  const f = await fixture();
  await assert.rejects(
    () => f.service.request("setup", {}, f.c),
    /permanently disabled/,
  );
  await assert.rejects(() => f.service.request("list", {}, {}), /unauthorized/);
  await assert.rejects(
    () =>
      f.service.request(
        "login",
        { username: "synthetic", password: "synthetic master password" },
        { actor: "20002" },
      ),
    /rebind/,
  );
});
test("Setup blocks data until recovery acknowledgement", async () => {
  const s = new VaultService(
      new TestCoordinator(),
      new MockTelegram(),
      randomBytes(32),
      "s".repeat(64),
    ),
    c = { actor: "10001", session: "" };
  const d = await s.request(
    "setup",
    {
      token: "s".repeat(64),
      username: "synthetic",
      password: "synthetic master password",
    },
    c,
  );
  c.session = d.token;
  await assert.rejects(() => s.request("list", {}, c), /unauthorized/);
  await s.request("ack", { confirm: true }, c);
  assert.equal((await s.request("list", {}, c)).records.length, 0);
});
test("Durable throttle bounded attempts, reset window, inactivity expiry and logout", async () => {
  const f = await fixture();
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      () =>
        f.service.request(
          "login",
          { username: "synthetic", password: "wrong" },
          f.c,
        ),
      /Invalid/,
    );
  await assert.rejects(
    () =>
      f.service.request(
        "login",
        { username: "synthetic", password: "synthetic master password" },
        f.c,
      ),
    /Too many/,
  );
  f.clock(f.now() + 900001);
  const d = await f.service.request(
    "login",
    { username: "synthetic", password: "synthetic master password" },
    f.c,
  );
  f.c.session = d.token;
  await f.service.request("logout", {}, f.c);
  await assert.rejects(
    () => f.service.request("list", {}, f.c),
    /unauthorized/,
  );
  const n = await f.service.request(
    "login",
    { username: "synthetic", password: "synthetic master password" },
    f.c,
  );
  f.c.session = n.token;
  f.clock(f.now() + 60001);
  await assert.rejects(
    () => f.service.request("list", {}, f.c),
    /unauthorized/,
  );
});
test("Rebind preserves vault identity, rejects wrong key and old sessions/callbacks", async () => {
  const f = await fixture();
  await f.service.request("save", saveBody(0), f.c);
  const vault = f.db.state.account!.backup.vaultId;
  const menu = await f.service.bot(f.c.actor);
  const id = menu.rows[0][0].callback_data.split(" ")[1];
  await assert.rejects(
    () =>
      f.service.request(
        "rebind",
        {
          username: "synthetic",
          password: "synthetic master password",
          recovery: "a".repeat(64),
          confirm: true,
        },
        { actor: "20002" },
      ),
    /Invalid/,
  );
  const d = await f.service.request(
    "rebind",
    {
      username: "synthetic",
      password: "synthetic master password",
      recovery: f.recovery,
      confirm: true,
    },
    { actor: "20002" },
  );
  assert.equal(f.db.state.account!.backup.vaultId, vault);
  await assert.rejects(
    () => f.service.request("list", {}, f.c),
    /unauthorized/,
  );
  await assert.rejects(
    () => f.service.request("callback", { id }, f.c),
    /unauthorized/,
  );
  assert.equal(
    (await f.service.request("list", {}, { actor: "20002", session: d.token }))
      .records.length,
    1,
  );
});
test("Forgotten password recovery uses recovery wrapper, changes password and revokes sessions", async () => {
  const f = await fixture();
  await f.service.request("save", saveBody(0), f.c);
  const d = await f.service.request(
    "recover-password",
    {
      username: "synthetic",
      recovery: f.recovery,
      newPassword: "new synthetic master password",
      confirm: true,
    },
    { actor: "20002" },
  );
  await assert.rejects(
    () => f.service.request("list", {}, f.c),
    /unauthorized/,
  );
  await assert.rejects(
    () =>
      f.service.request(
        "login",
        { username: "synthetic", password: "synthetic master password" },
        { actor: "20002" },
      ),
    /Invalid/,
  );
  const login = await f.service.request(
    "login",
    { username: "synthetic", password: "new synthetic master password" },
    { actor: "20002" },
  );
  assert.equal(
    (
      await f.service.request(
        "list",
        {},
        { actor: "20002", session: login.token },
      )
    ).records.length,
    1,
  );
  assert.ok(d.revoked);
});
test("Idempotent save and concurrent requests serialize with one revision", async () => {
  const f = await fixture(),
    body = saveBody(0);
  const results = await Promise.all([
    f.service.request("save", body, f.c),
    f.service.request("save", body, f.c),
  ]);
  assert.equal(results[0].revision, 1);
  assert.ok(results[1].replayed);
  assert.equal(f.db.state.account!.backup.revision, 1);
  await assert.rejects(
    () =>
      f.service.request(
        "save",
        { ...body, record: { ...body.record, name: "different" } },
        f.c,
      ),
    /Idempotency/,
  );
  const concurrent = await Promise.allSettled([
    f.service.request("save", saveBody(1), f.c),
    f.service.request("save", saveBody(1), f.c),
  ]);
  assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.db.state.account!.backup.revision, 2);
});
test("Upload success is not publication; failure is durable, next write blocked, retry resumes", async () => {
  const f = await fixture();
  f.tg.failPublish = true;
  const d = await f.service.request("save", saveBody(0), f.c);
  assert.equal(d.vaultSaved, true);
  assert.equal(d.upload, "uploaded");
  assert.equal(d.channel, "failed");
  assert.equal(d.backup, "pending");
  assert.equal(f.tg.deliveries, 1);
  await assert.rejects(
    () => f.service.request("save", saveBody(1), f.c),
    /publication/,
  );
  const count = f.tg.uploads;
  f.tg.failPublish = false;
  const retry = await f.service.request("retry", {}, f.c);
  assert.equal(retry.channel, "published");
  assert.equal(f.tg.uploads, count);
});
test("Private backup delivery failure is separate from commit and publication", async () => {
  const f = await fixture();
  f.tg.failDelivery = true;
  const d = await f.service.request("save", saveBody(0), f.c);
  assert.equal(d.channel, "published");
  assert.equal(d.backup, "failed");
  assert.equal(d.pendingBackups, 1);
  const uploads = f.tg.uploads;
  f.tg.failDelivery = false;
  assert.equal((await f.service.request("retry", {}, f.c)).backup, "delivered");
  assert.equal(f.tg.uploads, uploads);
});
test("Bulk import one revision and backup; restore does not revive identity or sessions", async () => {
  const f = await fixture();
  const before = f.tg.deliveries;
  const source =
    "name,url,username,password,note\nA,https://a.test,a,synthetic,\nB,https://b.test,b,synthetic,";
  await f.service.request(
    "import-commit",
    {
      source,
      policy: "skip",
      confirm: true,
      revision: 0,
      requestId: crypto.randomUUID(),
    },
    f.c,
  );
  assert.equal(f.tg.deliveries, before + 1);
  assert.equal(f.db.state.account!.backup.revision, 1);
  const other = createBackup(
    { username: "other", records: [] },
    "other synthetic password",
  );
  const gen = f.db.state.account!.generation;
  await f.service.request(
    "restore-commit",
    {
      backup: other.backup,
      recovery: other.recovery,
      mode: "replace",
      confirm: true,
      revision: 1,
      requestId: crypto.randomUUID(),
    },
    f.c,
  );
  assert.equal(f.db.state.account!.username, "synthetic");
  assert.equal(f.db.state.account!.binding, "10001");
  assert.equal(f.db.state.account!.generation, gen);
  assert.equal((await f.service.request("list", {}, f.c)).records.length, 0);
  assert.equal(f.db.state.jobs.length, 1);
  assert.equal(f.db.state.history?.length, 3);
});
test("Fail-closed production survives cold instances and concurrent requests", async () => {
  const s = () =>
    new VaultService(
      new DisabledCoordinator(),
      new MockTelegram(),
      randomBytes(32),
      "s".repeat(64),
    );
  const results = await Promise.allSettled(
    ["setup", "login", "save", "logout"].map((a) => s().request(a, {}, {})),
  );
  for (const r of results) {
    assert.equal(r.status, "rejected");
    if (r.status === "rejected") assert.match(r.reason.message, /disabled/);
  }
});
test("Local durable state persists revocation/throttle across cold start and locks competing processes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vault-")),
    path = join(dir, "state.local"),
    key = randomBytes(32);
  try {
    const db = await LocalCoordinator.create(path, key);
    await assert.rejects(() => LocalCoordinator.create(path, key), /EEXIST/);
    await db
      .run((s) => {
        s.attempts = { count: 5, until: 999999 };
        throw Error("auth rejected");
      })
      .catch(() => {});
    await db.close();
    const cold = await LocalCoordinator.create(path, key);
    assert.equal(await cold.run((s) => s.attempts.count), 5);
    assert.ok(!(await readFile(path, "utf8")).includes("999999"));
    const tg = new MockTelegram();
    const service = new VaultService(cold, tg, key, "s".repeat(64));
    const setup = await service.request(
      "setup",
      {
        token: "s".repeat(64),
        username: "synthetic",
        password: "synthetic master password",
      },
      { actor: "10001" },
    );
    const context = { actor: "10001", session: setup.token };
    await service.request("ack", { confirm: true }, context);
    await service.request("logout", {}, context);
    await cold.close();
    const restarted = await LocalCoordinator.create(path, key);
    const resumed = new VaultService(restarted, tg, key, "s".repeat(64));
    await assert.rejects(
      () => resumed.request("list", {}, context),
      /unauthorized/,
    );
    await assert.rejects(
      () => resumed.request("setup", {}, context),
      /permanently disabled/,
    );
    await restarted.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Mini App signatures and freshness; HMAC forwarding provenance and tampering", () => {
  const token = "synthetic-bot-token",
    p = new URLSearchParams({
      auth_date: "1000",
      user: JSON.stringify({ id: 10001 }),
    });
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  p.set(
    "hash",
    createHmac("sha256", secret)
      .update(
        [...p]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => k + "=" + v)
          .join("\n"),
      )
      .digest("hex"),
  );
  assert.equal(validateInitData(p.toString(), token, 1000000), "10001");
  assert.throws(() => validateInitData(p.toString(), token, 2000000));
  p.set("user", '{"id":20002}');
  assert.throws(() => validateInitData(p.toString(), token, 1000000));
  const signing = "s".repeat(64),
    raw = JSON.stringify({
      actor: "10001",
      event: "1",
      timestamp: 1000000,
      action: "home",
    }),
    sig = createHmac("sha256", signing).update(raw).digest("hex");
  assert.equal(verifyForward(raw, sig, signing, 1000000).actor, "10001");
  assert.throws(() =>
    verifyForward(raw.replace("10001", "20002"), sig, signing, 1000000),
  );
  assert.throws(() => verifyForward(raw, sig, signing, 2000000));
});
test("Native opaque callbacks expire and logout rejects old buttons", async () => {
  const f = await fixture();
  const router = new BotRouter(
    f.db,
    f.tg,
    f.key,
    "https://example.test",
    f.now,
  );
  await router.handle({
    actor: "10001",
    event: "1",
    timestamp: f.now(),
    action: "home",
  });
  const cb = f.tg.menus.at(-1).keyboard[0][0].callback_data.split(" ")[1];
  assert.ok(!JSON.stringify(f.tg.menus).includes("synthetic master password"));
  await f.service.request("logout", {}, f.c);
  await router.handle({
    actor: "10001",
    event: "2",
    timestamp: f.now(),
    action: "callback",
    callback: cb,
  });
  assert.match(f.tg.menus.at(-1).text, /locked/);
});
test("Standalone CLI restores offline with no old environment or Telegram", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vault-offline-"));
  try {
    const made = createBackup(
        { username: "synthetic", records: [] },
        "synthetic master password",
      ),
      input = join(dir, "backup.json"),
      output = join(dir, "recovered.json");
    await writeFile(input, JSON.stringify(made.backup));
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/recover.ts", input, output],
      { env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdin.end(made.recovery + "\n");
    const exit = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(exit, 0);
    assert.equal(
      JSON.parse(await readFile(output, "utf8")).username,
      "synthetic",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
