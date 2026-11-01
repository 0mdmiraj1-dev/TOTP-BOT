import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { handler } from "../src/http.js";
import { PostgresCoordinator, postgresConfig } from "../src/postgres.js";
import { VaultService } from "../src/service.js";
import { Outbox, LEASE_MS } from "../src/outbox.js";
import { BotRouter } from "../src/bot.js";
import type { Transport } from "../src/telegram.js";
import { digest, type Backup } from "../src/crypto.js";
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw Error(
    "TEST_DATABASE_URL must point to a disposable LOCAL PostgreSQL database; these tests reset its coordinator table",
  );
class FakeTelegram implements Transport {
  uploads = 0;
  publications = 0;
  deliveries: string[] = [];
  failPublish = false;
  failDelivery = false;
  menus: any[] = [];
  pins = 0;
  gateRevision?: number;
  entered?: () => void;
  release?: Promise<void>;
  gated = false;
  async upload(b: Backup) {
    this.uploads++;
    return {
      fileId: "synthetic-file-" + b.revision,
      messageId: b.revision + 1,
    };
  }
  async publish(b: Backup) {
    this.publications++;
    const id = this.publications + 100;
    if (this.failPublish) throw Error("Synthetic publication failure");
    if (this.gateRevision === b.revision && !this.gated) {
      this.gated = true;
      this.entered?.();
      await this.release;
    }
    return id;
  }
  async deliver(_b: Backup, actor: string) {
    if (this.failDelivery) throw Error("Synthetic delivery failure");
    this.deliveries.push(actor);
  }
  async pin() {
    this.pins++;
  }
  async menu(actor: string, text: string, keyboard: unknown) {
    this.menus.push({ actor, text, keyboard });
  }
}
async function fixture(initialize = true) {
  let now = Date.now();
  const key = randomBytes(32),
    a = new PostgresCoordinator(url!, key, true),
    b = new PostgresCoordinator(url!, key, true),
    tg = new FakeTelegram();
  await a.pool.query(
    await readFile(
      new URL("../sql/001-coordinator.sql", import.meta.url),
      "utf8",
    ),
  );
  await a.pool.query("TRUNCATE public.vault_coordinator");
  await a.pool.query(
    "INSERT INTO public.vault_coordinator(singleton) VALUES(1)",
  );
  const make = (db = a) =>
      new VaultService(db, tg, key, "s".repeat(64), 60000, () => now),
    s = make(),
    other = make(b),
    c = { actor: "10001", session: "" };
  let recovery = "";
  if (initialize) {
    const setup = await s.request(
      "setup",
      {
        token: "s".repeat(64),
        username: "synthetic",
        password: "synthetic master password",
      },
      c,
    );
    c.session = setup.token;
    recovery = setup.recovery;
    await s.request("ack", { confirm: true }, c);
  }
  return {
    a,
    b,
    tg,
    key,
    s,
    other,
    c,
    recovery,
    now: () => now,
    advance: (ms: number) => (now += ms),
    make,
    close: async () => {
      await a.close();
      await b.close();
    },
  };
}
const body = (revision: number) => ({
  revision,
  requestId: crypto.randomUUID(),
  record: {
    type: "password",
    name: "Synthetic",
    url: "https://example.test",
    username: "synthetic",
    password: "synthetic-record-secret",
    notes: "",
    favorite: false,
  },
});

