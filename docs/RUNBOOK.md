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

Copy the `https://xxxx.ngrok-free.app` URL, then:

1. Put it in `.env` as `API_BASE_URL=https://xxxx.ngrok-free.app`
2. `npm run webhook:set`

⚠️ Free ngrok gives a **new URL on every restart**. New URL = repeat steps 1–2, or the bot is deaf. If the machine sleeps, ngrok's session usually dies too.

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

First admin: `SEED_ADMIN_TELEGRAM_ID=<your telegram id> npm run seed`.

That one variable creates **two** rows, and they are not interchangeable:

| Row | Where | What it is for |
|---|---|---|
| `SUPER_ADMIN` | the bootstrap operator | reviews the deposit queue and approves money. Its approval limit is tenant-scoped, so it has to live where the deposits do |
| `PLATFORM_ADMIN` | tenant zero | the only role whose `X-Tenant-Id` header is honoured, and therefore the only way to reach `/v1/admin/tenants` |

Seed only the first and nobody can create a second operator; only the second and nobody can approve a deposit.

## Tenancy: the two baseline tenants

Every operational table carries a `tenant_id`. Two tenants exist from the moment the multi-tenant
migration runs, both with fixed ids so that SQL, seeds and code can agree without a lookup:

| Id | Slug | What it holds |
|---|---|---|
| `00000000-…-000000000000` | `platform` | tenant zero. Platform staff logins. Takes no deposits — a CHECK constraint enforces it |
| `00000000-…-000000000001` | `default` | the bootstrap operator. Every row that predates multi-tenancy was backfilled here |

**The placeholder secrets, and why re-running the seed is not enough on its own.** The migration
inserts the bootstrap operator, but a migration cannot read your `.env` — so its NOT NULL credential
columns land as `REPLACE-ME-…` sentinels. The seed *can* read `.env` and repairs a column **while it
still holds a sentinel**, and never afterwards. So:

- `.env` complete before the first `npm run seed` → credentials land, nothing to do.
- `.env` filled in later → run `npm run seed` again; the sentinels are repaired then.
- A value you already set (from the console, or an earlier seed) → **never** overwritten, even when
  `.env` disagrees with it. Rotate through the console, not by editing `.env` and re-seeding.

Check what actually landed — sealed columns start `v1.`, unconfigured ones are readable English:

```sql
SELECT slug, left(bot_token_enc, 12) AS bot, ichancy_username, admin_chat_id FROM tenants;
```

`REPLACE-ME-…` or `SEED-PLACEHOLDER-…` in `bot`, or `admin_chat_id = 0`, means that operator is not
configured. The seed prints a banner saying so; it is the last thing on screen for a reason.

## Things that WILL bite you (all happened already)

| Symptom | Cause | Fix |
|---|---|---|
| Bot completely silent, health OK | ngrok died or URL changed; Telegram delivers into nothing | restart ngrok, update `API_BASE_URL`, `npm run webhook:set`. Check what Telegram thinks: `getWebhookInfo` (see below) |
| Bot ignores NEW commands only | worker is running old code | restart the worker. Look for `Registered N Telegram handler(s)` — N must match expectations (16 as of 2026-08-14) |
| `EADDRINUSE 0.0.0.0:3000` | an API is already running (maybe a forgotten terminal) | find it: `Get-NetTCPConnection -LocalPort 3000 -State Listen` — kill it or use `PORT=3001` |
| Boot fails listing missing env vars | `.env` incomplete — the app refuses to start half-configured on purpose | add the listed vars; `.env.example` documents each |
| `ERROR agent float DRIFT …` every 5 min | fake-Ichancy balance vs empty ledger; meaningless while `ICHANCY_FAKE=true` | ignore in fake mode (silencing it in fake mode is a planned change) |
| Two ngrok processes, wrong URL registered | each ngrok has its own web port (4040, 4041…) | run ONE ngrok. Read the URL from its own terminal output, never from a port you assume |
| Bot silent, webhook fine, `tenants.bot_token_enc` reads `REPLACE-ME-…` | `.env` was incomplete when the migration ran, and the seed only repairs sentinels | fill `.env`, `npm run seed` again. See the tenancy section above |
| `No tenant context` thrown from a cron or a queue job | that entry point never entered `runWithTenant()` / `runAsPlatform()` | wrap the unit of work. Never "fix" it by defaulting to the bootstrap tenant — that files one operator's row under another |
| A platform admin sees their own (empty) operator everywhere | `X-Tenant-Id` was stripped at CORS preflight, or the row is not in tenant zero | header must be in `allowedHeaders` (it is, in `main.ts`); `PLATFORM_ADMIN` is honoured **only** when homed in tenant zero |
| A list endpoint returns another operator's rows | a raw-SQL query the Prisma extension cannot see, or a deliberate `acrossTenants()` | `grep acrossTenants` lists every intentional one; anything else with no `tenant_id` predicate is the bug |

Ask Telegram what it believes (replace TOKEN):

```
https://api.telegram.org/botTOKEN/getWebhookInfo
```

`url` empty → nobody registered. `last_error_message` set → Telegram tried and failed; the date tells you when.

## Where to look when a deposit is stuck

1. `/queue` in the bot (as admin) — is it waiting for review?
2. The `deposit_requests` row — `status` says which stage
3. `deposit_transitions` — the full history of that deposit, who moved it and when
4. `ichancy_calls` — every attempt against Ichancy with the raw request/response
5. `outbox_messages` — `PENDING` = not delivered yet; `DEAD` = gave up after 8 tries (needs a human)
6. `/breaks` — open reconciliation problems

The rule the system follows: **when unsure, it stops and waits for a human.** A deposit in `NEEDS_RECONCILIATION` is not a bug — it is the system refusing to guess with money.
