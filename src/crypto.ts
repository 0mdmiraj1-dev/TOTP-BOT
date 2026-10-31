import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scryptSync,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { dataSchema, type VaultData } from "./model.js";
import { backupSchema, payloadAad } from "./crypto-schema.js";
export { backupSchema } from "./crypto-schema.js";
export type Backup = z.infer<typeof backupSchema>;
export type Box = { iv: string; tag: string; ct: string };
export const randomKey = () => randomBytes(32);
export const digest = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
export function equal(a: string, b: string) {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function seal(key: Buffer, value: unknown, aad: string): Box {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
  return {
    iv: iv.toString("base64url"),
    ct: ct.toString("base64url"),
    tag: c.getAuthTag().toString("base64url"),
  };
}
export function open<T>(key: Buffer, box: Box, aad: string): T {
  const iv = Buffer.from(box.iv, "base64url"),
    tag = Buffer.from(box.tag, "base64url");
  if (iv.length !== 12 || tag.length !== 16)
    throw Error("Invalid encrypted envelope");
  const c = createDecipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  c.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([
      c.update(Buffer.from(box.ct, "base64url")),
      c.final(),
    ]).toString(),
  );
}
function derive(password: string, kdf: Backup["kdf"]) {
  return scryptSync(password, Buffer.from(kdf.salt, "base64url"), 32, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 64 * 1024 * 1024,
  });
}
function recoveryKey(value: string) {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw Error("Invalid recovery key");
  return Buffer.from(value, "hex");
}
const context = (b: Pick<Backup, "vaultId" | "schema">) =>
  `personal-vault:${b.vaultId}:${b.schema}`;
export function createBackup(data: VaultData, password: string) {
  const key = randomKey(),
    recovery = randomKey().toString("hex"),
    meta = { vaultId: crypto.randomUUID(), schema: 1 as const };
  const kdf = {
    name: "scrypt" as const,
    N: 32768 as const,
    r: 8 as const,
    p: 1 as const,
    salt: randomBytes(16).toString("base64url"),
  };
  const wrapping = derive(password, kdf);
  try {
    const b: Backup = {
      ...meta,
      format: "personal-vault",
      revision: 0,
      created: new Date().toISOString(),
      previous: null,
      kdf,
      password: seal(
        wrapping,
        key.toString("base64url"),
        context(meta) + ":password",
      ),
      recovery: seal(
        recoveryKey(recovery),
        key.toString("base64url"),
        context(meta) + ":recovery",
      ),
      payload: { iv: "", ct: "", tag: "" },
    };
    return { backup: encryptRevision(b, key, data, 0, null), key, recovery };
  } finally {
    wrapping.fill(0);
  }
}
export function parseBackup(input: unknown) {
  return backupSchema.parse(input);
}
export function unwrap(
  b: Backup,
  credential: string,
  mode: "password" | "recovery",
) {
  const k =
    mode === "password" ? derive(credential, b.kdf) : recoveryKey(credential);
  try {
    const result = Buffer.from(
      open<string>(k, b[mode], context(b) + ":" + mode),
      "base64url",
    );
    if (result.length !== 32) throw Error("Invalid key");
    return result;
  } finally {
    k.fill(0);
  }
}
export function decrypt(b: Backup, key: Buffer) {
  return dataSchema.parse(open(key, b.payload, payloadAad(b)));
}
export function encryptRevision(
  b: Backup,
  key: Buffer,
  data: VaultData,
  revision: number,
  previous: string | null,
): Backup {
  dataSchema.parse(data);
  const next = { ...b, revision, created: new Date().toISOString(), previous };
  return {
    ...next,
    payload: seal(key, data, payloadAad(next)),
  };
}
export function rewrap(b: Backup, key: Buffer, password: string) {
  const kdf = { ...b.kdf, salt: randomBytes(16).toString("base64url") },
    k = derive(password, kdf);
  try {
    return {
      ...b,
      kdf,
      password: seal(k, key.toString("base64url"), context(b) + ":password"),
    };
  } finally {
    k.fill(0);
  }
}
