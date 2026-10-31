# Still — personal Password + TOTP Vault

A Node.js/TypeScript backend, mobile web vault, native Bots.Business menus, encrypted Telegram channel snapshots, portable encrypted backups, and offline recovery tools.

**Status: experimental channel storage; production authentication and writes are disabled.** The requested platforms do not supply a verified atomic durable coordinator for account initialization, mutation ordering, revocation, throttling, replay protection, and publication jobs. No database has been added. A functional single-process **local development** implementation and independently usable recovery tools are provided. This is not a production-ready password manager. See [ARCHITECTURE.md](ARCHITECTURE.md) for the exact blocker, verified sources, and remaining documentation gaps.

## Requirements and checks

Node.js 22+ and npm. Tested here with Node.js 24.19.0. Use synthetic credentials for development.

```sh
npm ci
npm run check
```

`check` type-checks, builds both interfaces and the recovery CLI, and runs unit/mocked integration tests. Browser verification additionally needs Chromium at `/usr/bin/chromium`:

```sh
npm run test:ui
```

No Telegram, Bots.Business, Vercel credentials, or external services are needed for these tests. `STATUS.md` separates tested behavior from unverified integration.

## Run the working local development vault

1. Copy `.env.example` to `.env`. Generate **three independent** random values for `SERVER_KEY`, `SETUP_TOKEN`, and `BB_FORWARD_SECRET` using `openssl rand -hex 32` for each. Keep the setup token outside Telegram. Never commit `.env`.
2. For synthetic local use set these additional values:

   ```dotenv
   STORAGE_MODE=local-development
   APP_ORIGIN=http://127.0.0.1:3000
   LOCAL_STATE_PATH=work/vault.local
   LOCAL_MOCK_TELEGRAM=true
   ```

   Simulation displays an explicit notice and does not send any Telegram messages or files. To exercise actual Telegram transport locally, remove `LOCAL_MOCK_TELEGRAM` and configure `BOT_TOKEN` and `CHANNEL_ID`. Real calls have not been tested here. If Telegram is not configured, publication fails and subsequent writes stay blocked until the pending publication is resolved.
3. Build and start, loading the environment with Node's dotenv loader:

   ```sh
   npm run build
   node --env-file=.env --import tsx src/local.ts
   ```

4. Open `http://127.0.0.1:3000`. Choose **Initial setup**, enter the setup token, one username, and a unique master passphrase of at least 14 characters and eight distinct characters. Local development uses fixed synthetic Telegram identity `10001`, never a caller-selected identity.
5. Copy/download the newly generated recovery key. Store it separately from backups, outside Telegram. Acknowledge storage to finish initialization. The key is shown once; it is not stored in plaintext and cannot be retrieved later. Setup stays closed even if acknowledgement is pending. Losing the key before acknowledgement cannot be fixed by reopening registration.
6. Add records or import data, download an encrypted backup, and try standalone recovery with synthetic data before relying on the format.

The encrypted local coordinator file is durable only on this machine. A process lease prevents a second server from opening it. Stop with Ctrl-C to release the lease. After a crash, confirm no server process remains, then manually remove only `work/vault.local.lockfile`. Never delete that lease while a server runs. Never run this mode in a cluster, on shared network storage, or in Vercel temporary storage. Losing `SERVER_KEY` loses local security/session state, but a downloaded backup remains recoverable with its recovery key.

## Vercel configuration and blocked deployment

The source includes `api/index.ts` and `vercel.json`: one Node function, static `public/`, a 60-second duration request, no-store responses, restrictive CSP, and `/api/bot` routing. Node support and plan-specific function limits must be checked in the actual Vercel project; current hosted documentation was inaccessible in this environment.

1. Import this repository into Vercel. Select the Other framework preset, Node.js 22 or a supported newer version, build `npm run build`, output `public`. The checked-in configuration defines these commands.
2. Configure environment variables from `.env.example` in Vercel's private settings. Use the exact HTTPS deployment origin in `APP_ORIGIN`, with no trailing slash. Set `STORAGE_MODE=experimental-channel`. Leave local-only settings absent.
3. Deploy using Vercel's dashboard or `npx vercel` after configuring your account. This session **did not deploy** anything and no credentials were supplied. `GET /api` must report `writesEnabled:false`; sensitive operations return 503. Setting `STORAGE_MODE=local-development` cannot bypass that gate in `api/index.ts`.
4. Do not put real vault contents into this deployment. A production coordinator must first be selected, implemented and verified. There is deliberately no unsafe environment switch that enables Telegram-only production writes.

