# totpbot.vercel.app — শেষ setup checklist

এই guide repository-এর actual `src/runtime.ts`, `src/http.ts`, `vercel.json` ও Bots.Business command files অনুসারে লেখা। Update date: 2026-11-01, Asia/Dhaka। নিজের production token/key কোনো chat, issue, screenshot বা Git commit-এ দেবেন না।

## আমি কী শেষ করেছি / আপনাকে কী করতে হবে

**কোডে শেষ:** Neon/PostgreSQL coordinator, singleton row locking, encrypted durable security state, durable throttling/logout/expiry/rebinding, idempotent saves, leased/fenced retry worker, immutable Telegram manifests, production configuration gate, daily Vercel cron, setup/rebind entry URLs, চারটি bot command, SQL migration ও read-only Telegram diagnostics।

**পরীক্ষা শেষ:** 27 unit/mocked integration tests; real local PostgreSQL 17-এ 10 integration tests; Chromium mobile + offline recovery smoke। Real PostgreSQL tests আলাদা connections দিয়ে concurrent setup/save, cold-start revocation, expiry, rebind, stale worker এবং signed Telegram initData-সহ HTTP routes পরীক্ষা করে। Telegram calls mocked।

**আপনাকে করতে হবে:** নিজের Neon Free project create, SQL run, private Vercel variables set, Bots.Business commands/properties install, bot/channel permissions ও BotFather menu set, redeploy, নিচের synthetic-data acceptance tests চালানো। আপনার Neon/Vercel/Telegram credentials না থাকায় এগুলোর live success দাবি করা হয়নি। কোনো paid service provision বা webhook change করা হয়নি।

## Service এবং খরচ

নির্বাচিত service: **Neon PostgreSQL, Free plan**। অন্য Firebase/Supabase/Redis লাগে না। Official pricing review অনুযায়ী:

- $0, card লাগে না; প্রতি project-এ 100 CU-hours/month, 1 GB Postgres storage, 5 GB public network transfer। Idle compute 5 মিনিট পর suspend হয়।
- Free quota শেষ হলে compute suspend হতে পারে; storage বাড়ানো operation fail করতে পারে। Data নিজে থেকে delete হয় না। Free plan-এ থাকুন; paid plan/upgrade এই কাজের জন্য চালু করা হয়নি।
- Optional paid Launch usage-based: $0.106/CU-hour, $0.35/GB-month; history/other features-এর আলাদা charges হতে পারে। এগুলো অনুমোদিত নয়, enable করবেন না। Console-এর Organization → Billing এবং project Usage দেখুন।

