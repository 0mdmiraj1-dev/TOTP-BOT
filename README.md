# Still — personal Password + TOTP Vault

A personal single-account vault with a TypeScript/Vercel backend, compact dark web interface, Bots.Business native menus, encrypted Telegram channel snapshots/history and independent offline recovery.

**Start here: [বাংলা exact setup checklist](SETUP_BN.md).** Target origin: `https://totpbot.vercel.app`. Complete bot code: [BOTS_BUSINESS_COMMANDS.md](BOTS_BUSINESS_COMMANDS.md). Design/source verification: [ARCHITECTURE.md](ARCHITECTURE.md). Executed checks and remaining operator work: [STATUS.md](STATUS.md).

## Production coordinator

Production uses **Neon PostgreSQL Free** (or compatible PostgreSQL) as a small durable coordinator. Encrypted channel snapshots remain in Telegram; Neon stores encrypted security state, sessions/revocation, throttling, request IDs, authoritative published references, bounded pending jobs and a latest encrypted snapshot cache. No plaintext records or recovery keys are stored there. Completed historical ciphertext remains in Telegram; its references stay in the coordinator.

The adapter uses a pre-seeded singleton row and `SELECT ... FOR UPDATE` to serialize independent instances. It does not rely on process memory, Telegram pins or revision checks alone. Network effects are outside SQL transactions, with durable claim tokens and fenced receipts. Immutable manifests prevent a stale worker overwriting a newer revision. Pins are advisory and validated against the durable reference. The server remains fail-closed when config, schema, row, key or database availability is wrong.

No cloud project, paid service or webhook was provisioned/changed by this implementation. Actual Neon/Vercel/Telegram installation is still an operator step. **Production adapter implemented and locally tested is not a claim of live deployment success.**

## Requirements and tests

Node.js 22+ and npm. Tested with Node.js 24.19.0. Synthetic credentials only in tests.

```sh
npm ci
npm run check
npm run test:ui
```

`check` runs TypeScript, builds static assets and recovery CLI, and runs 27 unit/mocked integration tests. `test:ui` uses Chromium at `/usr/bin/chromium` (change the smoke script path for another installation) and explicitly simulates Telegram. It covers setup/ack, CRUD/reveal/edit, backup download, lock/login, mobile layout and browser recovery with networking disabled after assets loaded.

Ten additional tests use **real PostgreSQL**, separate database connections and mocked Telegram transport. They deliberately reset the coordinator table; use a disposable local database only:

```sh
docker run --rm -d --name vault-pg-test \
  -e POSTGRES_PASSWORD=synthetic-integration-only \
  -e POSTGRES_DB=vault_test -p 127.0.0.1:55432:5432 postgres:17-alpine
# Wait until pg_isready succeeds in the container.
TEST_DATABASE_URL=postgresql://postgres:synthetic-integration-only@127.0.0.1:55432/vault_test npm run test:postgres
docker stop vault-pg-test
```

The integration constructor permits plaintext PostgreSQL only for explicit loopback tests. Production always verifies TLS certificates and hostnames; no environment toggle disables TLS. Tests cover concurrency, setup closure, idempotency, cold start, throttling, logout/expiry/rebind, partial remote failures, expired worker fencing, immutable publication and authenticated HTTP routes. They do not connect to Neon/Telegram/Vercel.

## Minimal production setup

1. Create a **Neon Free** project and run [sql/001-coordinator.sql](sql/001-coordinator.sql) in its SQL Editor. Copy a pooled connection URL from Connect.
2. Set the private Vercel variables in `.env.example`: `STORAGE_MODE=postgres`, `DATABASE_URL`, `APP_ORIGIN`, `BOT_TOKEN`, `CHANNEL_ID`, `SERVER_KEY`, `SETUP_TOKEN`, `BB_FORWARD_SECRET`, `CRON_SECRET`, `SESSION_IDLE_SECONDS`. Generate each of the four hex secrets independently using `openssl rand -hex 32`.
3. Install the four Bots.Business commands and the two bot-scoped String properties from the Bengali checklist. Keep Bots.Business as the bot update/webhook owner.
4. Add the same bot as admin to a dedicated private channel (Post Messages + Edit Messages). Configure BotFather menu URL to the HTTPS root.
5. Redeploy the latest source. `GET /api` checks the configured database and must report `mode:postgres`, `writesEnabled:true`. Wrong/missing state fails 503 rather than resetting registration.
6. Inside Telegram use `/start` → Open Vault → `https://totpbot.vercel.app/?view=setup`; enter the private setup token, create one username/password, save the recovery key and acknowledge. The plain browser URL alone lacks Telegram initData.
7. Run the synthetic import/backup/rebind/expiry acceptance checklist before importing actual credentials.