test("Real PostgreSQL row locking serializes independent clients; state is encrypted", async () => {
  const f = await fixture(false);
  try {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => (entered = r)),
      wait = new Promise<void>((r) => (release = r));
    const first = f.a.run(async (s) => {
      s.attempts.count = 1;
      entered();
      await wait;
    });
    await started;
    let secondEntered = false;
    const second = f.b.run((s) => {
      secondEntered = true;
      s.attempts.count++;
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(secondEntered, false);
    release();
    await Promise.all([first, second]);
    assert.equal(await f.a.run((s) => s.attempts.count), 2);
    const raw = JSON.stringify(
      (
        await f.a.pool.query(
          "SELECT sealed_state FROM public.vault_coordinator",
        )
      ).rows[0],
    );
    assert.ok(!raw.includes("attempts"));
    assert.ok(!raw.includes("synthetic-record-secret"));
  } finally {
    await f.close();
  }
});

test("Concurrent production setup creates one account; initialization never reopens on cold start", async () => {
  const f = await fixture(false);
  try {
    const input = {
      token: "s".repeat(64),
      username: "synthetic",
      password: "synthetic master password",
    };
    const result = await Promise.allSettled([
      f.s.request("setup", input, f.c),
      f.other.request("setup", input, { actor: "20002" }),
    ]);
    assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
    const cold = new PostgresCoordinator(url!, f.key, true);
    try {
      await assert.rejects(
        () => f.make(cold).request("setup", input, f.c),
        /permanently disabled/,
      );
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});

test("Concurrent saves and retries across two PostgreSQL instances cannot lose updates", async () => {
  const f = await fixture();
  try {
    const input = body(0);
    const repeated = await Promise.all([
      f.s.request("save", input, f.c),
      f.other.request("save", input, f.c),
    ]);
    assert.equal(repeated[0].revision, 1);
    assert.equal(repeated[1].revision, 1);
    assert.ok(repeated.some((r) => r.replayed));
    assert.equal((await f.s.request("list", {}, f.c)).records.length, 1);
    const race = await Promise.allSettled([
      f.s.request("save", body(1), f.c),
      f.other.request("save", body(1), f.c),
    ]);
    assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await f.s.request("list", {}, f.c)).revision, 2);
    assert.equal(await f.a.run((s) => s.published?.revision), 2);
    assert.equal(f.tg.uploads, 3);
  } finally {
    await f.close();
  }
});

test("PostgreSQL persists rejected login counts and revocation; expiry survives a new service", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++)
      await assert.rejects(
        () =>
          f.other.request(
            "login",
            { username: "synthetic", password: "wrong" },
            f.c,
          ),
        /Invalid/,
      );
    await assert.rejects(
      () =>
        f.s.request(
          "login",
          { username: "synthetic", password: "synthetic master password" },
          f.c,
        ),
      /Too many/,
    );
    assert.equal(await f.a.run((s) => s.attempts.count), 5);
    f.advance(900001);
    const login = await f.other.request(
      "login",
      { username: "synthetic", password: "synthetic master password" },
      f.c,
    );
    const c = { ...f.c, session: login.token };
    await f.s.request("logout", {}, c);
    const cold = new PostgresCoordinator(url!, f.key, true);
    try {
      await assert.rejects(
        () => f.make(cold).request("list", {}, c),
        /unauthorized/,
      );
    } finally {
      await cold.close();
    }
    const again = await f.s.request(
      "login",
      { username: "synthetic", password: "synthetic master password" },
      f.c,
    );
    f.advance(60001);
    await assert.rejects(
      () => f.other.request("list", {}, { ...f.c, session: again.token }),
      /unauthorized/,
    );
  } finally {
    await f.close();
  }
});

test("Rebinding revokes old PostgreSQL sessions/callbacks, preserves vault UUID and records", async () => {
  const f = await fixture();
  try {
    await f.s.request("save", body(0), f.c);
    const id = await f.a.run((s) => s.account!.backup.vaultId);
    const menus = await f.s.bot(f.c.actor);
    const callback = menus.rows[0][0].callback_data.split(" ")[1];
    const replacement = await f.other.request(
      "rebind",
      {
        username: "synthetic",
        password: "synthetic master password",
        recovery: f.recovery,
        confirm: true,
      },
      { actor: "20002" },
    );
    assert.equal(await f.a.run((s) => s.account!.backup.vaultId), id);
    assert.equal(await f.a.run((s) => s.account!.generation), 2);
    await assert.rejects(() => f.s.request("list", {}, f.c), /unauthorized/);
    await assert.rejects(
      () => f.s.request("callback", { id: callback }, f.c),
      /unauthorized/,
    );
    const fresh = { actor: "20002", session: replacement.token };
    assert.equal((await f.s.request("list", {}, fresh)).records.length, 1);
    const router = new BotRouter(
      f.a,
      f.tg,
      f.key,
      "https://example.test",
      f.now,
      60000,
    );
    await router.handle({
      actor: "10001",
      event: "old-actor",
      timestamp: f.now(),
      action: "callback",
      callback,
    });
    assert.match(f.tg.menus.at(-1).text, /locked/);
  } finally {
    await f.close();
  }
});