[Official pricing](https://neon.com/pricing), [plans এবং limits](https://neon.com/docs/introduction/plans)। দাম বদলাতে পারে; project তৈরির সময় Free $0 লেখা আছে নিশ্চিত করুন।

Neon-এ generic row version/schema/update time ছাড়া security state encrypted থাকে: vault UUID, binding/auth generation, session-token hashes ও wrapped DEKs, login-attempt counter, callback/request IDs, current published file/manifest reference এবং pending job leases/receipts। Latest encrypted snapshot cache ও pending encrypted snapshots-ও থাকে—শুধু metadata নয়। পুরোনো completed snapshot ciphertext সেখানে জমতে থাকে না; history references থাকে। Encrypted snapshot/backup files ও immutable manifests private channel-এ থাকে; active private bot chat-এ backup copy যায়। Plaintext password/TOTP/recovery key Neon-এ রাখা হয় না।

## 1. Neon create এবং connect

1. [Neon Console](https://console.neon.tech)-এ account খুলে **Free** plan-এ একটি project বানান, যেমন `personal-vault`। Vercel function-এর কাছাকাছি region বেছে নিন। Default database `neondb` ও default role ব্যবহার করলে setup কম লাগে। Neon Auth, Object Storage, Functions বা paid extras লাগবে না।
2. ওই project-এর **SQL Editor** খুলে repository-এর [`sql/001-coordinator.sql`](sql/001-coordinator.sql)-এর পুরো content paste করে run করুন। Migration কেবল singleton coordinator table ও initial row বানায়; কোনো vault account/password বানায় না।
3. **Connect** → ঠিক project/branch/database/role নির্বাচন → **Connection pooling ON** → connection string copy করুন। Hostname-এ `-pooler` থাকবে। এই পুরো `postgresql://...` value-ই `DATABASE_URL`; `psql '...'` command-টা paste করবেন না।
4. URL শুধু Vercel-এর private variable-এ দিন। Source/BB properties/browser-এ নয়। TLS certificate ও hostname verification backend বাধ্যতামূলক করে; verification বন্ধ করার env switch নেই।
5. Runtime নিজে missing table/row তৈরি করে না। ভুল key, missing row, unavailable/quota-exhausted database হলে setup/login/save fail closed হবে। Live database-এর singleton row delete/reset করবেন না; old database restore করলে revoked sessions ফিরে আসতে পারে। Data restore-এর জন্য vault backup restore flow ব্যবহার করুন।

Optional local migration alternative: private `.env`-এ URL রেখে `node --env-file=.env --import tsx scripts/migrate.ts`। Console SQL Editor সবচেয়ে সহজ; production credentials command arguments-এ দেবেন না।

## 2. Final Vercel environment variables

Vercel → project → **Settings → Environment Variables**। Production scope নির্বাচন করুন। Preview deployment-এ production database/secrets share করবেন না—Preview দরকার হলে আলাদা test database/bot/channel ব্যবহার করুন। সব variables server-side; `NEXT_PUBLIC_` prefix দেবেন না।

| Name | Exact value / কোথা থেকে পাবেন |
|---|---|
| `STORAGE_MODE` | `postgres` |
| `DATABASE_URL` | Neon Connect থেকে copied pooled PostgreSQL connection string |
| `APP_ORIGIN` | `https://totpbot.vercel.app` — শেষে slash নয় |
| `BOT_TOKEN` | BotFather → `/mybots` → আপনার একই bot → API Token; Bots.Business-এ ব্যবহৃত bot-এর token |
| `CHANNEL_ID` | ধাপ 5-এর private channel-এর signed numeric ID, যেমন `-1001234567890` |
| `SERVER_KEY` | নতুন independent 64-character random hex; initialization-এর পর একইটি রাখবেন |
| `SETUP_TOKEN` | আরেকটি independent 64-character random hex; প্রথম setup form-এ লাগবে |
| `BB_FORWARD_SECRET` | আরেকটি independent 64-character random hex; BB-র `vault:forward_key`-এ একই value |
| `CRON_SECRET` | চতুর্থ independent 64-character random hex; Vercel cron Authorization header-এ পাঠাবে |
| `SESSION_IDLE_SECONDS` | `600` = 10 মিনিট; supported 60–3600 seconds, absolute session lifetime 1 hour |

প্রতিটি random value **আলাদাভাবে** নিজের trusted terminal-এ বানান:

```sh
openssl rand -hex 32
```

চারবার চালান; একই value চার জায়গায় reuse করবেন না। `SERVER_KEY` হারালে encrypted coordinator state খুলবে না; downloaded backup + recovery key দিয়ে নতুন deployment-এ restore করতে হবে। এই key হঠাৎ বদলাবেন না। Setup token private রাখুন; initial account তৈরি হলে database state দিয়েই setup permanently বন্ধ থাকে।

Vercel-এ `LOCAL_STATE_PATH`, `LOCAL_MOCK_TELEGRAM`, `TEST_DATABASE_URL` set করবেন না। `local-development` production mode নয়। Variables save করার পর redeploy দরকার।

## 3. Bots.Business-এর চারটি command

সব সম্পূর্ণ code একসঙ্গে: **[BOTS_BUSINESS_COMMANDS.md](BOTS_BUSINESS_COMMANDS.md)**। Original files: [bots-business/commands](bots-business/commands)।

সবচেয়ে সহজ installation:

1. Bots.Business-এ সঠিক bot খুলে **Tools → Make Bot Copy** দিয়ে আগের commands-এর copy রাখুন।
2. Commands editor-এ চারটি command create/edit করুন:
   - `/start` — aliases `/home`, `/cancel` editor-এ দিন;
   - `/vault`;
   - `/vault-response`;
   - `/vault-error`।
3. প্রত্যেকটির **Wait for answer OFF**; Answer ও Keyboard empty। Linked document থেকে প্রতিটির পুরো BJS code paste ও save করুন। `/*CMD ... CMD*/` comment রেখে paste করা যায়; command name ও aliases editor-এও সঠিকভাবে বসাতে হবে।
4. কোনো wildcard password collector, public configuration command বা additional backend webhook লাগবে না।

Git import চাইলে `bots-business/`-এর **contents** আলাদা repository-এর root-এ রাখুন: root `bot.json` এবং `commands/`। ওই আলাদা repo-তে read-only deploy key দিয়ে **Import from Git** করবেন। বর্তমান full-stack `TOTP-BOT` root সরাসরি BB importer-এর জন্য নয়; mobile import default branch নেয়। Git import আগের commands ও libraries replace করে, failure-এও পুরোনো commands মুছে যেতে পারে—copy ছাড়া import করবেন না। Manual চারটি command setup-এ deploy key লাগে না।

## 4. Bot-scoped properties

1. Bots.Business-এ আপনার bot খুলুন → **Properties** tab।
2. Scope controls-এ **bot / bot properties** নির্বাচন করুন। **Chats → কোনো user → Properties**-এ যাবেন না; সেটা user scope।
3. নতুন property যোগ করুন: Name `vault:origin`, Type **String**, Value `https://totpbot.vercel.app`; save করে reopen করে value দেখুন।
4. দ্বিতীয় property: Name `vault:forward_key`, Type **String**, Value Vercel-এর `BB_FORWARD_SECRET`-এর **একই** 64-character value। Save/reopen করে মিলিয়ে নিন।
5. `SERVER_KEY`, `SETUP_TOKEN`, master password, recovery key, DEK বা session token BB properties-এ দেবেন না।

বর্তমান BB HTTP transport certificate validation-এর সীমাবদ্ধতা আছে বলে command exact JSON-কে HMAC-sign করে; key পাঠায় না, HTTP response body-ও বিশ্বাস করে না। Backend নিজে Telegram API দিয়ে menu পাঠায়। ফলে BB HTTP timeout/error দেখালেও bot-এ menu আসতে পারে; `/start` নতুন করে দিয়ে status দেখুন, password chat-এ লিখবেন না।

## 5. Private channel, ID এবং permissions

1. Telegram-এ **Private Channel** বানান। আপনার vault-এর জন্য dedicated channel রাখুন।
2. সেই একই bot-কে **Administrator** হিসেবে add করুন। **Post Messages** ও **Edit Messages** দিন। Channel-এ pin করতে Bot API-র `can_edit_messages` দরকার; group-এর `can_pin_messages` আলাদা। Delete Messages/Invite Users/Add Admins এই project-এর জন্য দরকার নেই। Bot channel-এ log in করে না; admin হিসেবে add হয়।
3. Channel-এ নিজের একটি harmless test message post করুন → **Copy Link**। উদাহরণ:

   ```text
   https://t.me/c/1234567890/42
   ```

   এখানে `c/`-এর পরের channel number `1234567890`; official formula: `-(1000000000000 + channel number)`। উদাহরণে ID হয় `-1001234567890`। Number ছোট হলে শুধু `-100` জুড়ে দেবেন না—যেমন `123456789` → `-1000123456789`। শেষের `42` message ID, channel ID নয়। তাই Vercel `CHANNEL_ID=-1001234567890`। Invite link `t.me/+...` থেকে এই number পাওয়া যাবে না। [Official ID conversion](https://core.telegram.org/api/bots/ids)।
4. Link নিয়ে সন্দেহ হলে local `.env`-এ token/channel ID রেখে read-only diagnostic চালান:

   ```sh
   node --env-file=.env --import tsx scripts/telegram-check.ts
   ```

   এটি getMe/getChat/getChatMember call করে bot username, numeric channel ID ও required rights দেখায়; bot token print করে না, message post বা webhook change করে না।
5. নিজের private bot chat-এ **Start** দিন; না দিলে bot private backup পাঠাতে নাও পারবে। Replacement account দিয়েও আগে Start দিতে হবে।

প্রতিটি revision-এর encrypted document ও signed manifest আলাদা থাকে। Pin discovery hint; authoritative published revision Neon-এ। পুরোনো pin/late request নতুন revision overwrite করতে পারবে না। Telegram history থেকে code search করে current state ধরে নেওয়া হয় না।

## 6. BotFather Mini App/menu

BotFather → `/mybots` → ওই একই bot → **Bot Settings → Menu Button → Configure Menu Button**। Button text `Open Vault`, URL:

```text
https://totpbot.vercel.app
```

BotFather UI wording client অনুযায়ী একটু বদলাতে পারে; `/setmenubutton` দিয়ে bot বেছে একই text/URL-ও দেওয়া যায়। এই project menu-button/inline-button Mini App ব্যবহার করে; main Mini App profile setup বাধ্যতামূলক নয়।

Backend webhook-এর জন্য কোনো URL দেবেন না। Bots.Business incoming Telegram updates-এর একমাত্র owner থাকবে। Project কখনও setWebhook/deleteWebhook/getUpdates চালায় না। Native `/start`-এর Open Vault button প্রথম setup দরকার হলে `?view=setup` URL ব্যবহার করবে। Telegram initData backend-এ HMAC ও freshness-সহ validate হয়; standalone Chrome tab-এ নিজের Telegram ID লিখে login করা যায় না।

## 7. Redeploy এবং প্রথম vault setup

1. Vercel-এ latest GitHub commit deploy করুন; Other preset, `npm run build`, output `public`, Node.js 22 বা supported newer version। `vercel.json`-এ Node function duration 60 seconds ও daily cron আছে।
2. Public health URL খুলুন: **https://totpbot.vercel.app/api**। Expected: HTTP 200, `"mode":"postgres"`, `"writesEnabled":true`, প্রথমবার `"initialized":false`। এই response পেতে actual DB read/decryption সফল হতে হয়—শুধু flag দেখে true দেওয়া হয় না। 503/`missing` থাকলে variables/migration/connection ঠিক করুন।
3. Telegram private bot chat-এ `/start` দিন → **Open Vault**। প্রথম setup-এর exact form URL:

   **https://totpbot.vercel.app/?view=setup**

   **এটি Telegram Mini App-এর ভেতর খুলবেন।** বাইরে browser-এ URL paste করলে verified Telegram initData থাকবে না। Bot-এর Open Vault button এই context দেয়। Menu root খুললে **Initial setup** বাটনেও একই form পাওয়া যাবে।
4. Setup token = আপনার private `SETUP_TOKEN`; নতুন vault username দিন (3–100 characters); unique master password/passphrase দিন (14–256 characters, অন্তত 8 distinct characters)। Telegram username vault username নয়।
5. Generated recovery key একবার দেখাবে। Copy/download করে Telegram ও backup file থেকে আলাদা নিরাপদ জায়গায় রাখুন। Save acknowledgement checkbox → **Finish setup**। Setup এরপর আর খোলা যাবে না; acknowledgement-এর আগেও দ্বিতীয় account তৈরি হয় না।
6. প্রথম revision 0-এর status দেখুন: Vault saved; Channel published; Private backup delivered। Failure হলে state আলাদা দেখাবে—**Retry backup** দিন। Public health true মানেই channel permissions/delivery verified নয়; এই ধাপটি সেগুলো পরীক্ষা করে।
7. Vercel cron `/api/worker` daily `0 3 * * *` UTC—Bangladesh-এ আনুমানিক সকাল 9টা; Hobby scheduling এক ঘণ্টার window-তে হতে পারে। এটি session ছাড়াই pending **encrypted** jobs resume করে। Immediate retry app button থেকেই করুন; daily cron-এর জন্য অপেক্ষা করতে হবে না। Worker URL browser-এ খুলে 401 পাওয়া স্বাভাবিক—CRON_SECRET ছাড়া worker চলে না।

## 8. Import, backup ও অন্য account দিয়ে recovery test

প্রথমে **synthetic** data দিয়ে নিচের test করুন; production credentials import করার আগে live acceptance শেষ করুন।

**CSV:** Add/import → Import → Google export `.csv` বেছে Validate & preview। Header exactly `name,url,username,password,note`; BOM/quoted commas/newlines supported। Max 1 MiB/5000 rows। Valid/invalid/duplicate/new/updated counts দেখুন → Skip/Update/Keep Both → confirm। একটি bulk import = এক revision ও এক backup job। File/policy বদলালে preview আবার করুন।

**JSON:** OneCloud v1 adapter-এর root `v:1`, `app`, `accounts`; account fields issuer/account_name/secret/algorithm/digits/period। SHA1/SHA256/SHA512, digits 6/8, period 15–120 sec preserve হয়। Missing values-এ supported defaults SHA1/6/30। Unsupported exporter version/HOTP reject হয়। বাস্তব exporter-এর format ভিন্ন হলে আগে জানান—file না দেখে support দাবি করা হচ্ছে না। Password ও TOTP নাম মিলে গেলেই auto-link হয় না; editor-এ explicit link বেছে নিতে হয়।

**Backup:** Backup & restore → Download encrypted backup → device-এ `vault.encrypted.json` save করুন। Private bot chat-এ পাওয়া encrypted attachment-টিও device-এ download করে অন্য জায়গায় রাখুন; শুধু Telegram-এ থাকলে independent backup নয়। Channel/current/private delivery status আলাদা দেখুন। Login-এর পর Retry backup দিয়ে failed stage resume করা যায়।

**Offline recovery:** GitHub থেকে `public/recovery.html`, `public/recovery.js`, `public/style.css` একই local folder-এ রাখুন। Internet বন্ধ করে recovery.html খুলুন, downloaded backup + recovery key দিন → counts preview → plaintext JSON export। Managed browser file:// block করলে dependency install করা project-এ `npm run recover -- /path/backup.json /path/recovered.json` চালান; terminal-এ hidden key input দিন। Recovery Telegram/Neon/old SERVER_KEY ছাড়াই চলে। Export plaintext—সুরক্ষিত রাখুন।

**New Telegram account rebind:** A account-এ synthetic records, encrypted backup এবং recovery key save করুন। B account থেকে bot-কে Start দিন → Open Vault → **Rebind**। Form URL `https://totpbot.vercel.app/?view=rebind`; Mini App context লাগবে। Same vault username + master password + recovery key দিন; old binding/sessions revocation checkbox confirm করুন। Existing vault UUID/records থাকবে। A account-এর খোলা app/পুরোনো buttons দিয়ে sensitive operation করলে reject/expired/locked হওয়া চাই; B-তে record counts ও TOTP refresh কাজ করা চাই। চাইলে credentials+key দিয়ে একই flow-তে A-তে ফিরতে পারবেন।

**Forgotten password:** আলাদা **Forgot password** flow / `?view=recover-password` ব্যবহার করুন—username + recovery key + new strong master password + revoke confirmation। Normal rebind-এ পুরোনো password লাগে; forgotten-password recovery-তে লাগে না। পুরোনো sessions invalid এবং নতুন password কার্যকর হওয়া চাই।

**Restore preview:** Backup & restore-এ encrypted file + ওই backup-এর recovery key দিন → Authenticate & preview → Merge বা Replace নির্বাচন → explicit confirmation। Replace-এর আগে নিজের current encrypted backup download করুন। Restore কেবল records কপি করে; পুরোনো Telegram binding/session পুনরুজ্জীবিত হয় না। History-এর পুরোনো channel files delete হয় না।

**Logout/expiry:** Lock vault দিয়ে logout করে পুরোনো buttons/session reject হচ্ছে দেখুন। Inactivity expiry দ্রুত পরীক্ষা করতে সাময়িক `SESSION_IDLE_SECONDS=60`, redeploy, login করে এক মিনিট কোনো vault API action করবেন না; পরের action reject হওয়া চাই। শেষে আবার `600` ও redeploy দিন। Code আগে থেকেই 60 sec boundary ও server-side revocation test করেছে; এইটি আপনার actual deployment-এর acceptance check।

**Concurrent save/retry:** দুই Mini App instance/tab থেকে একই revision edit করার চেষ্টা করলে একটি save এবং অন্যটি stale/conflict হওয়া চাই; reload করে দ্বিতীয় change apply করুন। Worker timeout হলে একই revision দুবার তৈরি হবে না। Telegram timeout-এর ambiguous outcome-এ duplicate encrypted documents/messages হতে পারে; এটিকে exactly-once delivery বলা হচ্ছে না।

## সমস্যার দ্রুত mapping

| Symptom | কী দেখবেন |
|---|---|
| Health missing / writesEnabled false | Exact env names, Production scope, `STORAGE_MODE=postgres`, redeploy |
| Coordinator 503 | SQL migration row/table, DATABASE_URL, SERVER_KEY অপরিবর্তিত কি না, Neon Usage/limits |
| Verified Telegram identity required | Chrome tab নয়; Telegram Menu/Open Vault button দিয়ে খুলুন |
| Telegram authorization expired | Mini App close করে আবার খুলুন; launch authorization freshness 5 minutes |
| Bot says integration not configured | Bot-scoped String properties, exact names |
| No native menu / HTTP timeout | BB error log-এ শুধু sanitized diagnostics দেখুন; signed request/URL/key মিলান; Vercel request may already have completed |
| Channel failed | Bot admin, correct -100 ID, Post Messages/Edit Messages; Retry backup |
| Private backup failed | Active account bot-কে Start দিয়েছে কি না, bot blocked কি না; Retry backup |
| Button expired | `/start` দিয়ে fresh menu; old account হলে deliberate rebind |
| Worker returns 401 | Direct browser access expected to fail; Vercel CRON_SECRET/cron config দেখুন |

Vercel production deployment/live integration আমি এই environment থেকে verify করতে পারিনি। আপনার private variables বসানো ও live acceptance শেষ না হওয়া পর্যন্ত real secrets রাখবেন না।
