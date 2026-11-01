import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { postgresConfig } from "../src/postgres.js";
if (!process.env.DATABASE_URL)
  throw Error(
    "Load DATABASE_URL privately; do not put it in command arguments",
  );
let pool: Pool | undefined;
try {
  pool = new Pool(postgresConfig(process.env.DATABASE_URL));
  await pool.query(
    await readFile(
      new URL("../sql/001-coordinator.sql", import.meta.url),
      "utf8",
    ),
  );
  console.log("Coordinator schema initialized; no secret values displayed.");
} catch {
  console.error(
    "Migration failed; check database connectivity and role permissions privately.",
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