test("Upload then manifest failure persists across cold start; backup failure stays separate", async () => {
  const f = await fixture();
  try {
    f.tg.failPublish = true;
    const failed = await f.s.request("save", body(0), f.c);
    assert.equal(failed.upload, "uploaded");
    assert.equal(failed.channel, "failed");
    assert.equal(await f.a.run((s) => s.published?.revision), 0);
    const uploads = f.tg.uploads;
    const cold = new PostgresCoordinator(url!, f.key, true);
    try {
      f.tg.failPublish = false;
      f.tg.failDelivery = true;
      const retried = await f.make(cold).request("retry", {}, f.c);
      assert.equal(retried.channel, "published");
      assert.equal(retried.backup, "failed");
      assert.equal(f.tg.uploads, uploads);
      f.tg.failDelivery = false;
      assert.equal(
        (await f.other.request("retry", {}, f.c)).backup,
        "delivered",
      );
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});

test("Expired outbox owner cannot publish a stale receipt after a newer revision", async () => {
  const f = await fixture();
  try {
    let enter!: () => void, release!: () => void;
    const started = new Promise<void>((r) => (enter = r));
    f.tg.entered = enter;
    f.tg.release = new Promise<void>((r) => (release = r));
    f.tg.gateRevision = 1;
    const delayed = f.s.request("save", body(0), f.c);
    await started;
    // The external request is in flight, but no SQL transaction/row lock is held.
    assert.equal((await f.other.request("list", {}, f.c)).revision, 1);
    f.advance(LEASE_MS + 1);
    await f.other.request("retry", {}, f.c);
    assert.equal(await f.a.run((s) => s.published?.revision), 1);
    await f.other.request("save", body(1), f.c);
    assert.equal(await f.a.run((s) => s.published?.revision), 2);
    const authoritative = await f.a.run((s) => s.published);
    release();
    await delayed;
    assert.deepEqual(await f.a.run((s) => s.published), authoritative);
    assert.equal(f.tg.publications, 4); // initial + old ambiguous + retry + revision 2
  } finally {
    await f.close();
  }
});

test("Rebinding fences in-flight delivery receipts; pending backup goes to the new account", async () => {
  const f = await fixture();
  try {
    f.tg.failDelivery = true;
    await f.s.request("save", body(0), f.c);
    f.tg.failDelivery = false;
    const job = await f.a.run((s) => {
      const j = s.jobs.at(-1)!;
      j.lease = {
        token: "stale",
        until: f.now() + LEASE_MS,
        generation: s.account!.generation,
        actor: "10001",
        stage: "deliver",
      };
      return j.id;
    });
    const replacement = await f.other.request(
      "rebind",
      {
        username: "synthetic",
        password: "synthetic master password",
        recovery: f.recovery,
        confirm: true,
      },
      { actor: "20002" },
    );
    assert.equal(
      await f.a.run((s) => s.jobs.find((j) => j.id === job)?.delivered),
      true,
    );
    assert.equal(f.tg.deliveries.at(-1), "20002");
    assert.ok(replacement.revoked);
  } finally {
    await f.close();
  }
});

test("Missing row, wrong key and unavailable database fail closed", async () => {
  const f = await fixture();
  try {
    const wrong = new PostgresCoordinator(url!, randomBytes(32), true);
    try {
      await assert.rejects(
        () =>
          wrong.run((s) => {
            s.account = undefined;
          }),
        /unavailable/,
      );
    } finally {
      await wrong.close();
    }
    assert.equal(await f.a.run((s) => !!s.account), true);
    await assert.rejects(() =>
      f.a.pool.query("UPDATE public.vault_coordinator SET sealed_state=NULL"),
    );
    assert.equal(await f.a.run((s) => !!s.account), true);
    await f.a.pool.query("DELETE FROM public.vault_coordinator");
    await assert.rejects(
      () =>
        f.s.request(
          "setup",
          {
            token: "s".repeat(64),
            username: "synthetic",
            password: "synthetic master password",
          },
          f.c,
        ),
      /not initialized/,
    );
    const unreachable = new PostgresCoordinator(
      "postgresql://postgres:synthetic@127.0.0.1:1/test",
      f.key,
      true,
    );
    try {
      await assert.rejects(() => unreachable.run(() => {}), /unavailable/);
    } finally {
      await unreachable.close();
    }
    assert.throws(
      () => postgresConfig("invalid-secret-url"),
      (error) =>
        error instanceof Error &&
        error.message === "Invalid coordinator configuration",
    );
    const config = postgresConfig(
      "postgresql://synthetic:synthetic@ep-test-pooler.neon.tech/test?sslmode=require",
    );
    assert.deepEqual(config.ssl, { rejectUnauthorized: true });
    assert.ok(!config.connectionString!.includes("sslmode"));
    assert.throws(
      () =>
        postgresConfig(
          "postgresql://synthetic:synthetic@remote.example/test",
          true,
        ),
      /local/,
    );
  } finally {
    await f.close();
  }
});

test("Production HTTP routes use verified Telegram identity and the real PostgreSQL coordinator", async () => {
  const f = await fixture(false),
    previousToken = process.env.BOT_TOKEN;
  process.env.BOT_TOKEN = "synthetic-http-bot-token";
  const server = createServer((req, res) =>
    handler(req, res, {
      service: f.s,
      bot: new BotRouter(f.a, f.tg, f.key, "https://example.test", f.now),
      local: false,
      simulatedTelegram: false,
      production: true,
      mode: "postgres",
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  function init(actor: number) {
    const p = new URLSearchParams({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: actor }),
    });
    const key = createHmac("sha256", "WebAppData")
      .update(process.env.BOT_TOKEN!)
      .digest();
    p.set(
      "hash",
      createHmac("sha256", key)
        .update(
          [...p]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => k + "=" + v)
            .join("\n"),
        )
        .digest("hex"),
    );
    return p.toString();
  }
  async function post(
    action: string,
    body: any = {},
    token = "",
    actor = 10001,
  ) {
    const response = await fetch(base + "/api", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: process.env.APP_ORIGIN ?? "http://127.0.0.1:3000",
        authorization: "Bearer " + token,
        "x-telegram-init-data": init(actor),
      },
      body: JSON.stringify({ action, ...body }),
    });
    return { status: response.status, data: await response.json() };
  }
  try {
    const health = await (await fetch(base + "/api")).json();
    assert.equal(health.writesEnabled, true);
    const setup = await post("setup", {
      token: "s".repeat(64),
      username: "synthetic",
      password: "synthetic master password",
    });
    assert.equal(setup.status, 200);
    const token = setup.data.token;
    assert.equal(
      (await post("ack", { confirm: true }, token)).data.channel,
      "published",
    );
    assert.equal((await post("save", body(0), token)).data.revision, 1);
    assert.equal((await post("logout", {}, token)).status, 200);
    assert.equal((await post("list", {}, token)).status, 401);
    const rebound = await post(
      "rebind",
      {
        username: "synthetic",
        password: "synthetic master password",
        recovery: setup.data.recovery,
        confirm: true,
      },
      "",
      20002,
    );
    assert.equal(rebound.status, 200);
    assert.equal(
      (await post("list", {}, rebound.data.token, 20002)).data.records.length,
      1,
    );
    assert.equal(
      (await post("list", {}, rebound.data.token, 10001)).status,
      401,
    );
  } finally {
    if (previousToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = previousToken;
    await new Promise<void>((r) => server.close(() => r()));
    await f.close();
  }
});