The smallest extra component is a durable transactional coordinator (one personal-vault state row plus a durable job/idempotency ledger is sufficient) with linearizable transactions or single-writer execution and durable fencing. Bulk encrypted documents remain in Telegram. The required interface is `Coordinator.run`; a production adapter also needs bounded external-effect scheduling and recovery as described in the architecture. A stub is not an implementation. No production adapter is bundled.

## Telegram channel and webhook ownership

Use a private bot chat and a **dedicated private channel**. Add the bot as a channel administrator with permission to post, edit its own manifest message, and pin messages. A bot is added to the channel; it does not log in to a channel. Configure the channel's numeric ID as `CHANNEL_ID`. Do not infer ownership from a Telegram username. Only one numeric Telegram sender is actively bound to the independent vault UUID.

Reserve the channel's pinned-message slot for the signed manifest. Do not pin another message above it. Other admin changes, deleted pins/documents, or a missing/invalid manifest require operator recovery, never history scanning or a fallback to an arbitrary old document. The coordinator remains authoritative about intended current revision; the pin advertises completed channel publication. Telegram's Bot API is not a general channel history/search database.

**Bots.Business owns all incoming bot updates.** Do not call `setWebhook`, `deleteWebhook`, or run polling from this backend. This project never changes webhook configuration. Importing into an existing Bots.Business bot can replace commands; export its current commands first. Setting up or migrating a real bot/webhook is an operator action and requires your explicit deployment decision.

## Install Bots.Business commands

1. Review the official repository format and HTTP caveats linked in `ARCHITECTURE.md`. The files in `bots-business/commands/` contain supported `/*CMD ... CMD*/` headers. Copy each command into the Bots.Business editor with **Wait for answer off**, empty Answer and Keyboard, or import `bots-business/` as a separate repository root using the documented Git importer. The monorepo root is not a Bots.Business repository root.
2. Create `/start` (aliases `/home`, `/cancel`), `/vault`, `/vault-response`, and `/vault-error` from those files. No wildcard collects passwords or documents. Imports stay in HTTPS forms.
3. In the private Bots.Business properties/editor, set bot-scoped string properties `vault:origin` to your exact HTTPS origin and `vault:forward_key` to the same independently generated value as `BB_FORWARD_SECRET`. Do not add a public configuration command. No master password, recovery key, DEK, or session bearer belongs in Bots.Business properties.
4. The commands derive sender ID from `tgUpdate.message.from.id` or `tgUpdate.callback_query.from.id`, cross-check the private chat and runtime `user.telegramid`, and sign the exact JSON request bytes with runtime `CryptoJS.HmacSHA256`. Requests have a 60-second freshness window and durable event/callback validation behind the coordinator. Raw Telegram IDs in unauthenticated requests are never accepted.
5. HTTP redirects are disabled. Responses are ignored: current Bots.Business HTTP transport does not verify TLS certificates, so a network attacker could read signed metadata or inject a response. The signing key is not sent. The backend sends menus directly via its TLS-verified Telegram API transport. HMAC prevents changing sender/action; it does not hide traffic metadata or prevent denial of service. There is no transmission of vault secrets over Bots.Business HTTP.
6. Native menus include Home/Back, paging, explicit code disclosure and refresh, lock, and HTTPS forms for sensitive actions. Native search/add/import/edit/delete use Open Vault forms. Secrets never appear in callback data. Callbacks are opaque, one-use, short-lived, and bound to the current session hash and authentication generation.

## Configure the Mini App

After a production coordinator is available, configure the bot's Mini App/menu button in BotFather to your HTTPS root. Native backend menus use private-chat `web_app` inline buttons. Telegram's launch fragment `tgWebAppData` is read once, removed from browser history, and sent in a request header, never `initDataUnsafe`. The backend validates HMAC, unique fields, numeric sender, and freshness (5 minutes with 30 seconds clock skew). Reopen the Mini App when launch authorization expires. The launch protocol implementation still requires live verification against current Telegram docs/clients; no SDK or third-party analytics are loaded.

Session tokens exist only in page memory. Reloading requires login. Browser security policy allows only bundled assets and same-origin connections. No external favicon requests disclose stored domains.

## Import formats and preview

Choose **Import**, upload, pick Skip / Update / Keep Both, and select **Validate & preview**. Confirm before committing. File/policy changes invalidate the preview. The server validates again inside the revision-checked transaction. Invalid row reasons do not echo input values. A bulk import makes one revision and one backup job.

