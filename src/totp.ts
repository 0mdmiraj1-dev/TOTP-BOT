import { createHmac } from "node:crypto";
import { totpSchema, Fault } from "./model.js";
export const HOTP_UNSUPPORTED =
  "HOTP is not supported; use time-based TOTP records.";
export function base32(value: string) {
  if (!/^[A-Z2-7]+={0,6}$/i.test(value)) throw Error("Invalid Base32 secret");
  const raw = value.toUpperCase().replace(/=+$/, "");
  if (![0, 2, 4, 5, 7].includes(raw.length % 8))
    throw Error("Invalid Base32 length");
  let bits = 0,
    n = 0;
  const out: number[] = [];
  for (const c of raw) {
    n = (n << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((n >>> bits) & 255);
      n &= (1 << bits) - 1;
    }
  }
  if (n !== 0 || out.length < 10) throw Error("Invalid Base32 secret");
  return Buffer.from(out);
}
export function normalizeSecret(s: string) {
  const value = s.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  base32(value);
  return value;
}
export function totp(
  r: {
    secret: string;
    algorithm: "SHA1" | "SHA256" | "SHA512";
    digits: 6 | 8;
    period: number;
  },
  now = Date.now(),
) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / r.period)));
  const h = createHmac(r.algorithm.toLowerCase(), base32(r.secret))
    .update(counter)
    .digest();
  const offset = h[h.length - 1] & 15;
  return {
    code: ((h.readUInt32BE(offset) & 0x7fffffff) % 10 ** r.digits)
      .toString()
      .padStart(r.digits, "0"),
    expiresAt: (Math.floor(now / 1000 / r.period) + 1) * r.period * 1000,
    serverTime: now,
  };
}
export function parseOtpUri(value: string) {
  const u = new URL(value);
  if (u.protocol !== "otpauth:" || u.hostname !== "totp")
    throw new Fault(400, HOTP_UNSUPPORTED);
  const label = decodeURIComponent(u.pathname.slice(1));
  const colon = label.indexOf(":");
  const now = new Date().toISOString();
  return totpSchema.parse({
    type: "totp",
    id: crypto.randomUUID(),
    created: now,
    updated: now,
    favorite: false,
    issuer:
      u.searchParams.get("issuer") ?? (colon < 0 ? "" : label.slice(0, colon)),
    account: colon < 0 ? label : label.slice(colon + 1),
    secret: normalizeSecret(u.searchParams.get("secret") ?? ""),
    algorithm: (u.searchParams.get("algorithm") ?? "SHA1")
      .toUpperCase()
      .replace("-", ""),
    digits: Number(u.searchParams.get("digits") ?? 6),
    period: Number(u.searchParams.get("period") ?? 30),
  });
}
