import { z } from "zod";
export const text = z.string().max(1000);
const base = {
  id: z.uuid(),
  favorite: z.boolean().default(false),
  created: z.string().datetime(),
  updated: z.string().datetime(),
};
export const passwordSchema = z
  .object({
    ...base,
    type: z.literal("password"),
    name: text.min(1),
    url: z
      .string()
      .max(2048)
      .refine((v) => !v || /^https?:\/\//i.test(v), "Use an http(s) URL"),
    username: text,
    password: z.string().max(10000),
    notes: z.string().max(20000),
  })
  .strict();
export const totpSchema = z
  .object({
    ...base,
    type: z.literal("totp"),
    issuer: text,
    account: text,
    secret: z
      .string()
      .min(16)
      .max(1024)
      .regex(/^[A-Z2-7]+$/)
      .refine((v) => {
        const remainder = v.length % 8;
        if (![0, 2, 4, 5, 7].includes(remainder)) return false;
        const unused = (v.length * 5) % 8;
        return (
          unused === 0 ||
          ("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(v.at(-1)!) &
            ((1 << unused) - 1)) ===
            0
        );
      }, "Noncanonical Base32 secret"),
    algorithm: z.enum(["SHA1", "SHA256", "SHA512"]),
    digits: z.union([z.literal(6), z.literal(8)]),
    period: z.number().int().min(15).max(120),
    passwordId: z.uuid().optional(),
  })
  .strict();
export const recordSchema = z.discriminatedUnion("type", [
  passwordSchema,
  totpSchema,
]);
export const dataSchema = z
  .object({
    username: z.string().min(3).max(100),
    records: z
      .array(recordSchema)
      .max(5000)
      .superRefine((records, ctx) => {
        const ids = new Set<string>();
        const passwords = new Set(
          records.filter((r) => r.type === "password").map((r) => r.id),
        );
        for (const r of records) {
          if (ids.has(r.id))
            ctx.addIssue({ code: "custom", message: "Duplicate record ID" });
          ids.add(r.id);
          if (r.type === "totp" && r.passwordId && !passwords.has(r.passwordId))
            ctx.addIssue({
              code: "custom",
              message: "Invalid explicit password link",
            });
        }
      }),
  })
  .strict();
export type RecordItem = z.infer<typeof recordSchema>;
export type VaultData = z.infer<typeof dataSchema>;
export function hostname(url: string) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "No website";
  }
}
export function identity(r: RecordItem) {
  return r.type === "password"
    ? JSON.stringify([r.type, hostname(r.url), r.username])
    : JSON.stringify([r.type, r.issuer.toLowerCase(), r.account.toLowerCase()]);
}
export function mergeRecords(
  old: RecordItem[],
  incoming: RecordItem[],
  policy: "skip" | "update" | "both",
) {
  const out = structuredClone(old);
  const mapped = new Map<string, string>();
  const touched = new Set<number>();
  let duplicates = 0,
    added = 0,
    updated = 0;
  for (const record of incoming) {
    const i = out.findIndex((r) => identity(r) === identity(record));
    if (i >= 0) {
      duplicates++;
      if (policy === "skip") {
        mapped.set(record.id, out[i].id);
        continue;
      }
      if (policy === "update") {
        out[i] = { ...record, id: out[i].id, created: out[i].created };
        mapped.set(record.id, out[i].id);
        touched.add(i);
        updated++;
        continue;
      }
    }
    const id = crypto.randomUUID();
    mapped.set(record.id, id);
    touched.add(out.length);
    out.push({ ...record, id });
    added++;
  }
  for (const i of touched) {
    const r = out[i];
    if (r.type === "totp" && r.passwordId) {
      const target = mapped.get(r.passwordId) ?? r.passwordId;
      out[i] = {
        ...r,
        passwordId: out.some((p) => p.type === "password" && p.id === target)
          ? target
          : undefined,
      };
    }
  }
  return {
    records: dataSchema.shape.records.parse(out),
    duplicates,
    added,
    updated,
  };
}
export class Fault extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function requireThat(
  ok: unknown,
  status: number,
  message: string,
): asserts ok {
  if (!ok) throw new Fault(status, message);
}
