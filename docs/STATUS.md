# Status — where we are, what is left

Last updated: **2026-08-14**. Update this file when something big changes.

## ✅ Done and verified

| What | Proof |
|---|---|
| Full NestJS backend: 16 core parts, 6 modules, 51 HTTP endpoints | `tsc` 0 errors · eslint 0 · **713 unit tests pass** |
| Database on the shared postgres:16, own `ichancy` DB, non-owner app role | migrations + `db:bootstrap` + seed all green |
| Ledger safety enforced BY THE DATABASE | tested live: unbalanced posting rejected, one-sided rejected, app role refused UPDATE/DELETE on ledger + audit |
| Telegram bot: 13 commands + photo proof + admin Approve/Reject buttons | worker logs `Registered 16 Telegram handler(s)`; `/help` proven end-to-end through the real webhook path |
| Deposit can be OPENED with just an amount (CREATE/SUBMIT stage split) | was impossible before — bot AND Mini-App API were both dead on arrival; fixed + 68 new tests |
| 7 defects from adversarial review fixed | incl.: photo-only deposit could reach SUBMITTED with no reference; blank reference poisoned the unique index; admin edits after payment made proof impossible |
| Concurrency bugs fixed | player upsert race (20 parallel upserts → 1 row), `ICHANCY_FAKE` ignored (the safety switch did nothing), config vars stripped by the env loader |
| Admin group wired | bot posts + edits cards in supergroup `-1004382350658`; you (`912911246`) are SUPER_ADMIN with an approval limit |

## 🟡 True right now (2026-08-14)

- **Everything is STOPPED.** API, worker and ngrok are not running. See `RUNBOOK.md` to start.
- **Ichancy is FAKE.** No real credentials yet. No real money can move.
- **Payment destinations are PLACEHOLDERS.** A player who pays "to" them sends money nowhere. Replace via `POST /v1/admin/payment-methods/:id/destinations` before any real player.
- **Nothing is committed to git.** The whole project is uncommitted files on one machine. One disk failure = everything gone.
- The Telegram command MENU (BotFather list) still shows only the first 5 commands; the new ones work but are not in the menu.

## 🔨 Known gaps and debt (honest list)

| Gap | Impact | Planned fix |
|---|---|---|
| **Bot cannot collect the reference/sender text** — after `/deposit` + photo, bank/e-wallet deposits stay `AWAITING_PROOF` forever via bot alone (the rail demands reference + sender at SUBMIT) | bot-only players cannot finish a bank deposit | a reply-to-message text capture, or per-method config relaxing required fields; decide with the real rails |
| `DepositService` reached via `DiscoveryService` duck-typing in `player.handlers.ts` (module boundary blocks direct import) | works, but it is a workaround | publish a `DEPOSIT_PORT` token from `DepositModule` (~2 lines) and inject normally |
| Restated constants marked `MIRRORS` (queue statuses, break statuses, rail filter) | silent under-reporting if the originals drift | move the originals somewhere both sides may import |
| Fake-mode float alerts: `agent float DRIFT` ERROR every 5 min + low-float warnings in the admin group | alarm fatigue — trains you to ignore alerts | skip float sync alerts while `ICHANCY_FAKE=true` |
| `/float` command does not open a reconciliation break on drift (the HTTP endpoint does) | read-only inconsistency | route both through the same service |
| No dev polling mode — every bot test needs ngrok + webhook re-registration | the #1 source of "nothing works" so far | `TELEGRAM_POLLING=true`, worker-only, refuses to start if a webhook is registered |
| `crypto-manual` driver lists `TX_HASH`/`NETWORK` in `requiredProofFields` but nothing machine-checks them | reviewer must check by eye | fields on `RailSubmission` when crypto rail goes live |

## ▶️ Next (ordered)

1. **Commit to git.** Everything else is pointless if the disk dies.
2. Dev polling mode (kill the ngrok pain).
3. Silence fake-mode float alerts + update the BotFather command menu.
4. Bot text-capture for reference/sender → first END-TO-END deposit on the fake: `/deposit` → pay → proof → Approve in the group → `CREDITED`, ledger balanced. **This is the milestone that proves the product.**
5. `DEPOSIT_PORT` cleanup.

## 🔮 Then (needs things from outside)

| Needs | What |
|---|---|
| Ichancy agent credentials (base URL, username, password, agent id) | `ICHANCY_FAKE=false`, test with ONE small deposit, read `ichancy_calls`, fill `error-map.ts` with the real error strings — the docs PDF lists ~12, reality will have more |
| Real bank / e-wallet details | replace placeholder destinations, set real min/max per method |
| A real server + domain | deploy api + worker + redis + postgres; webhook on the domain; ngrok retired |

## 🔭 Future (designed for, not started)

- **Mini App frontend** — the API is ready for it (`POST /v1/auth/telegram` initData login, deposits, wallet). Build AFTER the bot flow works end to end, so the screens copy a proven flow.
- **Withdrawals** — mirror flow but fails UNSAFE; hold-first + mandatory dual approval; roughly +40% schema.
- **Rail automation** — order of value: Crypto Pay/Wallet Pay webhook → TON with memo → USDT TRC-20 per-player addresses → bank statement import. Each is one driver file + `tryAutoVerify`.
- **KYC tiers / limits enforcement** — `PlayerLimit` and `SelfExclusion` exist and are checked by `deposit-policy.service.ts` today. A `kycTier` column does NOT exist yet — add it when KYC work starts; real screening providers when licensing starts.
- Referral rewards, gift codes, promotions (the competitor-bot features) — all sit ON TOP of the ledger; none require schema surgery.
