import {
  DisabledCoordinator,
  LocalCoordinator,
  type Coordinator,
} from "./store.js";
import { PostgresCoordinator } from "./postgres.js";
import { Telegram, isChannelId, type Transport } from "./telegram.js";
import { VaultService } from "./service.js";
import { BotRouter } from "./bot.js";
export type Runtime = {
  service: VaultService;
  bot: BotRouter;
  local: boolean;
  simulatedTelegram: boolean;
  production?: boolean;
  mode?: string;
  missing?: string[];
  close?: () => Promise<void>;
};
let runtime: Promise<Runtime> | undefined;
export function createRuntime(local = false): Promise<Runtime> {
  return (runtime ??= make(local));
}
async function make(local: boolean): Promise<Runtime> {
  const mode = process.env.STORAGE_MODE ?? "experimental-channel";
  const enabled = local && mode === "local-development" && !process.env.VERCEL;
  const required = [
    "DATABASE_URL",
    "SERVER_KEY",
    "SETUP_TOKEN",
    "BB_FORWARD_SECRET",
    "CRON_SECRET",
    "BOT_TOKEN",
    "CHANNEL_ID",
    "APP_ORIGIN",
  ];
  const missing =
    mode === "postgres" ? required.filter((name) => !process.env[name]) : [];
  const validKey = /^[a-f0-9]{64}$/i.test(process.env.SERVER_KEY ?? "");
  if (mode === "postgres") {
    for (const name of [
      "SERVER_KEY",
      "SETUP_TOKEN",
      "BB_FORWARD_SECRET",
      "CRON_SECRET",
    ])
      if (
        !/^[a-f0-9]{64}$/i.test(process.env[name] ?? "") &&
        !missing.includes(name)
      )
        missing.push(name);
    try {
      const u = new URL(process.env.APP_ORIGIN ?? "");
      if (u.protocol !== "https:" || u.origin !== process.env.APP_ORIGIN)
        throw Error();
    } catch {
      if (!missing.includes("APP_ORIGIN")) missing.push("APP_ORIGIN");
    }
    if (
      !isChannelId(process.env.CHANNEL_ID ?? "") &&
      !missing.includes("CHANNEL_ID")
    )
      missing.push("CHANNEL_ID");
  }
  const key = validKey
    ? Buffer.from(process.env.SERVER_KEY!, "hex")
    : Buffer.alloc(32);
  let db: Coordinator = new DisabledCoordinator(),
    close: (() => Promise<void>) | undefined;
  const production = mode === "postgres" && missing.length === 0;
  if (production) {
    const store = new PostgresCoordinator(process.env.DATABASE_URL!, key);
    db = store;
    close = () => store.close();
  } else if (enabled) {
    if (
      !validKey ||
      !process.env.SETUP_TOKEN ||
      process.env.SETUP_TOKEN.length < 64
    )
      throw Error("Configure SERVER_KEY and SETUP_TOKEN");
    const store = await LocalCoordinator.create(
      process.env.LOCAL_STATE_PATH ?? "work/vault.local",
      key,
    );
    db = store;
    close = () => store.close();
  }
  const simulatedTelegram =
    enabled && process.env.LOCAL_MOCK_TELEGRAM === "true";
  const transport: Transport = simulatedTelegram
    ? {
        async upload(b) {
          return { fileId: "local-simulation", messageId: b.revision + 1 };
        },
        async publish(b) {
          return b.revision + 100;
        },
        async deliver() {},
        async menu() {},
      }
    : process.env.BOT_TOKEN && process.env.CHANNEL_ID
      ? new Telegram(process.env.BOT_TOKEN, process.env.CHANNEL_ID, key)
      : {
          async upload() {
            throw Error("Telegram not configured");
          },
          async publish() {
            throw Error("Telegram not configured");
          },
          async deliver() {
            throw Error("Telegram not configured");
          },
          async menu() {
            throw Error("Telegram not configured");
          },
        };
  const idle = Number(process.env.SESSION_IDLE_SECONDS ?? 600) * 1000;
  if (!Number.isFinite(idle) || idle < 60000 || idle > 3600000)
    throw Error("Invalid session expiry");
  const origin = process.env.APP_ORIGIN ?? "http://127.0.0.1:3000";
  return {
    service: new VaultService(
      db,
      transport,
      key,
      process.env.SETUP_TOKEN ?? "",
      idle,
    ),
    bot: new BotRouter(db, transport, key, origin, undefined, idle),
    local: enabled,
    simulatedTelegram,
    production,
    mode,
    missing,
    close,
  };
}
