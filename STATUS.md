# Status — 2026-11-01

## Implemented

- Production Neon/PostgreSQL coordinator: pre-seeded singleton, row locking across instances, encrypted state, durable auth/session generation and throttling, no automatic transaction-body replay, explicit fail-closed errors.
- Outbox claim → remote immutable effect → fenced receipt; expiring leases, idempotent mutations, monotonic authoritative published reference, encrypted snapshot upload/publication/private-delivery statuses, advisory pins, bounded pending jobs/ciphertext cache and retained channel history.
- Production environment validation, real database health check, signed Telegram sender/Mini App authorization, server-side logout/expiry, rebind/recovery revocation and old callback rejection.
- Existing password/TOTP UI, import/preview/duplicate/link/restore/encryption/offline recovery modules retained. Four complete bot command files and copy-ready BOTS_BUSINESS_COMMANDS.md.
- Exact Bengali operator checklist SETUP_BN.md, SQL migration, environment example, Vercel daily authenticated worker, migration and read-only Telegram diagnostics scripts.

## Executed tests

- `npm run check`: TypeScript/build plus **27 passing unit/mocked integration tests**.
- `TEST_DATABASE_URL=<disposable local PostgreSQL> npm run test:postgres`: **10 passing real PostgreSQL 17 integration tests**, separate connections and mocked Telegram. Covers concurrent setup/save, same-request retries, cold-start logout/expiry/throttling, rebind/old callbacks, upload-then-manifest failure, private-delivery failure, expired worker rejection after a newer revision, generation-fenced pending delivery, wrong keys/missing/unavailable state and signed-initData HTTP production flows.
- `npm run test:ui`: real Chromium mobile UI with **explicit local Telegram simulation**; setup/ack/add/reveal/edit/backup/lock/login/layout and recovery with networking disabled after page loading. File:// was blocked by this environment; a local-file launch is not claimed verified.

## Sources and cost

Selected **Neon PostgreSQL Free**, no card: currently $0, 100 CU-hours/month/project, 1 GB DB storage/project and 5 GB public transfer. Optional Launch is usage-priced, not authorized/provisioned. Free quota exhaustion can suspend/fail operations; stay on Free and monitor Console usage. Official pricing/plans, PostgreSQL/node-postgres transaction/TLS docs, Telegram Bot API/Mini Apps/ID conversion and Vercel limits/cron docs were read. BB references were read from its official documentation repository. Full references and trust model are in ARCHITECTURE.md.

## Operator steps still required / not tested live

- Create the user's Neon Free project, run sql/001-coordinator.sql and privately configure DATABASE_URL + other Vercel variables.
- Install four Bots.Business commands and bot-scoped String properties; add bot to private channel with Post/Edit rights; configure BotFather menu.
- Redeploy on Vercel, confirm /api health, initialize inside Telegram, save/ack recovery key and run synthetic import/backup/new-account rebind/expiry acceptance checks.
- Actual Neon cloud TLS/pooling, BB exact-byte forwarding, live Telegram permissions/uploads/manifests/private delivery, real Mini App clients and Vercel cron remain unverified. The user's live URL could not be accessed from the tools.

No paid service/cloud project was provisioned, production secret requested in chat, or bot webhook changed. Production adapter is implemented and locally tested; this is not a claim that the user's live service is already operational.