`vercel.json` builds `public`, configures a 60-second Node function, no-store/security headers, `/api/bot` forwarding and an authenticated `/api/worker` daily cron. The cron is at 03:00 UTC (about 09:00 Asia/Dhaka, within Hobby's hourly scheduling window). Saves try immediate delivery; Retry backup resumes immediately. A daily cron is only the unattended fallback. Each invocation awaits up to three persisted stages and starts no further stage once its time budget expires; no detached promises continue after response. Worker invocations require `Authorization: Bearer CRON_SECRET`; Vercel supplies that header.

## Local synthetic development

Do not use local storage on Vercel. On one persistent machine, configure a private `.env`:

```dotenv
STORAGE_MODE=local-development
APP_ORIGIN=http://127.0.0.1:3000
SERVER_KEY=YOUR_64_RANDOM_HEX_CHARACTERS
SETUP_TOKEN=YOUR_SEPARATE_64_RANDOM_HEX_CHARACTERS
LOCAL_STATE_PATH=work/vault.local
LOCAL_MOCK_TELEGRAM=true
SESSION_IDLE_SECONDS=600
```

```sh
npm run build
node --env-file=.env --import tsx src/local.ts
```

Open `http://127.0.0.1:3000`. Local mode uses fixed synthetic actor `10001` and shows a simulation notice; no Telegram messages/files are sent. The encrypted local state has a single-process file lease and fsync/atomic rename. Stop cleanly to release the lease. After a crash, verify no process runs before manually removing `work/vault.local.lockfile`. Do not use this mode on shared storage/in a cluster. `api/index.ts` cannot select it.

## Import and record semantics

- Google Passwords CSV: exact header `name,url,username,password,note`, BOM, quoted multiline/comma fields and empty optionals. Malformed rows are counted with sanitized reasons; malformed quoting rejects the file. Max 1 MiB/5000 rows and 40000-character CSV record, with bounded fields.
- OneCloud v1 adapter: root `v:1` or `"1"`, `app`, `accounts`. Each account supports `issuer`, `account_name`, Base32 `secret`, `algorithm`, `digits`, `period`, optional `type:totp`. SHA1/SHA256/SHA512; 6/8 digits; 15–120 seconds; missing parameters default to SHA1/6/30 in this adapter. Unsupported versions/fields/HOTP are rejected. No real exporter was supplied; confirm your export matches this schema before relying on it.
- Manual Base32 and otpauth TOTP URI entry are supported. No HOTP.
- Upload → detect/validate → preview counts/errors/duplicates/new/updated → Skip/Update/Keep Both → confirm → one revision and one backup job. The server validates again under serialization.
- Password duplicates use normalized hostname + exact username; TOTP duplicates use case-normalized issuer/account. Meaningful subdomains/domains stay distinct; www is normalized. No automatic password/2FA name linking. Explicit links survive restore-merge UUID remapping; deletion removes orphan links.

## Backup, restore and recovery

Backups use random 256-bit DEKs, AES-GCM, scrypt password wrapping and a separate random recovery-key wrapper. They are self-contained. The backend receives passwords and decrypts during authorized requests; **this is not zero-knowledge**. Key material between requests is wrapped under SERVER_KEY; session hashes/generation and expiry are checked server-side every time.

The transaction saves the intended revision + outbox first; document upload, immutable signed manifest publication, and private encrypted backup delivery have separate persisted status. A failed channel publication blocks the next mutation; private delivery failure stays independent. Retry uses durable stage ownership. Network ambiguity can duplicate encrypted sends/manifests; there is no exactly-once claim. Fenced late receipts cannot regress the published pointer or resurrect a binding. A Telegram message/file already in flight may still arrive; logout cannot erase delivered history, downloads or clipboard contents.

Download an encrypted backup outside Telegram using Backup & restore. A file only in Telegram is **not** an independent backup. Keep the recovery key separately. Browser offline recovery requires `public/recovery.html`, `recovery.js`, `style.css` together; it authenticates/decrypts locally and exports validated plaintext JSON without networking. Local file navigation was blocked in the managed test browser, so its recovery was tested after static loading with networking disabled. Browser policy permitting local Web Crypto is required; otherwise use the CLI:

```sh
npm ci # do this before going offline
npm run recover -- /path/vault.encrypted.json /path/recovered.json
```

The terminal prompt hides the recovery key; automation can supply a protected key file through stdin. The CLI never takes a key in argv/URLs and creates output exclusively with mode 0600. Export contains plaintext credentials; protect it and remove it after use.

Account lost but Telegram/bot available: new account Starts the same bot, then uses Rebind with username/master password/recovery key and explicit old binding/session revocation. Forgotten password is a separate recovery-key + new-password flow. Telegram/database unavailable: use a downloaded backup offline, or initialize a new deployment/vault and use authenticated preview → Merge/Replace → confirm. Restore copies records, not old identity/bindings/sessions. Download current backup before Replace; old channel documents remain as history.

Do not reset/reseed live coordinator state, silently restore an old database row, rotate SERVER_KEY without a migration, or point Preview deployments at the production state. Wrong keys/database outage fail closed; downloaded backups remain recoverable without the old environment.
