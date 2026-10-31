import { z } from "zod";
const b64 = z
  .string()
  .max(3000000)
  .regex(/^[A-Za-z0-9_-]+$/);
const boxSchema = z.object({ iv: b64, tag: b64, ct: b64 }).strict();
const kdfSchema = z
  .object({
    name: z.literal("scrypt"),
    N: z.literal(32768),
    r: z.literal(8),
    p: z.literal(1),
    salt: b64,
  })
  .strict();
export const backupSchema = z
  .object({
    format: z.literal("personal-vault"),
    schema: z.literal(1),
    vaultId: z.uuid(),
    revision: z.number().int().nonnegative(),
    created: z.string().datetime(),
    previous: z.string().nullable(),
    kdf: kdfSchema,
    password: boxSchema,
    recovery: boxSchema,
    payload: boxSchema,
  })
  .strict();

// Stable field order also survives JSON round-trips and schema parsing.
export function payloadAad(b: z.infer<typeof backupSchema>) {
  return (
    `personal-vault:${b.vaultId}:${b.schema}:payload:` +
    JSON.stringify([
      b.revision,
      b.created,
      b.previous,
      b.kdf.name,
      b.kdf.N,
      b.kdf.r,
      b.kdf.p,
      b.kdf.salt,
      b.password.iv,
      b.password.ct,
      b.password.tag,
      b.recovery.iv,
      b.recovery.ct,
      b.recovery.tag,
    ])
  );
}
