# Architecture, feasibility and trust model

Review date: 2026-10-31 (client timezone Asia/Dhaka). This document distinguishes source verification, inferred constraints, implementation choices and tests. No hosted integration or deployment is claimed.

## Decision and blocker

Telegram-only production storage is **experimental and disabled**. The missing guarantee is a durable, globally serialized transaction encompassing account initialization, generation/revocation, login-attempt counters, session authorization, mutation idempotency, intended revision and publication job state. Telegram document sends, message edits, and pins are independent remote operations; none is used as atomic compare-and-swap. Bots.Business's own documentation explicitly warns that simultaneous property read-modify-write operations can observe the same old value. Neither a local in-memory mutex nor a revision equality check coordinates separate Vercel instances.

One human can make concurrent requests from tabs, callbacks, retries, timeouts and devices. This is a correctness/security requirement even for one account.

The smallest additional component is a **durable transactional coordinator** holding a small encrypted security/state record and persistent outbox/idempotency ledger, with linearizable serialization or single-writer durable execution plus fencing. Telegram retains encrypted snapshots and history; the coordinator holds the authoritative intended revision and pending work. No Supabase, Firebase, Redis or other database is introduced. The `DisabledCoordinator` is the only runtime adapter selected by the Vercel entry point, regardless of environment switches. All protected actions, including login/logout/setup, fail 503 before accepting a production session.

The local development adapter demonstrates the complete operation flows on one persistent machine: a process-exclusive file lease, one serialized queue, authenticated-encrypted JSON state, file fsync, atomic rename and directory fsync. **Its queue is not a distributed mutex. Its lease is not a Vercel lock.** It is never selected by `api/index.ts`. TestCoordinator is explicitly test-only. A production coordinator adapter is intentionally absent rather than represented by a placeholder that pretends to work.

## Official sources actually read

Direct HTTPS fetches of help.bots.business, core.telegram.org and vercel.com were rejected by the environment proxy (403 CONNECT denial). The connected web tool returned errors. We did not bypass that policy. Official GitHub sources were accessible, so they were fetched and read at these revisions:

| Platform/source | Verified content | Limits of verification |
| --- | --- | --- |
| [Bots.Business official documentation repository](https://github.com/bots-business/help/tree/55fad10df874fbecd68c8ffee282bb1e8d589ff5) | HTTP, runtime context, properties, inline callbacks, file handling, Mini App hosting, CryptoJS, Git repository format | Documents, not a live account test |
| [Telegram official Bot API server](https://github.com/tdlib/telegram-bot-api/tree/e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1) | README and `telegram-bot-api/Client.cpp`, `Client.h`: method dispatch, getChat pinned_message, sendDocument, editMessageText, pinChatMessage, getFile, webhook methods, cloud download cap | Official implementation source; hosted Bot API docs and Mini App protocol docs could not be read |
| [Vercel official source](https://github.com/vercel/vercel/tree/84878e532142f0ac584953695658b324eb9e5b80) | README, runtime developer reference, Node build/dev/serverless handler/awaiter source; maxDuration configuration and explicit awaited lifecycle handling | Not verification of hosted account request limits or current plan maximum execution duration |

These source commits describe what was observed, not a promise about future runtime releases. Official hosted references requiring a follow-up review before production: [Telegram Bot API](https://core.telegram.org/bots/api), [Mini Apps authorization](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app), [Vercel function limits](https://vercel.com/docs/functions/limitations), [Vercel duration](https://vercel.com/docs/functions/configuring-functions/duration), [Vercel concurrency](https://vercel.com/docs/functions/concurrency-scaling). Current plan-specific request ceilings and Mini App launch-client compatibility remain **unverified**, not silently assumed to have been documented/tested.

### Bots.Business capabilities and constraints

Read the official [HTTP reference](https://github.com/bots-business/help/blob/55fad10df874fbecd68c8ffee282bb1e8d589ff5/bjs/http.md), [context](https://github.com/bots-business/help/blob/55fad10df874fbecd68c8ffee282bb1e8d589ff5/bjs/context.md), [properties](https://github.com/bots-business/help/blob/55fad10df874fbecd68c8ffee282bb1e8d589ff5/bjs/user-properties.md), [inline buttons](https://github.com/bots-business/help/blob/55fad10df874fbecd68c8ffee282bb1e8d589ff5/bjs/inline.md), [media handling](https://github.com/bots-business/help/blob/55fad10df874fbecd68c8ffee282bb1e8d589ff5/guides/send-media.md), [Mini App guide](https://github.com/bots-business/help/blob/55fad10df874fbecd68c8ffee282bb1e8d589ff5/guides/mini-app.md), and [CryptoJS examples](https://github.com/bots-business/help/blob/55fad10df874fbecd68c8ffee282bb1e8d589ff5/libraries/utilities.md).

- HTTP.post supports headers, string/object bodies and separate success/error commands. Responses are `content`, with status in `http_status`; HTTP errors can arrive through success. HTTP actions are not synchronous JavaScript return values. The documented per-network-call timeout is five seconds, and the documented redirect option is spelled `folow_redirects`.
- **The current HTTP transport does not validate HTTPS server certificates.** Passing a bearer forwarding credential in a request header would disclose it to an active network intermediary. This project instead sends an HMAC over exact payload bytes; the HMAC secret itself is never sent. No private records or unlock credentials travel in these requests. Response bodies are ignored entirely. This gives authenticity, not confidentiality, availability or exactly-once delivery.
- `user.telegramid` is a Telegram ID; `user.id` is a Bots.Business internal ID. Original Telegram context can be available as `tgUpdate`. The commands require it and cross-check sender/chat/private context. `/start` payloads, params, request bodies and Telegram usernames are not owner identity.
- Callback data dispatches commands and is constrained to 1–64 bytes. The bot passes `/vault ` plus a 32-character random identifier, never record IDs, labels, secrets or session tokens. The backend binds identifiers to actor, session hash, generation and five-minute expiry. Telegram message IDs are navigation targets, not authorization.
- Properties persist simple values but do not supply the required atomic transaction guarantee. The docs describe lookup-cache caveats and explicitly reject assuming ordinary read-modify-write atomicity. They cannot safely serialize this vault or implement its security counters.
- Receiving documents provides file_id, not local bytes. Api.sendDocument accepts supported file IDs/URLs; a local path is not a Telegram upload. The project imports sensitive files through HTTPS forms, avoiding credential uploads into chat. Encrypted backup delivery uses backend multipart upload.
- BJS has no general Node process, require, Promises, or permanent timers. Native commands are small routing/navigation code. Sensitive forms are externally hosted; the current BB Web App renderer is JSON-only, not an HTML host.

### Telegram capabilities and constraints

The official dispatch table exposes getChat, getFile, sendDocument, editMessageText, pinChatMessage and webhook methods. getChat's full object can contain pinned_message; getFile resolves file_id into a downloadable path. The inspected cloud implementation caps downloads at `20 << 20` bytes. This project uses stricter limits and does not deploy a local Bot API server. No claim is made about unverified hosted upload ceilings.

There is no general-purpose channel history/search method used here. The server source may contain internal TDLib history operations; their existence does not make a bot token a general Telegram history database. We depend only on a dedicated discoverable pin and stored file references. A bot must be added as an administrator with channel posting/pinning rights; there is no channel login.

Webhook ownership stays entirely with Bots.Business. Backend Telegram API calls send messages/files but never install/delete a webhook or poll updates. A real bot's webhook was not changed.

Mini App initData validation is implemented using the documented HMAC construction familiar to the protocol, freshness checking and signed user fields, and is tested against synthetic signatures. Because the current hosted Telegram Mini Apps documentation was inaccessible, **that protocol's current hosted documentation and real launch-data flow are not claimed verified**. The page reads signed tgWebAppData from the launch fragment; it does not use initDataUnsafe or require third-party remote scripts. This path requires a real-client smoke test before production.

### Vercel capabilities and constraints

The official source reads maxDuration, constructs Node serverless handlers, and explicitly awaits lifecycle work. This implementation awaits every external effect and persists each stage before returning; it has no fire-and-forget queue. Deployment requests 60 seconds; acceptance depends on actual project/runtime limits. Application-level limits are 3,500,000 bytes per JSON request, 1 MiB import source, under 2,500,000 bytes per encrypted committed snapshot, 5,000 records and bounded fields. Those are **our limits**, not assertions about current Vercel request ceilings. Hosted limits must be checked before deployment.

Vercel runtime memory and temporary files are not treated as persistent state. A fresh function instance has no authority to infer that setup is open or that a session remains valid. All operations fail closed without a coordinator. There is no claimed distributed synchronization via process globals, filesystem locks, a pinned message or expected revision alone.

## Data and encryption

`Backup` v1 is self-contained:

- format and schema;
- random vault UUID independent of usernames/Telegram IDs;
- revision, creation timestamp, preceding encrypted envelope digest;
- per-vault scrypt salt and recorded N=32768, r=8, p=1;
- AES-256-GCM password wrapper of a random 256-bit data key;
- separate AES-256-GCM recovery-key wrapper of that same data key;
- AES-256-GCM encrypted payload containing vault username and validated password/TOTP records.

Password KDF uses Node's scrypt with a per-vault 128-bit random salt and 64 MiB maxmem. Passwords must be 14–256 characters with at least eight distinct characters; a unique random password or long passphrase is recommended. Password-change recovery replaces the salt/wrapper and commits a new revision. The independent 256-bit random recovery key is hex encoded for copy/download, generated once at setup, and never retained in plaintext. It can unlock backups from a different deployment or offline without any server key. A recovery key has full backup decryption power; possession of it and the username also authorizes forgotten-password recovery.

Each encryption draws a fresh 96-bit nonce using Node crypto.randomBytes. GCM uses a 128-bit tag. There is no nonce counter that would reset on a cold start. Random nonce uniqueness is probabilistic; with this personal vault's bounded workload collision risk is negligible. Metadata AAD binds wrappers to vault UUID/schema/purpose; payload AAD also binds revision, timestamp, predecessor digest, KDF parameters and both complete wrappers. Schema validation rejects unexpected format versions and noncanonical Base32. No generated TOTP code is persisted.

Manifest integrity uses an HMAC-SHA256 under the deployment server key plus SHA-256 of the complete encrypted file. The manifest is public metadata inside the private channel: format, vault UUID, schema, revision, creation time, predecessor digest, file ID and document message ID, envelope hash, MAC. It contains no labels, domains, usernames, passwords, TOTP secrets or personal notes. Snapshot filename is always `vault.encrypted.json`; caption includes only encrypted-snapshot description and revision. File sizes and timings can leak approximate activity.

## Actual trust model

This is **not zero-knowledge**. The HTTPS backend receives the master password/recovery key and decrypts records during authorized operations. Trust includes the deployed backend code, Vercel/runtime administrators, server-key storage, trusted endpoint/browser, and Telegram clients when codes or backups are delivered. Malicious backend code can steal credentials. A hostile browser/extension or clipboard manager can capture revealed data. TLS authenticates browser↔backend and Node↔Telegram; Bots.Business's separate HTTP limitation is handled as described above.

Telegram sees encrypted documents, generic captions/manifest metadata and any explicit native-chat TOTP codes. It never receives the master password or recovery key. Bots.Business knows Telegram sender/navigation metadata and the forwarding signing key, which can impersonate navigation provenance if compromised; it cannot authenticate to the vault without an active authorized session, and has no plaintext unlock key. Operator compromise of the backend/server key plus session state can expose unlocked vault keys. Recovery wrappers and payloads remain portable without that server key.

Unlocked key material lives briefly in request buffers. Between requests each session's DEK is wrapped with AES-GCM under SERVER_KEY and AAD bound to actor/generation. Only a SHA-256 digest of the bearer token is stored. The local coordinator encrypts its whole file; it holds no plaintext credentials. Browser bearer tokens live in memory only, not localStorage, URLs, Telegram callback data or BB properties. Idle expiry defaults to 10 minutes; absolute session lifetime is one hour. Logout removes the stored session. Rebind/password recovery increment generation, delete all sessions and callbacks, and check the new binding on every sensitive request. Key buffers are cleared where practical; JavaScript strings, GC and browser CryptoKeys cannot promise secure memory erasure.

Authorization/session checks, expiry refresh and record mutation occur inside the same coordinator transaction. Password/recovery login attempts use a durable **vault-global** five-attempt/15-minute window, independent of caller IP or Telegram account. Username failures count too. This can allow denial of service against a personal vault but prevents creating unlimited counters to bypass throttling. Production currently issues no sessions because those counters cannot be maintained reliably by the selected stack alone.

## Mutation and publication protocol

```mermaid
sequenceDiagram
  participant U as Authorized client
  participant C as Durable coordinator (local development only)
  participant T as Private channel
  participant P as Private bot chat
  U->>C: Authorize + request ID + expected revision + mutation
  C->>C: Serialize; validate; encrypt; save intended revision + outbox
  C->>T: Upload encrypted snapshot
  C->>C: Persist document file/message reference
  C->>T: Create/edit signed manifest and pin
  C->>C: Persist publication completed
  C->>P: Deliver encrypted backup
  C->>C: Persist delivery completed
  C-->>U: Separate save/publication/delivery status
```

The diagram describes implemented local operations, not a claim that the production coordinator exists. The latest intended local revision may be ahead of the channel pin after a publication failure. We report vaultSaved and channel state separately, never an uploaded file as a published channel commit. Further writes are blocked while any channel revision remains unpublished. Private delivery may be pending independently.

The dedicated pin is discoverable with getChat; the adapter verifies its MAC, then resolves getFile and verifies the downloaded envelope hash. Operators must reserve the channel pin. If the pin is missing, inaccessible, replaced or corrupt, discovery fails rather than searching history or choosing the highest untrusted caption. The previous manifest may still be visible during a partial failure. The authoritative intended revision and pending state must remain in the durable coordinator; discovery alone cannot safely reconstruct revocation/session/throttle state. Changing the deployment server key invalidates old manifest signatures but does not prevent recovery-key decryption of downloaded backups.

The serialized local queue holds each network stage while executing, then saves the result. At most three stages are attempted per explicit retry request; calls use eight-second timeouts, with publication consisting of at most two Telegram calls. No success depends on post-response work. Crashes/timeouts after an effect but before recording it are ambiguous: retried sends can duplicate encrypted documents, initial manifest messages or backups. There is no exactly-once claim. Already-modified edit responses are tolerated before retrying the pin. Telegram failure text and URLs containing bot tokens are never logged or returned to the user.

Request idempotency is keyed by session digest + caller request ID and bound to a hash of the exact mutation. Reusing a key for different content is rejected. Repeating the same request yields its previous revision without a second mutation. Different requests with the same expected revision serialize: the first succeeds and the next conflicts. **Serialization provides the safety; the revision check merely detects staleness.** Local development ledgers cap at 10,000 request/event entries and fail closed; they are not silently evicted. Callback state is bounded and expired entries are pruned. History/jobs retain encrypted snapshots by default.

A production adapter cannot simply copy the in-memory queue into a function. It must provide durable ordering/security transactions, an outbox with worker ownership/fencing, bounded external-effect execution across crashes, and no network side effects from transactions that may transparently replay. The current callback-style coordinator assumes one non-replayed executor; a production SQL transaction adapter would require separating job claim/effect/receipt stages rather than retrying a transaction body containing Telegram calls. This design constraint is explicit.

## Recovery and verification boundaries

Restoring copies validated records, never auth/session/binding state from a backup. Replace confirmation is mandatory; Merge retains duplicate records as separate UUIDs. Prior published channel snapshots and encrypted local jobs remain available. The offline browser tool and CLI decrypt/authenticate/validate without contacting Telegram. Recovery output is intentionally plaintext and clearly labelled.

Unit and mocked integration tests cover vectors, parsing, encryption, auth, state transitions and the failure matrix. Chromium tests cover the local synthetic UI and recovery after networking is disabled. Real Bots.Business execution, Telegram permissions/pins/files, real Mini App launches, Vercel deployment limits and distributed production coordination are **not verified**. See STATUS.md for the current executed checks and explicit blockers.
