# How this project works

Written 2026-08-14. Simple words on purpose. If a sentence here disagrees with the code, the code wins — then fix this file.

## The pieces

```
                    TELEGRAM
                       │
              (HTTPS webhook POST)
                       │
   ngrok ──────────────┤            ← dev only. On a real server: your domain.
                       ▼
 ┌─────────────────────────────────┐
 │  API process   (APP_ROLE=api)   │  answers HTTP. Stores the update. Replies 200 fast.
 └───────────────┬─────────────────┘
                 │ job
                 ▼
 ┌─────────────────────────────────┐
 │  REDIS                          │  the job queue + locks + Ichancy token
 └───────────────┬─────────────────┘
                 │ job
                 ▼
 ┌─────────────────────────────────┐
 │  WORKER process (APP_ROLE=worker)│  runs the bot handlers, crons, outbox,
 │                                 │  and the ONLY Ichancy login
 └───────────────┬─────────────────┘
                 │
        ┌────────┴────────┐
        ▼                 ▼
   POSTGRES          ICHANCY API
 (the truth)      (the casino money)
```

Same codebase, one Docker image. `APP_ROLE` picks which half runs.

## Do we need the worker? YES

The API process only **receives**. It never does the work. The worker is the only thing that:

- runs the Telegram command handlers (`/help`, `/deposit`, Approve buttons…)
- moves outbox rows to the queue and delivers them
- calls Ichancy (credit, balance) — and holds the **only** Ichancy login
- runs the crons (below)

If the worker is off: the bot is silent, approvals never credit, nothing expires. The webhook still stores updates in `telegram_updates`, so nothing is lost — it is all processed when the worker comes back.

## Do we need Redis? YES

Redis holds four things. None of them can live in Postgres comfortably:

| What | Why it matters |
|---|---|
| BullMQ job queues (`telegram-updates` = inbound updates from the webhook; `telegram` = outbound bot sends/edits; plus `outbox`, `ichancy`, `media`, `recon`) | every command reply and every credit is a job. When tracing a lost update, look in `telegram-updates`, not `telegram` |
| Locks | the per-player credit lock is what stops a double credit; the cron locks stop two workers running the same job |
| The Ichancy token | Ichancy allows ONE login per agent. The token lives in Redis so exactly one process owns it |
| The initData one-shot nonce | stops a stolen Mini App login being replayed |

Redis is ~10 MB of RAM. Keep it.

## Do we need `webhook:set`? Only when the URL changes

`webhook:set` is not a running process. It is one HTTP call that tells Telegram: *"send updates to this address."* You run it:

- once per new public URL (every ngrok restart → new URL → run it again)
- once when you deploy to a real domain — then basically never again

The pain in dev is real. Planned fix: a `TELEGRAM_POLLING=true` dev mode (not built yet) so local development needs no ngrok at all.

## What happens when a player sends /deposit 50000

1. Telegram POSTs the update to `POST /telegram/webhook/<secret-path>`
2. API checks the secret header, writes `telegram_updates` (`ON CONFLICT DO NOTHING` — a resend is ignored), queues a job, replies 200 — all in ~10 ms
3. Worker picks the job, runs the handler
4. Handler calls `DepositService.create` — one DB transaction: the `DepositRequest` row, a `DepositTransition` row, an audit row
5. Bot replies: reference, where to pay, deadline

## What happens when the admin taps Approve

1. Same webhook path → worker → `DepositReviewService.approve`
2. **One transaction**: status CAS `UNDER_REVIEW→APPROVED` + ledger posting T1 + audit + an **outbox row**. No HTTP inside. Commit.
3. The outbox relay (worker, every 1 s) queues the job
4. The credit job: per-player Redis lock → read Ichancy balance (b0) → `depositToPlayer` → on ok: ledger T2 + `CREDITED` + tell the player. On timeout: re-read balance; if it grew by the amount, it landed (`BALANCE_DELTA`); else ONE retry; else `NEEDS_RECONCILIATION` and a human looks.

Why the outbox: the process can die between "approved" and "credited". The outbox row commits **with** the approval, so the credit can never be forgotten — only delayed.

## The money book (ledger)

There is no `wallet.balance` column that gets edited. A "wallet" is a `LedgerAccount` row, and its balance only changes by inserting `LedgerEntry` rows that always sum to zero per transaction. Postgres enforces this with triggers, and the app's DB role **cannot** UPDATE or DELETE ledger or audit rows (we tested this — see `prisma/sql/`).

| Account (per player / method) | Meaning |
|---|---|
| `PLAYER_LIABILITY:<player>` | money we owe the player, not yet pushed to Ichancy. Normally 0. Not 0 = stuck money |
| `CASINO_MIRROR:<player>` | what we believe Ichancy shows for him |
| `ICHANCY_AGENT_FLOAT` | our agent wallet at Ichancy — what we can still pay out |
| `RAIL_CLEARING:<method>` | approved, but no bank statement proved it yet. **Aged, this catches a lying admin** |
| `HOUSE_CASH:<method>` | proved by a statement |
| `SUSPENSE_UNIDENTIFIED`, `HOUSE_ROUNDING` | money with no owner yet / rounding remainders |

## The crons (worker only)

| Cron | Every | Job |
|---|---|---|
| outbox relay | 1 s | pending outbox rows → queue |
| outbox reaper | (see `outbox.constants.ts`) | rescue rows stuck in-flight |
| deposit sweep | `deposit-sweep` interval | expire unpaid deposits, release stale claims, reap stuck CREDITING |
| agent float sync | 5 min | compare ledger float vs Ichancy, warn when low, alert on drift |
| ledger invariants | 15 min | Σ per tx = 0, global Σ = 0, balances = Σ entries |
| rail ageing | (see service) | "approved but never proved" report |
| idempotency reaper | 10 min | delete expired idempotency keys |
| scheduled report | 10 min tick | posts the `/report` body every `REPORT_SCHEDULE_HOURS` (0 = off) |

The scheduled report is the odd one: the tick is fixed because `@Interval` needs a constant, and a
Redis marker (`SET NX EX`) decides which tick actually posts. That is what makes a restart neither
re-post nor reset the schedule, and what stops two workers posting the same report. It goes to the
feed group if one is configured, otherwise to the admin group — never nowhere.

## The three Ichancy problems and our answers

1. **No idempotency key on their API** → balance-delta protocol (read before, read after, one retry max, then a human). Every attempt is stored in `ichancy_calls` — request/response bodies with secrets redacted (passwords/tokens replaced by `[REDACTED]`, long values truncated), so it is the dispute record, not a verbatim byte dump.
2. **One login per agent, a second login kills the first** → only the worker signs in; token in Redis behind a lock; the API role only reads.
3. **Errors look like success** (HTTP 200 + `result:false`, HTTP 201 for unauthorized) → we never trust the HTTP code; `error-map.ts` reads the `notification` array. Unknown message = "ambiguous" = never retried blindly.

`ICHANCY_FAKE=true` routes everything to an in-memory fake. The worker prints which adapter it picked on every boot. **Read that line.**
