import { createHmac } from "node:crypto";
import { equal, digest, type Backup } from "./crypto.js";
import { requireThat } from "./model.js";
export function isChannelId(value: string) {
  if (!/^-\d{1,16}$/.test(value)) return false;
  const id = BigInt(value);
  return id >= -1997852516352n && id <= -1000000000001n;
}
export function channelIdFromLink(value: string) {
  const u = new URL(value),
    match = u.pathname.match(/^\/c\/(\d+)\/\d+/);
  requireThat(
    u.protocol === "https:" &&
      ["t.me", "telegram.me"].includes(u.hostname) &&
      match,
    400,
    "Use a private channel message link, not an invite link",
  );
  const id = BigInt(match[1]);
  requireThat(id >= 1n && id <= 997852516352n, 400, "Invalid channel ID");
  return String(-(1000000000000n + id));
}
export function validateInitData(raw: string, token: string, now = Date.now()) {
  requireThat(raw.length <= 12000, 401, "Invalid Telegram authorization");
  const p = new URLSearchParams(raw),
    hash = p.get("hash");
  requireThat(
    hash && /^[a-f0-9]{64}$/.test(hash),
    401,
    "Invalid Telegram authorization",
  );
  const seen = new Set<string>();
  for (const [k] of p) {
    requireThat(!seen.has(k), 401, "Invalid Telegram authorization");
    seen.add(k);
  }
  p.delete("hash");
  const data = [...p]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  requireThat(
    equal(hash, createHmac("sha256", secret).update(data).digest("hex")),
    401,
    "Invalid Telegram authorization",
  );
  const age = now / 1000 - Number(p.get("auth_date"));
  requireThat(
    Number.isFinite(age) && age >= -30 && age <= 300,
    401,
    "Telegram authorization expired; reopen the Mini App",
  );
  let user;
  try {
    user = JSON.parse(p.get("user") ?? "{}");
  } catch {
    throw Error("Invalid Telegram user");
  }
  requireThat(
    user && Number.isSafeInteger(user.id) && user.id > 0,
    401,
    "Invalid Telegram user",
  );
  return String(user.id);
}
export interface Transport {
  upload(b: Backup): Promise<{ fileId: string; messageId: number }>;
  publish(
    b: Backup,
    file: { fileId: string; messageId: number },
    manifestMessage?: number,
  ): Promise<number>;
  deliver(b: Backup, actor: string): Promise<void>;
  pin?(message: number): Promise<void>;
  menu(
    actor: string,
    text: string,
    keyboard: unknown,
    message?: number,
  ): Promise<void>;
}
export class Telegram implements Transport {
  constructor(
    private token: string,
    private channel: string,
    private manifestKey: Buffer,
  ) {}
  private async call(method: string, body: Record<string, unknown> | FormData) {
    const multipart = body instanceof FormData;
    const response = await fetch(
      `https://api.telegram.org/bot${this.token}/${method}`,
      {
        method: "POST",
        headers: multipart ? undefined : { "content-type": "application/json" },
        body: multipart ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      },
    );
    let payload;
    try {
      payload = (await response.json()) as {
        ok: boolean;
        result: any;
        error_code?: number;
        description?: string;
      };
    } catch {
      throw Error("Telegram request failed");
    }
    if (!response.ok || !payload.ok) {
      if (
        method === "editMessageText" &&
        payload.error_code === 400 &&
        payload.description?.includes("message is not modified")
      )
        return {};
      throw Error("Telegram request failed");
    }
    return payload.result;
  }
  private document(b: Backup, chat: string) {
    const form = new FormData();
    form.set("chat_id", chat);
    form.set(
      "document",
      new Blob([JSON.stringify(b)], { type: "application/json" }),
      "vault.encrypted.json",
    );
    form.set("caption", `Encrypted vault snapshot · revision ${b.revision}`);
    return this.call("sendDocument", form);
  }
  async upload(b: Backup) {
    const m = await this.document(b, this.channel);
    return {
      fileId: m.document.file_id as string,
      messageId: m.message_id as number,
    };
  }
  async publish(
    b: Backup,
    file: { fileId: string; messageId: number },
    message?: number,
  ) {
    const manifest = {
      format: "personal-vault-manifest",
      vaultId: b.vaultId,
      schema: b.schema,
      revision: b.revision,
      fileId: file.fileId,
      documentMessage: file.messageId,
      created: b.created,
      previous: b.previous,
      sha256: digest(JSON.stringify(b)),
    };
    const body = JSON.stringify(manifest),
      text = JSON.stringify({
        manifest,
        mac: createHmac("sha256", this.manifestKey).update(body).digest("hex"),
      });
    const result = await this.call("sendMessage", {
      chat_id: this.channel,
      text,
    });
    return result.message_id as number;
  }
  async pin(message: number) {
    await this.call("pinChatMessage", {
      chat_id: this.channel,
      message_id: message,
      disable_notification: true,
    });
  }
  async deliver(b: Backup, actor: string) {
    await this.document(b, actor);
  }
  async menu(actor: string, text: string, keyboard: unknown, message?: number) {
    await this.call(message ? "editMessageText" : "sendMessage", {
      chat_id: actor,
      ...(message ? { message_id: message } : {}),
      text,
      reply_markup: { inline_keyboard: keyboard },
    });
  }
  async discover(expected?: {
    revision: number;
    sha256: string;
    vaultId: string;
  }) {
    const chat = await this.call("getChat", { chat_id: this.channel });
    const text = chat.pinned_message?.text;
    requireThat(
      typeof text === "string",
      409,
      "Dedicated pinned manifest missing",
    );
    const { manifest, mac } = JSON.parse(text);
    requireThat(
      equal(
        mac,
        createHmac("sha256", this.manifestKey)
          .update(JSON.stringify(manifest))
          .digest("hex"),
      ),
      409,
      "Invalid manifest signature",
    );
    requireThat(
      expected &&
        manifest.revision === expected.revision &&
        manifest.sha256 === expected.sha256 &&
        manifest.vaultId === expected.vaultId,
      409,
      "Pinned hint is stale; use the coordinator's authoritative reference",
    );
    return manifest;
  }
  async retrieve(fileId: string, expectedHash: string) {
    const f = await this.call("getFile", { file_id: fileId });
    requireThat(
      typeof f.file_path === "string" && !f.file_path.includes(".."),
      409,
      "Invalid Telegram file",
    );
    const r = await fetch(
      `https://api.telegram.org/file/bot${this.token}/${f.file_path}`,
      { signal: AbortSignal.timeout(8000) },
    );
    requireThat(r.ok, 502, "Snapshot retrieval failed");
    const reader = r.body!.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 3000000) {
        await reader.cancel();
        throw Error("Snapshot too large");
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    requireThat(
      digest(bytes) === expectedHash,
      409,
      "Snapshot digest mismatch",
    );
    return JSON.parse(bytes.toString());
  }
}
