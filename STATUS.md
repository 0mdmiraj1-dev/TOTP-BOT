# Delivery status

## Completed

- TypeScript vault service; exactly one initialized account; recovery acknowledgement; independent vault UUID and one active numeric Telegram binding.
- Authenticated encryption, password/recovery wrappers, self-contained backups; masked listing, reveal, CRUD, favorites, search, hostname grouping, pagination and TOTP refresh.
- CSV/OneCloud/otpauth import parsing, validation, preview, duplicate policies and one-revision bulk commit; explicit manual password/2FA links.
- Durable single-machine local development coordinator, session revocation/generation, throttling, idempotency, partial-failure publication/delivery state and explicit retries.
- Telegram API transport and signed pin/file discovery; Bots.Business native commands with authenticated sender provenance; HTTPS sensitive forms.
- Dark mobile web UI; offline browser recovery and hidden-input Node.js recovery CLI; Vercel configuration and exact operator instructions.
- Fail-closed Vercel mode. No hidden database or production bypass.

## Tested here

`npm run check`: TypeScript build plus **26 passing tests** (unit and mocked integration). Covers SHA1/SHA256/SHA512 RFC vectors, boundary/leading-zero behavior, CSV multiline/BOM/malformed limits, OneCloud validation/defaults, duplicate policies, wrong password/recovery key, tampering/schema rejection, setup gate, unauthorized access, throttle, logout/expiry, rebind/generation, password recovery, idempotent/concurrent saves, publication failure after upload, delivery failure, restore identity isolation, encrypted local cold-start state/process exclusivity, HMAC/freshness, opaque stale callbacks, HTTP fail-closed behavior, Telegram adapter failure handling and CLI recovery without old environment.

`npm run test:ui`: real headless Chromium, mobile viewport, synthetic local account and **explicit simulated Telegram transport**. Setup/acknowledgement, add/reveal/edit preserving password, encrypted backup download, lock/login, responsive overflow check, and browser recovery after disabling networking. No browser page errors in this smoke flow. The environment blocks file:// navigation; a direct double-click/file:// launch was not verified.

## Untested / documentation gaps

- No live Telegram, Bots.Business, OneCloud-exporter or Vercel integration; no deployment occurred. No webhook was changed.
- Official Bots.Business docs were read from its official GitHub repository. Official Telegram Bot API and Vercel implementation/runtime references were read from their repositories. Hosted official Telegram Mini Apps documentation and current Vercel platform/plan limits could not be read because network policy denied access and the web tool failed. Their current capabilities are not claimed verified.
- Real Mini App initData/launch interoperability, Bots.Business property installation/runtime context, HMAC exact-byte forwarding, Telegram channel privileges and pin discovery require live verification with synthetic data.
- Browser copy/clipboard permissions, every accessibility combination, native Telegram client variants and large-vault performance were not exhaustively tested. The UI smoke is not a penetration test or crypto audit.

## Blocked

Production setup, login, reads, mutation and server-side logout/revocation stay disabled because the requested stack has no verified durable serialization/security-state component. Merely deploying this code will not produce an operational production vault. The channel remains the encrypted snapshot/history store, but a durable transactional coordinator is required for safe ordering and security state. A production adapter and its crash/fencing/distributed tests are not implemented pending that architecture decision.

The single architecture question: **May a small durable transactional coordinator be added for serialized security state and publication jobs, while keeping encrypted vault snapshots/history in Telegram?**