- Google Passwords CSV requires `name,url,username,password,note` in that order. `csv-parse` supports BOM, quoted commas/newlines and empty fields. Bad column counts are invalid rows; malformed quoting rejects the file. Input limit: 1 MiB, 5,000 rows, 40,000-character CSV record, plus per-field limits.
- OneCloud JSON accepts `v:1` (or `"1"`), nonempty `app`, and `accounts`. Each account accepts issuer, account_name, secret, algorithm, digits, period and optional `type:"totp"`. Unsupported versions/fields are rejected. Base32 is canonicalized/validated. Algorithms: SHA1/SHA256/SHA512; digits: 6/8; period: integer 15–120 seconds. Missing algorithm/digits/period default to SHA1/6/30 in this project's v1 adapter. Existing parameters are preserved. Verify your particular exporter uses this v1 schema; no live OneCloud export was available.
- Manual Base32 entry and `otpauth://totp` URIs are supported. HOTP is explicitly unsupported.

Duplicates compare password normalized hostname + exact username, or TOTP case-normalized issuer + account. Different significant subdomains and different domains stay separate; `www.` is normalized. Keep Both assigns new UUIDs. Records never link automatically; select an explicit linked password in the 2FA editor.

## Save, delivery and retry

The local transaction first saves the encrypted current revision and a pending job. Each completed remote stage is persisted separately: document upload → manifest edit/create and pin → private-chat encrypted backup. A successful upload is not a successful publication. The UI shows **Vault saved**, **Channel pending/failed/published**, and **Private backup pending/failed/delivered** separately.

A pending channel publication blocks another write. Private delivery failure does not roll back a saved/published vault. Select **Retry backup** to resume. Each request awaits at most three persisted stages; Telegram calls have eight-second timeouts. There is no detached work, permanent timer, or dependence on Vercel running after response. A future production implementation needs a durable scheduler for unattended retries; the current implementation retries only on an explicit request. A timeout/crash after a remote side effect but before recording its result can create duplicate Telegram documents/messages; Telegram offers no general idempotency key for these sends. Snapshot history is retained, including orphan uploads. No garbage collection silently removes backups.

## Recovery and disaster recovery

**A. Lost personal Telegram account, bot/channel still available:** open the Mini App with the replacement account, choose Rebind, enter vault username, master password and recovery key, then explicitly confirm revocation. Vault UUID and records remain. Authentication generation increments; old sessions and pending callback actions become invalid. Ordinary login cannot rebind. For a forgotten master password use the distinct Forgot password flow: username + recovery key + a new master password + revocation confirmation. This rewrites the password wrapper, saves a new encrypted revision, and revokes sessions.

**B. Bot/channel/Telegram unavailable:** use a downloaded encrypted backup and recovery key. Neither method below requires Telegram initData, a bot token, the old Vercel environment or its server key.

Browser recovery:

1. Preserve `public/recovery.html`, `public/recovery.js` (generated by build), and `public/style.css` together before a disaster. The source delivery includes the generated files.
2. Open `recovery.html` locally using a browser supporting Web Crypto in local files, select the backup and enter the recovery key. Decryption and schema validation happen only on the device; the recovery script contains no network requests. This environment's managed Chromium blocks file URLs; recovery was instead tested after static assets loaded, with networking disabled.
3. Preview counts and download recovered plaintext JSON. The download link expires after one minute. Keep exports secure. Browsers that disallow local Web Crypto can use the CLI below, or serve these static files on loopback without internet.

CLI recovery (install dependencies before going offline):

```sh
npm ci
npm run recover -- /path/to/vault.encrypted.json /path/to/recovered.json
```

The CLI prompts for a hidden recovery key in a terminal, never an argument or URL. For automation, pipe a protected key file into stdin. It creates the output exclusively with mode 0600 and refuses to overwrite an existing file. The output contains plaintext passwords and TOTP seeds. Keep it secure, then remove it when no longer needed. All recovery credentials/data exist transiently in process memory; JavaScript cannot guarantee complete memory erasure.

To move to a new deployment, initialize a fresh vault/binding there once reliable storage is available, then use Backup & restore with the old downloaded encrypted backup and its recovery key. Authenticate and preview, choose Merge or Replace, explicitly confirm. Only records are imported: old usernames, bindings, sessions and callback actions never revive. Current Telegram snapshots provide pre-restore history where publication succeeded.

A file that exists **only in Telegram is not an independent local backup**. Store regular downloaded copies and the recovery tools in another place. Logout cannot delete files already downloaded, clipboard contents, or previously delivered Telegram messages. Native-chat TOTP disclosure is explicit and can remain in history; password reveal/copy occurs in the web UI.
