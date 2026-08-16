# Ichancy Cashier Backend

A backend for a Telegram mini-app. Players use it to put money into their casino account.

The casino is **Ichancy**. We are an **agent** there. We hold a pool of money at Ichancy (our
"float"). When a player pays us in real life, we move money from our float into their casino
account.

The money is **NSP** (New Syrian Pound). Scale is **2**. So `1.00 NSP` is stored as `100`.

---

## More docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit: api, worker, Redis, webhook, ledger, crons
- [docs/DECISIONS.md](docs/DECISIONS.md) — every big choice and its why
- [docs/RUNBOOK.md](docs/RUNBOOK.md) — start / stop / un-break it (read this when something is silent)
- [docs/STATUS.md](docs/STATUS.md) — what is done, what is true right now, what is next

## Table of contents

- [What this service does](#what-this-service-does)
- [The deposit flow](#the-deposit-flow)
- [3 things about the Ichancy API](#3-things-about-the-ichancy-api)
- [How to run it](#how-to-run-it)
- [The two roles: api and worker](#the-two-roles-api-and-worker)
- [Environment variables](#environment-variables)
- [Tests](#tests)
- [Project layout](#project-layout)
- [Rules you must follow](#rules-you-must-follow)

---

## What this service does

1. A player opens the mini-app inside Telegram.
2. The player says: "I want to deposit 50,000 NSP."
3. We show a bank account or a wallet number. The player pays there in real life.
4. The player uploads a photo of the receipt.
5. An admin looks at the photo. The admin says yes or no.
6. If yes, we call Ichancy and put the money in the player's casino account.
7. Every step is written in a **double-entry ledger**. Nothing is deleted. Nothing is edited.

Only an admin can approve. Big amounts need **two different admins** (four eyes).

---

## The deposit flow

Read this diagram from top to bottom. `T1` and `T2` are ledger transactions.

```
  PLAYER (Telegram mini-app)                 US                        ICHANCY
  ==========================                 ==                        =======

  1. POST /v1/deposits
     amount = 50000.00 NSP     ------>  deposit_requests row
                                        status = AWAITING_PROOF
                                        shortId = K7Q2ZP9V3M
                               <------  "Pay to account 1234-5678"

  2. player pays in real life
     (bank / wallet / cash)

  3. POST /v1/deposits/K7Q2ZP9V3M/proof
     photo of the receipt      ------>  deposit_proofs row
                                        image -> S3 / MinIO
                                        status = SUBMITTED
                                        duplicate photo? -> flagged
                                             |
                                             |  outbox -> queue
                                             v
                                        ADMIN gets a card in Telegram


  ADMIN
  =====

  4. admin taps "Approve"      ------>  is the admin allowed this amount?
                                        is our float big enough?
                                             |
                                             |  yes
                                             v
                                        LEDGER T1  (one transaction)
                                          debit  RAIL_CLEARING   50000.00
                                          credit PLAYER_LIABILITY 50000.00
                                        status = APPROVED
                                             |
                                             |  outbox row -> BullMQ
                                             v
                                        WORKER picks up the job


  WORKER (credit)
  ===============

  5. take a lock for this player only
     |
     +-- read balance  ------------------------------------------>  getPlayerBalanceById
     |                                                       b0 <--
     |
     +-- send money    ------------------------------------------>  depositToPlayer
     |                                                              comment = K7Q2ZP9V3M
     |
     +-- what came back?
         |
         +-- OK        -> LEDGER T2   debit  ICHANCY_AGENT_FLOAT 50000.00
         |                            credit CASINO_MIRROR       50000.00
         |               status = CREDITED                   <-- DONE, player has the money
         |
         +-- REJECTED  -> no ledger movement
         |               status = CREDIT_FAILED               <-- safe, nothing moved
         |
         +-- UNSURE    -> wait, then read the balance again -----> getPlayerBalanceById
             (timeout,                                      b1 <--
              5xx,        |
              weird       +-- (b1 - b0) >= 50000.00 ?
              answer)     |     yes -> it worked. T2. CREDITED.
                          |            verifiedBy = BALANCE_DELTA
                          |
                          +-- no  -> try the POST ONE more time.
                                     still unsure -> status = NEEDS_RECONCILIATION
                                     A HUMAN MUST LOOK. We never try a third time.
```

**Why the lock in step 5?** Because we check the balance before and after. If two credits for the
same player run at the same time, the difference means nothing. So credits for one player run one
at a time.

**Why never retry more than once?** Because Ichancy has no idempotency key. A blind retry can pay
the player twice. Twice is worse than late.

---

## 3 things about the Ichancy API

This part is important. The Ichancy API is not normal. Please read it before you change any code
that talks to it.

### 1. There is no idempotency key

You cannot say "this is request #123, do not repeat it". There is also no way to ask "did my
request from one minute ago work?". There is no lookup by reference.

So if a request times out, **we do not know** if the money moved.

**What we do:** we read the player's balance _before_ we send the money, and again _after_. If the
balance went up by the right amount, the money moved. We write `verifiedBy = BALANCE_DELTA` so a
human can see later that we guessed from the balance, not from an answer.

This only works if credits for one player never overlap. That is why there is a lock per player.

If we still do not know after that, the deposit becomes `NEEDS_RECONCILIATION`. A human opens the
Ichancy panel and looks. We put our `shortId` in the `comment` field of every call, so a human can
find it there.

### 2. Only one login can exist at a time

Ichancy gives one `accessToken` + one `refreshToken` per agent. Rules:

- The access token lives 1 hour. The refresh token lives 7 days.
- Using the refresh token gives you a new pair. **The old refresh token dies immediately.**
- Signing in again **kills the previous tokens**.

So if two processes sign in, they knock each other out, and deposits start failing.

**What we do:** only the **worker** may sign in. The tokens live in Redis. A distributed lock
(`SET NX PX`) makes sure only one process refreshes them. If ten calls get a 401 at the same time,
they all wait for **one** refresh, not ten.

The **api** process never signs in. It only reads the token from Redis. If there is no token, the
api fails loudly and tells you to start the worker.

**So: start the worker at least once before the first deposit.**

### 3. Errors can look like success

The HTTP status is not reliable:

- `201` can mean UNAUTHORIZED. Yes, `201`.
- `200` can carry an error inside the body.
- `422` is used for normal business errors.

And this is a real answer that means **failure**:

```json
{
  "status": true,
  "result": false,
  "notification": [{ "content": "You don't have AMD wallet", "status": "error" }]
}
```

`status` is `true`. It still failed.

**What we do:** we never trust the HTTP status alone. We read the whole body:

```ts
isError = notification.some((n) => n.status === 'error') || result === false || status === false;
```

Everything we do not recognise becomes `ambiguous`, not `ok`. An empty balance answer (`result: []`)
is **not** read as zero — reading it as zero would let a failed credit pass the balance check.

All of this lives in one place: `src/core/ichancy/`. Do not talk to Ichancy from anywhere else.

---

## How to run it

You need: **Node 22**, **Docker**, and **npm**.

### Step 1 — install

```bash
npm install
```

### Step 2 — start the databases

```bash
docker compose up -d
```

This starts:

| Service  | What it is        | Port |
| -------- | ----------------- | ---- |
| postgres | PostgreSQL 17     | 5432 |
| redis    | Redis 7           | 6379 |
| minio    | S3 for the photos | 9000 |

If port 5432 is already used on your machine:

```bash
POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose up -d
```

### Step 3 — make your .env

```bash
cp .env.example .env
```

Now open `.env` and fill it in. See [Environment variables](#environment-variables) below.

### Step 4 — create the tables

```bash
npm run prisma:generate
npm run prisma:migrate
```

### Step 5 — apply the safety SQL (IMPORTANT)

Prisma cannot make these rules. They are in `prisma/sql/`. They are what keeps the ledger honest.

```bash
for f in prisma/sql/0*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
```

Run them in order: `001` → `002` → `003` → `004` → `005`.
Read `prisma/sql/README.md` — it explains each file and how to fold them into a migration.

**If you skip this step, your database looks fine and protects nothing.** No balance check, no
append-only ledger, no four-eyes check.

### Step 6 — seed

```bash
npm run seed
```

This creates: the NSP currency, two payment methods, the ledger accounts, and one owner admin.

To create the owner admin, set this first (your Telegram user id — ask `@userinfobot`):

```bash
SEED_ADMIN_TELEGRAM_ID=123456789
SEED_ADMIN_DISPLAY_NAME="Your Name"
```

The seed is safe to run again. It never makes copies.

> The seed creates **placeholder** payment destinations. A player who pays into them sends money
> nowhere. Replace them before you take real money. The seed prints a big warning about this.

The seed **refuses to run** when `NODE_ENV=production`. That is on purpose. If you really mean it:
`SEED_ALLOW_PRODUCTION=1 npm run seed`.

### Step 7 — run it

Two terminals. You need both.

```bash
# terminal 1 — the HTTP server
npm run dev:api

# terminal 2 — queues, schedules, and the Ichancy login
npm run dev:worker
```

Now open http://localhost:3000/docs to see the API.

### Step 8 — connect Telegram (only when you have a public https URL)

```bash
npm run webhook:set
npm run webhook:set -- --info          # just look, change nothing
npm run webhook:set -- --drop-pending  # after a long outage
npm run bot:setup                      # push command menus, bot description and menu button (safe to re-run)
```

This is a **manual** step on purpose. It is a global change to your bot. It must not happen
automatically on every deploy.

---

## The two roles: api and worker

One Docker image. Two ways to start it. `APP_ROLE` decides which.

|                            | **api**          | **worker**         |
| -------------------------- | ---------------- | ------------------ |
| Serves HTTP                | yes              | no                 |
| Runs `@Cron` / `@Interval` | no               | yes                |
| Reads BullMQ queues        | no               | yes                |
| Runs the outbox relay      | reports only     | yes                |
| Signs in to Ichancy        | **never**        | **yes, only here** |
| Handles Telegram updates   | receives + saves | processes          |
| How many can run           | many             | see below          |

The api can run as many copies as you like.

The worker uses locks, so more than one copy is safe. But **one is enough** to start, and one is
simpler to reason about.

Why split them? Three reasons:

1. Ichancy allows only one login. Many api copies would fight over it.
2. Two api copies would both run the "expire old deposits" job at the same second.
3. A slow queue job must never make an HTTP request slow.

**A worker that is not running means:** no credits, no Telegram buttons, no expiry, no
reconciliation. Deposits will sit in `APPROVED` and never reach the player.

---

## Environment variables

Every variable in `.env.example` is required. The app **refuses to start** if one is missing or
looks wrong, and it prints **all** the problems at once, not just the first.

That is on purpose. A cashier that starts half-configured takes money it cannot deliver.

### The main ones

| Variable                                | What it is                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `APP_ROLE`                              | `api` or `worker`. Nothing else.                                                     |
| `NODE_ENV`                              | `development`, `test`, or `production`.                                              |
| `PORT`                                  | HTTP port for the api.                                                               |
| `API_BASE_URL`                          | Public URL of this service. Used to build the webhook URL.                           |
| `DATABASE_URL`                          | PostgreSQL. Must be a **non-owner** role, or `003_app_role_grants.sql` does nothing. |
| `REDIS_URL`                             | Redis. Used for queues, locks, sessions, and rate limits.                            |
| `JWT_SECRET`                            | At least 16 characters. At least 32 in production.                                   |
| `TELEGRAM_BOT_TOKEN`                    | From `@BotFather`.                                                                   |
| `TELEGRAM_WEBHOOK_SECRET`               | We check this header on every update.                                                |
| `TELEGRAM_WEBHOOK_PATH_TOKEN`           | Random text in the webhook URL, so nobody can guess it.                              |
| `TELEGRAM_ADMIN_CHAT_ID`                | The group that gets the review cards. Negative for supergroups.                      |
| `TELEGRAM_FEED_CHAT_ID`                 | Optional. A second group that also gets the credit card, **masked**. Empty = off.    |
| `TELEGRAM_FEED_FULL_DETAIL`             | Optional. `true` posts the full card to the feed. Default `false` = masked.          |
| `REPORT_SCHEDULE_HOURS`                 | Hours between automatic `/report` posts. Default `6`. `0` or empty = off.            |
| `MINI_APP_ORIGIN`                       | Comma-separated. CORS allow-list. Must be `https` in production.                     |
| `ICHANCY_BASE_URL`                      | The agent API.                                                                       |
| `ICHANCY_USERNAME` / `ICHANCY_PASSWORD` | Agent login. **Only the worker uses these.**                                         |
| `ICHANCY_AGENT_ID`                      | Our `affiliateId`. Used as `parentId` when we register a player.                     |
| `S3_*`                                  | Where the receipt photos go.                                                         |
| `DUAL_APPROVAL_THRESHOLD_MINOR`         | At or above this, a second admin must approve. In minor units.                       |
| `DEPOSIT_EXPIRY_MINUTES`                | Unpaid deposits are cancelled after this.                                            |
| `AGENT_FLOAT_LOW_WATERMARK_MINOR`       | Warn when our Ichancy float gets low.                                                |

### Extra variables (not in `.env.example` yet)

These are read straight from the environment. They all have safe defaults.

| Variable                        | Default                    | What it does                                                                |
| ------------------------------- | -------------------------- | --------------------------------------------------------------------------- |
| `ICHANCY_FAKE`                  | fake when `NODE_ENV=test`  | `1` = use the fake casino. No real money moves.                             |
| `FILE_STORAGE_DRIVER`           | `local` in test, else `s3` | `local` writes photos to disk.                                              |
| `FILE_STORAGE_LOCAL_DIR`        | temp folder                | Where `local` writes.                                                       |
| `SEED_ADMIN_TELEGRAM_ID`        | —                          | Telegram id of the first admin. No value = no admin is created.             |
| `SEED_ADMIN_DISPLAY_NAME`       | `Owner`                    | Name shown in the panel.                                                    |
| `SEED_ADMIN_USERNAME`           | —                          | Telegram `@username`, without the `@`.                                      |
| `SEED_ADMIN_SINGLE_LIMIT_MINOR` | `500000000`                | Most the first admin may approve at once.                                   |
| `SEED_ADMIN_DAILY_LIMIT_MINOR`  | `5000000000`               | Most the first admin may approve per day.                                   |
| `SEED_ALLOW_PRODUCTION`         | —                          | `1` lets the seed run with `NODE_ENV=production`.                           |
| `SEED_DATABASE_URL`             | `DATABASE_URL`             | Seed with a different (owner) connection.                                   |
| `MIGRATE_DATABASE_URL`          | `DATABASE_URL`             | Migrate as the schema owner.                                                |
| `POSTGRES_TEST_URL`             | —                          | Integration tests use this database instead of starting a container.        |
| `REDIS_TEST_URL`                | —                          | Same idea for Redis. Use a spare db index, e.g. `redis://localhost:6379/9`. |

**Money is always in minor units here.** `100000000` means `1,000,000.00 NSP`. Never write a decimal
point in a `*_MINOR` variable.

---

## Tests

```bash
npm test          # fast. no Docker needed.
npm run test:int  # slow. needs Docker.
npm run typecheck
npm run lint
```

`npm run test:int` starts a real PostgreSQL 17 and a real Redis 7 with testcontainers. It pushes the
schema **and** applies `prisma/sql/001..005`, so the ledger rules are really tested.

Already have a database with the schema? Skip the containers:

```bash
POSTGRES_TEST_URL=postgresql://... REDIS_TEST_URL=redis://localhost:6379/9 npm run test:int
```

To write your own integration test:

```ts
import { createTestApp } from '../test/setup/app-factory';

const ctx = await createTestApp();
await request(ctx.httpServer).get('/v1/wallet').expect(401);
await ctx.reset(); // clean database, clean Redis, fresh seed
await ctx.close();
```

`createTestApp()` boots the **real** `AppModule` with the **real** middleware. Only two things are
fake: the Ichancy port and the Telegram bot.

No test can reach the real Ichancy. `test/setup/jest-setup.ts` sets `ICHANCY_FAKE=1` for every test
file. A test that moves real money is not a test.

---

## Project layout

```
src/
  main.ts                    api entrypoint (also branches on APP_ROLE)
  main.worker.ts             worker entrypoint
  main.cli.ts                webhook:set and other commands
  app.module.ts              what the api runs
  worker.module.ts           what the worker runs
  feature-ports.module.ts    lets deposit reach player/admin/payment-method
  request-context.middleware.ts   who is acting + one correlation id
  body-parser.middleware.ts       body size limits + real error codes

  common/     pure code. no framework, no database. imports nothing local.
  core/       infrastructure: prisma, redis, ichancy, ledger, auth, telegram, queues
  modules/    features: player, admin, payment-method, deposit, wallet, reconciliation

prisma/
  schema.prisma   the tables
  sql/            the rules Prisma cannot express. YOU MUST APPLY THESE.
  seed/           idempotent seed data
test/
  setup/          containers, truncate, app factory
  fakes/          the fake Ichancy adapter
```

### Layering

```
modules  ->  core  ->  common
```

- `modules` may use `core` and `common`.
- `core` may use `common`.
- `common` uses nothing local.
- **`modules/A` may never import `modules/B`.**

ESLint enforces this. It is not a style rule. It stops one feature from reaching past another
feature's transaction boundary.

Features talk to each other through **string tokens** instead: `PLAYER_LINK_PORT`,
`APPROVAL_LIMIT_PORT`, `PAYMENT_METHOD_PORT`. `feature-ports.module.ts` connects them.

---

## Rules you must follow

1. **Money is `bigint` minor units.** Never `number`. Never `float`. Never Prisma `Decimal`.
   Use `@common/helpers/money.util`. ESLint blocks `parseFloat` and `Math.round`.

2. **Never call Ichancy inside a database transaction.** A transaction can be retried. A retried
   HTTP call can pay a player twice. Write an outbox row instead, and let the worker send it.

3. **The ledger is append-only.** No `UPDATE`. No `DELETE`. Database triggers refuse them, even for
   the owner. To fix a mistake, post a reversal.

4. **Every service that writes money takes `Tx` as its first argument.** The service owns the
   transaction. The repository just uses it.

5. **Error codes are stable strings**, like `DEPOSIT_ALREADY_CREDITED`. Not translated sentences.
   The mini-app reads the code.

6. **Only the worker signs in to Ichancy.** See point 2 of the Ichancy section.

7. **Everything a person claims and everything we verified are separate columns.**
   `claimedAmountMinor` is what the player typed. `verifiedAmountMinor` is what an admin confirmed.
   We never overwrite the claim.

---

## Health checks

| Path                | Checks           | Use it for                |
| ------------------- | ---------------- | ------------------------- |
| `GET /health/live`  | nothing          | "restart this container?" |
| `GET /health/ready` | database + Redis | "send traffic here?"      |

`/live` touches nothing on purpose. If it checked the database, one database problem would restart
every replica at the same time, and the restarts would make the database worse.

The worker has no HTTP server, so it has no health endpoint. Watch the queue depth and
`outbox_messages.status` instead.

---

## Rate limits

Only three routes are limited. Everything else is free, so an admin working through the review
queue is never blocked.

| Route                                             | Limit         |
| ------------------------------------------------- | ------------- |
| `POST /v1/auth/telegram`, `POST /v1/auth/refresh` | 30 per minute |
| `POST /v1/deposits`                               | 12 per minute |
| `POST /v1/deposits/:shortId/proof`                | 10 per minute |

The counter is in Redis, so all api replicas share it.

For logged-in routes we count per **player**, not per IP. Many players in Syria share one IP through
the mobile network. Counting per IP would block a whole city instead of one bad client.

If Redis is down, the limit **allows** the request and logs an error. A rate limiter must not turn a
small problem into an outage.

At startup the app checks that every rule still matches a real route. If a route was renamed, you
get a loud error in the log instead of a rate limit that quietly does nothing.
