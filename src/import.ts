import { parse } from "csv-parse/sync";
import { z } from "zod";
import {
  passwordSchema,
  totpSchema,
  type RecordItem,
  mergeRecords,
} from "./model.js";
import { normalizeSecret, parseOtpUri, HOTP_UNSUPPORTED } from "./totp.js";
export const MAX_IMPORT = 1024 * 1024;
export function inspectImport(
  source: string,
  existing: RecordItem[] = [],
  policy: "skip" | "update" | "both" = "skip",
) {
  if (Buffer.byteLength(source) > MAX_IMPORT) throw Error("File exceeds 1 MiB");
  const records: RecordItem[] = [];
  const errors: { row: number; reason: string }[] = [];
  let format = "";
  const add = (row: number, fn: () => RecordItem) => {
    try {
      records.push(fn());
    } catch (error) {
      errors.push({
        row,
        reason:
          error instanceof Error && error.message === HOTP_UNSUPPORTED
            ? HOTP_UNSUPPORTED
            : "Invalid record fields, size, or TOTP parameters",
      });
    }
  };
  const time = new Date().toISOString(),
    common = () => ({
      id: crypto.randomUUID(),
      created: time,
      updated: time,
      favorite: false,
    });
  const input = source.replace(/^\uFEFF/, "").trim();
  if (input.startsWith("otpauth:")) {
    format = "otpauth";
    add(1, () => parseOtpUri(input));
  } else if (input.startsWith("{")) {
    format = "onecloud";
    const root = z
      .object({
        v: z.union([z.literal(1), z.literal("1")]),
        app: z.string().min(1).max(100),
        accounts: z.array(z.unknown()).max(5000),
      })
      .parse(JSON.parse(input));
    root.accounts.forEach((a, index) =>
      add(index + 1, () => {
        const r = z
          .object({
            issuer: z.string().max(1000).optional(),
            account_name: z.string().max(1000).optional(),
            secret: z.string().max(1024),
            algorithm: z.string().optional(),
            digits: z.number().optional(),
            period: z.number().optional(),
            type: z.string().optional(),
          })
          .strict()
          .parse(a);
        if (r.type && r.type.toLowerCase() !== "totp")
          throw Error(HOTP_UNSUPPORTED);
        return totpSchema.parse({
          ...common(),
          type: "totp",
          issuer: r.issuer ?? "",
          account: r.account_name ?? "",
          secret: normalizeSecret(r.secret),
          algorithm: (r.algorithm ?? "SHA1").toUpperCase().replace("-", ""),
          digits: r.digits ?? 6,
          period: r.period ?? 30,
        });
      }),
    );
  } else {
    format = "google-csv";
    let rows: string[][];
    try {
      rows = parse(source, {
        bom: true,
        skip_empty_lines: true,
        max_record_size: 40000,
        relax_column_count: true,
      });
    } catch {
      throw Error("Malformed CSV quoting or record size");
    }
    if (
      JSON.stringify(rows.shift()) !==
      JSON.stringify(["name", "url", "username", "password", "note"])
    )
      throw Error(
        "Expected Google Passwords CSV columns: name, url, username, password, note",
      );
    if (rows.length > 5000) throw Error("Too many records");
    rows.forEach((r, i) =>
      add(i + 2, () => {
        if (r.length !== 5) throw Error("Malformed columns");
        return passwordSchema.parse({
          ...common(),
          type: "password",
          name: r[0],
          url: r[1],
          username: r[2],
          password: r[3],
          notes: r[4],
        });
      }),
    );
  }
  const merged = mergeRecords(existing, records, policy);
  return {
    format,
    records,
    valid: records.length,
    invalid: errors.length,
    errors,
    duplicates: merged.duplicates,
    new: merged.added,
    updated: merged.updated,
  };
}
