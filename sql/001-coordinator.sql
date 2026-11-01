-- Run once in the Neon project's SQL Editor. No credentials belong in this file.
-- A singleton row exists BEFORE first signup, so concurrent setup requests lock
-- the same row. Runtime never recreates a missing row/table.
BEGIN;
CREATE TABLE IF NOT EXISTS public.vault_coordinator (
  singleton smallint PRIMARY KEY CHECK (singleton = 1),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  sealed_state jsonb,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (sealed_state IS NULL OR jsonb_typeof(sealed_state) = 'object'),
  CHECK ((version = 0 AND sealed_state IS NULL) OR (version > 0 AND sealed_state IS NOT NULL))
);
INSERT INTO public.vault_coordinator (singleton) VALUES (1) ON CONFLICT DO NOTHING;
REVOKE ALL ON public.vault_coordinator FROM PUBLIC;
COMMIT;
-- Never DELETE/reset this row or restore old database state on a live deployment.
-- Re-running this migration is harmless on an intact database, but not a recovery
-- mechanism for deleted security state. Restore downloaded backups into a NEW vault.
