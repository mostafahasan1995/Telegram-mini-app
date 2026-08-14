# Decisions — what we chose and why

Each decision here cost something. If you want to change one, first read its "why", then check what breaks.

## Money and database

| Decision | Why | Where |
|---|---|---|
| **BigInt minor units, never float, never Prisma Decimal** | `0.1 + 0.2 !== 0.3` in JS. Prisma Decimal has precision bugs on the write path. `50000.00 NSP` is stored as `5000000`. Scale (2) is frozen at seed — changing it later means a ledger migration | `src/common/helpers/money.util.ts`, seed |
| **Double-entry ledger, append-only** | when money goes missing, a plain balance column gives you a number with no story. The ledger gives who/when/why for every movement, and DB triggers refuse UPDATE/DELETE — even for us | `src/core/ledger/`, `prisma/sql/001,002` |
| **App connects as a NON-owner role (`ichancy_app`)** | `REVOKE` against an owner is a no-op in Postgres. Splitting migrator/app roles is what makes "the app cannot rewrite history" true | `prisma/sql/003`, `scripts/db-bootstrap.ts` |
| **Constraints in the DB, not only in code** (zero-sum trigger, four-eyes CHECK, partial unique on external reference) | code has bugs; a constraint holds even against buggy code and against a human with a SQL console | `prisma/sql/001..005` |
| **Uniqueness is the idempotency mechanism** (insert-first, never check-then-insert) | two concurrent requests both "check" and both pass. Only the unique index actually prevents the double | `src/core/idempotency/`, deposit create |
| **CAS state machine** — `UPDATE … WHERE status = <expected>` and 0 rows = handled outcome | double taps, webhook redeliveries, duplicate jobs all become harmless no-ops instead of double approvals | `deposit-state.machine.ts` |
| **Shared Postgres server, own database** | you already run postgres:16 for another project; a second server was waste. But NEVER the same database — backups and drops must stay independent. Verified: all guarantees hold on PG 16.13 and 17 | docker-compose `--profile local-db` |

## Process shape

| Decision | Why | Where |
|---|---|---|
| **One image, two roles (`APP_ROLE=api\|worker`)** | webhook must answer in ms; credits may take 30 s of retries. Different jobs, different processes. Crons must not double-fire, so `ScheduleModule` exists only in the worker | `main.ts`, `worker.module.ts` |
| **Transactional outbox** (`enqueue(tx, …)` — a `Tx` is REQUIRED) | you cannot commit Postgres and call HTTP atomically. Intent is committed with the money; a worker delivers it. The signature makes "fired the event but the tx rolled back" impossible to write | `src/core/outbox/` |
| **Webhook + queue, not polling** | polling works with exactly one process and loses confirmed messages on crash. Webhook + `telegram_updates` dedupe + queue survives crashes and scales. Cost: needs a public URL (ngrok in dev — a known pain, polling dev mode is planned) | `webhook.controller.ts` |
| **grammY, inside the worker, not a separate bot service** | Telegraf's last release is from 2024; the grammY Nest wrapper is archived. Handlers are Nest providers discovered at boot and call the SAME services as the HTTP controllers — no second auth surface, no HTTP hop | `src/core/telegram/` |

## Ichancy

| Decision | Why | Where |
|---|---|---|
| **Port + adapter (anti-corruption layer)** | Ichancy's API is non-standard (200-with-error, 201-for-unauthorized, no idempotency). All of that weirdness lives in ONE folder; the rest of the code sees a clean `IchancyResult = ok \| rejected \| ambiguous` | `src/core/ichancy/` |
| **Three outcomes, not two** | collapsing "rejected" and "timeout" into one `catch` is how cashiers double-credit. `ambiguous` is a first-class state that is never blindly retried | `ichancy.types.ts` |
| **Balance-delta verification** | their credit API has no idempotency key. So: read balance → credit → on timeout read again. Delta ≥ amount = it landed. One retry max, then a human. A per-player Redis lock covers the whole window or the delta means nothing | `deposit-credit.service.ts` |
| **Only the worker signs in** | Ichancy allows one token pair per agent; a second sign-in kills the first. Two processes signing in = they kill each other forever | `ichancy-session.service.ts` |
| **`ICHANCY_FAKE` in the validated env schema** | it was once read from raw `process.env`, where the schema had silently stripped it — the safety switch did nothing. Now it is validated config, and the worker LOGS which adapter it chose on every boot | `env.schema.ts`, `ichancy.module.ts` |
| **`ichancy_calls` records every attempt** (secrets redacted, long values truncated) | integration disputes are settled with records, not memories — while passwords and tokens never touch the table | schema, `ichancy-call-log.service.ts` |

## Rails (payment methods)

| Decision | Why | Where |
|---|---|---|
| **A rail = a DB row + a small driver file** | "how many ways can a user send money? we don't know yet" — correct answer: make adding a way cheap. New e-wallet = one driver + one seed row, no schema change | `src/modules/payment-method/rails/` |
| **CREATE vs SUBMIT validation stages** | at create time there is no receipt yet; requiring one made opening a deposit impossible (real bug, found by test). CREATE checks amount/destination only; SUBMIT demands reference/sender/receipt. Unknown stage = SUBMIT (fails closed) | `manual-rail.driver.ts` |
| **All rails MANUAL in v1** | admin approval is the product right now. Auto-verify (`tryAutoVerify`) exists in the interface, returns null, and is where crypto watchers plug in later | `rail.interface.ts` |

## Deliberately NOT built (choices, not accidents)

| Not built | Why |
|---|---|
| Withdrawals | they fail UNSAFE (money leaves). Need hold-first ordering + mandatory dual approval designed from scratch. v2 |
| Backend i18n | two clients, both localize. Backend returns stable error codes |
| GraphQL, CASL, multi-tenancy, websockets | enterprise weight from the reference codebase with no job here |
| OCR of receipts | duplicate-hash detection catches more fraud for a tenth of the cost. OCR later, as form pre-fill only |
| Card/PSP rail | gambling MCC needs licensing; revisit then |
