# Runbook — how to start, stop, and un-break it

## Daily start (no bot, just the API)

```bash
docker ps            # postgres + ichancy_redis must be Up
npm run dev:api      # terminal 1  → wait for "API listening on port 3000"
npm run dev:worker   # terminal 2  → wait for "Worker started"
```

Check: http://localhost:3000/health/ready → `"status":"ok"`.

**Read this line in the worker output, every time:**

```
Ichancy adapter: FAKE (in-memory). No real money can move.
```

If it says `REAL -> https://…` then money is real. This one line is the safety indicator.

## Start WITH the Telegram bot (needs a public URL)

```bash
# terminal 3
ngrok http 3000
```

Then, in another terminal:

```bash
npm run tunnel:sync                      # every ACTIVE operator
npm run tunnel:sync -- --tenant <slug>   # just one operator (any status)
```

It reads the ngrok URL, writes `API_BASE_URL` to `.env`, and runs `webhook:set` for the operators you
named. By hand that is: put the URL in `.env` as `API_BASE_URL=…`, then
`npm run webhook:set -- --all-active` (or `--tenant <slug>`).

There is no global bot. Each operator's bot token, webhook path token, secret and chats are set in the
dashboard. An operator the dashboard never gave a webhook is refused with that instruction. Restart the
api after `API_BASE_URL` changes.

⚠️ Free ngrok gives a **new URL on every restart**. New URL = run `tunnel:sync` again, or every bot is deaf. If the machine sleeps, ngrok's session usually dies too.

Only the `default` operator's players can sign in to the **mini app** for now: it does not yet say which
operator it was opened for. Every operator's bot works in Telegram.

## Stop

- Ctrl+C in each terminal. Docker containers keep running (fine).
- To silence the bot without stopping anything: kill ngrok.

## First-time machine setup

```bash
cp .env.example .env      # then fill the secrets (see comments inside)
npm install
docker compose up -d      # redis + minio. Postgres is opt-in: --profile local-db
npm run db:setup          # migrate + safety SQL + seed  (all three in one)
```

If you use an existing Postgres server: create a dedicated database + non-owner app role first — the commented block at the top of `docker-compose.yml` has the exact SQL — then `npx prisma migrate deploy && npm run db:bootstrap && npm run seed`.

First admin: `npm run seed:platform-admin`. It creates **one** `PLATFORM_ADMIN` in tenant zero, signed into with a username and a password; everything after that (operators, their bot tokens, their staff) is done from the dashboard. It reads no `TELEGRAM_*` variable and no `JWT_SECRET`, and it is production-safe (no fixtures, no guard to bypass).

Pass the password without it landing in shell history:

```bash
read -rs SEED_PLATFORM_ADMIN_PASSWORD && export SEED_PLATFORM_ADMIN_PASSWORD
docker compose run --rm -e SEED_PLATFORM_ADMIN_USERNAME=owner -e SEED_PLATFORM_ADMIN_PASSWORD tools npm run seed:platform-admin
unset SEED_PLATFORM_ADMIN_PASSWORD
```

A bare `-e NAME` forwards the caller's value. On a laptop without Docker, drop the `docker compose run --rm -e … tools` part and run `SEED_PLATFORM_ADMIN_USERNAME=owner npm run seed:platform-admin`.

PowerShell:

```powershell
$secure = Read-Host -AsSecureString 'Platform admin password'
$env:SEED_PLATFORM_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $secure).Password
docker compose run --rm -e SEED_PLATFORM_ADMIN_USERNAME=owner -e SEED_PLATFORM_ADMIN_PASSWORD tools npm run seed:platform-admin
Remove-Item Env:SEED_PLATFORM_ADMIN_PASSWORD; Remove-Variable secure
```

| Variable | Required | Meaning |
|---|---|---|
| `SEED_PLATFORM_ADMIN_USERNAME` | yes | trimmed and lower-cased; 3–64 of `A-Z a-z 0-9 . _ @ + -` |
| `SEED_PLATFORM_ADMIN_PASSWORD` | yes | 8–72 characters, never trimmed, never printed |
| `SEED_ADMIN_DISPLAY_NAME` | no | `Owner` when the row is created; applied on a re-run only when set |
| `SEED_ADMIN_TELEGRAM_ID` | no | digits only. Adopts an old Telegram-id-only platform admin with that id. It does NOT make the bot recognise this admin: bot commands resolve staff inside the operator, and this row lives in tenant zero |
| `SEED_PLATFORM_ADMIN_RESET_PASSWORD` | no | `1` replaces the password of an existing platform admin |

Re-running prints `unchanged`, or `updated` when it re-activated the admin, applied a display name / Telegram id you passed, or reset the password. **A re-run never changes the password without `SEED_PLATFORM_ADMIN_RESET_PASSWORD=1`**, so a password changed in the console survives redeploys. If the username belongs to another role in tenant zero it refuses (exit 2) rather than promoting that account. Created and updated are audited in tenant zero's log as `admin.user.created` / `admin.user.updated` with a `SYSTEM` actor.

A running api caches admin identities for up to 60 seconds, so a re-armed admin can sign in at once but may see `ADMIN_INACTIVE` on guarded routes for up to a minute.

`npm run seed` is the **development fixture** seed (currency, baseline tenants, placeholder rails, ledger accounts, and the platform admin when the two variables above are set). It refuses `NODE_ENV=production` unless `SEED_ALLOW_PRODUCTION=1`; the `tools` image sets `NODE_ENV=production`, so use `seed:platform-admin` there.

