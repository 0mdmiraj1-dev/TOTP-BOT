import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBackup,
  decrypt,
  unwrap,
  parseBackup,
  encryptRevision,
} from "../src/crypto.js";
import { totp, parseOtpUri, base32 } from "../src/totp.js";
import { inspectImport } from "../src/import.js";
import { mergeRecords, hostname, type RecordItem } from "../src/model.js";
function encode(buffer: Buffer) {
  let bits = 0,
    n = 0,
    s = "";
  for (const b of buffer) {
    n = (n << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      s += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[(n >>> bits) & 31];
      n &= (1 << bits) - 1;
    }
  }
  if (bits) s += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[(n << (5 - bits)) & 31];
  return s;
}
const times = [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000];
const expected = {
  SHA1: [
    "94287082",
    "07081804",
    "14050471",
    "89005924",
    "69279037",
    "65353130",
  ],
  SHA256: [
    "46119246",
    "68084774",
    "67062674",
    "91819424",
    "90698825",
    "77737706",
  ],
  SHA512: [
    "90693936",
    "25091201",
    "99943326",
    "93441116",
    "38618901",
    "47863826",
  ],
};
for (const [algorithm, length] of [
  ["SHA1", 20],
  ["SHA256", 32],
  ["SHA512", 64],
] as const)
  test(`RFC 6238 ${algorithm} vectors including leading zeroes`, () => {
    const secret = encode(Buffer.from("1234567890".repeat(7).slice(0, length)));
    times.forEach((time, i) =>
      assert.equal(
        totp({ secret, algorithm, digits: 8, period: 30 }, time * 1000).code,
        expected[algorithm][i],
      ),
    );
  });
