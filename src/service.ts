import { z } from "zod";
import { randomBytes } from "node:crypto";
import {
  createBackup,
  decrypt,
  unwrap,
  encryptRevision,
  rewrap,
  seal,
  open,
  digest,
  equal,
  parseBackup,
} from "./crypto.js";
import {
  requireThat,
  Fault,
  dataSchema,
  recordSchema,
  mergeRecords,
  type RecordItem,
} from "./model.js";
import { normalizeSecret, parseOtpUri, totp } from "./totp.js";
import { inspectImport } from "./import.js";
import {
  pruneSecurity,
  type Coordinator,
  type State,
  type Session,
} from "./store.js";
import { Outbox, enqueue } from "./outbox.js";
import type { Transport } from "./telegram.js";
export type Context = { actor?: string; session?: string };
const strong = (p: unknown) =>
  z
    .string()
    .min(14)
    .max(256)
    .refine(
      (value) => new Set(value).size >= 8,
      "Use a unique password or passphrase with at least eight distinct characters",
    )
    .parse(p);
const random = () => randomBytes(32).toString("hex");
export class VaultService {
  constructor(
    private db: Coordinator,
    private transport: Transport,
    private serverKey: Buffer,
    private setupToken: string,
    private idle = 600000,
    private clock = () => Date.now(),
  ) {}
  private session(s: State, c: Context, allowSetup = false) {
    const a = s.account,
      t = c.session && s.sessions[digest(c.session)];
    requireThat(
      a &&
        t &&
        t.generation === a.generation &&
        t.actor === c.actor &&
        a.binding === c.actor &&
        t.expires > this.clock() &&
        t.absolute > this.clock() &&
        (allowSetup || a.ack),
      401,
      "Session expired or unauthorized",
    );
    t.expires = Math.min(t.absolute, this.clock() + this.idle);
    return t;
  }
  private key(t: Session) {
    return Buffer.from(
      open<string>(
        this.serverKey,
        t.key,
        "session-key:" + t.actor + ":" + t.generation,
      ),
      "base64url",
    );
  }
  private issue(s: State, actor: string, key: Buffer, setup = false) {
    const token = random(),
      a = s.account!;
    for (const [id, t] of Object.entries(s.sessions))
      if (t.expires <= this.clock() || t.absolute <= this.clock())
        delete s.sessions[id];
    requireThat(
      Object.keys(s.sessions).length < 20,
      429,
      "Too many active sessions; lock existing sessions first",
    );
    s.sessions[digest(token)] = {
      generation: a.generation,
      actor,
      expires: this.clock() + this.idle,
      absolute: this.clock() + 3600000,
      key: seal(
        this.serverKey,
        key.toString("base64url"),
        "session-key:" + actor + ":" + a.generation,
      ),
      setup,
    };
    return token;
  }
  private throttle(s: State) {
    if (s.attempts.until <= this.clock())
      s.attempts = { count: 0, until: this.clock() + 900000 };
    requireThat(
      s.attempts.count < 5,
      429,
      "Too many attempts; try again after 15 minutes",
    );
    s.attempts.count++;
  }
  private credentials(s: State, body: any, mode: "password" | "recovery") {
    this.throttle(s);
    requireThat(
      s.account && s.account.username === body.username,
      401,
      "Invalid credentials",
    );
    try {
      return unwrap(
        s.account.backup,
        String(mode === "password" ? body.password : body.recovery),
        mode,
      );
    } catch {
      throw new Fault(401, "Invalid credentials");
    }
  }
  private actor(c: Context) {
    requireThat(
      c.actor && /^\d+$/.test(c.actor),
      401,
      "Verified Telegram identity required",
    );
    return c.actor;
  }
  private revoke(s: State) {
    s.account!.generation++;
    s.sessions = {};
    s.callbacks = {};
    s.prepared = undefined;
    for (const job of s.jobs) delete job.lease;
  }
  private async commit(
    s: State,
    key: Buffer,
    records: RecordItem[],
    newPassword?: string,
  ) {
    requireThat(
      !s.jobs.some((j) => !j.published),
      409,
      "Retry pending channel publication before another change",
    );
    const old = s.account!.backup,
      data = decrypt(old, key);
    const template = newPassword ? rewrap(old, key, newPassword) : old;
    const b = encryptRevision(
      template,
      key,
      { ...data, records },
      old.revision + 1,
      digest(JSON.stringify(old)),
    );
    requireThat(
      Buffer.byteLength(JSON.stringify(b)) < 2500000,
      413,
      "Encrypted vault size limit exceeded",
    );
    enqueue(s, b);
    s.account!.backup = b;
    return b.revision;
  }
  async request(action: string, body: any, c: Context): Promise<any> {
    // Every protected operation uses the same durable transaction as auth checks.
    if (action === "retry") return this.retry(c);
    const result: any = await this.db.run(async (s) => {
      pruneSecurity(s, this.clock());
      if (action === "setup") {
        requireThat(!s.account, 409, "Setup is permanently disabled");
        requireThat(
          this.setupToken.length >= 64 &&
            typeof body.token === "string" &&
            equal(body.token, this.setupToken),
          401,
          "Invalid setup token",
        );
        const actor = this.actor(c),
          username = z.string().min(3).max(100).parse(body.username),
          password = strong(body.password);
        const { backup, key, recovery } = createBackup(
          { username, records: [] },
          password,
        );
        try {
          s.account = {
            username,
            binding: actor,
            generation: 1,
            ack: false,
            backup,
          };
          const token = this.issue(s, actor, key, true);
          return { token, recovery, acknowledgementRequired: true };
        } finally {
          key.fill(0);
        }
      }
      if (action === "login") {
        const key = this.credentials(s, body, "password");
        try {
          const actor = this.actor(c);
          requireThat(
            s.account!.binding === actor,
            403,
            "Use the deliberate rebind flow for a new Telegram account",
          );
          s.attempts = { count: 0, until: 0 };
          return {
            token: this.issue(s, actor, key, !s.account!.ack),
            acknowledgementRequired: !s.account!.ack,
          };
        } finally {
          key.fill(0);
        }
      }
      if (action === "rebind" || action === "recover-password") {
        requireThat(
          body.confirm === true,
          400,
          "Explicit revocation confirmation required",
        );
        const actor = this.actor(c);
        let key: Buffer;
        if (action === "rebind") {
          key = this.credentials(s, body, "password");
          try {
            const recovery = unwrap(
              s.account!.backup,
              String(body.recovery),
              "recovery",
            );
            try {
              requireThat(
                equal(key.toString("hex"), recovery.toString("hex")),
                401,
                "Invalid credentials",
              );
            } finally {
              recovery.fill(0);
            }
          } catch {
            key.fill(0);
            throw new Fault(401, "Invalid credentials");
          }
        } else key = this.credentials(s, body, "recovery");
        try {
          if (action === "recover-password") {
            requireThat(
              !s.jobs.some((j) => !j.published),
              409,
              "Resolve publication first",
            );
            await this.commit(
              s,
              key,
              decrypt(s.account!.backup, key).records,
              strong(body.newPassword),
            );
          }
          this.revoke(s);
          s.account!.binding = actor;
          s.account!.ack = true;
          s.attempts = { count: 0, until: 0 };
          return { token: this.issue(s, actor, key), revoked: true };
        } finally {
          key.fill(0);
        }
      }
      const session = this.session(s, c, action === "ack");
      if (action === "ack") {
        requireThat(
          body.confirm === true,
          400,
          "Confirm recovery key is stored safely",
        );
        s.account!.ack = true;
        session.setup = false;
        if (!s.jobs.length) enqueue(s, s.account!.backup);
        return { acknowledged: true };
      }
      if (action === "logout") {
        delete s.sessions[digest(c.session!)];
        for (const [id, cb] of Object.entries(s.callbacks))
          if (cb.session === digest(c.session!)) delete s.callbacks[id];
        return { locked: true };
      }
      if (action === "status") return this.status(s);
      if (action === "manifest") return { reference: s.published ?? null };
      if (action === "callback") {
        const cb = s.callbacks[String(body.id)];
        requireThat(
          cb &&
            cb.actor === c.actor &&
            cb.generation === s.account!.generation &&
            cb.session === digest(c.session!) &&
            cb.expires > this.clock(),
          401,
          "Button expired; reopen vault",
        );
        delete s.callbacks[String(body.id)];
        return { action: cb.action };
      }
      const key = this.key(session);
      try {
        const data = decrypt(s.account!.backup, key);
        if (action === "list")
          return {
            records: data.records.map((r) =>
              r.type === "password"
                ? { ...r, password: undefined }
                : { ...r, secret: undefined },
            ),
            ...this.status(s),
          };
        if (action === "reveal") {
          const r = data.records.find((r) => r.id === body.id);
          requireThat(r?.type === "password", 404, "Password not found");
          return { password: r.password };
        }
        if (action === "totp") {
          const r = data.records.find((r) => r.id === body.id);
          requireThat(r?.type === "totp", 404, "2FA record not found");
          return totp(r, this.clock());
        }
        if (action === "backup") return { backup: s.account!.backup };
        if (action === "import-preview") {
          const report = inspectImport(
            z.string().parse(body.source),
            data.records,
            z.enum(["skip", "update", "both"]).parse(body.policy),
          );
          return { ...report, records: undefined };
        }
        if (action === "restore-preview") {
          const b = parseBackup(body.backup),
            k = unwrap(b, String(body.recovery), "recovery");
          try {
            const restored = decrypt(b, k);
            return {
              passwords: restored.records.filter((r) => r.type === "password")
                .length,
              totp: restored.records.filter((r) => r.type === "totp").length,
            };
          } finally {
            k.fill(0);
          }
        }
        const id = z.string().min(16).max(100).parse(body.requestId),
          scope = digest(c.session!) + ":" + id,
          hash = digest(JSON.stringify({ action, body }));
        const prior = s.idempotency[scope];
        if (prior) {
          requireThat(
            prior.hash === hash,
            409,
            "Idempotency key reused with a different request",
          );
          return { revision: prior.revision, replayed: true };
        }
        requireThat(
          Object.keys(s.idempotency).length < 10000,
          409,
          "Idempotency capacity reached",
        );
        requireThat(
          body.revision === s.account!.backup.revision,
          409,
          "Vault changed; reload and preview again",
        );
        let records = data.records;
        if (action === "save") {
          let raw = body.record;
          if (raw?.type === "totp") {
            raw = raw.uri
              ? { ...parseOtpUri(raw.uri), id: raw.id ?? crypto.randomUUID() }
              : {
                  ...raw,
                  secret: normalizeSecret(
                    raw.secret ??
                      (
                        records.find(
                          (r) => r.id === raw.id && r.type === "totp",
                        ) as any
                      )?.secret ??
                      "",
                  ),
                };
          }
          if (raw?.type === "totp" && raw.passwordId === null)
            raw = { ...raw, passwordId: undefined };
          const now = new Date(this.clock()).toISOString(),
            found = records.find((r) => r.id === raw?.id);
          const r = recordSchema.parse({
            ...found,
            ...raw,
            ...(raw.type === "password" &&
            raw.password === undefined &&
            found?.type === "password"
              ? { password: found.password }
              : {}),
            id: found?.id ?? crypto.randomUUID(),
            created: found?.created ?? now,
            updated: now,
          });
          if (r.type === "totp" && r.passwordId)
            requireThat(
              records.some(
                (p) => p.id === r.passwordId && p.type === "password",
              ),
              400,
              "Linked password not found",
            );
          records = found
            ? records.map((p) => (p.id === r.id ? r : p))
            : [...records, r];
        } else if (action === "delete") {
          requireThat(
            body.confirm === true,
            400,
            "Deletion confirmation required",
          );
          requireThat(
            records.some((r) => r.id === body.id),
            404,
            "Record not found",
          );
          records = records
            .filter((r) => r.id !== body.id)
            .map((r) =>
              r.type === "totp" && r.passwordId === body.id
                ? { ...r, passwordId: undefined }
                : r,
            );
        } else if (action === "import-commit") {
          requireThat(
            body.confirm === true,
            400,
            "Import confirmation required",
          );
          const policy = z.enum(["skip", "update", "both"]).parse(body.policy),
            report = inspectImport(
              z.string().parse(body.source),
              records,
              policy,
            );
          requireThat(report.valid > 0, 400, "No valid records");
          records = mergeRecords(records, report.records, policy).records;
        } else if (action === "restore-commit") {
          requireThat(
            body.confirm === true,
            400,
            "Restore confirmation required",
          );
          const b = parseBackup(body.backup),
            k = unwrap(b, String(body.recovery), "recovery");
          try {
            const restored = decrypt(b, k);
            requireThat(
              ["merge", "replace"].includes(body.mode),
              400,
              "Choose merge or replace",
            );
            records =
              body.mode === "replace"
                ? restored.records
                : mergeRecords(records, restored.records, "both").records;
          } finally {
            k.fill(0);
          }
        } else throw new Fault(404, "Unknown operation");
        dataSchema.parse({ ...data, records });
        const revision = await this.commit(s, key, records);
        s.idempotency[scope] = { hash, revision };
        return { revision };
      } finally {
        key.fill(0);
      }
    });
    if (
      [
        "ack",
        "save",
        "delete",
        "import-commit",
        "restore-commit",
        "recover-password",
        "rebind",
      ].includes(action) &&
      !result.replayed
    ) {
      const delivery = await this.retry({
        ...c,
        session: result.token ?? c.session,
      }).catch(() => ({ vaultSaved: true, retryRequired: true }));
      return { ...result, ...delivery };
    }
    return result;
  }
  private status(s: State) {
    const j = s.jobs.at(-1);
    return {
      vaultSaved: !!s.account?.ack,
      publishedRevision: s.published?.revision,
      pendingBackups: s.jobs.filter((j) => !j.delivered).length,
      pendingPublications: s.jobs.filter((j) => !j.published).length,
      pin: j?.pinError ? "failed" : "advisory",
      busy: !!j?.lease && j.lease.until > this.clock(),
      revision: s.account?.backup.revision,
      channel: j?.published
        ? "published"
        : j?.publicationError
          ? "failed"
          : "pending",
      backup: j?.delivered
        ? "delivered"
        : j?.deliveryError
          ? "failed"
          : "pending",
      upload: j?.uploaded ? "uploaded" : j?.uploadError ? "failed" : "pending",
    };
  }
  async retry(c: Context) {
    await new Outbox(this.db, this.transport, this.clock).drain((s) => {
      this.session(s, c);
    });
    return this.db.run((s) => {
      this.session(s, c);
      return this.status(s);
    });
  }
  async work() {
    await new Outbox(this.db, this.transport, this.clock).drain();
    return { processed: true };
  }
  async health() {
    return this.db.run((s) => ({
      initialized: !!s.account,
      setupComplete: !!s.account?.ack,
      publishedRevision: s.published?.revision,
    }));
  }
  async bot(actor: string, message?: number) {
    return this.db.run(async (s) => {
      const a = s.account;
      const sessionEntry = Object.entries(s.sessions).find(
        ([, t]) =>
          a &&
          a.ack &&
          a.binding === actor &&
          t.actor === actor &&
          t.generation === a.generation &&
          t.expires > this.clock() &&
          t.absolute > this.clock(),
      );
      const menu = [
        "Passwords",
        "2FA",
        "Search",
        "Add",
        "Import",
        "Backup & Restore",
        "Settings",
        "Lock / Logout",
      ];
      const rows = [];
      for (const label of menu) {
        const id = random().slice(0, 32);
        if (sessionEntry) {
          s.callbacks[id] = {
            actor,
            generation: a!.generation,
            session: sessionEntry[0],
            action: label,
            expires: this.clock() + 300000,
          };
          rows.push([{ text: label, callback_data: "/vault " + id }]);
        }
      }
      for (const [id, cb] of Object.entries(s.callbacks))
        if (cb.expires < this.clock()) delete s.callbacks[id];
      requireThat(
        Object.keys(s.callbacks).length < 200,
        429,
        "Reopen the Mini App",
      );
      return { rows, authenticated: !!sessionEntry };
    });
  }
}