## Tenancy: the two baseline tenants

Every operational table carries a `tenant_id`. Two tenants exist from the moment the multi-tenant
migration runs, both with fixed ids so that SQL, seeds and code can agree without a lookup:

| Id | Slug | What it holds |
|---|---|---|
| `00000000-…-000000000000` | `platform` | tenant zero. Platform staff logins. Takes no deposits — a CHECK constraint enforces it |
| `00000000-…-000000000001` | `default` | the bootstrap operator. Every row that predates multi-tenancy was backfilled here |

**The placeholder secrets, and why re-running the seed is not enough on its own.** The migration
inserts the bootstrap operator, but a migration cannot read your `.env` — so its NOT NULL credential
columns land as `REPLACE-ME-…` sentinels. **Telegram columns (bot token, webhook, chat ids) are never
filled from `.env`**: each operator's bot token is pasted into the dashboard by a platform admin. The
development fixture seed (`npm run seed`) still repairs the **Ichancy** credential columns from `.env`
**while they hold a sentinel**, and never afterwards. So, for those:

- `.env` complete before the first `npm run seed` → credentials land, nothing to do.
- `.env` filled in later → run `npm run seed` again; the sentinels are repaired then.
- A value you already set (from the console, or an earlier seed) → **never** overwritten, even when
  `.env` disagrees with it. Rotate through the console, not by editing `.env` and re-seeding.

Check what actually landed — sealed columns start `v1.`, unconfigured ones are readable English:

```sql
SELECT slug, left(bot_token_enc, 12) AS bot, ichancy_username, admin_chat_id FROM tenants;
```

`REPLACE-ME-…` or `SEED-PLACEHOLDER-…` in `bot`, or `admin_chat_id = 0`, means that operator's bot is
not configured yet; set it from the dashboard, not by editing `.env` and re-seeding.

## Things that WILL bite you (all happened already)

| Symptom | Cause | Fix |
|---|---|---|
| Bot completely silent, health OK | ngrok died or URL changed; Telegram delivers into nothing | restart ngrok, `npm run tunnel:sync`. Check what Telegram thinks: `npm run webhook:set -- --tenant <slug> --info` |
| Worker/api log `Ignoring retired environment variables: TELEGRAM_…` | an old env file still has the single-bot keys | harmless; delete those lines. Bot tokens, webhooks and chats are per operator, in the dashboard |
| Staff get no cards, log says `has no admin chat set` | that operator's `tenants.admin_chat_id` is 0 | set the operator's admin chat in the dashboard |
| Mini app sign-in answers 503 `INIT_DATA_BOT_UNAVAILABLE` | the `default` operator's bot token is unset or unreadable | set that operator's bot token in the dashboard |
| Bot ignores NEW commands only | worker is running old code | restart the worker. Look for `Registered N Telegram handler(s)` — N must match expectations (16 as of 2026-08-14) |
| `EADDRINUSE 0.0.0.0:3000` | an API is already running (maybe a forgotten terminal) | find it: `Get-NetTCPConnection -LocalPort 3000 -State Listen` — kill it or use `PORT=3001` |
| Boot fails listing missing env vars | `.env` incomplete — the app refuses to start half-configured on purpose | add the listed vars; `.env.example` documents each |
| `ERROR agent float DRIFT …` every 5 min | fake-Ichancy balance vs empty ledger; meaningless while `ICHANCY_FAKE=true` | ignore in fake mode (silencing it in fake mode is a planned change) |
| Two ngrok processes, wrong URL registered | each ngrok has its own web port (4040, 4041…) | run ONE ngrok. Read the URL from its own terminal output, never from a port you assume |
| Bot silent, webhook fine, `tenants.bot_token_enc` reads `REPLACE-ME-…` | the operator's bot token was never set — the seed no longer copies `TELEGRAM_BOT_TOKEN` into a tenant | set the bot token for that operator from the dashboard. See the tenancy section above |
| `No tenant context` thrown from a cron or a queue job | that entry point never entered `runWithTenant()` / `runAsPlatform()` | wrap the unit of work. Never "fix" it by defaulting to the bootstrap tenant — that files one operator's row under another |
| A platform admin sees their own (empty) operator everywhere | `X-Tenant-Id` was stripped at CORS preflight, or the row is not in tenant zero | header must be in `allowedHeaders` (it is, in `main.ts`); `PLATFORM_ADMIN` is honoured **only** when homed in tenant zero |
| A list endpoint returns another operator's rows | a raw-SQL query the Prisma extension cannot see, or a deliberate `acrossTenants()` | `grep acrossTenants` lists every intentional one; anything else with no `tenant_id` predicate is the bug |

Ask Telegram what it believes about one operator's bot (prints no token, masks the path):

```bash
npm run webhook:set -- --tenant <slug> --info
```

`url (none)` → nobody registered. `matches_this_deployment: no` → registered for another URL or an old path token. `last_error_message` set → Telegram tried and failed.

## Where to look when a deposit is stuck

1. `/queue` in the bot (as admin) — is it waiting for review?
2. The `deposit_requests` row — `status` says which stage
3. `deposit_transitions` — the full history of that deposit, who moved it and when
4. `ichancy_calls` — every attempt against Ichancy with the raw request/response
5. `outbox_messages` — `PENDING` = not delivered yet; `DEAD` = gave up after 8 tries (needs a human)
6. `/breaks` — open reconciliation problems

The rule the system follows: **when unsure, it stops and waits for a human.** A deposit in `NEEDS_RECONCILIATION` is not a bug — it is the system refusing to guess with money.