test("TOTP boundary expiry and canonical Base32", () => {
  const r = {
    secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    algorithm: "SHA1" as const,
    digits: 6 as const,
    period: 30,
  };
  assert.equal(totp(r, 29999).expiresAt, 30000);
  assert.equal(totp(r, 30000).expiresAt, 60000);
  assert.notEqual(totp(r, 29999).code, totp(r, 30000).code);
  assert.throws(() => base32("INVALID!"));
  assert.throws(() => base32("AAAAAAAAAAAAAAAAAB"));
});
test("OTP URI preserves algorithms and rejects HOTP", () => {
  const r = parseOtpUri(
    "otpauth://totp/Test:a?secret=GEZDGNBVGY3TQOJQ&algorithm=SHA512&digits=8&period=45",
  );
  assert.equal(r.algorithm, "SHA512");
  assert.equal(r.digits, 8);
  assert.equal(r.period, 45);
  const rejected = inspectImport("otpauth://hotp/Test?secret=GEZDGNBVGY3TQOJQ");
  assert.equal(rejected.valid, 0);
  assert.match(rejected.errors[0].reason, /HOTP is not supported/);
  assert.throws(
    () => parseOtpUri("otpauth://hotp/Test?secret=GEZDGNBVGY3TQOJQ"),
    /HOTP/,
  );
});
test("CSV BOM, multiline, commas, optional fields, malformed rows and quoting", () => {
  const d = inspectImport(
    '\uFEFFname,url,username,password,note\r\n"Example, Inc",https://www.example.com,a,"synthetic,pass","line 1\nline 2"\r\nEmpty,,,,\r\nbad,short\r\n',
  );
  assert.equal(d.valid, 2);
  assert.equal(d.invalid, 1);
  assert.equal((d.records[0] as any).notes, "line 1\nline 2");
  assert.throws(() =>
    inspectImport('name,url,username,password,note\na,b,"unfinished'),
  );
  assert.throws(() => inspectImport("x".repeat(1048577)), /1 MiB/);
  assert.throws(() =>
    inspectImport(
      'name,url,username,password,note\na,,,,"' + "x".repeat(50000) + '"',
    ),
  );
});
test("OneCloud defaults, preserved parameters and sanitized validation errors", () => {
  const d = inspectImport(
    JSON.stringify({
      v: 1,
      app: "OneCloud",
      accounts: [
        {
          issuer: "Example",
          account_name: "a",
          secret: "GEZDGNBVGY3TQOJQ",
          algorithm: "SHA-256",
          digits: 8,
          period: 45,
        },
        { secret: "GEZDGNBVGY3TQOJQ" },
        { secret: "do-not-echo-invalid-secret" },
        { secret: "GEZDGNBVGY3TQOJQ", algorithm: "MD5" },
        { secret: "GEZDGNBVGY3TQOJQ", digits: 7 },
        { secret: "GEZDGNBVGY3TQOJQ", period: 0 },
      ],
    }),
  );
  assert.equal(d.valid, 2);
  assert.equal(d.invalid, 4);
  assert.equal((d.records[0] as any).period, 45);
  assert.equal((d.records[1] as any).algorithm, "SHA1");
  assert.ok(!JSON.stringify(d.errors).includes("do-not-echo"));
  assert.throws(() => inspectImport('{"v":2,"app":"OneCloud","accounts":[]}'));
});
export function passwordRecord(): RecordItem {
  return {
    id: crypto.randomUUID(),
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    favorite: false,
    type: "password",
    name: "Synthetic",
    url: "https://example.com",
    username: "synthetic",
    password: "synthetic-secret",
    notes: "",
  };
}
test("Duplicate skip/update/both and domain distinctions; no automatic links", () => {
  const original = passwordRecord(),
    changed = { ...original, id: crypto.randomUUID(), password: "changed" };
  assert.equal(mergeRecords([original], [changed], "skip").records.length, 1);
  const updated = mergeRecords([original], [changed], "update");
  assert.equal(updated.updated, 1);
  assert.equal(updated.records[0].id, original.id);
  assert.equal(mergeRecords([original], [changed], "both").records.length, 2);
  assert.notEqual(
    hostname("https://example.co.uk"),
    hostname("https://example.com"),
  );
  assert.notEqual(
    hostname("https://admin.example.com"),
    hostname("https://example.com"),
  );
  const report = inspectImport(
    JSON.stringify({
      v: 1,
      app: "OneCloud",
      accounts: [{ issuer: "Synthetic", secret: "GEZDGNBVGY3TQOJQ" }],
    }),
    [original],
  );
  assert.equal((report.records[0] as any).passwordId, undefined);
  const linked = {
    ...parseOtpUri("otpauth://totp/Example:a?secret=GEZDGNBVGY3TQOJQ"),
    passwordId: original.id,
  };
  const restored = mergeRecords([], [linked, original], "both").records;
  const otp = restored.find((r) => r.type === "totp")!;
  const pw = restored.find((r) => r.type === "password")!;
  assert.equal((otp as any).passwordId, pw.id);
  assert.notEqual(pw.id, original.id);
});
test("Portable authenticated backup, wrong credentials, schema and tamper failures", () => {
  const made = createBackup(
    { username: "synthetic", records: [passwordRecord()] },
    "synthetic master password",
  );
  const portable = parseBackup(JSON.parse(JSON.stringify(made.backup)));
  const k = unwrap(portable, made.recovery, "recovery");
  assert.equal(decrypt(portable, k).records.length, 1);
  assert.throws(() => unwrap(portable, "wrong password", "password"));
  assert.throws(() => unwrap(portable, "a".repeat(64), "recovery"));
  assert.throws(() => parseBackup({ ...portable, schema: 2 }));
  assert.throws(() => decrypt({ ...portable, revision: 7 }, k));
  assert.throws(() =>
    decrypt(
      { ...portable, kdf: { ...portable.kdf, salt: "tampered-salt" } },
      k,
    ),
  );
  assert.throws(() =>
    decrypt(
      { ...portable, password: { ...portable.password, ct: "tampered" } },
      k,
    ),
  );
  assert.throws(() =>
    decrypt(
      {
        ...portable,
        payload: {
          ...portable.payload,
          ct: "AA" + portable.payload.ct.slice(2),
        },
      },
      k,
    ),
  );
  const next = encryptRevision(
    portable,
    k,
    decrypt(portable, k),
    1,
    "previous",
  );
  assert.notEqual(next.payload.iv, portable.payload.iv);
  assert.throws(() => decrypt({ ...next, previous: "tampered" }, k));
  k.fill(0);
  made.key.fill(0);
});
