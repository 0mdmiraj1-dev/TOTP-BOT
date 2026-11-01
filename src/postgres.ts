import { Pool, type PoolConfig } from "pg";
import { seal, open, type Box } from "./crypto.js";
import { Fault, requireThat } from "./model.js";
import { empty, type Coordinator, type State } from "./store.js";

export function postgresConfig(
  connectionString: string,
  localTest = false,
): PoolConfig {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Fault(503, "Invalid coordinator configuration");
  }
  requireThat(
    ["postgres:", "postgresql:"].includes(url.protocol),
    503,
    "Invalid coordinator configuration",
  );
  // URL sslmode parameters can override node-postgres's explicit TLS object.
  // Always verify the certificate and hostname in production, even if the copied
  // Neon connection URL says sslmode=require.
  for (const name of [
    "sslmode",
    "sslcert",
    "sslkey",
    "sslrootcert",
    "uselibpqcompat",
    "ssl",
  ])
    url.searchParams.delete(name);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  requireThat(
    !localTest || loopback,
    503,
    "Plaintext PostgreSQL is limited to local integration tests",
  );
  return {
    connectionString: url.toString(),
    ssl: localTest ? false : { rejectUnauthorized: true },
    max: 2,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 10000,
    allowExitOnIdle: true,
  };
}

export class PostgresCoordinator implements Coordinator {
  readonly pool: Pool;
  constructor(
    connectionString: string,
    private key: Buffer,
    localTest = false,
  ) {
    requireThat(key.length === 32, 503, "Invalid coordinator key");
    this.pool = new Pool(postgresConfig(connectionString, localTest));
    // Never print database URLs/driver error objects (they may contain credentials).
    this.pool.on("error", () => {});
  }
  async close() {
    await this.pool.end();
  }
  async run<T>(fn: (s: State) => Promise<T> | T): Promise<T> {
    let client;
    let began = false;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      began = true;
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '8s'");
      await client.query(
        "SET LOCAL idle_in_transaction_session_timeout = '15s'",
      );
      const row = await client.query<{
        schema_version: number;
        version: string;
        sealed_state: Box | null;
      }>(
        "SELECT schema_version, version, sealed_state FROM public.vault_coordinator WHERE singleton = 1 FOR UPDATE",
      );
      requireThat(
        row.rows.length === 1 && row.rows[0].schema_version === 1,
        503,
        "Coordinator not initialized; run the SQL migration",
      );
      const box = row.rows[0].sealed_state;
      requireThat(
        box !== null || row.rows[0].version === "0",
        503,
        "Coordinator state is unexpectedly missing; registration remains closed",
      );
      // Corruption/wrong key is fatal. Never fall back to an empty vault.
      const state = box
        ? open<State>(this.key, box, "postgres-coordinator-v1")
        : empty();
      requireThat(
        Array.isArray(state.jobs) && !!state.sessions && !!state.idempotency,
        503,
        "Coordinator state is invalid",
      );
      let value: T | undefined, rejected: Fault | undefined;
      try {
        value = await fn(state);
      } catch (error) {
        // Expected application rejections must durably consume auth attempts.
        // Unexpected failures roll back; callbacks never run a second time.
        if (!(error instanceof Fault)) throw error;
        rejected = error;
      }
      const encoded = JSON.stringify(
        seal(this.key, state, "postgres-coordinator-v1"),
      );
      requireThat(
        Buffer.byteLength(encoded) <= 24000000,
        507,
        "Coordinator capacity reached; resolve pending deliveries",
      );
      await client.query(
        "UPDATE public.vault_coordinator SET sealed_state=$1::jsonb, version=version+1, updated_at=clock_timestamp() WHERE singleton=1",
        [encoded],
      );
      await client.query("COMMIT");
      began = false;
      if (rejected) throw rejected;
      return value as T;
    } catch (error) {
      if (client && began) {
        try {
          await client.query("ROLLBACK");
        } catch {}
      }
      if (error instanceof Fault) throw error;
      // A connection loss while committing has an ambiguous result. Do not
      // automatically replay fn; clients retry mutations with the SAME request ID.
      throw new Fault(
        503,
        "Coordinator unavailable or transaction outcome unknown; retry the same request safely",
      );
    } finally {
      client?.release();
    }
  }
}
