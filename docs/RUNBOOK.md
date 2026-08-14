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

## Things that WILL bite you (all happened already)

| Symptom | Cause | Fix |
|---|---|---|
| Bot completely silent, health OK | ngrok died or URL changed; Telegram delivers into nothing | restart ngrok, update `API_BASE_URL`, `npm run webhook:set`. Check what Telegram thinks: `getWebhookInfo` (see below) |
| Bot ignores NEW commands only | worker is running old code | restart the worker. Look for `Registered N Telegram handler(s)` — N must match expectations (16 as of 2026-08-14) |
| `EADDRINUSE 0.0.0.0:3000` | an API is already running (maybe a forgotten terminal) | find it: `Get-NetTCPConnection -LocalPort 3000 -State Listen` — kill it or use `PORT=3001` |
| Boot fails listing missing env vars | `.env` incomplete — the app refuses to start half-configured on purpose | add the listed vars; `.env.example` documents each |
| `ERROR agent float DRIFT …` every 5 min | fake-Ichancy balance vs empty ledger; meaningless while `ICHANCY_FAKE=true` | ignore in fake mode (silencing it in fake mode is a planned change) |
| Two ngrok processes, wrong URL registered | each ngrok has its own web port (4040, 4041…) | run ONE ngrok. Read the URL from its own terminal output, never from a port you assume |

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
