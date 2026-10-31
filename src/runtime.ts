import {
  DisabledCoordinator,
  LocalCoordinator,
  type Coordinator,
} from "./store.js";
import { Telegram, type Transport } from "./telegram.js";
import { VaultService } from "./service.js";
import { BotRouter } from "./bot.js";
export type Runtime = {
  service: VaultService;
  bot: BotRouter;
  local: boolean;
  simulatedTelegram: boolean;
  close?: () => Promise<void>;
};
let runtime: Promise<Runtime> | undefined;
export function createRuntime(local = false): Promise<Runtime> {
  return (runtime ??= make(local));
}
async function make(local: boolean): Promise<Runtime> {
  const enabled =
    local &&
    process.env.STORAGE_MODE === "local-development" &&
    !process.env.VERCEL;
  const key = /^[a-f0-9]{64}$/i.test(process.env.SERVER_KEY ?? "")
    ? Buffer.from(process.env.SERVER_KEY!, "hex")
    : Buffer.alloc(32);
  let db: Coordinator = new DisabledCoordinator();
  let close;
  if (enabled) {
    if (
      !/^[a-f0-9]{64}$/i.test(process.env.SERVER_KEY ?? "") ||
      !process.env.SETUP_TOKEN ||
      process.env.SETUP_TOKEN.length < 64
    )
      throw Error(
        "Configure SERVER_KEY and SETUP_TOKEN before local development",
      );
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
        async publish() {
          return 1;
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
    bot: new BotRouter(db, transport, key, origin),
    local: enabled,
    simulatedTelegram,
    close,
  };
}
