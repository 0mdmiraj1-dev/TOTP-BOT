import { createHmac } from "node:crypto";
import { equal, open, decrypt } from "./crypto.js";
import { requireThat } from "./model.js";
import { totp } from "./totp.js";
import type { Coordinator, State } from "./store.js";
import type { Transport } from "./telegram.js";
const choices = [
  "Passwords",
  "2FA",
  "Search",
  "Add",
  "Import",
  "Backup & Restore",
  "Settings",
  "Lock / Logout",
];
export function verifyForward(
  raw: string,
  signature: string,
  secret: string,
  now = Date.now(),
) {
  requireThat(
    secret.length >= 64 && /^[a-f0-9]{64}$/.test(signature),
    401,
    "Invalid forwarding signature",
  );
  requireThat(
    equal(signature, createHmac("sha256", secret).update(raw).digest("hex")),
    401,
    "Invalid forwarding signature",
  );
  const p = JSON.parse(raw);
  requireThat(
    typeof p.actor === "string" &&
      /^\d+$/.test(p.actor) &&
      typeof p.event === "string" &&
      p.event.length < 100 &&
      Number.isSafeInteger(p.timestamp) &&
      Math.abs(now - p.timestamp) < 60000,
    401,
    "Invalid or expired forwarding request",
  );
  requireThat(
    p.action === "home" ||
      (p.action === "callback" && /^[a-f0-9]{32}$/.test(p.callback)),
    400,
    "Invalid bot action",
  );
  requireThat(
    p.message === undefined ||
      (Number.isSafeInteger(p.message) && p.message > 0),
    400,
    "Invalid message",
  );
  return p as {
    actor: string;
    event: string;
    timestamp: number;
    action: string;
    callback?: string;
    message?: number;
  };
}
export class BotRouter {
  constructor(
    private db: Coordinator,
    private tg: Transport,
    private serverKey: Buffer,
    private origin: string,
    private clock = () => Date.now(),
  ) {}
  async handle(p: ReturnType<typeof verifyForward>) {
    return this.db.run(async (s) => {
      const a = s.account;
      const entry = Object.entries(s.sessions).find(
        ([, t]) =>
          a &&
          a.ack &&
          a.binding === p.actor &&
          t.actor === p.actor &&
          t.generation === a.generation &&
          t.expires > this.clock() &&
          t.absolute > this.clock(),
      );
      const openButton = (view = "") => [
        {
          text: "Open Vault",
          web_app: {
            url: this.origin + (view ? "#" + encodeURIComponent(view) : ""),
          },
        },
      ];
      const replay = "bot:" + p.event;
      if (s.idempotency[replay]) return;
      requireThat(
        Object.keys(s.idempotency).length < 10000,
        429,
        "Development event capacity reached",
      );
      s.idempotency[replay] = {
        hash: "bot",
        revision: a?.backup.revision ?? 0,
      };
      if (!entry) {
        await this.tg.menu(
          p.actor,
          "Vault locked. Open Vault to sign in securely. A new Telegram account must use Rebind.",
          [openButton()],
          p.message,
        );
        return;
      }
      const [sessionHash, session] = entry;
      const token = (action: string) => {
        const id = crypto.randomUUID().replaceAll("-", "");
        s.callbacks[id] = {
          actor: p.actor,
          generation: a!.generation,
          session: sessionHash,
          action,
          expires: this.clock() + 300000,
        };
        return "/vault " + id;
      };
      for (const [id, c] of Object.entries(s.callbacks))
        if (c.expires < this.clock()) delete s.callbacks[id];
      // Durable replay marker: expired events pruned; cap protects bounded coordinator state.
      let action = "home";
      if (p.action === "callback") {
        const cb = s.callbacks[p.callback!];
        if (
          !cb ||
          cb.actor !== p.actor ||
          cb.session !== sessionHash ||
          cb.generation !== a!.generation ||
          cb.expires <= this.clock()
        ) {
          await this.tg.menu(
            p.actor,
            "Button expired. Send /start or reopen the vault.",
            [openButton()],
            p.message,
          );
          return;
        }
        action = cb.action;
        delete s.callbacks[p.callback!];
      }
      session.expires = Math.min(session.absolute, this.clock() + 600000);
      if (action === "Lock / Logout") {
        delete s.sessions[sessionHash];
        for (const [id, c] of Object.entries(s.callbacks))
          if (c.session === sessionHash) delete s.callbacks[id];
        await this.tg.menu(
          p.actor,
          "Vault locked. Previously delivered messages and files remain in Telegram.",
          [openButton()],
          p.message,
        );
        return;
      }
      let text = "Personal Vault",
        rows: any[] = [];
      const nav = () => [
        { text: "Back", callback_data: token("home") },
        { text: "Home", callback_data: token("home") },
      ];
      if (action === "home") {
        rows = choices.map((label) => [
          { text: label, callback_data: token(label) },
        ]);
      } else if (
        action === "Passwords" ||
        action === "2FA" ||
        action.startsWith("page:")
      ) {
        const parts = action.split(":"),
          type = action === "2FA" || parts[1] === "totp" ? "totp" : "password",
          page = action.startsWith("page:") ? Number(parts[2]) : 0;
        requireThat(Number.isInteger(page) && page >= 0, 400, "Invalid page");
        const key = Buffer.from(
          open<string>(
            this.serverKey,
            session.key,
            "session-key:" + p.actor + ":" + session.generation,
          ),
          "base64url",
        );
        try {
          const records = decrypt(a!.backup, key).records.filter(
              (r) => r.type === type,
            ),
            pages = Math.max(1, Math.ceil(records.length / 6));
          text = `${type === "totp" ? "2FA" : "Passwords"} · ${page + 1}/${pages}`;
          if (!records.length)
            text += "\nNo records yet. Add one in Open Vault.";
          rows = records
            .slice(page * 6, page * 6 + 6)
            .map((r) => [
              {
                text: (r.type === "password"
                  ? r.name + " · " + r.username
                  : r.issuer + " · " + r.account
                ).slice(0, 60),
                callback_data: token("record:" + r.id),
              },
            ]);
          if (page > 0)
            rows.push([
              {
                text: "Previous",
                callback_data: token(`page:${type}:${page - 1}`),
              },
            ]);
          if (page + 1 < pages)
            rows.push([
              {
                text: "Next",
                callback_data: token(`page:${type}:${page + 1}`),
              },
            ]);
        } finally {
          key.fill(0);
        }
      } else if (action.startsWith("record:") || action.startsWith("code:")) {
        const key = Buffer.from(
          open<string>(
            this.serverKey,
            session.key,
            "session-key:" + p.actor + ":" + session.generation,
          ),
          "base64url",
        );
        try {
          const r = decrypt(a!.backup, key).records.find(
            (r) => r.id === action.split(":")[1],
          );
          requireThat(r, 404, "Record not found");
          if (r.type === "totp") {
            if (action.startsWith("code:")) {
              const code = totp(r, this.clock());
              text = `${r.issuer} · ${r.account}\n${code.code}\nExpires ${new Date(code.expiresAt).toISOString()}\nDelivered codes can remain in Telegram history.`;
              rows.push([
                { text: "Refresh", callback_data: token("code:" + r.id) },
              ]);
            } else {
              text = `${r.issuer} · ${r.account}\nShow current code in Telegram? It may remain in chat history.`;
              rows.push([
                { text: "Show code", callback_data: token("code:" + r.id) },
              ]);
            }
          } else {
            text = `${r.name}\n${r.username}\nPassword: ••••••••\nUse Open Vault to reveal, copy, edit, or delete.`;
          }
        } finally {
          key.fill(0);
        }
      } else {
        text =
          action === "Backup & Restore"
            ? "Download an encrypted backup or retry delivery in Open Vault. A file only in Telegram is not an independent backup."
            : action === "Settings"
              ? "Manage recovery and Telegram binding in Open Vault."
              : `${action} securely in Open Vault. Use Cancel or Home to leave a form.`;
      }
      if (action !== "home") rows.push(nav());
      rows.push(openButton(action));
      requireThat(
        Object.keys(s.callbacks).length < 200,
        429,
        "Too many pending buttons; wait five minutes",
      );
      await this.tg.menu(p.actor, text, rows, p.message);
    });
  }
}
