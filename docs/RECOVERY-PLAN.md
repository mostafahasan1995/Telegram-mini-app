# Recovery plan — rebuilding the lost backend & mini-app work

> Generated from a 34-agent audit that cross-referenced the **dashboard** (the only repo whose
> latest work survived) against the **backend** and **mini-app**. The dashboard is the
> specification of record: it is an API client, so its contract doc, MSW mocks and types state
> exactly what the missing backend must do.

Companion file: [`RECOVERY-GAPS.json`](./RECOVERY-GAPS.json) — all 255 gaps with concrete
request/response shapes, evidence, dependencies and rebuild notes. Use that as the input when
rebuilding each endpoint; this file is the map and the order.

---

## 1. What happened

| Repo | Role | Last commit | Date | Lag |
|---|---|---|---|---|
| `manager-account-dashboard` | Admin dashboard | `dfaa738` | **2026-09-09** | — |
| `telegram-balance-bot` | Telegram mini app | `db9a2f2` | 2026-08-26 | 14 days |
| `Telegram-mini-app` | Backend (NestJS) | `8125cc8` | 2026-08-20 | **20 days** |

All three working trees are clean and exactly match their remotes. `git reflog` and
`git fsck --lost-found` found **no stashes, no dangling commits, no unpushed branches** on any
of them. The lost work existed only on the other PC.

### Likely root cause

`C:\Users\dell\Desktop\.git` is a stray clone of `shamkey-dashboard` sitting at the Desktop
root, and `Desktop\bot\` has no `.git` of its own. So **any git command run from `Desktop\bot`
silently operates on the Desktop repo instead of the project**. A push of "backend + front app"
issued from that directory would not reach either project remote. The dashboard survived because
it was pushed from inside its own folder.

> ⚠️ Never run `git clean -fdx` from `Desktop` — it would delete 141 entries.

---

## 2. Verdict: the rebuild is transcription, not guesswork

The dashboard carries a near-complete executable spec of the missing backend:

| Asset | Size | What it gives you |
|---|---|---|
| `docs/API-CONTRACT.md` | 88 KB | "The backend contract this console is built against" — 125 endpoints, envelope, auth, roles |
| `src/mocks/handlers.ts` | 107 KB | MSW mocks — concrete request **and** response JSON per route |
| `src/lib/api/queries.ts` | 77 KB | react-query hooks showing real field usage |
| `src/lib/api/endpoints.ts` | 44 KB | Every path the UI calls |
| `src/types/*.ts` | 20 files | Full entity models |
| `docs/TASKS.md` | 142 KB | Roadmap state as of 2026-09-09 |

Backend today: **14 controllers / 47 routes**, and zero occurrences of `tenant`, `shamcash`,
`bot-menu`, `exchange-rate`, `stats`, or `PLATFORM_ADMIN` anywhere in `src/` or `prisma/`.

The backend is a coherent *pre-window snapshot*. It even states the old world in its own comments —
`activity-report.service.ts:189`: *"there is deliberately NO withdrawals section — withdrawals do not exist"*.

---

## 3. Scoreboard

**255 confirmed gaps** across 17 domains — 105 blockers, 68 major, 17 minor.
Every gap was adversarially re-verified against the real backend source; only **1** claim was refuted.

| Domain | Dashboard expects | Backend has | Gaps | Prisma gaps |
|---|---:|---:|---:|---:|
| `auth` | 2 | 6 | **10** | 11 |
| `tenants` | 20 | 2 | **26** | 13 |
| `staff` | 8 | 8 | **13** | 12 |
| `players` | 11 | 3 | **14** | 11 |
| `deposits` | 12 | 16 | **5** | 7 |
| `withdrawals` | 5 | 0 | **11** | 13 |
| `payment-methods` | 13 | 11 | **18** | 13 |
| `platform-finance` | 8 | 5 | **12** | 9 |
| `shamcash` | 13 | 0 | **16** | 10 |
| `reconciliation` | 9 | 8 | **8** | 3 |
| `stats` | 6 | 3 | **6** | 6 |
| `telegram-bot-config` | 19 | 1 | **23** | 15 |
| `wallet-and-rates` | 4 | 1 | **8** | 7 |
| `settings-misc-health` | 3 | 10 | **8** | 5 |
| `data-model` | 18 | 40 | **29** | 36 |
| `mini-app` | 8 | 16 | **15** | 7 |
| `gap-window-history` | 58 | 8 | **33** | 22 |

---

## 4. Rebuild order

Dependency-ordered. Phase 1 is a hard prerequisite for almost everything else: the tenant claim,
`tenantId` scoping and `PLATFORM_ADMIN` are woven through every later domain.

The phases below account for **193 of the 255 gaps**. The remaining two domains are cross-cutting
rather than schedulable, and are folded into the phases above:

- **`data-model` (29 gaps)** — the Prisma models/enums/columns each phase needs. They appear as the
  *"Schema work first"* list at the head of each phase. Full definitions are in
  [`RECOVERY-GAPS.json`](./RECOVERY-GAPS.json) under `domain: "data-model"`, including proposed model
  bodies. Read that domain's note in §5 **before** starting Phase 1 — the tenant-scoping rewrite
  (`@unique` → `@@unique([tenantId, …])` across every scoped model) touches the whole schema at once
  and is far cheaper to do in one migration than incrementally.
- **`gap-window-history` (33 gaps)** — the chronological reconstruction of what was being built
  between 2026-08-20 and 2026-09-09, derived from dashboard commits and `TASKS.md`. These are the
  same features as the phases, expressed as lost work items with the commit evidence that proves they
  existed. Use it to sanity-check that a phase is complete, and to recover intent the endpoint list
  alone does not carry (e.g. which migration filenames were used).

### Phase 0 — Stop the bleeding (repo hygiene)

1. Confirm you no longer need `C:\Users\dell\Desktop\.git`, then remove it so Desktop stops
   shadowing your projects. Verify with `git -C C:/Users/dell/Desktop/bot rev-parse --show-toplevel`
   — it should fail, not print `C:/Users/dell/Desktop`.
2. Check the other PC one more time before writing any code: look for unpushed commits
   (`git log --branches --not --remotes`), stashes, and IDE local history
   (`.idea/shelf`, VS Code `History`). Anything recovered there saves days.
3. Work on a branch per phase; push after every phase.

### Phase 1 — Multi-tenant core — everything else depends on it

*Domains: `tenants` — 26 gaps (14 blockers)*

**Schema work first:**

- model Tenant — confirmed absent. prisma/schema.prisma declares exactly 36 models/enums (lines 35-946): PlayerStatus, AdminRole, ActorType, PaymentRail, VerificationMode, DepositStatus, RejectionCode, ProofSource, LedgerAccountKind, LedgerTxKind, IchancyOperation, IchancyOutcome, OutboxStatus, BreakCategory, BreakStatus, CreditVerifiedBy, Currency, PaymentMethod, PaymentDestination, Player, PlayerSession, AdminUser, AdminApprovalLimit, DepositRequest, DepositProof, DepositTransition, LedgerAccount, LedgerTransaction, LedgerEntry, OutboxMessage, IdempotencyKey, TelegramUpdate, IchancyCall, AuditLog, ReconciliationBreak, PlayerLimit, SelfExclusion. No Tenant.
- enum TenantStatus { ACTIVE SUSPENDED CLOSED } — confirmed absent from the enum list above.
- enum DepositMode and enum WithdrawalMode — confirmed absent. The only mode-ish enum is VerificationMode (schema.prisma:75), which is about proof verification, not deposit/withdrawal automation.
- AdminRole is missing PLATFORM_ADMIN — confirmed at prisma/schema.prisma:46-54.
- model PlatformDefaults — confirmed absent; `grep -rniE "platform.?default\|house.?agent" src prisma` returns 0 lines.
- tenant_id column + FK missing on EVERY scoped model — confirmed: `grep -rni tenant src prisma` returns 0 lines total across the whole backend (src + prisma).
- AdminUser.telegramUserId is `BigInt @unique @map("telegram_user_id")` at prisma/schema.prisma:422 — confirmed global unique; must become @@unique([tenantId, telegramUserId]).
- AdminUser.username is `String? @unique` at prisma/schema.prisma:423 — confirmed global unique; must become @@unique([tenantId, username]).
- Player.telegramUserId is `BigInt @unique` at prisma/schema.prisma:344, and Player.ichancyPlayerId (355), Player.ichancyLogin (357), Player.ichancyEmail (358) are all globally `@unique` — confirmed; all four need to become tenant-composite.
- prisma/sql/006 (the CHECK forbidding a PLATFORM_ADMIN row outside tenant zero) — confirmed absent. prisma/sql/ contains only 001_ledger_balanced_trigger.sql, 002_immutability.sql, 003_app_role_grants.sql, 004_partial_indexes.sql, 005_four_eyes_check.sql, README.md.
- Tenant-zero seed row + TENANT_ZERO_ID constant — confirmed absent. prisma/seed/ holds only admin.seed.ts, client.ts, currency.seed.ts, index.ts, ledger-account.seed.ts, payment-method.seed.ts, and package.json has no tenant:bootstrap or admin:platform script (full script list: dev:api dev:worker build start:api start:worker lint lint:fix format typecheck test test:watch test:cov test:int playwright:install prisma:generate prisma:migrate db:bootstrap db:setup prisma:deploy prisma:studio seed webhook:set tunnel:sync bot:setup admin:code ichancy:check ichancy:check:signin player:register).
- Per-tenant Telegram destinations model — confirmed absent. admin/feed chat ids are single env values: src/core/config/config.service.ts:58 (adminChatId: bigint), :64 (feedChatId: bigint \| null), populated at :188-189 from TELEGRAM_ADMIN_CHAT_ID / TELEGRAM_FEED_CHAT_ID. No destinations table, no @@unique([tenant_id, chat_id]).
- Row-level security policies — confirmed absent; no RLS statements in prisma/sql/001-005 (003_app_role_grants.sql does GRANTs only), and no plan-multitenant.md exists in the backend repo (docs/ holds only ARCHITECTURE.md, DECISIONS.md, RUNBOOK.md, STATUS.md).

**Endpoints:**

| Sev | Endpoint | Purpose |
|---|---|---|
| 🔴 | `GET /v1/admin/tenants` | List operators — the Operators screen |
| 🔴 | `GET /v1/admin/tenants/:id` | One operator for the detail panel |
| 🔴 | `POST /v1/admin/tenants` | Create an operator and provision it end to end (defaults resolve, getMe verify, seal secrets, CSPRNG webhook path token + secret, row lands SUSPENDED… |
| 🔴 | `PATCH /v1/admin/tenants/:id` | Edit an operator's mutable settings; response is the row the detail panel re-renders from |
| 🔴 | `POST /v1/admin/tenants/:id/activate` | Second step: real Ichancy signin with that operator's credentials; refuses to activate if the agent does not answer |
| 🔴 | `POST /v1/admin/tenants/:id/suspend` | Stop an operator serving |
| 🔴 | `POST /v1/admin/tenants/:id/webhook` | Register this operator's webhook with Telegram — without it a newly created operator's bot receives nothing |
| 🔴 | `POST /v1/admin/tenants/:id/bot-setup` | Push command menus to this operator's bot so /start and the rest appear |
| 🔴 | `GET /v1/admin/tenants/:id/health` | Bot, webhook, Ichancy agent and float in one on-demand call |
| 🔴 | `GET /v1/admin/platform-defaults` | The single settings row every NEW operator inherits from |
| 🔴 | `PATCH /v1/admin/platform-defaults` | Edit those defaults; absent key leaves the stored value alone; does not reach back into existing operators |
| 🔴 | `GET /v1/admin/finance/balances` | Every operator's finance balances in one cheap overview (agent float present; USDT wallets and Sham Cash come back not_loaded) |
| 🔴 | `ALL /v1/admin/* — `tid` token claim, tenant-context middleware, X-Tenant-Id override` | Structural spine: HOME tenant (identity, immovable) vs EFFECTIVE tenant (whose data is read) |
| 🔴 | `N/A AdminRole.PLATFORM_ADMIN (enum value)` | The role every tenants / platform-defaults / finance / stats route requires |
| 🟠 | `DELETE /v1/admin/tenants/:id/webhook` | Unregister — stop delivery without suspending |
| 🟠 | `PATCH /v1/admin/tenants/:id/ichancy` | Change base URL / username / password / agent id, re-verified with a real signin before saving |
| 🟠 | `PATCH /v1/admin/tenants/:id/bot` | Replace the bot token — verified with getMe before sealing; invalidates the cached bot |
| 🟠 | `POST /v1/admin/tenants/:id/import-players` | Platform-side re-run of the Ichancy player import for one operator; repeatable, known rows count as `existing` |
| 🟠 | `POST /v1/admin/finance/tenants/:tenantId/refresh` | The expensive per-operator read: loads that operator's USDT wallets and Sham Cash and answers the freshened row |
| 🟠 | `GET /v1/admin/stats/tenants` | Every ACTIVE operator's stats side by side — the platform dashboard |
| 🟡 | `GET /v1/admin/stats` | The tenant-scoped stats endpoint (the in-operator dashboard), distinct from /v1/admin/stats/tenants. No stats controller exists at all — `grep -rniE … |
| 🟡 | `N/A Sham Cash rail — entirely absent from the backend` | The Tenant model is specified to carry shamcash_wallet_id + shamcash_api_key_enc, and GET /v1/admin/finance/balances and the per-tenant refresh both … |
| 🟡 | `N/A Per-tenant bot registry / cache invalidation — src/core/telegram/services/bot.factory.ts` | bot.factory.ts:63 builds ONE Bot from the env token and caches getMe in Redis under a single key (BOT_INFO_TTL_SECONDS). PATCH /tenants/:id/bot is sp… |
| 🟡 | `N/A Per-tenant Ichancy adapter factory — src/core/ichancy/http-ichancy.adapter.ts` | The adapter is a process-global singleton that reads AppConfigService directly (this.config.ichancy.agentId at :89, this.config.ichancy.currency at :… |
| 🟡 | `N/A Webhook path token IS present but global — src/core/telegram/controllers/webhook.controller.ts` | Correction to the claimed evidence for gaps 3 and 7: `config.telegram.webhookPathToken` DOES exist and the webhook route already does a constant-time… |
| 🟡 | `N/A Secret-sealing helper exists in the wrong place — src/modules/player/utils/secret-box.util.ts` | Correction to the claimed evidence for gap 3: there is no sealBotToken/sealIchancyPassword, but there IS a working AES secret box (src/modules/player… |

### Phase 2 — Console auth — replaces bot-code login

*Domains: `auth`, `staff` — 23 gaps (10 blockers)*

**Schema work first:**

- `model Tenant` — CONFIRMED ABSENT. `grep -rni tenant prisma` returns zero hits in schema.prisma AND in both migrations (20260813101853_init, 20260820120000_player_link_backfill). Needs id/slug(unique)/displayName/status(ACTIVE\|SUSPENDED\|CLOSED)/ichancyBaseUrl/ichancyUsername/ichancyPasswordEnc/ichancyAgentId?/currencyCode per dashboard src/types/tenant.ts:14-24,85-93.
- `enum AdminRole` prisma/schema.prisma:46-54 — CONFIRMED five values (SUPER_ADMIN, FINANCE_ADMIN, REVIEWER, SUPPORT, VIEWER); PLATFORM_ADMIN missing.
- `AdminUser.tenantId` — CONFIRMED ABSENT. Full model read at prisma/schema.prisma:420-446: id, telegramUserId, username, displayName, role, isActive, passwordHash, totpSecretEnc, lastLoginAt, createdAt, updatedAt + relations. No tenant column, no tenant relation.
- `AdminUser.telegramUserId BigInt @unique` at prisma/schema.prisma:422 — CONFIRMED NOT NULL. Must become `BigInt?` for password-only managers (dashboard src/types/admin.ts:8-9 declares it nullable, and adminIdentitySchema :28 nullable too).
- GLOBAL uniques CONFIRMED: prisma/schema.prisma:422 `telegramUserId BigInt @unique` and :423 `username String? @unique`; the model's only @@ block is `@@index([role, isActive])` at :443. Both must become @@unique([tenantId, ...]).
- `AdminUser.passwordHash` at prisma/schema.prisma:428 — CONFIRMED DEAD. `grep -rni "passwordHash\|password_hash" src` returns exactly ONE hit, a comment at src/modules/admin/dtos/admin-user.dto.ts:102 saying the view never exposes it. Nothing writes, reads or hashes it, and argon2/bcrypt is not even a package.json dependency.
- `AdminUser.lastLoginAt` at prisma/schema.prisma:430 — CONFIRMED NEVER WRITTEN. `grep -rn lastLoginAt src` returns two hits only: the view field (admin-user.dto.ts:110) and the read mapper (admin-user.service.ts:47). No update anywhere.
- No CHECK constraint confining PLATFORM_ADMIN to tenant zero — CONFIRMED; there is no tenant concept at all to constrain, and migrations contain no CHECK for admin_users.
- `AuditLog` has no tenantId — CONFIRMED via the zero-hit tenant grep over prisma/. `action` is free text so no enum change needed for 'admin.user.agentPrincipalCreated'.
- `AdminApprovalLimit` prisma/schema.prisma:446-471 — CONFIRMED no tenantId: adminUserId, currencyCode, three minor-unit columns, effectiveFrom/To, createdAt, @@unique([adminUserId, currencyCode, effectiveFrom]).
- No admin session/refresh row — CONFIRMED and CORRECT AS-IS. src/modules/admin/dtos/admin-auth.dto.ts:36-46 states admin tokens are stateless with no session row and AdminSessionView has no refreshToken. Do NOT add one.
- CONFIRMED — enum AdminRole (prisma/schema.prisma:46-54) has only SUPER_ADMIN, FINANCE_ADMIN, REVIEWER, SUPPORT, VIEWER. PLATFORM_ADMIN appears nowhere in src, prisma, scripts or package.json (grep returns zero). Needs an enum-value migration.
- CONFIRMED — no Tenant model: `grep -rni 'tenant' src prisma scripts package.json` returns ZERO hits in the entire backend. The whole multi-tenant layer (model, FK, JWT claim, X-Tenant-Id override) is absent, not merely unwired.
- CONFIRMED — AdminUser (prisma/schema.prisma:420-444) has no tenantId column and no Tenant relation.
- …and 9 more (see `RECOVERY-GAPS.json`)

**Endpoints:**

| Sev | Endpoint | Purpose |
|---|---|---|
| 🔴 | `POST /v1/admin/auth/credentials` | Username/email + password sign-in — the console's only door. Server tries the caller's console credential first, then the operator's Ichancy agent ac… |
| 🔴 | `(cross-cutting) JWT `tid` claim + tenant-context middleware + X-Tenant-Id override` | The tenant claim AdminSession.tenantId/tenantSlug carries and every later request assumes; lets a PLATFORM_ADMIN point a request at another operator. |
| 🔴 | `(cross-cutting) AdminRole.PLATFORM_ADMIN + role-guard superset semantics` | Sixth role, treated by the dashboard as the owner superset holding every capability; gates Operators, platform finance and the tenant switcher. |
| 🔴 | `POST/PATCH /v1/admin/admins (username + password credential management)` | Creating and re-crediting the console login that /credentials verifies: CreateAdminBody { displayName, role, username, password } with NO telegramUse… |
| 🔴 | `GET /v1/admin/admins, /v1/admin/admins/:id (and every mutation response)` | Return AdminUserView in the shape the console's adminUserSchema parses (hasPassword, nullable telegramUserId). |
| 🔴 | `POST /v1/admin/admins` | Create a staff account from displayName, role, username and password (the only way to add staff since 2026-09-05). |
| 🔴 | `PATCH /v1/admin/admins/:id` | Edit a staff account including setting/replacing the console password (omitted = unchanged). |
| 🔴 | `ALL /v1/admin/admins/**, /v1/admin/approval-limits/**` | Let PLATFORM_ADMIN read and write the staff directory and approval limits. |
| 🔴 | `ALL /v1/admin/admins/**, /v1/admin/admins/:adminUserId/approval-limits` | Scope the staff directory and approval limits to the caller's tenant. |
| 🔴 | `POST /v1/admin/auth/credentials` | Sign in with a staff username and password — the console's only sign-in. |
| 🟠 | `POST /v1/admin/auth/ichancy` | Ichancy agent credential on its own published route (steps 2-4 of /credentials), answering AGENT_CREDENTIALS_INVALID. Kept alive for the Flutter cons… |
| 🟠 | `POST/PATCH /v1/admin/admins, /v1/admin/admins/:id` | Enforce mayGrantRole — refuse to grant PLATFORM_ADMIN unless the actor holds it AND has no tenant override. |
| 🟠 | `GET /v1/admin/admins?role=PLATFORM_ADMIN` | Accept PLATFORM_ADMIN as a role filter value. |
| 🟡 | `(cross-cutting) throttle rule for /v1/admin/auth/credentials and /v1/admin/auth/ichancy` | 10 attempts/minute then blocked 15 minutes — longer than bot-code because a password does not expire on its own. |
| 🟡 | `PATCH /v1/admin/admins/:id` | Refuse ANY self-edit with ADMIN_SELF_MODIFICATION, not only role/isActive changes. |
| 🟡 | `(response shape) AdminSessionView / AdminIdentityView` | The sign-in response is missing tenantId + tenantSlug, and telegramUserId is the wrong nullability for a password-only manager. |
| 🟡 | `(error codes) src/modules/admin/enums/admin-error-code.enum.ts` | The credential-login error vocabulary the dashboard switches on does not exist. |
| 🟡 | `(dependency) package.json` | No password-hashing library is installed at all. |
| 🟡 | `(CORS) src/main.ts:181` | X-Tenant-Id is not in allowedHeaders, so the browser preflight blocks the override before any backend code sees it. |
| 🟡 | `POST /v1/admin/auth/ichancy` | Sign in as the operator's Ichancy agent account (the second credential behind the same two fields), with the four AGENT_* failure codes. |
| 🟡 | `CONFIG src/core/throttler/throttle-routes.ts` | Rate-limit the credentials sign-in (10/min, 15-minute block) — and remove the now-dead bot-code rule, which will otherwise crash the app at boot. |
| 🟡 | `WRITE AdminUser.lastLoginAt` | Actually stamp lastLoginAt when a staff member signs in. |
| 🟡 | `DELETE bot /console command + AdminLoginCodeService` | Remove the retired Telegram bot-code door that the contract says was deleted on 2026-09-05. |

### Phase 3 — Player shape changes

*Domains: `players` — 14 gaps (8 blockers)*

**Schema work first:**

- CONFIRMED: Player.telegramUserId is `BigInt @unique @map("telegram_user_id")` at prisma/schema.prisma:344 — NOT NULL. Must become `BigInt?` for ICHANCY_IMPORT/ADMIN rows. Read paths that break on null: toPlayerView (src/modules/player/dtos/player.view.ts:41, `player.telegramUserId.toString()`) — note this is the SHARED mapper, so the mini-app's GET /v1/me and GET /v1/wallet identity path are affected too, not just the admin views. Uniqueness must become per-tenant for PLAYER_TELEGRAM_ID_TAKEN's 'another player in this operator' rule.
- CONFIRMED: `enum PlayerSource { TELEGRAM ICHANCY_IMPORT ADMIN }` does not exist and Player.source does not exist — the enum inventory in prisma/schema.prisma is PlayerStatus, AdminRole, ActorType, PaymentRail, VerificationMode, DepositStatus, RejectionCode, ProofSource, LedgerAccountKind, LedgerTxKind, IchancyOperation, IchancyOutcome, OutboxStatus, BreakCategory, BreakStatus, CreditVerifiedBy. Default TELEGRAM for existing rows.
- CONFIRMED: enum PlayerStatus (prisma/schema.prisma:35-44) is PENDING_ICHANCY, ACTIVE, SUSPENDED, SELF_EXCLUDED, CLOSED — no BLOCKED.
- CONFIRMED: Player (prisma/schema.prisma:341-393) has no blockedAt, no blockedReason, no blockedByAdminId and no relation to AdminUser for one. All three are present-but-nullable keys in the dashboard's adminPlayerSchema (src/types/player.ts:42-44).
- CONFIRMED: no `model PlayerDebit` and no `enum PlayerDebitStatus` anywhere in prisma/schema.prisma. CreditVerifiedBy DOES already exist (prisma/schema.prisma:239) and is reusable, as claimed.
- CONFIRMED: enum AdminRole (prisma/schema.prisma:46-54) is SUPER_ADMIN, FINANCE_ADMIN, REVIEWER, SUPPORT, VIEWER — grep -rni PLATFORM_ADMIN over src+prisma returns ZERO hits. PLAYER_READER_ROLES (src/modules/player/player.constants.ts:154-159) correspondingly lists only SUPER_ADMIN/FINANCE_ADMIN/REVIEWER/SUPPORT, and PLAYER_ICHANCY_MANAGER_ROLES (:167-170) only SUPER_ADMIN/FINANCE_ADMIN.
- CONFIRMED: `grep -in tenant prisma/schema.prisma` returns zero hits, and `grep -rni 'x-tenant\|tenantId' src` returns zero hits — the backend does not read the X-Tenant-Id header the dashboard sends on every request (src/lib/api/client.ts). No Tenant model, no Player.tenantId, no tenant module in src/modules (admin, deposit, payment-method, player, reconciliation, wallet only).
- CONFIRMED: Player.ichancyPlayerId, ichancyLogin and ichancyEmail are each global `@unique` (prisma/schema.prisma:355, :357, :359). Must become composite uniques with tenantId once tenants exist, or two operators sharing an Ichancy agent collide on import.
- CONFIRMED: Player's indexes are @@index([status]), @@index([createdAt]) and @@index([status, ichancyLinkNextAttemptAt]) only (prisma/schema.prisma:388-391) — nothing for source or blockedAt. And toPlayerWhere's search (src/modules/player/utils/player-filter.util.ts:40-45) covers telegramUsername/firstName/lastName/ichancyLogin, not phone.
- ADDITIONAL (missed by the first agent): enum PaymentRail (prisma/schema.prisma:64-73) has BANK_TRANSFER, MOBILE_WALLET, CASH_OFFICE, CRYPTO, INTERNAL — no MANUAL_CREDIT rail and no seeded manual-credit PaymentMethod for POST /v1/admin/deposits/manual to hang off.
- NOT a gap, verified: model PlayerLimit (prisma/schema.prisma:918) and model SelfExclusion (prisma/schema.prisma:946) both exist and are wired to Player (relations `limits` and `selfExclusions`, schema.prisma:384-385) and actively used by PlayerService.checkEligibility (src/modules/player/services/player.service.ts:129-149). The dashboard exposes no endpoints for either.

**Endpoints:**

| Sev | Endpoint | Purpose |
|---|---|---|
| 🔴 | `GET /v1/admin/players` | Player directory powering the /players page (segment tabs, filters, table). |
| 🔴 | `GET /v1/admin/players/:id` | Player detail header, identity card, blocked alert. |
| 🔴 | `GET /v1/admin/players/:id/balance` | One player's live Ichancy balance — table balance column and detail-page balance pill. |
| 🔴 | `POST /v1/admin/players` | Register a player from the console (source=ADMIN), optionally linking Ichancy on the way out. |
| 🔴 | `POST /v1/admin/players/:id/block` | Operator's own lock on a player. |
| 🔴 | `POST /v1/admin/players/:id/unblock` | Lift the operator's lock. |
| 🔴 | `POST /v1/admin/players/:id/debit` | Manual debit — money taken back out of a player's Ichancy account into the agent float. |
| 🔴 | `POST /v1/admin/deposits/manual` | Manual credit ('add points') recorded as a manual-rail deposit; backs credit-player-dialog.tsx. |
| 🟠 | `PATCH /v1/admin/players/:id/telegram` | Attach a Telegram id to an imported or admin-registered row that has none. |
| 🟠 | `POST /v1/admin/players/import` | Import the operator's pre-existing Ichancy agent accounts as ICHANCY_IMPORT rows ('old players'); the Import button on the players page. |
| 🟡 | `POST /v1/admin/tenants/:id/import-players` | Platform-side import of an operator's Ichancy agent accounts (the tenant-scoped twin of POST /v1/admin/players/import). Backs TenantImportPlayersCard… |
| 🟡 | `N/A src/modules/deposit/services/deposit-policy.service.ts:94-112` | A BLOCKED player must be refused by the deposit gate, but assertPlayerActive is a DENY-list. |
| 🟡 | `N/A src/modules/player/services/player-link-backfill.service.ts:259-302` | Blocking overloads `status`, which silently drops rows out of the Ichancy backfill selector. |
| 🟡 | `N/A src/modules/player/controllers/player-admin.controller.ts:71` | GET /v1/admin/players/:id declares `Promise<PlayerView>` while returning an AdminPlayerView at runtime. |

### Phase 4 — Withdrawals — an entire missing module

*Domains: `withdrawals` — 11 gaps (5 blockers)*

**Schema work first:**

- model WithdrawalRequest — CONFIRMED absent. `grep -n '^model ' prisma/schema.prisma` gives exactly the 21 models the first agent listed (Currency 251 … SelfExclusion 946); `grep -ni 'withdraw\|payout' prisma/schema.prisma` matches ONLY IchancyOperation members WITHDRAW_FROM_AGENT (177) and WITHDRAW_FROM_PLAYER (182) plus two unrelated 'debit-normal' comments. Model it on DepositRequest (schema.prisma:473-568) with the column list the auditor gave; shortId via src/common/helpers/short-id.util.ts.
- enum WithdrawalStatus { REQUESTED APPROVED DEBITING DEBITED PAID DEBIT_FAILED NEEDS_RECONCILIATION REJECTED CANCELLED } — CONFIRMED absent. Only DepositStatus exists (schema.prisma:87).
- enum WithdrawalMode { AUTO MANUAL } — CONFIRMED absent from schema.prisma's enum list.
- enum WalletCheckStatus { ok insufficient unknown not_configured } — CONFIRMED absent. Enforce the never-0 rule as a data constraint: availableMinor/currency NULL for unknown and not_configured.
- model WithdrawalTransition — CONFIRMED absent; DepositTransition (schema.prisma:602) is the template for the append-only from/to/at/byAdminId/reason timeline.
- LedgerTxKind (schema.prisma:154-170) has no withdrawal member — verified by reading the enum body in full: DEPOSIT_CLAIM, DEPOSIT_CREDIT, DEPOSIT_REVERSAL, AGENT_FLOAT_TOPUP, AGENT_FLOAT_SYNC, FEE, ROUNDING, MANUAL_ADJUSTMENT, RECONCILIATION_WRITEOFF. Needs WITHDRAWAL_DEBIT, WITHDRAWAL_PAYOUT, WITHDRAWAL_REVERSAL + rules in src/core/ledger/posting-rules.ts.
- Relations back to WithdrawalRequest missing on Player, PaymentMethod, PaymentDestination, Currency, AdminUser (WithdrawalDecidedBy + WithdrawalPaidBy), LedgerTransaction, IchancyCall (schema.prisma:805 links only to DepositRequest) and ReconciliationBreak — CONFIRMED, no such field names appear anywhere in the schema.
- BreakCategory (schema.prisma:214-225) read in full = AGENT_FLOAT_MISMATCH, PLAYER_BALANCE_MISMATCH, MISSING_CREDIT, DUPLICATE_CREDIT, UNIDENTIFIED_RECEIPT, LEDGER_IMBALANCE, ORPHAN_ICHANCY_CALL, STUCK_DEPOSIT — CONFIRMED no STUCK_WITHDRAWAL / MISSING_PAYOUT.
- No withdrawalMode setting anywhere — CONFIRMED: `grep -rn -il 'bot-menu\|botMenu\|withdrawalMode\|tenant' src` returns ZERO files. No bot-menu module, no Tenant model, no settings column. Until it exists every row must be created MANUAL.
- No Tenant/tenantId column at all — CONFIRMED (same zero-hit grep); every model is single-tenant.
- AdminRole (schema.prisma:46-54) read in full = SUPER_ADMIN, FINANCE_ADMIN, REVIEWER, SUPPORT, VIEWER — CONFIRMED no PLATFORM_ADMIN, which docs/API-CONTRACT.md:158 lists in the withdrawals.read set.
- TASKS in src/core/queue/queue.types.ts has no withdrawal task — CONFIRMED: only ICHANCY_DEPOSIT_CREDIT (24), ICHANCY_PLAYER_REGISTER (26), ICHANCY_AGENT_FLOAT_SYNC (28), each mapped in TASK_QUEUE at 137-139. Add ICHANCY_WITHDRAWAL_DEBIT: 'ichancy.withdrawal.debit' with its payload type and QUEUE_NAMES.ICHANCY mapping.
- WITHDRAWAL_NOT_FOUND / WITHDRAWAL_INVALID_STATE / WITHDRAWAL_INSUFFICIENT_BALANCE absent from src/common/exceptions/error-codes.ts — CONFIRMED (grep for WITHDRAW\|PAYOUT\|INVALID_STATE\|INSUFFICIENT matched only line 30 INSUFFICIENT_ROLE).

**Endpoints:**

| Sev | Endpoint | Purpose |
|---|---|---|
| 🔴 | `GET /v1/admin/withdrawals` | The withdrawal queue — the entire /withdrawals route of the console. Offset-paginated, filters status/playerId/shortId/createdFrom/createdTo/sort/lim… |
| 🔴 | `GET /v1/admin/withdrawals/:id` | One withdrawal for the detail sheet (payout address, wallet check, timeline, failure text); fetched on load when ?selected=<id>. |
| 🔴 | `POST /v1/admin/withdrawals/:id/approve` | REQUESTED -> APPROVED (the human decision MANUAL mode waits for); the worker then debits the player and checks the payout wallet. |
| 🔴 | `POST /v1/admin/withdrawals/:id/reject` | REQUESTED -> REJECTED with a reason (1..280). Nothing was taken from the player, so no ledger movement. |
| 🔴 | `POST /v1/admin/withdrawals/:id/mark-paid` | DEBITED -> PAID with payoutReference (1..128); server posts the payout to the ledger and closes the row. |
| 🟡 | `POST /v1/withdrawals (player-facing create) + GET /v1/withdrawals + POST /v1/withdrawals/:shortId/cancel` | The creation and player-cancel path the admin queue depends on. docs/API-CONTRACT.md:544-545 defines CANCELLED as 'the player, while still REQUESTED'… |
| 🟡 | `SERVICE shared player-debit service (mutex + two attempts + balance-delta verify)` | The contract says approve hands off to 'the same debit service a manual debit uses'. Not only is there no withdrawal caller — there is NO caller of d… |
| 🟡 | `SERVICE payout wallet-check port/adapter (walletCheck field)` | AdminWithdrawalView.walletCheck { status, availableMinor, currency, checkedAt } is filled after the debit by asking the payout wallet what it holds. … |
| 🟡 | `WORKER WithdrawalDebitProcessor + withdrawal outbox handler + withdrawal Telegram cards` | APPROVED -> DEBITING -> DEBITED/DEBIT_FAILED/NEEDS_RECONCILIATION is a worker transition, and the console's float pill going up depends on it. Also t… |
| 🟡 | `BOT Telegram 'withdraw' built-in action / cash-out flow` | docs/API-CONTRACT.md:495-496 makes REQUIRED_BUILTIN_ACTIONS = deposit, withdraw, profile — the bot menu must always carry a live withdraw button, and… |
| 🟡 | `NOTE src/modules/admin/services/activity-report.service.ts:186-190` | Live in-code marker that must be revisited when the module lands: the report deliberately omits a withdrawals section ('withdrawals do not exist in t… |

### Phase 5 — Money rails: rates, chain verification, balances

*Domains: `wallet-and-rates`, `platform-finance`, `payment-methods`, `deposits` — 43 gaps (15 blockers)*

**Schema work first:**

- model ExchangeRate — CONFIRMED ABSENT. I enumerated every `^model `/`^enum ` line in prisma/schema.prisma: enums PlayerStatus:35, AdminRole:46, ActorType:56, PaymentRail:64, VerificationMode:75, DepositStatus:87, RejectionCode:108, ProofSource:125, LedgerAccountKind:135, LedgerTxKind:154, IchancyOperation:172, IchancyOutcome:188, OutboxStatus:203, BreakCategory:214, BreakStatus:227, CreditVerifiedBy:239; models Currency:251, PaymentMethod:275, PaymentDestination:312, Player:341, PlayerSession:395, AdminUser:420, AdminApprovalLimit:446, DepositRequest:473, DepositProof:568, DepositTransition:602, LedgerAccount:628, LedgerTransaction:665, LedgerEntry:702, OutboxMessage:732, IdempotencyKey:758, TelegramUpdate:784, IchancyCall:805, AuditLog:840, ReconciliationBreak:867, PlayerLimit:918, SelfExclusion:946. No ExchangeRate. Rebuild exactly as the prior agent specified (id uuid pk; quoteAsset; currencyCode VarChar(3) FK->Currency onDelete Restrict; rateMinor BigInt + CHECK rate_minor > 0; source; sourceNote?; setByAdminId? @db.Uuid with `setBy AdminUser? @relation("ExchangeRateSetBy", ..., onDelete: Restrict)`; effectiveFrom/effectiveTo Timestamptz(6); createdAt; partial unique index on (quote_asset, currency_code) WHERE effective_to IS NULL; @@map("exchange_rates")) — copy AdminApprovalLimit:446 field-for-field as the versioning template.
- Migration 20260826120000_exchange_rates — CONFIRMED MISSING. `ls prisma/migrations` returns exactly: 20260813101853_init, 20260820120000_player_link_backfill, migration_lock.toml. The migration USDT-RAILS-STATE.md:38 records as 'applied' is not in this checkout.
- No chain/crypto data model whatsoever — CONFIRMED. No ChainNetwork enum and no ChainSettlement model in the enum/model inventory above; no 20260826140000_chain_settlements migration. grep over src+prisma for usdt\|trc20\|bep20\|erc20\|tron returns ZERO substantive hits (the only 'chain' matches are English prose about token/call chains and cert chains). Rebuild `chain_settlements` with UNIQUE (network, tx_hash) and CHECK (tx_hash = lower(tx_hash)), tenant-blind on purpose. The wallet-balance endpoint itself needs no table — the network is derived from PaymentDestination.accountIdentifier at read time. NOTE a real hook already exists for this: src/modules/payment-method/rails/rail.interface.ts:32-34 already declares an on-chain transaction hash plus which chain the transfer was made on, and rails/crypto-manual.driver.ts:10-11 documents why NETWORK is required — so the DTO surface exists and only the persisted settlement table + uniqueness guard are missing.
- PaymentDestination lacks the four declared-balance columns — CONFIRMED by reading schema.prisma:312-340 in full: id, paymentMethodId, label, accountIdentifier, accountHolder, isActive, priority, dailyCapMinor, notes, createdAt, updatedAt, relations paymentMethod + depositRequests, @@unique([paymentMethodId, accountIdentifier]), @@index([paymentMethodId, isActive, priority]). Nothing else. grep -rni 'declared.?balance' over src and prisma returns ZERO hits. Add declaredBalanceMinor BigInt?, declaredBalanceCurrency String? @db.VarChar(3), declaredBalanceUpdatedAt DateTime? @db.Timestamptz(6), declaredBalanceSetByAdminId String? @db.Uuid + a real onDelete: Restrict relation to AdminUser ("PaymentDestinationDeclaredBalanceSetBy"), and migration 20260827100000_declared_account_balance. Display-only and hand-typed — must not be conflated with the live chain figure even though both sit on the same card and the same route file.
- AdminRole has no PLATFORM_ADMIN — CONFIRMED by reading schema.prisma:46-54 verbatim: SUPER_ADMIN, FINANCE_ADMIN, REVIEWER, SUPPORT, VIEWER, @@map("admin_role"). Further: grep -rn 'PLATFORM_ADMIN\|tenant\|Tenant' over src and prisma returns ZERO hits — the backend has NO tenancy concept at all, not just a missing enum member. The rate write guard can be written today against SUPER_ADMIN\|FINANCE_ADMIN (API-CONTRACT.md:812), but the PLATFORM_ADMIN read arm cannot be specified until the tenancy domain lands.
- model Currency (schema.prisma:251-273) is ADEQUATE as claimed — verified: code @db.VarChar(3) @id, name, scale (comment states FROZEN at seed), symbol?, isActive, createdAt, updatedAt, plus back-relations players, paymentMethods, depositRequests, ledgerAccounts, ledgerTransactions, ledgerEntries, adminApprovalLimits, playerLimits, reconciliationBreaks. Only addition needed is `exchangeRates ExchangeRate[]`. The @db.VarChar(3) vs API-CONTRACT.md:583 '2-8 letter code' conflict for the declared-balance currency is real and belongs to the payment-methods work.
- Ledger* models are COMPLETE for this domain — verified LedgerAccount:628, LedgerTransaction:665, LedgerEntry:702 all present; core/ledger/account-codes.ts:167 exports ichancyAgentFloatCode(currency) and account-codes.ts:67-74 registers the ICHANCY_AGENT_FLOAT singleton kind; AccountRegistryService.computeBalanceFromEntries (account-registry.service.ts:141) already sums entries. Only the read service and the route are missing — no schema change.
- NO Tenant model, and no tenant concept anywhere: `grep -rni "tenant" src/ prisma/` returns ZERO files in the entire backend. prisma/schema.prisma declares 21 models (verified: `grep -c "^model "` = 21; the prior audit said 18 but then listed 21 — cosmetic error, substance holds): Currency, PaymentMethod, PaymentDestination, Player, PlayerSession, AdminUser, AdminApprovalLimit, DepositRequest, DepositProof, DepositTransition, LedgerAccount, LedgerTransaction, LedgerEntry, OutboxMessage, IdempotencyKey, TelegramUpdate, IchancyCall, AuditLog, ReconciliationBreak, PlayerLimit, SelfExclusion. None carries a tenantId. TenantFinanceRow is keyed on { tenantId, slug } (dashboard src/types/platform-finance.ts:94), so the whole platform-finance surface has no rows to build from. Needs model Tenant { id, slug, displayName, status TenantStatus ACTIVE\|SUSPENDED\|CLOSED, currencyCode, ichancyBaseUrl, ichancyAgentId, dualApprovalThresholdMinor BigInt, agentFloatLowWatermarkMinor BigInt, depositExpiryMinutes, createdAt, updatedAt }, tenantId on every scoped model, plus the tenant-scope Prisma client extension (no such file under src/core/prisma).
- AdminRole enum (prisma/schema.prisma:46-54, read verbatim) is SUPER_ADMIN \| FINANCE_ADMIN \| REVIEWER \| SUPPORT \| VIEWER. PLATFORM_ADMIN is absent and `grep -rn PLATFORM_ADMIN src/ prisma/` returns nothing, yet every route in this domain's overview is PLATFORM_ADMIN-only. Adding it touches the enum + migration, src/core/auth/auth.types.ts, src/core/auth/guards/roles.guard.ts and the role constant sets in src/modules/*/*.constants.ts.
- Per-tenant agentFloatLowWatermarkMinor does not exist as a column — verified it is a deployment-global env value only: src/core/config/env.schema.ts:368 (AGENT_FLOAT_LOW_WATERMARK_MINOR via bigintMinor) → src/core/config/config.service.ts:236. The dashboard AgentFloatCell reads a per-operator lowWatermarkMinor, so it must move onto the Tenant row; warnLowFloat() at src/modules/reconciliation/services/agent-float-sync.service.ts:290 must then read it per tenant instead of from config.
- NO ExchangeRate model. Verified zero hits for exchange.?rate / exchangeRate / rateMinor / quoteAsset across src/ AND prisma/. Needs { id, tenantId, quoteAsset, currencyCode, rateMinor BigInt, source, sourceNote String?, setByAdminId String? FK AdminUser, effectiveFrom Timestamptz, effectiveTo Timestamptz? }, versioned exactly like AdminApprovalLimit (prisma/schema.prisma:446), with CHECK (rate_minor > 0) and an index on (tenantId, quoteAsset, effectiveTo). Migration 20260826120000_exchange_rates is absent — prisma/migrations/ contains only 20260813101853_init, 20260820120000_player_link_backfill, migration_lock.toml. DepositRequest (prisma/schema.prisma:473) also needs a column recording which rate version priced it.
- NO ChainSettlement model and no chain tables of any kind (migration 20260826140000_chain_settlements absent). Needs { network, txHash, depositRequestId, ledgerTransactionId, creditedAt } with UNIQUE (network, tx_hash) and CHECK (tx_hash = lower(tx_hash)); deliberately TENANT-BLIND (the old payment_method_id key is per-operator, so the same transfer could be credited twice) and deliberately absent from TENANT_SCOPED_MODELS with a spec asserting that absence. The row must be written in the SAME transaction as the ledger postings so the unique index rolls them back with it — see src/core/ledger/ledger.service.ts:84 postWithRetry and src/core/ledger/serialization-retry.util.ts.
- PaymentDestination (prisma/schema.prisma:312-338, read in full) lacks all four declared-balance columns: declaredBalanceMinor BigInt? @map("declared_balance_minor"), declaredBalanceCurrency String? @map("declared_balance_currency"), declaredBalanceUpdatedAt DateTime? @db.Timestamptz(6), declaredBalanceSetByAdminId String? @db.Uuid — the last a REAL FK to AdminUser with the back-relation added. Migration 20260827100000_declared_account_balance is absent.
- Currency.code is String @id @db.VarChar(3) (prisma/schema.prisma:252, verified) — 'USDT' is four characters, so USDT can never be a Currency row under the present column. That is consistent with the design (USDT figures travel as { asset, scale } and are deliberately NOT MoneyView), but a rebuilder must not try to seed a USDT currency. Only NSP is seeded (prisma/seed/currency.seed.ts), and the model comment states scale is FROZEN at seed, so any USD rail work needs a USD row created deliberately.
- …and 22 more (see `RECOVERY-GAPS.json`)

**Endpoints:**

| Sev | Endpoint | Purpose |
|---|---|---|
| 🔴 | `GET /v1/admin/exchange-rates/usdt` | Read the current USDT rate, or null when nobody has set one (UsdtRatePanel + the deposit chain-check price). |
| 🔴 | `POST /v1/admin/exchange-rates/usdt` | Set the rate (body { rate, sourceNote?, confirmLargeChange? }); the four guards ARE the feature. |
| 🔴 | `GET /v1/admin/payment-destinations/:id/balance` | On-chain USDT balance of one payout destination; mounted on every CRYPTO account card on /financial. |
| 🔴 | `GET /v1/admin/reconciliation/agent-float` | Ledger read of the operator's Ichancy agent float for the top-bar pill on every console screen; cheap by contract (ledger only, no Ichancy round trip… |
| 🔴 | `GET /v1/admin/finance/balances` | Platform finance overview — cheap per-operator row set rendering the whole /platform-finance screen (PLATFORM_ADMIN only). |
| 🔴 | `POST /v1/admin/finance/tenants/:tenantId/refresh` | Load one operator's expensive columns (USDT wallets via chain call, Sham Cash) and return the freshened row. |
| 🔴 | `GET /v1/admin/reconciliation/agent-float` | Float behind the top-bar pill on every screen — cheap ledger balance read on ICHANCY_AGENT_FLOAT plus the low-watermark verdict. |
| 🔴 | `GET /v1/admin/exchange-rates/usdt` | Read the current USDT→operator-currency rate that prices every crypto deposit. |
| 🔴 | `POST /v1/admin/exchange-rates/usdt` | Set a new USDT rate version; closes the previous row so an edit can never retroactively reprice an already-paid deposit. |
| 🔴 | `GET /v1/admin/payment-destinations/:id/balance` | Live on-chain balance of one USDT payout wallet — the unit the platform-finance USDT column is assembled from and the figure on the /financial rail c… |
| 🔴 | `DELETE /v1/admin/payment-methods/:id/permanent` | Hard-delete a rail that never took a payment; the rails table's trash button is gated on method.deletable and 404s without this route. |
| 🔴 | `PATCH /v1/admin/payment-destinations/:id/declared-balance` | CC-020: set or clear the operator's hand-typed balance for an account no chain/API can be asked about (cash office, bank, Sham Cash). Display-only bo… |
| 🔴 | `GET /v1/admin/payment-destinations/:id/balance` | On-chain balance of one USDT payout wallet, rendered by WalletBalance on the financial card. |
| 🔴 | `HEADER X-Tenant-Id scoping on payment methods and destinations` | Every payment-method read/write the console makes is tenant-scoped; the backend has no tenant concept, so one operator's rails are every operator's r… |
| 🔴 | `POST /v1/admin/deposits/manual` | The only path by which an admin credits a player's points: records a MANUAL DEPOSIT on the INTERNAL MANUAL_CREDIT rail and hands it to the existing a… |
| 🟠 | `PATCH /v1/admin/payment-destinations/:id/declared-balance` | Set or clear the operator's hand-typed balance for an account no chain can be asked about (cash office, bank, Sham Cash). |
| 🟠 | `GET /v1/admin/deposits/:id/chain-check` | On-chain verdict for one crypto deposit as its own resource (USDT-tracking read; depends on the same missing core/chain layer). |
| 🟠 | `GET /v1/admin/payment-methods` | PARTIAL: route exists (admin-payment-method.controller.ts:58) but the response is missing requiresProof, deletable and deleteBlockedBy, which the con… |
| 🟠 | `GET /v1/admin/payment-methods/:id/destinations` | PARTIAL: route exists (admin-payment-method.controller.ts:100) but every PaymentDestination response omits the five declared-balance fields the conso… |
| 🟠 | `POST /v1/admin/payment-methods/:id/destinations` | PARTIAL: route exists (admin-payment-method.controller.ts:108) but there is no server-side chain-address validation. CC-019 — a CRYPTO-rail payout ac… |
| 🟠 | `POST /v1/admin/tenants -> provisionDefaultPaymentMethods` | CC-018: the payment half of tenant provisioning — every new operator gets its default rails plus one ACTIVE placeholder destination per rail, and the… |
| 🟠 | `ROLE PAYMENT_METHOD_MANAGER_ROLES / PAYMENT_METHOD_READER_ROLES lack PLATFORM_ADMIN` | The console grants PLATFORM_ADMIN every capability including paymentMethods.write and states it mirrors the backend. |
| 🟠 | `GET /v1/admin/deposits/:id/chain-check` | On-chain verdict for one crypto deposit (outcome / network / arrived USDT@scale6 / creditable in tenant currency / txHash / fromAddress / confirmatio… |
| 🟡 | `PATCH /v1/admin/payment-destinations/:id/declared-balance` | Set or clear the operator's hand-typed balance for one account (endpoints.ts:427-435). The prior agent listed the COLUMNS as a data-model gap but nev… |
| 🟡 | `GET /v1/admin/players/:id/balance` | One player's live Ichancy balance — one upstream call per player, no bulk read (API-CONTRACT.md:301, :340; endpoints.ts:323-330, behind a client-side… |
| 🟡 | `POST /v1/admin/shamcash/balance (plus GET /status, POST /api, DELETE /api, POST /test)` | The operator's external Sham Cash cashier balance and sealed credential status (API-CONTRACT.md:848-859; endpoints.ts:465-492). |
| 🟡 | `GET /v1/admin/finance/balances (plus POST /v1/admin/finance/tenants/:id/refresh)` | Platform-wide finance overview: every operator's agent float (cheap ledger read) plus not_loaded markers for USDT wallets and Sham Cash, with a per-o… |
| 🟡 | `POST /v1/admin/shamcash/balance` | Read the operator's Sham Cash balance — the Sham Cash half of every platform-finance row and of the tenant refresh. Dashboard: src/lib/api/endpoints.… |
| 🟡 | `GET /v1/admin/shamcash/status` | Report whether the Sham Cash browser session / HTTP API credential is linked and when — the gate the finance screen checks before offering a balance … |
| 🟡 | `POST /v1/admin/shamcash/api (POST set, DELETE clear) and /v1/admin/shamcash/test (POST)` | Set (write-only, no read-back), clear, and live-test the Sham Cash HTTP API credential that supersedes the browser session for reading transactions. … |
| 🟡 | `GET /v1/admin/players/:id/balance` | Per-player balance read called from finance/player screens (dashboard endpoints.ts:329, playerBalanceSchema). |
| 🟡 | `GET /v1/admin/exchange-rates/usdt` | Read the current USDT rate (answers null when nobody has set one — a normal empty-form state, not a 404). Called by the financial page's usdt-rate-pa… |
| 🟡 | `POST /v1/admin/exchange-rates/usdt` | Set the current USDT rate; each set records a new version behind the single 'current' answer. |
| 🟡 | `GET /v1/admin/shamcash/status` | Whether the operator's Sham Cash browser session / HTTP API credentials are linked and when. Never returns the credentials themselves. |
| 🟡 | `POST /v1/admin/shamcash/balance` | Read the Sham Cash wallet balance using the stored session — the non-chain sibling of the USDT wallet-balance route. |
| 🟡 | `POST /v1/admin/shamcash/api` | Store the Sham Cash HTTP API credentials, sealed on arrival with no read-back by design; supersedes the browser session for reading transactions. |
| 🟡 | `DELETE /v1/admin/shamcash/api` | Clear the stored Sham Cash API credentials. |
| 🟡 | `POST /v1/admin/shamcash/test` | Live proof the saved key works — reads the balance AND lists transactions, reporting each separately. Deliberately distinct from checkBalance. |
| 🟡 | `FIELD PaymentMethodView.requiresProof (player-facing, GET /v1/payment-methods)` | The player-facing view is a separate interface from the admin one and will also need requiresProof, otherwise the mini-app cannot know whether to dem… |
| 🟡 | `AUDIT No audit action codes exist for the new payment writes` | Every existing payment write audits ('payment_destination.created' at payment-destination.service.ts:99, 'payment_method.*' in payment-method.service… |
| 🟡 | `GET /v1/admin/exchange-rates/usdt` | Reads the operator's current USDT rate (nullable when nobody has set one — a normal empty-form state, not a 404). Hard dependency of chain-check: wit… |
| 🟡 | `POST /v1/admin/exchange-rates/usdt` | Sets the current USDT rate. One current rate, but every set records a new version behind it (the console's own comment) — so it is a history-keeping … |
| 🟡 | `GET /v1/admin/stats` | The deposit aggregates behind the queue — deposits opened, CREDITED, rejected, expired, still waiting, and fees kept, summed in the database per oper… |

### Phase 6 — Telegram: destinations, discovered chats, editable bot menu

*Domains: `telegram-bot-config` — 23 gaps (8 blockers)*

**Schema work first:**

- model BotMenuNode - absent. prisma/schema.prisma declares 21 models (Currency, PaymentMethod, PaymentDestination, Player, PlayerSession, AdminUser, AdminApprovalLimit, DepositRequest, DepositProof, DepositTransition, LedgerAccount, LedgerTransaction, LedgerEntry, OutboxMessage, IdempotencyKey, TelegramUpdate, IchancyCall, AuditLog, ReconciliationBreak, PlayerLimit, SelfExclusion) and none is menu-related.
- model BotMenuButton - absent. No nodeId/rowIndex/label/kind columns anywhere; sortOrder exists only on PaymentMethod/PaymentDestination.
- enum BotMenuButtonKind { BUILTIN NAVIGATE TEXT BACK } - absent. The schema's enums are PlayerStatus, AdminRole, ActorType, PaymentRail, VerificationMode, DepositStatus, RejectionCode, ProofSource, LedgerAccountKind, LedgerTxKind, IchancyOperation, IchancyOutcome, OutboxStatus, BreakCategory, BreakStatus, CreditVerifiedBy.
- Channel-gate columns (gateChannelId BigInt?, gateChannelUsername String?) - absent; there is no settings/tenant row to hold them and no membership check anywhere in src.
- model TelegramDestination - absent. Every 'destination' symbol in the backend is PaymentDestination (prisma/schema.prisma:312, src/modules/payment-method/*), an unrelated payment-routing model.
- enum NotificationCategory - absent.
- enum TelegramChatType { GROUP SUPERGROUP CHANNEL } - absent.
- enum TelegramBotChatStatus { CREATOR ADMINISTRATOR MEMBER RESTRICTED LEFT KICKED } - absent.
- model TelegramDiscoveredChat - absent; my_chat_member payloads land in the generic TelegramUpdate table (prisma/schema.prisma:784) and are never projected into a chat directory.
- model Tenant - entirely absent; the schema has no tenancy at all, so miniAppUrl / depositMode / withdrawalMode / chatMenuButtonSet / adminChatId / feedChatId / botToken have no home. adminChatId and feedChatId live only in ENV (src/core/config/config.service.ts:61-75 and :189).
- enum DepositMode { AUTO MANUAL } and enum WithdrawalMode { AUTO MANUAL } - absent. Confirmed the dashboard needs both: src/types/bot-menu.ts:72 puts depositMode on the settings view even though docs/API-CONTRACT.md:429 lists only miniAppUrl/withdrawalMode/chatMenuButtonSet - rebuild should serve all three settings.
- AdminRole lacks PLATFORM_ADMIN - prisma/schema.prisma:46-52 is exactly SUPER_ADMIN, FINANCE_ADMIN, REVIEWER, SUPPORT, VIEWER.
- Role constant groups BOT_MENU_MANAGER_ROLES / TELEGRAM_DESTINATION_MANAGER_ROLES - absent. src/modules/admin/admin.constants.ts defines only APPROVER_ROLES, ADMIN_MANAGER_ROLES, ADMIN_READER_ROLES.
- Error codes BOT_MENU_ROOT_PROTECTED, BOT_MENU_NODE_IN_USE, BOT_MENU_NODE_NOT_FOUND, BOT_MENU_BUTTON_NOT_FOUND, BUTTON_REQUIRED, TELEGRAM_CHAT_REJECTED - absent; grep over src returns zero hits. src/modules/admin/admin.constants.ts:13-22 shows the per-module code-map pattern to copy into bot-menu.constants.ts / telegram-destination.constants.ts.
- …and 1 more (see `RECOVERY-GAPS.json`)

**Endpoints:**

| Sev | Endpoint | Purpose |
|---|---|---|
| 🔴 | `GET /v1/admin/bot-menu` | Whole flow graph: nodes + buttons + builtinAction catalogue + gate + settings. |
| 🔴 | `POST /v1/admin/bot-menu/nodes` | Create a screen. |
| 🔴 | `POST /v1/admin/bot-menu/buttons` | Add a button to a screen. |
| 🔴 | `PATCH /v1/admin/bot-menu/buttons/:id` | Rename / re-kind / hide a button. |
| 🔴 | `GET /v1/admin/bot-menu/settings` | Read the bot's non-button runtime settings (miniAppUrl, deposit/withdrawal mode, chatMenuButtonSet). |
| 🔴 | `PATCH /v1/admin/bot-menu/settings` | Save mini-app URL and deposit/withdrawal modes; best-effort setChatMenuButton afterwards. |
| 🔴 | `GET /v1/admin/telegram/destinations` | List where this operator's bot publishes - the entire /telegram page. |
| 🔴 | `POST /v1/admin/telegram/destinations` | Bind a group/channel only after proving the bot can post there. |
| 🟠 | `PATCH /v1/admin/bot-menu/nodes/:id` | Rename a screen / set its prompt text. |
| 🟠 | `DELETE /v1/admin/bot-menu/nodes/:id` | Delete a screen; three distinct refusals rendered by the UI. |
| 🟠 | `PATCH /v1/admin/bot-menu/nodes/:id/reorder` | Apply a screen's whole keyboard layout in one transaction. |
| 🟠 | `DELETE /v1/admin/bot-menu/buttons/:id` | Hard-delete a button. |
| 🟠 | `PATCH /v1/admin/bot-menu/gate` | Set/clear the channel a player must join before /start opens the menu. |
| 🟠 | `PATCH /v1/admin/telegram/destinations/:id` | Edit displayName / categories / isActive; cannot repoint the chat. |
| 🟠 | `DELETE /v1/admin/telegram/destinations/:id` | Deactivate (never hard-delete) so re-adding the same chat revives the row. |
| 🟠 | `POST /v1/admin/telegram/destinations/:id/check` | Silent re-verification; writes lastVerifiedAt/lastError, sends nothing. |
| 🟠 | `POST /v1/admin/telegram/destinations/:id/test` | Post a real message - the only proof of delivery; stamps lastPublishedAt. |
| 🟠 | `GET /v1/admin/telegram/chats` | Read back chats Telegram volunteered via my_chat_member - the only way to bind a PRIVATE group. |
| 🟠 | `POST /v1/admin/reports/activity/publish` | Publish the activity report to every active destination subscribed to REPORT. |
| 🟡 | `INTERNAL src/core/telegram/services/bot.service.ts:85-246` | Missing Telegram READ primitives. The full public surface is sendMessage, editMessageText, editMessageReplyMarkup, answerCallback, sendPhoto, deleteM… |
| 🟡 | `INTERNAL src/core/telegram/services/update-dedupe.service.ts:57-62` | No my_chat_member CONSUMER. The update is allowed (telegram.constants.ts:48) and classified, and its chat id is persisted into telegram_updates, then… |
| 🟡 | `INTERNAL src/modules/player/telegram/player.handlers.ts:420,687` | The RUNTIME half of bot-menu is missing, not just the admin CRUD. /start (line 420) and the menu (@OnCallback(MENU_NS), line 687) are built from hard… |
| 🟡 | `INTERNAL src/core/telegram/services/bot.service.ts:222 + src/modules/deposit/services/deposit-notify.service.ts:273-310 + src/modules/admin/services/report-schedule.cron.ts:219-226` | No category fan-out. Every existing notifier targets the single ENV chat (config.telegram.feedChatId ?? adminChatId). TelegramDestination.categories … |

### Phase 7 — ShamCash integration

*Domains: `shamcash` — 16 gaps (3 blockers)*

**Schema work first:**

- No Tenant/Operator model exists in prisma/schema.prisma — verified by listing every model and enum declaration (lines 251-946: Currency, PaymentMethod, PaymentDestination, Player, PlayerSession, AdminUser, AdminApprovalLimit, DepositRequest, DepositProof, DepositTransition, LedgerAccount, LedgerTransaction, LedgerEntry, OutboxMessage, IdempotencyKey, TelegramUpdate, IchancyCall, AuditLog, ReconciliationBreak, PlayerLimit, SelfExclusion). grep -rni 'tenant\|operator' over schema.prisma yields exactly one hit, a prose comment at line 368. Root dependency for the whole domain.
- Tenant.shamcashWalletId (String? @map("shamcash_wallet_id")) — missing. grep -rni 'walletId\|wallet_id' over src and prisma returns zero hits; the only 'api_key' hits are two redaction regexes (src/core/ichancy/ichancy-call-log.service.ts:40, src/core/logging/redaction.ts:51).
- Tenant.shamcashApiKeyEnc (String? @map("shamcash_api_key_enc")) — missing. The sealing machinery to build it already exists and should be reused, not rewritten: src/modules/player/utils/secret-box.util.ts (aes-256-gcm at line 23, hkdfSync at line 49, random nonce per encryption) with a per-purpose HKDF label like CREDENTIAL_INFO_ENCRYPTION at src/modules/player/player.constants.ts:67.
- DB CHECK constraint enforcing both-or-neither on (shamcash_wallet_id, shamcash_api_key_enc) — missing. The repo already has a home for hand-written constraints: prisma/sql/ holds 001_ledger_balanced_trigger.sql through 005_four_eyes_check.sql; add the CHECK there and reference it from the new migration, matching the existing convention.
- PaymentMethod row with code 'SHAM_CASH' (displayName 'شام كاش', rail MOBILE_WALLET) is NOT seeded. prisma/seed/payment-method.seed.ts defines exactly two specs — BANK_TRANSFER_CODE at line 47 and EWALLET_CODE at line 65 — and hardcodes VerificationMode.MANUAL_PROOF at lines 103 and 119. No src/core/payments/default-payment-methods.ts exists (find over the repo returns nothing). POST /v1/admin/shamcash/api's rail-sync step has no method row to sync to.
- PaymentDestination seed row for SHAM_CASH ('SEED-PLACEHOLDER-SHAMCASH-0000' / 'REPLACE ME') — missing. The seed produces only -BANK-0000 (line 60) and -WALLET-0000 (line 77) under PLACEHOLDER_PREFIX (line 28).
- No `paymentMethodsNeedAccounts` API field anywhere in the backend. PARTIAL CORRECTION to the first agent: a `destinationIsPlaceholder` computation DOES already exist, but only inside the seed reporter — prisma/seed/payment-method.seed.ts:86 (type field) and :166 (`activePlaceholders > 0`), consumed at prisma/seed.ts:89 to print a console warning. It is not on any DTO or endpoint, so the dashboard-facing field is genuinely missing; the computation is a ready-made snippet to lift.
- Correct that no persistence is needed for the dev bench. There is no shamcash_session table and none should be added — only 2 migrations exist (20260813101853_init, 20260820120000_player_link_backfill), so the contract's 20260903140000_drop_shamcash_session never landed here and there is nothing to drop. The pairing registry and linked-account snapshot are in-memory module state; src/core/ichancy/ichancy-session.store.ts is the in-process holder pattern to copy.
- No NotificationCategory enum exists in schema.prisma at all — verified against the full enum list (PlayerStatus, AdminRole, ActorType, PaymentRail, VerificationMode, DepositStatus, RejectionCode, ProofSource, LedgerAccountKind, LedgerTxKind, IchancyOperation, IchancyOutcome, OutboxStatus, BreakCategory, BreakStatus, CreditVerifiedBy). SHAM_CASH_DEPOSIT / SHAM_CASH_WITHDRAWAL are enum members only, no producer by design.
- No env vars for this domain in src/core/config/env.schema.ts. Verified against the full key list (APP_ROLE through the ICHANCY_*, S3_*, TELEGRAM_* blocks): SHAM_CASH_DEV_CHECK, SHAM_CASH_PROXY_SERVER, SHAM_CASH_SETTLE_MS and an api-shamcash.com base URL are all absent, and nothing is wired into src/core/config/config.service.ts either. Add them with the existing helpers (optionalFlag(), httpUrl(), z.coerce.number()) and surface them on ConfigService the way browserHeadless/transport are at config.service.ts:107-110.

**Endpoints:**

| Sev | Endpoint | Purpose |
|---|---|---|
| 🔴 | `GET /v1/admin/shamcash/status` | Whether a key is configured + which wallet id. Card's root query. |
| 🔴 | `POST /v1/admin/shamcash/api` | Save wallet id + API key together, seal the key, and sync the wallet id onto the SHAM_CASH method's active destinations. |
| 🔴 | `DELETE /v1/admin/shamcash/api` | Clear the stored credential pair. |
| 🟠 | `POST /v1/admin/shamcash/balance` | Live balance read from the vendor HTTP API (GET https://api-shamcash.com/api/v1/wallets/shamcash/{walletId}/balance with an x-api-key header). |
| 🟠 | `POST /v1/admin/shamcash/test` | Prove the saved key works: balance AND transaction listing, reported separately. |
| 🟠 | `GET /v1/admin/shamcash/account` | Cached snapshot of the linked account. Root query of the /dev/shamcash page. |
| 🟠 | `POST /v1/admin/shamcash/account/refresh` | Re-read through the warm page; concurrent callers share one load. |
| 🟠 | `POST /v1/admin/shamcash/dev/qr` | Open a browser on shamcash.sy's login page, screenshot the QR, keep the browser open. |
| 🟠 | `GET /v1/admin/shamcash/dev/qr/:pairingId` | Poll the pairing; on 'linked' hand the signed-in browser to the account service and drop the pairing. |
| 🟠 | `POST /v1/admin/shamcash/dev/parse` | Offline, deterministic page-text parser — separates a parsing regression from a credential problem. |
| 🟡 | `DELETE /v1/admin/shamcash/account` | Close the held browser and drop the snapshot. |
| 🟡 | `DELETE /v1/admin/shamcash/dev/qr/:pairingId` | Polite close on console unmount; idempotent. |
| 🟡 | `POST /v1/admin/shamcash/dev/browser-check` | Replay pasted session values in real Chromium against shamcash.sy; 55-90s. |
| 🟡 | `N/A (enum member) prisma/schema.prisma:46-54 — AdminRole` | The PLATFORM_ADMIN role the Sham Cash endpoints are authorized against does not exist in the backend. |
| 🟡 | `N/A (error code) src/common/exceptions/error-codes.ts:73` | SHAMCASH_NOT_LINKED error code for the 503 on /account/refresh. |
| 🟡 | `N/A (route guard) src/modules/shamcash — SHAM_CASH_DEV_CHECK 404 guard` | A guard that turns a flagged-off route into 404 rather than 403. |

### Phase 8 — Stats, reconciliation, platform finance reporting

*Domains: `stats`, `reconciliation` — 14 gaps (2 blockers)*

**Schema work first:**

- Tenant model — CONFIRMED ENTIRELY ABSENT. I listed every model/enum in prisma/schema.prisma (35 of them: Currency, PaymentMethod, PaymentDestination, Player, PlayerSession, AdminUser, AdminApprovalLimit, DepositRequest, DepositProof, DepositTransition, LedgerAccount, LedgerTransaction, LedgerEntry, OutboxMessage, IdempotencyKey, TelegramUpdate, IchancyCall, AuditLog, ReconciliationBreak, PlayerLimit, SelfExclusion + 14 enums) — there is no Tenant, no Operator, no Merchant. `grep -niE "tenant\|platform\|merchant" prisma/schema.prisma` = 0 hits. TenantStats needs { id, slug, displayName, currencyCode, status: ACTIVE\|SUSPENDED\|CLOSED } (contract line 802 pins the TenantStatus enum) plus the Ichancy/bot columns the tenants surface uses. Note also that only TWO migrations exist — prisma/migrations/20260813101853_init and 20260820120000_player_link_backfill — which independently confirms the schema is frozen at 2026-08-20, i.e. nothing from the lost 20 days landed.
- tenantId FK on DepositRequest, Player, PaymentMethod, PaymentDestination, AdminUser, AdminApprovalLimit, ReconciliationBreak (and the future WithdrawalRequest) — CONFIRMED, zero occurrences of tenantId in the schema. Every aggregate the backend can currently compute is platform-wide by construction, so even a 'good enough' single-tenant /v1/admin/stats has to invent tenantId/slug/displayName/currency, all four of which the dashboard's tenantStatsSchema (src/types/stats.ts) requires non-nullable.
- WithdrawalRequest model — CONFIRMED ABSENT (see gap 3). Without feeMinor on it, TenantStats.profit.withdrawalFees can only ever be a hardcoded 0, and withdrawals.paid (basis paidAt) / .pending (basis 'current') have no source at all.
- AdminRole enum is missing PLATFORM_ADMIN — CONFIRMED verbatim at prisma/schema.prisma:46-54: SUPER_ADMIN, FINANCE_ADMIN, REVIEWER, SUPPORT, VIEWER, @@map("admin_role"). `grep -rn PLATFORM_ADMIN src --include=*.ts` = 0 hits backend-wide, so nothing in the auth guard knows the role either. The dashboard's ADMIN_ROLES has six values and /v1/admin/stats/tenants is gated on the missing one. Adding it is a Prisma enum migration plus a decision in src/core/auth/auth.types.ts (TokenRole = PLAYER_ROLE \| AdminRole, line 16).
- No index supporting the credited-in-window aggregate — CONFIRMED. DepositRequest's indexes are exactly @@index([playerId, createdAt]), @@index([status, createdAt]), @@index([paymentMethodId, status]), @@index([shortId]). The stats blocks filter on status+creditedAt and status+decidedAt, neither of which is covered; add @@index([status, creditedAt]) and @@index([status, decidedAt]), and once tenancy lands lead every one of them with tenantId.
- VERIFIED NOT A GAP (the first agent was right): DepositRequest already carries claimedAmountMinor, verifiedAmountMinor, feeMinor (@default(0)), creditedAmountMinor, and submittedAt/reviewStartedAt/decidedAt/secondApprovedAt/creditedAt — I read the model in full. DepositStatus has all eight statuses. PaymentMethod has isActive/feeFixedMinor/feeBps/displayName. So the deposit half of TenantStats and all of profit.{depositFees,chargingRails,activeRails} are computable against today's schema.
- AdminRole enum (prisma/schema.prisma:46-54) lacks PLATFORM_ADMIN — verified, the enum is exactly SUPER_ADMIN, FINANCE_ADMIN, REVIEWER, SUPPORT, VIEWER and `grep -rn PLATFORM_ADMIN src prisma` returns nothing. API-CONTRACT.md:165 grants reconciliation.read to five roles; VIEW_ROLES (reconciliation.controller.ts:44-49) can only list four.
- No Tenant model and no tenantId column exist anywhere — verified by `grep -rni tenant src prisma`, which returns zero hits in the entire backend. ReconciliationBreak (prisma/schema.prisma:865-912) needs `tenantId String @map("tenant_id") @db.Uuid` + a Tenant relation, and its @@index([status, detectedAt]) / @@index([category, status]) (schema.prisma:908-909) should become tenant-leading composites before the break list can be scoped per operator.
- ReconciliationBreak.dedupeKey is `@unique` GLOBALLY (prisma/schema.prisma:886: `dedupeKey String? @unique @map("dedupe_key")`). Once tenants exist this must become @@unique([tenantId, dedupeKey]) or two operators hitting the same natural key (e.g. `agent-float:NSP:2026-09-11` from breakKeys.agentFloat in reconciliation.constants.ts) collide and one operator's finding overwrites the other's.

**Endpoints:**

| Sev | Endpoint | Purpose |
|---|---|---|
| 🔴 | `GET /v1/admin/stats` | Per-operator aggregates for one window — every tile, the profit card and the by-rail table on /stats. |
| 🔴 | `GET /v1/admin/reconciliation/agent-float` | Server-side read of the ICHANCY_AGENT_FLOAT:<currency> ledger balance plus the server's own isLow verdict against AGENT_FLOAT_LOW_WATERMARK_MINOR, fo… |
| 🟠 | `GET /v1/admin/stats/tenants` | Cross-operator stats table on /stats ('Every operator' card). PLATFORM_ADMIN only. |
| 🟠 | `GET /v1/admin/withdrawals` | (a) the 'withdrawals waiting' tile on /overview reads meta.total off this list; (b) TenantStats.withdrawals.{paid,pending} and profit.withdrawalFees … |
| 🟠 | `* /v1/admin/reconciliation/* (tenant scoping + PLATFORM_ADMIN)` | Scope every reconciliation route to one operator and let a PLATFORM_ADMIN retarget via the X-Tenant-Id header; grant reconciliation.read to PLATFORM_… |
| 🟡 | `POST /v1/admin/reconciliation/invariants/run` | Emit invariant names the console can translate; today 3 of the 4 backend names are untranslatable. |
| 🟡 | `POST /v1/admin/reconciliation/breaks/:id/resolve` | Reject an empty resolution note server-side. |
| 🟡 | `GET /v1/admin/reconciliation/breaks/:id` | Answer a missing break with the domain code BREAK_NOT_FOUND rather than the generic RESOURCE_NOT_FOUND. |
| 🟡 | `MIDDLEWARE/INTERCEPTOR tenant request context — tenant-context.middleware.ts + `tid` token claim + TenantOverrideInterceptor (X-Tenant-Id)` | Decides WHICH operator GET /v1/admin/stats answers for. endpoints.ts:668 says `mine` is 'whichever operator the session is acting as — the caller's h… |
| 🟡 | `GET/POST AdminSessionView is missing tenantId and tenantSlug` | The console reads the acting tenant off the sign-in response (API-CONTRACT.md:51 `AdminSessionView = { accessToken, expiresAt, admin, tenantId, tenan… |
| 🟡 | `NOTE ActivityReportService is the only aggregation code and is HTTP-unreachable` | Worth flagging so the rebuild reuses it instead of duplicating the money semantics. |
| 🟡 | `POST /v1/admin/reconciliation/breaks/:id/assign` | 404 error code: assigning a non-existent break answers RESOURCE_NOT_FOUND, not BREAK_NOT_FOUND. |
| 🟡 | `POST /v1/admin/reconciliation/breaks/:id/correct-float` | Empty-note validation, identical to the resolve gap the agent did file. |
| 🟡 | `* per-tenant reconciliation config (AGENT_FLOAT_LOW_WATERMARK_MINOR)` | The low-float watermark is a process-wide env var, but the contract calls it a per-operator setting. |

### Phase 9 — Cross-cutting plumbing

*Domains: `settings-misc-health` — 8 gaps (1 blockers)*

**Schema work first:**

- CONFIRMED — `AuditLog` (prisma/schema.prisma:840-865) has no `tenantId`. Full model read: id, actorType, actorId, action, entityType, entityId, before, after, ip, userAgent, correlationId, createdAt; indexes @@index([entityType,entityId,createdAt]), @@index([actorType,actorId,createdAt]), @@index([action,createdAt]). Add `tenantId String @db.Uuid` + @@index([tenantId,createdAt]) + @@index([tenantId,entityType,entityId,createdAt]). Forward-only migration with a backfill default: prisma/sql/002_immutability.sql installs the append-only trigger and prisma/sql/003_app_role_grants.sql revokes UPDATE/DELETE (both files verified present in prisma/sql).
- CONFIRMED — `IdempotencyKey` (prisma/schema.prisma:758-783) declares `@@unique([scope, key])` with no tenant column: a platform-global key namespace. Needs `tenantId` in the model and `@@unique([tenantId, scope, key])`. Callers must change in lockstep: src/core/ledger/ledger.repository.ts:216-228 (create) and :273-275 (`where: { scope_key: { scope, key } }` — the compound-key accessor name changes with the constraint), plus src/core/idempotency/idempotency.service.ts.
- CONFIRMED — No `Tenant`/operator model exists and NO model carries a `tenantId`. Every model in prisma/schema.prisma: Currency, PaymentMethod, PaymentDestination, Player, PlayerSession, AdminUser, AdminApprovalLimit, DepositRequest, DepositProof, DepositTransition, LedgerAccount, LedgerTransaction, LedgerEntry, OutboxMessage, IdempotencyKey, TelegramUpdate, IchancyCall, AuditLog, ReconciliationBreak, PlayerLimit, SelfExclusion. `grep -rin tenant src/ prisma/` = 0 hits. This is what makes the CORS/X-Tenant-Id blocker unfixable beyond the header allow-list.
- CONFIRMED — `AdminRole` (prisma/schema.prisma:46-54) is exactly SUPER_ADMIN \| FINANCE_ADMIN \| REVIEWER \| SUPPORT \| VIEWER with @@map("admin_role"); `grep -rn PLATFORM_ADMIN src/ prisma/` = 0 hits. Also CONFIRMED: `AdminUser` (prisma/schema.prisma:420-445) has no `tenantId` — fields are id, telegramUserId, username, displayName, role, isActive, passwordHash, totpSecretEnc, lastLoginAt, createdAt, updatedAt plus relations and @@index([role,isActive]). No CHECK constraint for 'a PLATFORM_ADMIN row must live in tenant zero' exists: prisma/sql contains only 001_ledger_balanced_trigger, 002_immutability, 003_app_role_grants, 004_partial_indexes, 005_four_eyes_check.
- CONFIRMED (informational, not a defect) — `AuditLog.actorId` is `String? @db.Uuid` with the schema comment 'Null for SYSTEM. Not a foreign key: the actor may be a player, an admin, or nobody.' (prisma/schema.prisma:843-845). A rebuilt audit READ endpoint must resolve display names itself by branching on `actorType` into admin_users / players. Worth adding: there is currently NO audit read path at all — the only AuditLog read anywhere in src is src/modules/player/services/referral.service.ts:114 (`auditLog.findFirst`), and the dashboard does not yet call an audit endpoint either (grep 'audit' in endpoints.ts = 0 hits).

**Endpoints:**

| Sev | Endpoint | Purpose |
|---|---|---|
| 🔴 | `OPTIONS * (CORS preflight for every /v1/admin/* request — missing `x-tenant-id` in allowedHeaders)` | Allow the console's `X-Tenant-Id` header through the browser preflight so admin requests are not blocked before they are sent. |
| 🟠 | `GET /health/ready (the 503 / degraded path only)` | Return the terminus body (status/info/error/details) on a 503 so the console's readiness panel can name the failing dependency instead of rendering '… |
| 🟠 | `POST Idempotency-Key on admin money-path POSTs (/v1/admin/deposits/:id/approve\|reject\|claim\|release, /v1/admin/players/:id/credit\|debit, withdrawal decisions, tenant writes)` | Make a double-click or a retried admin decision a replay instead of a second money movement. |
| 🟡 | `GET /health/live — `status` values other than the literal 'ok'` | Make the console's amber 'degraded' liveness state reachable instead of dead UI. |
| 🟡 | `GET /health/live — `role: 'worker'`` | Settings > Connection prints the process role verbatim; 'worker' is asserted by the dashboard test but can never be served over HTTP. |
| 🟡 | `POST /v1/admin/auth/credentials` | The console's ONLY sign-in (username/email + password, falling back to the operator's Ichancy agent account, answering an AdminSession, with a 409 AD… |
| 🟡 | `CONFIG CORS origin allow-list has no console/dashboard origin` | `allowedOrigins` is built solely from `config.app.miniAppOrigins` (src/main.ts:163), fed by the required env MINI_APP_ORIGIN; there is no ADMIN/CONSO… |
| 🟡 | `CONFIG CORS exposedHeaders omits `idempotency-replayed`` | IDEMPOTENCY_REPLAY_HEADER = 'idempotency-replayed' is set on a replayed response so a client can tell a cached answer from a fresh one, but it is not… |

### Phase 10 — Mini-app API layer

*Domains: `mini-app` — 15 gaps (6 blockers)*

**Schema work first:**

- WithdrawalRequest model — CONFIRMED ABSENT. `grep '^model \\|^enum ' prisma/schema.prisma` yields 36 declarations (Currency, PaymentMethod, PaymentDestination, Player, PlayerSession, AdminUser, AdminApprovalLimit, DepositRequest, DepositProof, DepositTransition, LedgerAccount, LedgerTransaction, LedgerEntry, OutboxMessage, IdempotencyKey, TelegramUpdate, IchancyCall, AuditLog, ReconciliationBreak, PlayerLimit, SelfExclusion + enums) and none is withdrawal-related. Model DepositRequest at schema.prisma:473 is the shape to copy; field list is fully specified at manager-account-dashboard/docs/API-CONTRACT.md:518-531.
- WithdrawalStatus enum — CONFIRMED ABSENT. The only `withdraw` tokens in schema.prisma are IchancyOperation.WITHDRAW_FROM_AGENT (:177) and .WITHDRAW_FROM_PLAYER (:182), plus AdminRole.SUPPORT (:50) matching on 'support'. Needs: REQUESTED APPROVED DEBITING DEBITED PAID DEBIT_FAILED NEEDS_RECONCILIATION REJECTED CANCELLED (API-CONTRACT.md:533-534). Copy the DepositStatus enum's placement at schema.prisma:87.
- WithdrawalTransition model — CONFIRMED ABSENT. DepositTransition DOES exist at schema.prisma:602 and is the exact template; withdrawals need it to support the 'DEBITED is not PAID' queue semantics (API-CONTRACT.md:543-548), where a human must be able to see who moved a row and when.
- Referral code / referredByPlayerId / referralLockedAt on Player — CONFIRMED ABSENT. Player model schema.prisma:341-393 has no such column and no Referral relation; bindings live in AuditLog (schema.prisma:840) under action `player.referral.bound`. The gap is documented in-code at src/modules/player/services/referral.service.ts:4-27, which also states the fix: `referred_by_player_id uuid null` + `referral_locked_at timestamptz null` on `players` plus a partial unique index, backfillable from audit_logs because nothing was discarded.
- Support ticket / FAQ models — CONFIRMED ABSENT. No model in the 36-declaration list; `grep -niE 'ticket\|support\|faq' prisma/schema.prisma` matches only AdminRole.SUPPORT at :50. Recommend NOT adding models — serve FAQ as static config until a dashboard editing contract exists.
- Service-status / version registry — CONFIRMED ABSENT. src/core/health/indicators/ holds exactly database.indicator.ts and redis.indicator.ts; there is no model, no indicator, and no controller for the four player-facing services the Support tab names (bot, platform, payments, sync). Likely needs no table at all — compute the board live and cache it in Redis (core/cache exists) rather than persisting status rows.
- ADDITIONAL: no BotSetting / BotMenu / Tenant model. `withdrawalMode: 'AUTO'\|'MANUAL'` and `miniAppUrl` are specified on /v1/admin/bot-menu/settings (API-CONTRACT.md:429-430, 481-492) and again on TenantView (:789-794), but schema.prisma has no model holding either. The withdrawal module's AUTO-vs-MANUAL branch (API-CONTRACT.md:540) therefore has nothing to read, so this must land alongside WithdrawalRequest or the withdrawal flow has no mode.

**Endpoints:**

| Sev | Endpoint | Purpose |
|---|---|---|
| 🔴 | `UI src/lib/api/*` | HTTP client, base URL, auth header injection, error-envelope handling, react-query hooks |
| 🔴 | `UI Telegram initData bootstrap + token storage/refresh` | Read window.Telegram.WebApp.initData, POST /v1/auth/telegram, persist + refresh the token pair, call ready()/expand()/themeParams |
| 🔴 | `POST /v1/withdrawals` | Player requests a cash-out |
| 🔴 | `GET /v1/withdrawals` | Player's own withdrawal history for the 'العمليات' tab |
| 🔴 | `UI Withdrawal screen / tab` | Player-facing withdrawal form and status list |
| 🔴 | `UI Deposit screen — payment destination display` | Show the player the account identifier / holder / instructions to pay into |
| 🟠 | `POST /v1/withdrawals/:shortId/cancel` | Player cancels their own withdrawal while still REQUESTED |
| 🟠 | `GET /v1/me/referral` | Player's referral code + t.me invite link for the Account tab's two copy fields |
| 🟠 | `GET /v1/me/casino-credentials` | ichancy.com username + password as copyable fields in the Account tab |
| 🟠 | `GET /v1/status` | Public service-status board: app version + per-service state and latency (bot, platform, payments, sync) |
| 🟠 | `UI /deposits/$shortId — deposit detail screen` | Status timeline, rejection code/note, proof count, expiry countdown, cancel, add-another-proof |
| 🟠 | `UI Auth gate, loading, empty and error states` | Unauthenticated, eligibility-blocked (self-exclusion), in-flight, empty-history and API-error branches |
| 🟠 | `UI Idempotency-Key generation for deposit creation` | Per-attempt key so a retry on a flaky mobile network cannot open a second deposit |
| 🟡 | `GET /v1/support/faq` | FAQ content + a support chat destination for the two dead cards in the Support tab |
| 🟡 | `UI Proof upload limits enforcement` | Read maxBytes / maxProofsPerDeposit and reject oversized files before uploading |

---

## 5. Domain notes

The single most valuable output of the audit. Each note states what a rebuilder must not get wrong.

<details>
<summary><b>auth</b> — 10 gaps</summary>

**Rebuild from these dashboard files:**

- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md — section 2 Authentication (lines 41-129: both doors, the full failure taxonomy with statuses and `details` shapes, the agent-principal JIT rule, rate limits) and section 5 The tenant claim (lines 1342-1384: how `tid` and X-Tenant-Id behave)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/endpoints.ts:138-157 — authApi.signIn, the only auth call the console makes
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/admin.ts — adminSessionSchema (:35-49), adminIdentitySchema (:26-32), AdminCredentialsBody (:105-127), agentOperatorChoiceSchema + agentOperatorChoices (:129-150), adminUserSchema (:6-19)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/handlers.ts:306-388 (agentSignIn — exact refusal order, statuses, details payloads) and :538-609 (the two route handlers with concrete success bodies)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/auth/auth-provider.tsx — signIn wiring (:118-137), the no-refresh expiry timer (:80-98), the central 401 -> signOut('unauthorized') hook (:68-77)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/auth/session-storage.ts — sessionStorage-only persistence, expiry handling, EXPIRY_WARNING_MS
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/features/auth/login-page.tsx — the single form, the ambiguity picker, credentialsErrorMessage (:135-150) enumerating every code the UI branches on
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/features/auth/login-page.test.tsx:150-215 — the concrete 409 details.operators fixture and the exact retry body { username, password, operatorSlug }
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/auth/permissions.ts — the role/capability table the backend guards must mirror
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/features/auth/messages.ts — the three distinct refusal sentences, which is why the three codes must stay three
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/demo.ts — MOCK_ROLE_LOGINS / MOCK_AGENT_USERNAMES / MOCK_SUSPENDED_AGENT_USERNAME, the fixture accounts each refusal path was demonstrated with

**Findings**

THE HEADLINE: the backend's admin auth surface is one route older than the dashboard's entire model of sign-in. @Controller('v1/admin/auth') (C:/Users/dell/Desktop/bot/Telegram-mini-app/src/modules/admin/controllers/admin-auth.controller.ts:35) exposes ONLY POST bot-code. The dashboard's only sign-in call, POST /v1/admin/auth/credentials, does not exist in any form. The login screen is therefore 100% non-functional against this backend, and since every dashboard route sits behind the auth guard, so is the whole console.

WHAT THE BACKEND HAS THAT THE DASHBOARD NO LONGER WANTS: POST /v1/admin/auth/bot-code and the /console bot command that mints its codes (src/modules/admin/telegram/admin.handlers.ts:172-201; src/modules/admin/services/admin-login-code.service.ts). docs/API-CONTRACT.md:73-77 records that BOTH were REMOVED on 2026-09-05 — "a bot that hands out console credentials leaves them in a chat log" — and that BOT_CODE_INVALID / BOT_CODE_EXPIRED (src/modules/admin/enums/admin-error-code.enum.ts:8-10) are RETIRED AND MUST NOT BE REUSED. When rebuilding, delete the route, the /console handler, AdminLoginCodeService, BotCodeDto, the admin-scoped half of core/auth/services/login-code.service.ts, and the admin-bot-code throttle rule (src/core/throttler/throttle-routes.ts:73-84). The PLAYER-side bot-code route (POST /v1/auth/bot-code) STAYS — it belongs to the mini-app, not the console.

THE REAL SIZE OF THIS GAP IS NOT TWO ROUTES. `grep -rni tenant` over the backend's entire src/ returns ZERO hits. The multi-tenant model that /credentials, the tid claim, the operator picker, the agent principal and X-Tenant-Id all rest on simply does not exist yet — no Tenant model, no tenantId on AdminUser, no tenant middleware, no PLATFORM_ADMIN role. Rebuilding auth in isolation is not possible: the Tenant model and AdminUser.tenantId are hard prerequisites, so sequence the tenants domain first (or at least its Prisma model plus the tenant-context middleware) and land auth on top.

SECURITY PROPERTIES THAT ARE PART OF THE CONTRACT, NOT IMPLEMENTATION DETAIL — a rebuild that loses these is wrong even if the happy path works:
- The two credentials behind one field pair must be INDISTINGUISHABLE: same response shape, same 401 sentence for a miss on either. Which one answered must not be reported and must not be inferable from timing — hence the constant-time compare against the sealed tenant password.
- NOTHING about which operators exist may be said until a password is proved right. All four *_OPERATOR_* codes are post-authentication answers about an operator the caller has already proved they run.
- The four refusals are four and not one because only ADMIN_CREDENTIALS_INVALID is fixed by retyping; the other three name the person who CAN fix it. The dashboard renders three distinct sentences off these codes (src/features/auth/messages.ts:43-47).
- 409 AMBIGUOUS is a QUESTION. The console keeps the password in memory and re-submits with operatorSlug; it does not clear the field or show an error. Answering 401 there would leave an owner with correct credentials retyping forever.
- operatorSlug must be genuinely optional under forbidNonWhitelisted — the client omits the KEY, never sends undefined (src/lib/auth/auth-provider.tsx:129-132).
- Password is NOT trimmed; username IS. The asymmetry is deliberate and asserted in the provider.

SESSION SEMANTICS TO PRESERVE: admins get an ACCESS TOKEN ONLY — no refresh token, no session row. src/modules/admin/dtos/admin-auth.dto.ts:36-46 already says this and the dashboard is built on it (docs/TASKS.md:2081-2084 lists "No refresh token" under "deliberately not a gap"). The console stores the session in sessionStorage (not localStorage), counts down expiresAt, warns at 5 minutes, and signs out on any 401 from one central place. Do NOT introduce an admin refresh route while rebuilding; the whole client is designed around its absence.

RESPONSE ENVELOPE: every body is { success, data, error: { code, message, details? }, meta: { correlationId, timestamp } }. The dashboard reads error.code and error.details.operators through ApiError, and Zod-parses data against adminSessionSchema — a role string outside the six-value enum, or a missing accessToken/expiresAt/admin, makes signIn reject client-side even on an HTTP 200.

ONE MORE COUPLING: AdminIdentityService caches identity for 60s keyed on the GLOBAL telegramUserId (src/core/auth/services/admin-identity.service.ts:44-74, adminIdentityKey) and does findUnique({ where: { telegramUserId } }). Once AdminUser is tenant-scoped and telegramUserId becomes nullable, both the cache key and that lookup must be re-keyed on (tenantId, telegramUserId), or the agent principals — all of which share the reserved id 0 — will collide across operators.

**Verification**

Zero refutations — I could not find an implementation for any claimed gap, and several are worse than stated. Method: enumerated every @Controller in the backend (15 total; only src/modules/admin/controllers/admin-auth.controller.ts:35 is on v1/admin/auth, single handler at :45), confirmed there is no global prefix (src/main.ts:262 explicitly declines setGlobalPrefix('v1') because each controller carries its own v1/ path, so no path reconstruction error is possible), read prisma/schema.prisma:415-471 in full, listed prisma/migrations (two, neither tenant-related), read src/core/throttler/throttle-routes.ts:49-105 in full, read src/core/auth/guards/roles.guard.ts:40-67, src/core/auth/auth.types.ts:1-30, src/core/auth/services/session.service.ts:355-382, src/modules/admin/dtos/admin-auth.dto.ts and admin-user.dto.ts in full. `grep -rni tenant src prisma` is genuinely ZERO hits across .ts, .prisma and .sql — the operator concept has never existed in this backend. The single partial refutation is gap 6: the /v1/admin/admins routes DO exist (admin-user.controller.ts:44 POST, :53 PATCH) — only the credential fields (nullable telegramUserId, password, hasPassword) are missing, so that work is a DTO+service+schema edit rather than a new module. Dependency order for the rebuild: Tenant model + AdminRole.PLATFORM_ADMIN + AdminUser column changes (migration) -> tid claim and tenant middleware -> /credentials and /ichancy routes + throttle rule in the same commit -> admins DTO password handling.

</details>

<details>
<summary><b>tenants</b> — 26 gaps</summary>

**Rebuild from these dashboard files:**

- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/TENANT-OPERATIONS.md (all 324 lines — the single most valuable file for this domain; §1 create semantics, §3 the shared-Ichancy-session trap, §4 the three places still assuming one operator, §5-6 the six operational endpoints with shapes and six settled details, §7 the per-operator setup loop, §8 what is still open)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:727-805 (Tenants section — routes, create required/optional split, default resolution, TenantView field list, TenantStatus)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:1040-1075 (platform-defaults), :1079-1100 (stats/tenants), :1128-1165 (finance/balances + refresh), :1165-1196 (the provisioning block)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:1342-1400 (§5 'The tenant claim' — the tid claim, tenant-context middleware, TenantOverrideInterceptor, and the three X-Tenant-Id rules with a measured truth table)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:40-60 (AdminSessionView carries tenantId/tenantSlug), :125-200 (AdminRole incl. PLATFORM_ADMIN, the full capability->role table, mayGrantRole rule)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/tenant.ts (all 319 lines — zod schemas and TS interfaces for Tenant, CreateTenantBody, UpdateTenantBody, TenantWebhook, TenantBotSetup, TenantBotHealth, TenantIchancyHealth, TenantHealth, UpdateTenantIchancyBody, UpdateTenantBotBody, TenantProvisioning, TenantCreated, PlatformDefaults, UpdatePlatformDefaultsBody)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/endpoints.ts:656-810 (statsApi, platformDefaultsApi, platformFinanceApi, tenantsApi — every path, verb and parse schema)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/handlers.ts:2003-2143 (the 13 tenant MSW handlers with exact status codes and error codes), :755-820 (platform-defaults + finance), :955-975 (stats)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/db.ts:1140-1230 (resolveIchancyAgentId + createTenant + the provisioning report), :1320-1560 (platformDefaultsView, updatePlatformDefaults, operatorOps, registerWebhook, removeWebhook, replaceTenantBot, updateTenantIchancy, operatorsSharingAgent, tenantHealth), :664-692 (importPlayersForTenant), :1620-1648 (financeBalancesView, refreshTenantFinance)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/fixtures.ts:145-149 (TENANT_IDS), :1745-1830 (three complete Tenant rows: active tenant-zero, active northern-branch, suspended pilot-operator), :1899-1950 (mockTenantFinance rows deliberately containing every failure state)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/queries.ts:1115-1270 (useTenants, useTenant, useCreateTenant, useUpdateTenant, useActivateTenant, useSuspendTenant, useTenantHealth, useRegisterTenantWebhook, useRemoveTenantWebhook, useSetupTenantBot, useUpdateTenantIchancy, useUpdateTenantBot, useImportTenantPlayers — plus the cache-invalidation graph each one needs)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/client.ts:120-135 and :270-290 (how X-Tenant-Id is attached to every request)

**Findings**

THE HEADLINE: the backend has NO tenant concept whatsoever. This is not a few missing endpoints — it is the entire structural spine of the product, and it is 100% absent. Verified four independent ways, not inferred from one grep:

1. `grep -rni "tenant|merchant|organization|org|workspace|multi-tenan|subdomain|x-tenant" --include=*.ts --include=*.prisma` over C:/Users/dell/Desktop/bot/Telegram-mini-app returns ZERO functional hits — only "subdomain" in Cloudflare cookie comments and "api.telegram.org" in log redaction.
2. `grep -cin tenant prisma/schema.prisma` = 0. There is no Tenant model, no tenant_id column on any of the 21 models, no TenantStatus/DepositMode/WithdrawalMode enum, no PlatformDefaults model.
3. All 14 @Controller declarations enumerated: health, telegram/webhook, v1/admin (approval-limit), v1/admin/auth, v1/admin/admins, v1/admin/deposits, v1/deposits, v1/admin (payment-method), v1/payment-methods, v1/admin/players, v1/auth, v1, v1/admin/reconciliation, v1/wallet. There is no src/modules/tenant directory and no v1/admin/tenants, /platform-defaults, /finance or /stats controller.
4. src/core/auth/auth.types.ts:18-27 — AccessTokenClaims is { sub, tgid, role, sid, iat, exp }. No `tid`. No tenant-context.middleware.ts, no TenantOverrideInterceptor, no tenant-scope Prisma extension (src/core/prisma/ has only actor-stamp.extension.ts), no prisma/sql/006, no `X-Tenant-Id` anywhere in src.

The backend is a SINGLE-TENANT application. The dashboard is a MULTI-TENANT console. That is the gap.

REBUILD ORDER — this domain gates almost everything else, so build it first and in this order:
  1. Prisma: Tenant model + TenantStatus/DepositMode/WithdrawalMode enums + PlatformDefaults + AdminRole.PLATFORM_ADMIN. Add tenant_id to every scoped model, and flip the global uniques on AdminUser.telegramUserId/username and Player.telegramUserId/ichancy* to composite (tenantId, x) uniques. Seed tenant zero. Add the CHECK forbidding a PLATFORM_ADMIN row outside tenant zero.
  2. The claim: sign `tid` into both login routes; a tenant-context middleware that runs BEFORE any guard inside runWithTenant(tid); AdminIdentityService resolving (tenantId, telegramUserId); a TenantOverrideInterceptor AFTER the guard for X-Tenant-Id; a Prisma extension that scopes every query so a foreign id is a 404, not a leak.
  3. Then the 13 tenant routes + platform-defaults + finance + stats/tenants.

THREE MONEY-PATH BUGS the backend will still have after the CRUD lands (TENANT-OPERATIONS §4, all three verified as still true in the current code):
  - src/core/file/telegram-file.service.ts:108 downloads deposit proofs with the GLOBAL config.telegram.botToken. Telegram file_ids are bot-scoped, so every receipt uploaded to operator B's bot fails to ingest. This is on the money path.
  - src/core/ichancy/http-ichancy.adapter.ts reads config.ichancy.currency for wallet lookup and amounts — an operator on another currency reads the wrong wallet.
  - src/core/auth/services/init-data.service.ts validates mini-app initData against the GLOBAL bot token, so operator B's mini-app players cannot authenticate. Same for POST /v1/auth/refresh (no bearer token, so the middleware cannot know the operator). Both are unauthenticated-request designs with their own threat model — flag them, do not hand-wave them.

THE ICHANCY SESSION TRAP (TENANT-OPERATIONS §3) — easy to rebuild wrong and it fails intermittently with nothing in the logs naming the cause. Ichancy issues ONE token pair per agent account and signing in again kills the previous tokens. Do NOT key the session by tenant. Key it by AGENT IDENTITY: `agentKey = sha256(ichancyBaseUrl + '|' + ichancyUsername).slice(0,32)`, then `ichancy:session:v2:<agentKey>:tokens` and `lock:ichancy:session:<agentKey>`, and key the in-process single-flight memo the same way. The password never appears in a key. This is also why TenantIchancyHealth.sharesAgentWith matches on baseUrl+username and NOT on agentId.

CROSS-DOMAIN OVERLAP — flag to the orchestrator so these are not built twice or dropped between agents:
  - GET /v1/admin/stats and GET /v1/admin/stats/tenants: neither exists. The tenant-scoped one belongs to the stats domain; I listed only /stats/tenants here.
  - /v1/admin/finance/balances and /finance/tenants/:id/refresh sit on "the tenants surface" per the contract but read USDT wallets and Sham Cash — overlaps the platform-finance / usdt-rails / shamcash domains.
  - POST /v1/admin/auth/credentials (username+password, with operatorSlug? disambiguation and the AGENT_OPERATOR_AMBIGUOUS "question, not a failure" flow) does not exist — the backend has only @Post('bot-code'). That is the auth domain's gap, but AdminSessionView's { tenantId, tenantSlug } and the signed `tid` are this domain's requirement on it.
  - POST /v1/admin/tenants/:id/import-players shares its implementation with the tenant-scoped POST /v1/admin/players/import, which also does not exist (player-admin.controller.ts declares only @Get(), @Get(':id'), @Post(':id/ichancy-account')).
  - Telegram destinations, bot-menu and reports are all tenant-keyed and none of them exists either.

TWO SUBTLE CONTRACT RULES that will silently corrupt data if rebuilt wrong:
  - On POST /v1/admin/tenants an omitted optional field must be ABSENT from the JSON, never '' or null. An empty string is a value and the backend would store it rather than resolve the platform default — that is how an operator ends up with a blank currency. src/features/tenants/tenant-form-dialog.tsx's toCreateBody is the one place the console decides this.
  - hasWebhookPath is NOT delivery status. It is true for a brand-new operator Telegram has never heard of. Delivery is health.bot.webhookMatches, always.

OPERATIONAL BOOTSTRAP GAP: a fresh install has no PLATFORM_ADMIN and no way to reach one from inside the product — prisma/seed/admin.seed.ts seeds a SUPER_ADMIN and POST /v1/admin/admins refuses to grant PLATFORM_ADMIN unless the caller already holds it. The lost backend solved this with an `npm run admin:platform [-- <telegram-id>] [--replace-super-admin]` script; package.json has no such script today. TENANT-OPERATIONS §7 also documents a real PowerShell trap worth preserving: PS 5.1 eats a bare `--`, so the script must also accept the confirmation via npm_config_replace_super_admin (and deliberately NOT npm_config_force, which any ~/.npmrc may carry).

WHAT MAKES THIS DOMAIN CHEAP TO REBUILD DESPITE ITS SIZE: docs/TASKS.md names the exact backend file paths the lost work used — src/modules/tenant/{controllers/tenant-admin.controller.ts, services/tenant.service.ts, services/tenant-operations.service.ts, services/platform-defaults.service.ts, dtos/tenant.dto.ts, dtos/tenant.view.ts, dtos/tenant-operations.view.ts} — and src/mocks/db.ts:1158-1230 is a working reference implementation of createTenant + provision() including the default-resolution precedence. TASKS.md even cites line numbers inside the lost files (tenant.service.ts:198 reads platformDefaults.current(); tenant.service.ts:298 calls provisionDefaultPaymentMethods; tenant-admin.controller.ts:80-95 is the create route), which is a useful sanity check on the rebuilt shape.

**Verification**

Verification method: enumerated every @Controller in src (14 total, listed below), grepped the whole backend (src + prisma, node_modules excluded) for `tenant` in every casing — 0 lines — plus synonyms (operator, merchant, organisation/organization, org, brand, workspace, multitenant/multi-tenant), and for each gap's intent rather than its name (finance/balances, stats, platform-default, house-agent, import-players/importPlayers/bulkImport, activate/suspend, seal/encrypt/aes-256-gcm/slugify, shamcash, X-Tenant-Id, tid, PLATFORM_ADMIN, usdt/trc20/tron). Also enumerated every @Get/@Post/@Patch/@Delete in the admin-facing controllers to catch composed paths.

Route composition: src/main.ts:262 carries an explicit comment that setGlobalPrefix('v1') is deliberately NOT called — each controller declares its own 'v1/...' path — and there is no enableVersioning. So the @Controller strings ARE the full paths; there is no prefix the previous agent could have mis-reconstructed. Full controller list: health (core/health/health.controller.ts:31), telegram/webhook (:50), v1/admin (admin-approval-limit:25), v1/admin/auth (:35), v1/admin/admins (:27), v1/admin/deposits (:69), v1/deposits (:44), v1/admin (admin-payment-method:49), v1/payment-methods (:39), v1/admin/players (:44), v1/auth (:24), v1 (player.controller:25), v1/admin/reconciliation (:60), v1/wallet (:16). app.module.ts imports exactly six feature modules: Admin, Deposit, PaymentMethod, Player, Reconciliation, Wallet — there is no tenant, finance, stats or platform-defaults module to have been overlooked.

RESULT: 0 of 20 claimed gaps refuted. Every one is genuinely absent. The previous agent's evidence was accurate in substance; I found only two small inaccuracies in its supporting detail, both recorded in additionalGapsFound because they change HOW to rebuild rather than WHETHER: (a) `webhookPathToken` does exist as a global config value and the webhook route already does the constant-time double compare, so gap 7 is a swap of the compare's data source, not a from-scratch route; (b) a working AES secret box already exists at src/modules/player/utils/secret-box.util.ts, so gap 3's sealing is a lift-and-generalise, not new crypto.

Dependency ordering for the rebuild: nothing in this domain can be built before (1) the Tenant + PlatformDefaults models and the TenantStatus/DepositMode/WithdrawalMode enums, (2) AdminRole.PLATFORM_ADMIN, (3) the tenantId column + composite uniques replacing the global uniques on AdminUser (schema.prisma:422-423) and Player (:344,355,357,358), and (4) the tid claim + tenant-context ALS + tenant-scope Prisma extension. Then the two per-tenant factories in additionalGapsFound (bot registry, Ichancy adapter) gate gaps 5, 7, 9, 10, 11, 12, 13, 16, 17.

</details>

<details>
<summary><b>staff</b> — 13 gaps</summary>

**Rebuild from these dashboard files:**

- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:631-670 (Admin directory + Approval limits — authoritative paths, bodies, error codes, username/password rules)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:131-190 (AdminRole list, capability->roles table, mayGrantRole rule)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:40-110 (POST /v1/admin/auth/credentials, agent principal creation, bot-code removal)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/admin.ts (adminUserSchema:6-19, approvalLimitSchema:55-66, AdminListQuery:68-73, CreateAdminBody:80-86, UpdateAdminBody:88-95, SetApprovalLimitBody:97-102, isCurrentLimit:105)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/enums.ts:15-42 (ADMIN_ROLES, labels, per-role descriptions)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/endpoints.ts:508-535 (adminsApi — every staff path) and :140-158 (authApi.signIn)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/queries.ts:936-1016 (useAdmins, useAdmin, useApprovalLimits, useOpenApprovalLimits, useCreateAdmin, useUpdateAdmin, useDeactivateAdmin, useSetApprovalLimit, useEndApprovalLimit)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/handlers.ts:1831-1925 (concrete request/response JSON, status codes and error codes for all 8 endpoints)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/db.ts:1050-1097 (createAdmin, setApprovalLimit — exact write semantics incl. lower-casing and version closing)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/fixtures.ts:159-283 (mockAdmins, mockApprovalLimits — canonical entity instances)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/auth/permissions.ts (capability map, PLATFORM_ADMIN superset, mayGrantRole:177-185)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/features/staff/admin-form-dialog.tsx (username/password validation constants :59-64, create body :208-217, update body :219-231)

**Findings**

ROUTE COVERAGE IS FINE; THE CONTRACT IS NOT. All 8 staff paths the dashboard calls exist in the backend at exactly the right method+path (admin-user.controller.ts:27-70, admin-approval-limit.controller.ts:25-58). The damage is entirely in DTOs, the view shape, the role enum and tenant scoping — a rebuilder should NOT re-scaffold controllers, only rewrite the DTOs/service/schema.

THE APPROVAL-LIMIT HALF IS ALREADY CORRECT. Backend ApprovalLimitView (dtos/approval-limit.dto.ts:52-63) is field-for-field identical to the dashboard's approvalLimitSchema (types/admin.ts:55-65), including decimal strings in MAJOR units, nullable secondApprovalAbove and nullable effectiveTo; toApprovalLimitView (services/admin-approval-limit.service.ts:82-97) formats them right; SetApprovalLimitDto matches SetApprovalLimitBody exactly; the list is returned as a bare array newest-first, and DELETE lives at /v1/admin/approval-limits/:id as the console expects. The ONLY things missing here are PLATFORM_ADMIN in the guard role lists and tenant scoping. Do not rewrite this service.

THE SINGLE HIGHEST-VALUE FIX is `hasPassword` on AdminUserView. It is one line (`hasPassword: admin.passwordHash !== null`) plus making telegramUserId nullable, and without it EVERY staff request — list, detail, create, update, deactivate — fails zod parsing in the console and the Staff page renders an error state even when the backend did the right thing. Fix this before anything else.

THE STAFF MODEL CHANGED UNDER THE BACKEND'S FEET. On 2026-09-05 a staff account stopped being "a Telegram id" and became "a username and a password" (API-CONTRACT.md:640-654, admin-form-dialog.tsx:31-52). The backend is still on the old model end-to-end: CreateAdminUserDto demands telegramUserId, there is no password field anywhere, no hashing library is imported, and the only sign-in route left is the bot-code exchange the contract says was deleted. Rebuilding staff therefore means rebuilding the credential path with it — POST /v1/admin/auth/credentials is listed as a gap here even though it nominally belongs to the auth domain, because a staff account with no way to sign in is not a staff account.

TENANT SCOPING IS A CROSS-CUTTING PREREQUISITE, NOT A STAFF FEATURE. `grep -rn 'tenantId|X-Tenant|PLATFORM_ADMIN' Telegram-mini-app/src` returns zero hits across the entire backend. Sequence the rebuild: (1) Tenant model + AdminUser.tenantId + the two composite unique indexes + PLATFORM_ADMIN enum value; (2) password hashing + AdminUserView.hasPassword; (3) the DTO rewrite for create/update; (4) role lists and mayGrantRole; (5) POST /v1/admin/auth/credentials. Steps 2 and 3 are independently shippable and unblock the Staff screen on a single-tenant deployment.

WHAT NOT TO CHANGE: the offset-pagination envelope already matches (common/dtos/paginated.dto.ts paginate() emits { total, limit, offset, hasMore }, which is exactly what the client's pageMetaSchema parses at src/lib/api/client.ts:238-250); DELETE-as-deactivate is already correct and correctly justified (admin_users is referenced by every deposit with onDelete: Restrict); the ADMIN_ALREADY_EXISTS / ADMIN_SELF_MODIFICATION / ADMIN_LAST_SUPER_ADMIN / ADMIN_NOT_FOUND / APPROVAL_LIMIT_NOT_FOUND codes already exist in admin.constants.ts:13-22 and match what the console switches on; the last-super-admin check is already done inside the write transaction, which is the hard part.

ONE DELIBERATE DIVERGENCE TO SETTLE: the backend refuses a self-edit only when role or isActive actually changes, the MSW mock refuses every self-PATCH. Pick one and make the contract doc say it — the console just renders the server's message.

**Verification**

Nothing was refuted. I searched for every claimed route by path segment and by intent across the whole backend, read every admin controller's decorators (all five admin-surface controllers are @Controller('v1/admin...'), and main.ts:262 explicitly documents that setGlobalPrefix is NOT called and no versioning is enabled, so there is no hidden path composition), and read prisma/schema.prisma directly rather than trusting line numbers. Three greps settle most of the domain: `grep -rni 'PLATFORM_ADMIN|platformAdmin|platform-admin' src prisma scripts package.json` = 0 hits, `grep -rni 'tenant' src prisma scripts package.json` = 0 hits, `grep -rn 'scrypt|argon2|bcrypt' src package.json` = 0 hits (no hashing code and no hashing dependency installed). The previous agent's evidence was accurate in every particular I checked, including the exact line ranges. The staff domain is not partially behind — the entire post-2026-09-05 model (password accounts, tenants, PLATFORM_ADMIN) is absent, while the pre-2026-08-20 model (Telegram-id staff + bot-code login) is fully intact and still wired, which is consistent with the backend being ~20 days stale rather than corrupted. Approval limits are the one part of this domain that is genuinely complete: the backend ApprovalLimitView (src/modules/admin/dtos/approval-limit.dto.ts:48-59), the AdminApprovalLimit model (prisma/schema.prisma:446-467) and all three routes on AdminApprovalLimitController (controllers/admin-approval-limit.controller.ts:30,36,52 composing to GET/POST /v1/admin/admins/:adminUserId/approval-limits and DELETE /v1/admin/approval-limits/:id) match the dashboard's approvalLimitSchema and endpoints.ts:526-534 exactly — only the role list and tenant scoping need touching there. Rebuild order that minimises rework: (1) Prisma — PLATFORM_ADMIN enum value, Tenant model, AdminUser.tenantId + nullable telegramUserId + composite uniques; (2) a scrypt hasher in core/ plus the credentials route and lastLoginAt stamp; (3) DTO/view changes (hasPassword, password, username rules); (4) role constants and mayGrantRole; (5) tenant context/interceptor and repository predicates; (6) delete the bot-code route AND its throttle rule together, or the app will not boot.

</details>

<details>
<summary><b>players</b> — 14 gaps</summary>

**Rebuild from these dashboard files:**

- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md (lines 295-412 — the authoritative Players section: routes, role table, AdminPlayerView field list, the source/blocking/debit narratives, and the 'manual credit is not under /players' correction)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/endpoints.ts (lines 227-333 — playersApi: exact paths, methods, verbs and the BALANCE_CONCURRENCY=4 limiter)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/handlers.ts (lines 1164-1516 — every player MSW handler: concrete request parsing, every error code/status pair, and exact response JSON; plus the manual-credit handler at 1475)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/db.ts (lines 421-692 — debitPlayer, manualCredit, linkIchancyAccount, registerPlayer, blockPlayer, unblockPlayer, importPlayers: the state transitions each route performs)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/player.ts (the complete zod schemas: adminPlayerSchema, ichancyAccountSchema, registerPlayerResultSchema, playerImportSummarySchema, playerDebitSchema, manualCreditSchema, playerBalanceSchema, and the request-body interfaces + length constants)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/enums.ts (lines 179-262 — PLAYER_STATUSES incl. BLOCKED, PLAYER_SOURCES, PLAYER_DEBIT_STATUSES, CREDIT_VERIFIED_BY)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/player-admin-handlers.test.ts (the executable acceptance suite for register / block / unblock / attach-telegram / import / directory filters — assertions name the exact status codes and codes)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/queries.ts (lines 506-695 — cache-invalidation semantics per mutation, which reveal which reads each write is expected to change)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/features/players/ (segments.ts + player-filters.tsx for the query-param contract; block/unblock/attach/register/debit/credit dialogs for the per-error-code UI behaviour; player-balance-cell.tsx for the 'unknown, never zero' balance rule)

**Findings**

THE HEADLINE: of 11 endpoints the dashboard's players domain calls, the backend implements 3 — and 2 of those 3 are shape-incompatible, so the count of endpoints that actually work today is ONE (POST /:id/ichancy-account). The /players list page and the /players/:id detail page both fail at the zod parse boundary before any missing-route error is reached, because adminPlayerSchema (src/types/player.ts:24-45) requires `source`, `blockedAt`, `blockedReason` and `blockedByAdminId` as non-optional keys and toAdminPlayerView (src/modules/player/dtos/player.view.ts:54-62) emits none of them. Fix the view + prisma columns FIRST; every other gap is downstream of that.

ON THE FLAGGED COMMITS a840c76 / 8125cc8: they are NOT the console registration feature. a840c76 ('feat register new player', 2026-08-19) and 8125cc8 ('feat register player without issues', 2026-08-20) add the Ichancy-side registration plumbing — the browser/fetch transports, the Cloudflare cookie harvester, the transport preflight, IchancyHealthService, PlayerLinkService/ensureLinked, a `register-player.command.ts` CLI, and the `POST /:id/ichancy-account` route. That is "register this player WITH ICHANCY", not "register a player row from the admin console". `POST /v1/admin/players` was never built, and player-admin.controller.ts:21-26 carries a doc block explicitly arguing it must never exist ("A player IS a Telegram account here … creating one is not a gap, it is a thing that must not exist"). The dashboard reversed that decision on 2026-09-04 (docs/API-CONTRACT.md:370-385, the "Players that were never a Telegram account" section). Whoever rebuilds must delete that comment along with the NOT-NULL on telegram_user_id — leaving it will get the feature argued back out.

THE ONE-WAY DOOR: `POST /:id/debit` is the only route in this domain that is not idempotent. Ichancy has no idempotency key, so a retry is a second real debit of a real person's money. The contract's rule is that when the server cannot prove which way the call went, it answers 200 with status NEEDS_RECONCILIATION — never a 5xx that invites a retry. Build it with the same mutex + two-attempt + balance-delta verification the credit worker already uses (src/modules/deposit/processors/credit-deposit.processor.ts), and do NOT put @Idempotent() on it (that would replay an HTTP response, which is the wrong guarantee here).

WHAT IS ALREADY IN PLACE AND SHOULD BE REUSED, NOT REWRITTEN: IchancyPort already exposes getPlayerBalance (ichancy.port.ts:84), debitPlayer (:93) and findPlayerByLogin (:99) — so the balance and debit routes are thin layers over existing primitives. PlayerLinkService.ensureLinked is the idempotent link that POST /v1/admin/players must call AFTER its transaction commits. PlayerAccessService.scopedPlayerWhere already applies a viewer scope with AND-only narrowing, so new filters can be added to toPlayerWhere without widening access. The `paginate()` helper already emits the { data, meta:{total,limit,offset} } envelope the dashboard's api.page expects. The ONLY genuinely new upstream primitive needed is a paged "list every player under this agent" IchancyPort method for the import route (the wire constant GET_PLAYERS_FOR_CURRENT_AGENT exists at src/core/ichancy/ichancy.wire.ts:25 but is currently only reachable via a single-login lookup).

MIND THE VALIDATION PIPE: main.ts:196 configures whitelist + forbidNonWhitelisted. Any query param the DTO does not declare is a 400, not a silent ignore. That is why `?source=` and `?blocked=` are blockers rather than cosmetic — three of the four segment tabs 400 immediately.

MONEY IS ALWAYS A STRING OF MINOR UNITS on this boundary (amountMinor, balanceMinor, playerBalanceBeforeMinor/AfterMinor). Never a JS number, never a decimal string like "1500.00" — the dashboard validates /^\\d{1,18}$/ before sending and the backend must refuse anything else with 400 VALIDATION_FAILED and the exact field message 'amountMinor must be minor units as a digits-only string'.

TENANCY IS THE HIDDEN PREREQUISITE: prisma/schema.prisma has zero occurrences of "tenant". The dashboard sends X-Tenant-Id on every call and its mocks scope the player list by it. Several player rules are literally unstateable without it (PLAYER_TELEGRAM_ID_TAKEN "within an operator", the per-operator import, tenant.counts.players). Coordinate with the tenants-domain rebuild before finalising the Player model's unique constraints.

DELIBERATELY OUT OF SCOPE (do not invent endpoints for these): PlayerLimit and SelfExclusion tables exist and are complete, but the dashboard has NO routes for either — SELF_EXCLUDED shows up only as a status-filter option. And `POST /v1/admin/players/:id/credit` must NOT be created; crediting is POST /v1/admin/deposits/manual with playerId in the body, so it rides the deposit → approve → credit spine and inherits the four-eyes admin_approval_limits bound (docs/API-CONTRACT.md:344-361). Also note the sibling route POST /v1/admin/tenants/:id/import-players (endpoints.ts:804) returns the same PlayerImportSummary shape — build the import service once and expose it from both places."

**Verification**

Verification method: enumerated EVERY route in the backend with a single grep over all *.controller.ts for @Controller/@Get/@Post/@Patch/@Put/@Delete (full inventory, 70 routes), so no route could be missed by a naming guess. Confirmed there is no setGlobalPrefix and no enableVersioning — src/main.ts:262 carries a comment saying each controller declares its own `v1/...` prefix, so the composed paths are exactly as the decorators read. The only routes under v1/admin/players are @Get(), @Get(':id') and @Post(':id/ichancy-account'). All ten claimed gaps survived refutation; nothing could be refuted. I also searched by intent rather than name: for balance I grepped getPlayerBalance/balanceMinor/playerBalance repo-wide and checked the wallet module (GET /v1/wallet is @PlayerAuth self-scoped, no :playerId, so it cannot serve the admin column); for block I checked whether it might be modelled as a status change (no status-mutation route or service exists at all — the only prisma.player.update* calls are link bookkeeping); for manual credit I grepped 'manual' across the whole deposit module; for import I checked whether getPlayersForCurrentAgent had an admin-reachable path (it does not — it is reached only through IchancyPort.findPlayerByLogin, one login at a time). I also checked two things the first agent did not: the pagination envelope matches exactly (PaginatedResult {data, meta:{total,limit,offset,hasMore}} vs the dashboard's api.page), and the player-detail deposits tab is NOT a gap — ListDepositsQueryDto already supports playerId (src/modules/deposit/dtos/deposit-query.dto.ts:68). One correction to the first agent's gap 2 evidence: the detail route does return the full AdminPlayerView for an admin viewer (player.service.ts:54 branches on viewer type); the TS return annotation is just wrong. The substance of the claim — missing source/blocked* — is unaffected.

</details>

<details>
<summary><b>deposits</b> — 5 gaps</summary>

**Rebuild from these dashboard files:**

- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/USDT-RAILS-STATE.md — THE most valuable file for this domain. A handoff note written on the lost machine that describes the missing backend file by file (src/core/chain/*, deposit-chain-check.service.ts, auto-credit-decision.ts, deposit-auto-credit.service.ts, ChainWatchProcessor), the two unapplied migrations, the env flags, and six real bugs with their root causes. Rebuild the chain work from this, not from first principles.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:195-293 — authoritative endpoint list, AdminDepositView field list, the six-arm ReviewOutcome union, the DepositStatus and RejectionCode enums, and the full chain-check contract with its per-outcome rules.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:345-364 — why manual credit is POST /v1/admin/deposits/manual and not /players/:id/credit.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/deposit-chain-check.ts — the complete verdict algorithm as executable code: which outcome, with which fields null, and the exact bigint arithmetic (toUsdtMinor / toCurrencyMinor at USDT scale 6 against a rate at scale 2). Port this logic directly.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/deposit-chain-check-handlers.test.ts — the acceptance criteria for chain-check, with worked numbers. Use it as the backend spec's test list.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/handlers.ts:975-1157 — concrete request/response JSON for all ten implemented deposit routes plus chain-check.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/handlers.ts:1468-1517 and src/mocks/db.ts:469-496 — the manual-credit endpoint's validation order, error codes and 202 body.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/deposit.ts — every entity shape (adminDepositSchema, reviewOutcomeSchema, depositChainCheckSchema, chainArrivalSchema) with the reasoning for each.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/player.ts:176-244 — manualCreditSchema, CreditPlayerBody, the 280-char reason limit.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/endpoints.ts:169-225 and :304-312 — the endpoint definitions themselves.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/features/deposits/chain-verdict.tsx + chain-money.ts + approve-dialog.tsx:255-290 — how each of the seven outcomes is consumed, including the three gates on offering creditable as an amount.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/TASKS.md:1080-1130 — CC-019, which documents backend line numbers (payment-destination.service.ts:40-43, :214-215) as they were on the lost machine.

**Findings**

SUMMARY: the deposits domain is in far better shape than the drift suggests. 10 of the 12 admin endpoints the dashboard calls already exist and match field-for-field. Exactly TWO are missing, and both are from the 2026-08-26+ USDT work.

WHAT ALREADY LINES UP (verified, do not re-litigate):
- The backend's AdminDepositView (src/modules/deposit/dtos/deposit.view.ts:60-77) is a field-for-field match for the console's adminDepositSchema (src/types/deposit.ts:37-68) — id, shortId, status, claimed/verified/credited/fee as {minor,amount,currency}, externalReference, senderAccount, proofCount, the five timestamps, rejectionCode/Note, destination, playerId, playerTelegramUserId (stringified, since Telegram ids exceed 2^53), playerTelegramUsername, paymentMethodId, reviewStartedAt, decidedByAdminId, secondApproverAdminId, creditVerifiedBy, creditAttempts, creditKeyEpoch, riskFlags, requiresSecondApproval, proofs[].
- The backend's ReviewOutcome union (deposit-review.service.ts:90-97) is exactly the console's six arms, alreadyHandled included.
- AdminDepositQueueQueryDto (dtos/deposit-query.dto.ts:59-118) accepts every filter DepositQueueQuery declares, with the same comma-list status parsing, the same decimal-string money filters and the same four sort values.
- The cursor envelope matches: backend CursorMeta {limit, nextCursor, hasMore} (common/dtos/paginated.dto.ts:18-23) vs the console's cursorMetaSchema.
- ApproveDepositDto / RejectDepositDto / RetryCreditDto (dtos/review.dto.ts) match the request bodies; retry-credit already answers 202.
- Role gates match: QUEUE_ROLES = SUPER_ADMIN, FINANCE_ADMIN, REVIEWER, SUPPORT, VIEWER; DECIDE_ROLES = the first three.

THE TWO GAPS, AND WHY THEIR SEVERITIES DIFFER:
- chain-check is 'major' rather than 'blocker' by design. The console degrades honestly: a 404 renders as `unavailable` — an outage of ours, never a verdict against the player (chain-verdict.tsx:55-69, and USDT-RAILS-STATE.md says so explicitly). The deposits page and the review sheet keep working. But for the operator's real rail — coded plain `USDT` — it means every crypto deposit is priced by hand.
- manual credit is 'blocker': the credit-player dialog has no other endpoint to call, and the contract forecloses adding one under /players.

THREE TRAPS THE LOST WORK PAID FOR — a rebuilder who misses these reproduces live money bugs:
1. NEVER key chain logic on a payment-method CODE. The operator's rail is coded `USDT`, not `USDT_TRC20`. A networkFor() keyed on codes answered `skipped` for every real deposit for months, silently. Take the network from the ADDRESS: `T…` = TRC20, `0x…` = BEP20. An address cannot lie about its chain; a name can. The console pins this with a regression test.
2. BSC's USDT contract reports 18 decimals, not 6. Applying USDT_SCALE=6 to BEP20 credits 10^12 times the value. Canonicalise to 6 and SEND `scale` on the wire (the console parses `arrived.minor` at the `scale` the response carries, never at a default) — src/features/deposits/chain-money.ts.
3. TronGrid's /transactions/trc20 returns EVENTS, not payments. An `Approval` has the same shape and moves nothing; anyone can emit one for ten million USDT naming the operator's wallet for a few cents. Check `type === 'Transfer'`, the contract address, the destination in code, and pass `only_confirmed=true`.
Both 1 and 2 passed their full test suites on the lost machine — the fixtures encoded the same wrong assumption as the code.

STRUCTURAL RULES THE CONSOLE DEPENDS ON:
- chain-check must stay its OWN resource, never a field on AdminDepositView. It costs a chain-explorer call, so folding it in would make GET /v1/admin/deposits do one per row on a screen that refetches every 30s. deposits-page.test.tsx pins this: the queue asks about no row, opening one deposit asks exactly once. It also has a query-key root outside depositKeys.all so a claim/release cannot invalidate it.
- `arrived` must carry `asset`, not `currency`, so it is structurally NOT assignable to MoneyView. That is the type-level defence against rendering µUSDT at scale 2.
- `creditable` must be null on `pending` and `suspect`. A figure beside either reads as permission to approve.
- `unavailable` must be structurally distinct from the refusals: no arrived, no creditable, no confirmations.

KNOWN-OPEN ISSUES CARRIED OVER (from USDT-RAILS-STATE.md, still unfixed anywhere): TronVerifierService returned `confirmations: required` unconditionally, so `pending` is unreachable on TRC20 — either measure real depth or have auto-credit refuse when depth was not genuinely measured. Auto-credit's kill switch is env-only. Its ceilings are deployment-global in a per-tenant, multi-currency system.

SCOPE NOTE: the auto-credit path (deposit-auto-credit.service.ts, auto-credit-decision.ts with its 26 pure-function guard tests, the `chain` BullMQ queue with ChainWatchProcessor re-enqueuing itself at 45s x 20, approveFromChainEvidence(), and the DEPOSIT_AUTO_CREDIT_* env flags that refuse to boot without both ceilings) is entirely missing too. The dashboard never calls it, so it is not an endpoint gap — but it shares every dependency with chain-check and USDT-RAILS-STATE.md describes it as COMPLETE on the lost machine, so rebuild it in the same pass.

**Verification**

Both claimed gaps CONFIRMED; nothing refuted. Searches actually run, not assumed: full src/ directory tree enumerated (no core/chain/, deposit/services/ holds 11 files, none chain- or manual-related); all 14 *.controller.ts files' @Controller/@Get/@Post/@Patch/@Delete decorators enumerated in one pass, giving the complete route surface; `grep -rni` for chain.check/chainCheck/chain_check, usdt/trc20/bep20/tron/bsc/tx_hash, manual/MANUAL_CREDIT, exchangeRate/rateMinor/quoteAsset, tenant, and settlement over src/ + prisma/ + test/ + docs/; all 36 prisma model/enum declarations listed; prisma/migrations/ listed; prisma/seed/payment-method.seed.ts read in full; git branch -a and `git log --all --diff-filter=D --name-only` checked for deleted or side-branch chain/exchange files (nothing — only master and origin/T1-Auth exist).\n\nRoute-reconstruction traps checked and cleared: src/main.ts:262 explicitly documents that setGlobalPrefix is NOT called because every controller declares its own 'v1/...' path, and there is no enableVersioning — so no endpoint is hiding behind a prefix the previous agent failed to compose. The two @Controller('v1/admin') controllers (admin-payment-method:49, admin-approval-limit:25) were expanded route-by-route in case a deposit-adjacent handler was parked in them; neither holds one.\n\nTwo things worth flagging to whoever sequences the rebuild. (1) The dependency order is ExchangeRate model -> exchange-rates endpoints -> chain-check; building chain-check first yields an endpoint that can only answer 'unavailable'. (2) The manual-credit blocker has a cheap prerequisite that is easy to miss: DepositRequest.paymentMethodId is a non-null FK, so the MANUAL_CREDIT/INTERNAL PaymentMethod row must be seeded per operator before the route can write anything — and because driver-registry.ts:52 deliberately returns no driver for INTERNAL and PaymentMethodService:62 treats a driverless rail as misconfiguration, that seeded row must also be excluded from the player-facing GET /v1/payment-methods listing.\n\nOne finding that sharpens rather than contradicts the previous agent: the crypto rail is not merely un-automated, it is documented as intentionally manual — src/modules/payment-method/rails/crypto-manual.driver.ts opens with 'WHY this is MANUAL even though a blockchain is the one rail that could be checked automatically', and TX_HASH/NETWORK exist there only as free-text proof fields a human reads (line 25). So chain-check is a genuine behaviour change to that rail, not the restoration of a half-wired path, and the driver's header comment should be revised in the same change or it will read as a contradiction of the new endpoint."

</details>

<details>
<summary><b>withdrawals</b> — 11 gaps</summary>

**Rebuild from these dashboard files:**

- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:499-563 — the authoritative withdrawal section: routes, AdminWithdrawalView, the status list, the full state machine narrative, the 409/404 rules and the role sets. Read this first.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/handlers.ts:1519-1649 — the five MSW handlers: exact query parsing, exact filter semantics (shortId is a CONTAINS match), exact validation ordering (body before state), exact error codes and message strings.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/db.ts:694-806 — approveWithdrawal / rejectWithdrawal / markWithdrawalPaid and payoutWalletCheck: which fields each transition stamps, and the four-way wallet-check decision per rail (CRYPTO / SHAM_CASH / declared-balance / unknown).
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/fixtures.ts:1203-1346 — five concrete rows, one per state the queue renders differently. Use these verbatim as the backend's seed/e2e fixtures.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/withdrawal.ts:1-146 — the zod schema for AdminWithdrawalView, WalletCheck, WithdrawalListQuery, the two body types, the 280/128 length limits, and the four status predicates (canDecideWithdrawal, canMarkWithdrawalPaid, isWithdrawalOpen, withdrawalNeedsAttention, isWithdrawalTerminal).
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/enums.ts:263-395 — WITHDRAWAL_STATUSES (exact members and order), OPEN_/ATTENTION_ subsets, WITHDRAWAL_MODES, WITHDRAWAL_SORTS, WALLET_CHECK_STATUSES.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/withdrawal-handlers.test.ts:1-217 — an executable acceptance suite for the backend: default-is-all-statuses, sort, filters, offset paging meta, 404 code, role matrix, the debit-refused branch, 409-not-a-second-decision, and cannot-be-paid-twice. Port these as the backend's e2e tests.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/endpoints.ts:335-372 — the five call sites, including the fact that approve sends NO body and that mark-paid is deliberately non-idempotent.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/queries.ts:696-770 — polling cadence, cache invalidation, and which action moves the agent float (approve and mark-paid do; reject does not).
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/features/withdrawals/withdrawal-model.ts:1-265 — the timeline derivation (four steps x five states), the wallet asset-scale table (USDT/USDC are scale 6, everything else 2), and the playerHandle fallback chain. This tells you which nullable combinations the backend must never emit.
- C:/Users/dell/Desktop/bot/Telegram-mini-app/src/modules/deposit/ — the structural template to copy: deposit-state.machine.ts, controllers/deposit-admin.controller.ts, dtos/deposit.view.ts + deposit-query.dto.ts + review.dto.ts, repositories/deposit.repository.ts, services/deposit-review.service.ts, services/deposit-credit.service.ts (the mutex / two-attempt / balance-delta debit spine to mirror), processors/credit-deposit.processor.ts.

**Findings**

VERDICT: the backend has ZERO withdrawal code. Not a partial module, not a renamed one — nothing. This is the largest single gap of the three repos, and it is confirmed by the backend's own source: src/modules/admin/services/activity-report.service.ts:189-190 says "there is deliberately NO withdrawals section — withdrawals do not exist in this system yet". All five endpoints the dashboard calls are blockers; the /withdrawals route is 100% non-functional against the real API.

THE ONE RULE THAT MATTERS MOST: **DEBITED IS NOT PAID.** The player's casino balance has been taken so it cannot be spent twice, and nobody has been paid. It is the state the queue exists for, the only state mark-paid accepts, and the mistake the whole design is arranged to prevent. If a rebuilder collapses APPROVED->PAID in one step, or makes mark-paid idempotent, players get charged and never paid, or paid twice.

STATE MACHINE (docs/API-CONTRACT.md:536-553), to implement as a withdrawal-state.machine.ts:
  REQUESTED --approve(human, MANUAL)--> APPROVED           [decidedAt, decidedByAdminId=<admin>]
  REQUESTED --auto(AUTO mode, same transaction as create)--> APPROVED  [decidedAt set, decidedByAdminId=NULL]
  REQUESTED --reject(human)--> REJECTED                    [rejectionReason, decidedAt, decidedByAdminId, closedAt]
  REQUESTED --cancel(player)--> CANCELLED                  [closedAt]  (only from REQUESTED)
  APPROVED  --worker picks up--> DEBITING
  DEBITING  --Ichancy OK / BALANCE_DELTA proven--> DEBITED [playerDebitId, debitedAt, then walletCheck taken]
  DEBITING  --Ichancy REJECTED (player spent it)--> DEBIT_FAILED  [failureCode, failureMessage, closedAt]
  DEBITING  --Ichancy AMBIGUOUS/TIMEOUT, delta inconclusive--> NEEDS_RECONCILIATION  [NOTHING RETRIES; a human checks Ichancy]
  DEBITED   --mark-paid(human)--> PAID                     [payoutReference, ledgerPayoutTxId, paidAt, paidByAdminId, closedAt]
Terminal: PAID, REJECTED, CANCELLED. Needs-a-human: DEBIT_FAILED, NEEDS_RECONCILIATION. Everything else is open.

Two ordering rules the console depends on and that are easy to get wrong:
1. The wallet check is taken AFTER the debit lands, not before — walletCheck is null until debitedAt exists (types/withdrawal.ts:29-33, db.ts:775-778).
2. Body validation runs BEFORE the state check on reject and mark-paid (handlers.ts:1604-1619, 1634-1647). A bad reason on an already-decided row is a 400, not a 409.

AUTO mode is NOT auto-payout. Even under AUTO the platform only approves + debits + checks the wallet; a human still performs the transfer and marks paid, because no payout rail here can send money over an API (Sham Cash is read-only). enums.ts:329-334 and API-CONTRACT.md:501-505 both say so.

WHERE APPROVE GETS ITS MONEY MOVEMENT: the debit hands chips back to the agent, so ICHANCY_AGENT_FLOAT goes UP by the amount — the same posting as a manual debit (withdrawal-handlers.test.ts:102-103, queries.ts:730-733). Reject moves nothing.

NEVER-0 RULE on walletCheck: availableMinor and currency are null for `unknown` (the chain or Sham Cash did not answer) and `not_configured` (a placeholder address, a cash office). Neither is `insufficient`, and neither may be stored or emitted as 0. Also note availableMinor is in the WALLET's own asset — USDT is scale 6, so '12500000000' is 12,500.000000 USDT, not 125,000,000.00; the console looks the scale up by currency (withdrawal-model.ts:138-164) and the backend must not pre-format it.

THINGS THE DASHBOARD DOES NOT CALL BUT THE MODULE CANNOT LIVE WITHOUT (out of scope for the gap list, in scope for a rebuild):
  - A player-facing create route (POST /v1/withdrawals or the bot's `withdraw` builtin action) — no row can ever exist without it. The backend's telegram handlers directory has deposit.handlers.ts and player.handlers.ts but no withdraw handler, and there is no bot-menu module at all, so the `withdraw` builtin action (REQUIRED_BUILTIN_ACTIONS, API-CONTRACT.md:495-497) has no implementation.
  - A player-facing cancel route — the CANCELLED status exists solely for "the player, while still REQUESTED" (API-CONTRACT.md:552-553) and nothing in the console can produce it.
  - GET /v1/admin/payment-destinations/:id/balance — the payout wallet read the worker performs to build walletCheck. Also missing (admin-payment-method.controller.ts has only 8 routes, none of them /balance).
  - The shared player-debit service (mutex, two attempts, balance-delta verify) that the contract says the withdrawal worker reuses. It does not exist either — there is no POST /v1/admin/players/:id/debit and no debit service; only the raw IchancyPort.debitPlayer primitive at src/core/ichancy/ichancy.port.ts:93. Build the debit spine once and have both routes call it, or the two will drift and that drift is a double-charge.

The mini-app repo (C:/Users/dell/Desktop/bot/telegram-balance-bot) also contains no withdrawal code — a grep for "withdraw" across its src returns nothing — so the player-side UI for this domain is gone too.

**Verification**

Adversarial sweep found NOTHING to refute — all five routes and all thirteen data-model claims hold up under harder searching than the first agent did. Methods used: (1) full route inventory, not just controller decorators — every @Get/@Post/@Patch/@Delete in src/modules/*/controllers/*.ts (51 routes) plus src/core/health and src/core/telegram; no withdrawal path and nothing that could compose into one; (2) prefix check — src/main.ts has NO setGlobalPrefix and NO enableVersioning (line 262 is a comment explaining that each controller declares its own 'v1/...' path), so no route was hiding behind an unreconstructed prefix; (3) filesystem sweep — `find . -iname '*withdraw*' -o -iname '*payout*'` over the entire repo (untracked files included) returns ZERO files; (4) history sweep — `git log --all -i --grep=withdraw` and a deleted-file scan return nothing, so the work was never committed in this repo; (5) synonym sweep — withdraw/payout/cashout/debit case-insensitive over src+prisma hits only the Ichancy adapter/port/wire/money-codec, ledger 'debit-normal' prose, and the activity-report comment; (6) schema enums read in full (AdminRole 46-54, LedgerTxKind 154-170, BreakCategory 214-225) rather than trusting the summary. Two findings are HARDER than the first agent stated: nothing in the backend calls IchancyPort.debitPlayer at all (the shared debit service does not exist in any direction, not merely for withdrawals), and there is no adapter anywhere that can read an external payout wallet balance, so walletCheck has no possible data source today. One correction in the backend's favour for rebuild: offset pagination is already supported — src/common/dtos/paginated.dto.ts:39-50 has the offset page helper alongside the cursor one, so the queue's offset shape needs no new plumbing.

</details>

<details>
<summary><b>payment-methods</b> — 18 gaps</summary>

**Rebuild from these dashboard files:**

- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:565-630 — the authoritative endpoint list, the declared-balance semantics, the PaymentRail/VerificationMode enums, and the full argument for the nullable wallet-balance shape
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/TASKS.md:1780-2080 — CC-020, the complete declared-balance rebuild spec (migration, CHECKs, DTO, guard, audit action names, view fields, acceptance criteria TC-20.1..20.8)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/TASKS.md:1080-1135 — CC-019, server-side crypto address validation on POST /destinations
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/TASKS.md:1180-1265 — CC-021, role gating on AdminPaymentMethodController (updateDestination guard, the doubled @AdminAuth on the balance route, TC-21.1..21.5)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/TASKS.md:1600-1760 — CC-018, default rails, the two USDT methods, SEED-PLACEHOLDER provisioning and paymentMethodsNeedAccounts
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/USDT-RAILS-STATE.md:95-135 — the backend files that existed: destination-balance.service.ts (30s cache, failures uncached), tron-verifier.service.ts, bsc-verifier.service.ts (balanceOf 0x70a08231), core/payments/wallet-address.ts
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/endpoints.ts:374-453 — paymentMethodsApi and walletBalancesApi, every path and verb verbatim
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/queries.ts:773-880 — the hooks, invalidation strategy, and the 2-minute staleTime / no-poll / retry:false policy on the wallet balance
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/handlers.ts:1651-1830 — CONCRETE request/response JSON and every error code and message string for all twelve routes
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/db.ts:970-1046 — createMethod / deleteMethod / createDestination: exact field defaults the backend must match (requiresProof defaults true, deletable true on a new rail, cascade of destinations on permanent delete)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/fixtures.ts:497-720 — six PaymentMethod and six PaymentDestination rows incl. the two USDT rails exactly as provisioning should write them
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/wallet-balance.ts — mockWalletBalance(address, checkedAt): the whole balance-read decision tree, the two problem codes and their exact detail sentences

**Findings**

THREE ROUTES ARE ENTIRELY MISSING (DELETE .../permanent, PATCH .../declared-balance, GET .../balance) and THREE MORE ARE PARTIAL — they answer, but with a body the console cannot use. Do not read "9 of 12 implemented" as "mostly fine": the financial page (src/features/payment-methods/financial-page.tsx) is non-functional end to end, because both of the things it exists to show — the live chain balance and the declared balance — are absent.

HOW THE PARTIAL FAILURES ACTUALLY MANIFEST (worth knowing before you debug). The API client does NOT throw on schema drift: parseResponse (src/lib/api/client.ts:212-221) uses safeParse, console.warns, and returns the RAW value. So a missing field is not a red screen, it is a silent undefined:
  - method.requiresProof === undefined -> MethodFormDialog.toFormValues (method-form-dialog.tsx:146) seeds a z.boolean() field with undefined -> the rail EDIT form fails validation on submit with no obvious cause.
  - destination.declaredBalance === undefined -> AccountBalance computes `recorded = declaredBalance !== null && declaredBalanceCurrency !== null`, and undefined !== null is TRUE -> the card takes the populated branch and renders a blank amount plus formatters.relative(undefined). The "add balance" empty state is unreachable.
  - method.deletable degrades SAFELY (z.boolean().catch(false)) — the trash button is permanently greyed with the has-history tooltip. That was designed for exactly this case.

THE BACKEND IS FURTHER BEHIND THAN THE DOCS ASSUME. TASKS.md and USDT-RAILS-STATE.md were written against a backend that had src/core/payments/ (default-payment-methods.ts, wallet-address.ts), destination-balance.service.ts, tron-verifier.service.ts, bsc-verifier.service.ts, payment-destination.service.spec.ts, an ExchangeRate model and a Tenant model, and whose schema.prisma ran past line 1433. The schema on disk is 970 lines with 20 models and none of that exists. Two consequences: (1) CC-019 describes a BUG (a code-keyed address lookup that silently skips validation) — on disk there is no address validation of any kind to fix, you are writing it from scratch; (2) CC-021 describes a doubled @AdminAuth on a `destinationBalance` handler that does not exist, but its OTHER half is real and unfixed: admin-payment-method.controller.ts:120 `updateDestination` DOES carry @AdminAuth(...PAYMENT_METHOD_MANAGER_ROLES) on disk, so that half is already correct — verify before "fixing" it.

REBUILD ORDER (each step unblocks the next):
  1. Prisma migration: payment_methods.requires_proof; payment_destinations.declared_balance_{minor,currency,updated_at,set_by_admin_id} + FK + the two CHECKs. Timestamp after 20260826140000_chain_settlements.
  2. Widen AdminPaymentMethodView/toAdminView (requiresProof, deletable, deleteBlockedBy) and AdminPaymentDestinationView/toAdminDestinationView (the five declared fields). This alone repairs the two silent-undefined bugs above.
  3. src/core/payments/wallet-address.ts — detectWalletNetwork(address), TRC20 ^T[1-9A-HJ-NP-Za-km-z]{33}$ and BEP20 ^0x[A-Fa-f0-9]{40}$. Wire it into PaymentDestinationService.create gated on method.rail === 'CRYPTO'.
  4. PATCH .../declared-balance (CC-020 is a complete, ready-to-execute spec).
  5. DELETE .../permanent + the deletable/deleteBlockedBy computation.
  6. destination-balance.service.ts + the two chain verifiers + GET .../balance. Largest piece, and the only one with a third-party dependency.

THE ONE RULE THAT MUST NOT BE LOST IN THE REBUILD, repeated in four separate places in the dashboard: a balance that could not be READ must never be rendered or returned as 0. Zero is a real answer (an empty wallet) and an outage shown as "0.00 USDT" is the most alarming false statement this console can make to somebody whose money is in that wallet. Hence 200-with-null + a problem code, never a 5xx and never a default. The same reasoning is why `scale: 6` is sent rather than assumed, and why `network` is detected from the ADDRESS and is null (not invented) for a SEED-PLACEHOLDER identifier.

A SECOND RULE, structural: a method code is a name somebody types, so it can never be a lookup key. The operator's live USDT rail is coded plain `USDT`, not `USDT_TRC20`. Both the balance read and the create-time address check must branch on `method.rail === 'CRYPTO'` and then read the chain off the address string. Do not reintroduce a WALLET_NETWORK_BY_METHOD_CODE table — that is the exact bug this rail was rebuilt to undo, and it is why a TRC20 and a BEP20 account can legitimately sit under one method.

ROLE/TENANT CROSS-CUTTING: AdminRole has no PLATFORM_ADMIN and there is no Tenant model, so PaymentMethod.code being globally @unique will break the moment two operators both want a rail coded USDT. Both belong to the admin/tenants domains but they gate this one: PLATFORM_ADMIN must satisfy PAYMENT_METHOD_READER_ROLES (read, per the deliberate "platform admin does not redirect a tenant's money" boundary in payment-method.constants.ts) — though the console now grants it write too, which is a decision the owner already made and the backend has not caught up with.

TEST COVERAGE THE MODULE LACKS TODAY: no admin-payment-method.controller.spec.ts, no payment-destination.service.spec.ts. Only destination-picker.service.spec.ts and rails/rails.spec.ts exist. CC-021's TC-21.5 (reflect every handler and assert exactly one AUTH_REQUIREMENT_KEY metadata value) is worth writing first — it is the mechanism that stops a stray or missing guard shipping again.

**Verification**

All 9 claimed gaps CONFIRMED — I could not find an implementation for any of them. I verified route composition rather than trusting names: there is no global prefix (src/main.ts:262 explicitly says setGlobalPrefix('v1') is NOT called because each controller declares its own 'v1/...' path), and I enumerated all 15 @Controller declarations in the repo. AdminPaymentMethodController is @Controller('v1/admin') at :49 and declares exactly 8 routes (payment-methods list/get/create/update/delete at :58-:91, payment-methods/:id/destinations list/create at :100-:113, payment-destinations/:id patch/delete at :120-:137). No /permanent, no /declared-balance, no /balance. src/modules contains only admin, deposit, payment-method, player, reconciliation, wallet — no tenant, no exchange-rate, no shamcash module; src/core/payments/ does not exist.

Two corrections to the first agent's EVIDENCE (the conclusions still stand, so I did not move them to refuted):
1. Gap 7's evidence says grep for SEED-PLACEHOLDER returns zero hits. That is only true of src/. The backend DOES have it: prisma/seed/payment-method.seed.ts:28 defines PLACEHOLDER_PREFIX = 'SEED-PLACEHOLDER', and seedPaymentMethods() (same file) already implements the whole provisioning shape — idempotent upsert of two default rails each with one ACTIVE placeholder destination, computing destinationIsPlaceholder, which is precisely the paymentMethodsNeedAccounts signal. The rebuild is a lift-and-parameterise of an existing file, not a from-scratch build. That matters: it means the console's SEED_PLACEHOLDER_PREFIX string is already honoured by the backend's seeded data today.
2. Gap 6 is slightly understated. The absence of address validation is not only a missing check — dtos/payment-destination.dto.ts carries a deliberate file-header decision NOT to normalise accountIdentifier (uppercasing a Base58 address yields a valid-looking different address). So the validator must be written to verify WITHOUT normalising, and it cannot live in the DTO at all, because the rule depends on the parent method's rail, which the DTO cannot see. It belongs in PaymentDestinationService.create() after assertMethodExists().

Also worth flagging for the rebuild order: gap 9 (tenancy) is upstream of gaps 1, 4, 5 and 7 — adding requiresProof and the declared_balance_* columns before the tenantId migration means two migrations touching the same two tables, and PaymentMethod.code must move from @unique to @@unique([tenantId, code]) in the same change. Do the Tenant migration first.

An additional whole subsystem the first agent missed: Sham Cash credentials (5 endpoints under /v1/admin/shamcash/*) and the two exchange-rate endpoints, both of which live on the same financial page as this domain. The Sham Cash one needs a per-operator sealed-secret store the backend has no precedent for today — the only secrets it handles come from env (src/core/config/env.schema.ts), never from the database.

</details>

<details>
<summary><b>platform-finance</b> — 12 gaps</summary>

**Rebuild from these dashboard files:**

- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/platform-finance.ts (the whole file — every cell union, with the reasoning for each arm)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/agent-float.ts
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/shamcash.ts (shamCashReadResultSchema — the ShamCashCell loaded arms, verbatim)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/payment-method.ts:129-216 (exchangeRateSchema, SetExchangeRateBody, USDT_SCALE, chainNetworkSchema, walletBalanceSchema) and :63-84 (declaredBalance fields, SetDeclaredBalanceBody)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/deposit.ts:140-215 (chainCheckOutcomeSchema, chainArrivalSchema, depositChainCheckSchema)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/endpoints.ts:221-223, 430-435, 450-453, 496-503, 537-557, 706-734
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/queries.ts:181, 203-345 (the catch-up window and refreshAgentFloat), 420, 837, 869-925, 1270-1345, 1559-1583
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/handlers.ts:714-750 (exchange rates), 788-820 (finance), 1041-1064 (chain-check), 1755-1829 (declared balance + wallet balance), 1952-1958 (agent float)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/db.ts:1240-1319 (usdtRateView, setUsdtRate + the 2000bps/24h constants), 1546-1646 (agentFloatView, syncAgentFloat, correctFloat, financeBalancesView, refreshTenantFinance)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/fixtures.ts:1823-1946 (mockTenantFinance — the concrete three-operator seed, USDT_MINOR_SCALE=6, usdtWalletOk/usdtWalletUnavailable, mockLoadedUsdt, mockShamCashOk)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/wallet-balance.ts (address→network detection, UNREADABLE_WALLET_ADDRESS, why the mock must be able to fail)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/deposit-chain-check.ts (MOCK_TX_HASHES — one sentinel hash per outcome, SHORTFALL_MINOR, PENDING/REQUIRED_CONFIRMATIONS)

**Findings**

THE HEADLINE: of the 9 endpoints this domain needs, the backend implements ZERO. What it does have is the reconciliation half next door — POST agent-float/sync, POST breaks/:id/correct-float, GET rail-ageing, POST invariants/run — plus the entire ledger core the missing reads should be built on. Everything the dashboard added between 2026-08-20 and 2026-09-09 for this domain (core/chain, exchange rates, destination balances, declared balances, the finance overview) is gone from the backend without a trace: no source, no migrations, no tests.

ORDER OF REBUILD, cheapest-first:
1. GET /v1/admin/reconciliation/agent-float — a ~30-line service and one @Get on an existing controller. Every dependency is already there (AccountRegistryService.findByCode + .computeBalanceFromEntries, ichancyAgentFloatCode, config.limits.agentFloatLowWatermarkMinor). This unblanks a pill that is currently invisible on every screen in the console. It must NOT go through AgentFloatSyncService: that calls Ichancy and opens a reconciliation break on disagreement, and a pill polled from every screen would file a break per page load and bury the real ones.
2. ExchangeRate model + GET/POST /v1/admin/exchange-rates/usdt.
3. core/chain + GET /v1/admin/payment-destinations/:id/balance.
4. declared-balance columns + PATCH.
5. Tenant model + PLATFORM_ADMIN role (a different domain's work), then /v1/admin/finance/*, which is pure composition over 1 and 3 once those exist.

A CONTRADICTION THE REBUILDER MUST RESOLVE, not paper over. What does GET agent-float read?
 - docs/API-CONTRACT.md:684 and endpoints.ts:551-553 both say the LEDGER float ("the same number the reviewer decides deposits against").
 - The MSW mock says the opposite, at length: src/mocks/db.ts:1548-1556 returns db.agentFloatIchancyMinor and argues that "an approval is drawn against what the agent wallet actually holds", deliberately differing from the ledger figure so the reconciliation screen has drift to find.
 - docs/USDT-RAILS-STATE.md says agent-float-read.service.ts read it "deliberately not routed through the float sync".
The cheap-by-contract requirement (a pill polling every 120s, bursting to 3s) settles it: it must be the LEDGER read. Pick that, and make the mock agree.

TWO PATH FACTS THAT ALREADY COST A PRODUCTION OUTAGE, worth not repeating:
 - The float read is at /v1/admin/reconciliation/agent-float, NOT /v1/admin/agent-float. docs/USDT-RAILS-STATE.md still names the old path; API-CONTRACT.md:675-677 records that the old one 404s and that the pill rendered nothing in a real deployment because of it. Build the reconciliation path.
 - The rate route is POST, not PUT. @Put('usdt') was the only PUT in 75 routes and main.ts's CORS allowlist is GET/POST/PATCH/DELETE/OPTIONS, so rate editing failed with a CORS error. The regression guard written for it (src/core/http/cors-methods.ts + a spec walking every route decorator) is also missing — rebuild it, it is cheap and it fails the build rather than a user's afternoon.

THE ONE RULE THIS WHOLE DOMAIN EXISTS FOR, and the reason every response here is a discriminated union rather than a nullable number: A READ THAT FAILED MUST NEVER SERIALIZE AS 0. Zero is a real answer — an empty wallet — and an outage rendered as a zero balance tells somebody with money in that account that it is gone. The server side of that rule is structural, not careful: ChainBalance must be a UNION so `balance ?? 0n` cannot be written; the finance cells must carry `status` with the ok arm the only one holding a figure; a chain read that did not land answers 200 with balanceMinor:null plus problem/detail, never a 5xx and never a 0. The dashboard has 12 tests pinning this (platform-finance-page.test.tsx) and will render a parse failure rather than a number if the backend flattens the union.

FIVE BUGS docs/USDT-RAILS-STATE.md records as found and fixed — all of them in code that no longer exists, so all of them will come back unless deliberately re-fixed:
 1. BSC USDT has 18 decimals, not 6. A shared USDT_SCALE=6 credits BEP20 deposits 10^12× their value. Needs USDT_DECIMALS per network + toCanonicalUsdtMinor().
 2. TronGrid /transactions/trc20 returns EVENTS, not payments — an `Approval` has the same shape and moves nothing, and anyone can emit one for ten million USDT naming the operator's wallet for a few cents. Check type === 'Transfer'.
 3. networkFor() keyed on the seeded codes USDT_TRC20/USDT_BEP20 while the operator's real rail is coded plain `USDT`, so the chain check answered "skipped" for every real deposit, silently, for months. Read the chain off the ADDRESS. An address cannot lie about its chain the way a name can. Note: 1 and 2 both PASSED ALL THEIR TESTS — the fixtures encoded the same wrong assumption as the code.
 4. Same transfer creditable more than once (case variants, and cross-tenant because the index keyed on payment_method_id). Closed only by the chain_settlements table.
 5. Unconfirmed blocks — the Tron query needs only_confirmed=true.

STILL-OPEN adversarial findings, carried forward: TronVerifierService returned `confirmations: required` unconditionally, so `pending` was unreachable on TRC20 — either measure real depth or have auto-credit refuse when depth was not genuinely measured. Auto-credit has no runtime kill switch (env-only). Its ceilings are deployment-global in a per-tenant, multi-currency system. And CC-019: payout addresses are unvalidated on the rails operators actually create, with accountIdentifier immutable by design, so a bad paste is permanent — the console's own check is currently the only one there is, contrary to its own comment.

SMALLER THINGS A REBUILDER WILL TRIP ON:
 - GET /finance/balances answers a WRAPPER `{ tenants: [...] }`; POST .../refresh answers the BARE row. That asymmetry is intentional and the client depends on it (endpoints.ts:725-733).
 - GET /exchange-rates/usdt answers 200 with a JSON `null` when no rate is set — not 404. The client parses with exchangeRateSchema.nullable().
 - The USDT column starts `not_loaded` and the platform never fans out server-side. FINANCE_REFRESH_CONCURRENCY = 2 on the client; do not add a server-side "refresh all", it moves the burst behind the backend where nothing can pace it.
 - The float pill's 202-ACCEPTED problem is a client-side workaround, not a backend gap: approving posts only T1, the float moves on T2 seconds later via the outbox relay and a BullMQ worker, so the console polls at 3s for 30s after any money mutation. If a websocket or SSE ever lands, refreshAgentFloat (queries.ts:303-308) is where it replaces the burst.
 - ShamCashCell's arms are ok | not_linked | unauthorized | unavailable. docs/API-CONTRACT.md:1146 is STALE — it still says `expired`, from the browser-session era. src/types/shamcash.ts is the current truth: Sham Cash uses API keys now, and a key does not lapse.
 - `arrived` on chain-check carries `asset`, not `currency`, specifically so it is not assignable to MoneyView and formatMoney(arrived) does not compile. Keep that field name.

**Verification**

Verdict: ALL EIGHT claimed gaps CONFIRMED, none refuted. I re-derived the route table independently rather than trusting the prior audit: `grep -rn "@Get(|@Post(|@Patch(|@Delete(|@Put(" src/ --include=*.controller.ts` yields 57 route decorators across 15 controller files, and I checked every @Controller prefix for composed paths (the trap the task warned about: @Controller('v1/admin') at admin-payment-method.controller.ts:49 and admin-approval-limit.controller.ts:25 DO compose into /v1/admin/payment-destinations/:id and /v1/admin/approval-limits/:id — but no composition anywhere produces /v1/admin/finance/*, /v1/admin/exchange-rates/*, GET /v1/admin/reconciliation/agent-float, /v1/admin/payment-destinations/:id/balance, .../declared-balance, or /v1/admin/deposits/:id/chain-check). src/main.ts:262 carries an explicit NOTE that there is deliberately NO setGlobalPrefix — versioning is per-controller — so no hidden prefix is masking a path. I searched synonyms and casings for every concept (finance/Finance, tenant/tenantId/tenant_id, exchangeRate/exchange-rate/rateMinor/quoteAsset, chain/chainCheck/chain-check/TRC20/BEP20/TronGrid/ChainNetwork/ChainSettlement, declared/declaredBalance, shamcash/sham_cash/'sham cash', balance/wallet-address, PLATFORM_ADMIN) across src/ AND prisma/; the only 'finance' hits in the backend are the FINANCE_ADMIN role constant. The nearest thing to gap 3 is @Post('agent-float/sync') (reconciliation.controller.ts:149) — not a substitute (wrong verb, calls Ichancy, can open a ReconciliationBreak) — but its private helper ledgerFloat() at agent-float-sync.service.ts:271 is exactly the read to extract, making gap 3 the cheapest of the eight to rebuild. Suggested rebuild order: (1) Tenant model + PLATFORM_ADMIN role + tenant-scope extension, since gaps 1, 2, 4, 5 are all keyed on a tenant that does not exist; (2) GET agent-float (trivial extraction); (3) core/chain + ChainSettlement, which unlocks gaps 2, 6 and 8 together; (4) ExchangeRate; (5) declared-balance columns; (6) shamcash module. One correction to the prior audit's bookkeeping: schema.prisma has 21 models, not 18 (its own enumeration listed 21) — the conclusion that none is a Tenant/ExchangeRate/ChainSettlement is correct.

</details>

<details>
<summary><b>shamcash</b> — 16 gaps</summary>

**Rebuild from these dashboard files:**

- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:841-1035 — THE authoritative spec. Three sections: 'Sham Cash — /v1/admin/shamcash' (841-894, the live API-key path plus the 2026-09-03 removal note), 'Sham Cash developer bench — /v1/admin/shamcash/dev (flagged OFF)' (896-996, including the QR sub-section at 944-996), 'The linked account — read on demand, from a warm browser' (997-1035).
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/shamcash.ts (106 lines, complete) — shamCashStatusSchema, shamCashBalanceSchema, shamCashReadResultSchema, SetShamCashApiBody, shamCashApiTransactionSchema, shamCashTestResultSchema. Read in full; the doc comments carry the design reasoning.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/shamcash-dev.ts (200 lines, complete) — shamCashTransactionSchema, shamCashHomeSchema, shamCashDevResultSchema, ShamCashBrowserCheckBody, ShamCashParseBody, StartShamCashPairingBody, shamCashPairingStartedSchema, shamCashPairingPollSchema, accountSnapshotSchema, accountStatusSchema.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/handlers.ts:619-712 (live API-key path: status/api/test/balance, with role gates) and :820-948 (dev bench: browser-check/parse/qr trio/account trio). Concrete request AND response JSON — the single most useful rebuild artifact.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/shamcash-dev.ts (173 lines, complete) — contains a working reference implementation of the page parser (parseBalances at :45-60, parseTransactions at :63-91) plus MOCK_SHAM_PAGE at :21-33, which is described as 'matching the backend's own reader fixture'. This is the closest thing to the lost backend parser that survives.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/endpoints.ts:463-493 (shamCashApi), :594-629 (shamCashDevApi), :631-653 (shamCashAccountApi).
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/queries.ts:918-935 (status/balance hooks), :1350-1420 (browser-check, parse, PAIRING_POLL_MS=2000, pairing start/poll), :1421-1482 (account status/refresh/unlink, cancel pairing), :1810-1845 (setApi/clearApi/test).
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/features/shamcash-dev/ — account-panel.tsx, qr-link-panel.tsx, parser-bench.tsx, parsed-tables.tsx, shamcash-account-page.tsx, messages.ts (17.7KB of en/ar copy describing every state the backend can return), shamcash-account-page.test.tsx.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/features/payment-methods/shamcash-api-card.tsx — the LIVE card, wired into financial-page.tsx:11,80. Calls useShamCashStatus/useSetShamCashApi/useClearShamCashApi/useTestShamCashApi (lines 47-50).
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/db.ts:184,288 (shamCashSession state shape) and :720-724 (SHAM_CASH payout-wallet check — how the withdrawal path consumes the link status).
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:1124-1162 — the platform-finance ShamCashCell, which reuses ShamCashReadResult verbatim. Cross-domain consumer.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/app/router.tsx:26,276-300 — the /dev/shamcash route registration and its VITE_ENABLE_SHAMCASH_DEV gate.

**Findings**

VERDICT: the backend has ZERO shamcash code. Not a partial implementation — nothing. `grep -rni "shamcash|sham_cash|sham-cash"` over Telegram-mini-app/src and Telegram-mini-app/prisma returns no hits at all. All 13 endpoints the dashboard calls are gaps. There is no provider, no adapter, no DTO, no service, no controller, no column, no migration.

CONFIRMATION THE WHOLE FEATURE POST-DATES THE LAST PUSHED BACKEND COMMIT: Telegram-mini-app/prisma/migrations contains exactly two directories — 20260813101853_init and 20260820120000_player_link_backfill. The API contract itself names a migration `20260903140000_drop_shamcash_session` (docs/API-CONTRACT.md:916). So the shamcash feature was built, then substantially REWRITTEN (browser session -> HTTP API key on 2026-09-03, then the reader restored as a dev bench on 2026-09-07, then QR pairing added on 2026-09-08), entirely inside the lost 20-day window. The dashboard commit dfb41f7 "shamcash-fix" is the tail of that work.

TWO SEPARATE MECHANISMS, DO NOT CONFLATE THEM. This is the single most important thing for a rebuilder:
  1. THE LIVE PATH — /v1/admin/shamcash/{status,balance,test,api}. An API key + wallet id stored on the tenant, called over plain HTTPS against api-shamcash.com with an x-api-key header. No browser. This is what production uses and what the Financial page renders. Roles: SUPER_ADMIN, FINANCE_ADMIN, PLATFORM_ADMIN.
  2. THE DEV BENCH — /v1/admin/shamcash/dev/* and /v1/admin/shamcash/account/*. A headless Chromium replaying a shamcash.sy session, gated behind SHAM_CASH_DEV_CHECK, answering 404 (deliberately not 403) when unset. Roles: SUPER_ADMIN, PLATFORM_ADMIN only. It exists to answer the two questions the HTTP API cannot: "are these credentials still valid" and "does our parser still recognise the page". Note the /account/* routes are gated by the same flag even though they are not under /dev.

REBUILD ORDER (cheapest-first, and it maps to real value):
  1. POST /dev/parse — a pure function, no browser, no network, no DB. A reference implementation already exists in manager-account-dashboard/src/mocks/shamcash-dev.ts:45-100. Do this first; it is an afternoon.
  2. Tenant model + shamcash_wallet_id/shamcash_api_key_enc + the both-or-neither CHECK. Everything on the live path blocks on this.
  3. GET /status, POST /api, DELETE /api — the ShamCashApiCard's four buttons.
  4. POST /balance, POST /test — the vendor HTTP client.
  5. The browser-held routes last: qr trio, account trio, browser-check.

ASSETS THAT SURVIVED IN THE BACKEND AND SHOULD BE REUSED:
  - Telegram-mini-app/src/modules/player/utils/secret-box.util.ts — AES-256-GCM with hkdfSync-derived keys, a v1 format prefix, random 96-bit nonce and timingSafeEqual. Exactly the sealing the contract specifies for shamcash_api_key_enc. Do not write a second one.
  - playwright ^1.62.1 and patchright ^1.62.1 are already in Telegram-mini-app/package.json:106-109 (optionalDependencies) with a `playwright:install` script at line 24, and Telegram-mini-app/src/core/ichancy/transport/browser.transport.ts is 684 lines of working browser-driving code with session handling. The QR/account services should be modelled on it.
  - Telegram-mini-app/src/core/ichancy/ichancy-http.client.ts is the pattern for the api-shamcash.com client.

DESIGN INVARIANTS THAT MUST BE PRESERVED — these are stated repeatedly in the contract and the types, and getting one wrong is worse than the endpoint being absent:
  - A FAILED READ IS NEVER A WALLET OF ZEROS. Every read result is a discriminated union on `status`; only the `ok` arm carries figures. `not_linked`, `unauthorized`, `unavailable` and `not_loaded` carry none. Zero is a real answer (an empty wallet); an outage shown as zero tells an operator their money is gone.
  - THE KEY IS NEVER RETURNED, by any endpoint. The wallet id IS returned in full — it is a URL path segment, not a credential.
  - `expired` from browser-check is a 200, not a 4xx. It is the answer to the question asked.
  - `refresh` answers 503, not 404, when nothing is linked. The route exists; the thing behind it does not.
  - The QR session is handed over EXACTLY ONCE. A `linked` poll closes the pairing; polling that id again answers `expired`.
  - `pinRequired: true` does NOT mean the link failed. ShamCash shows Create-PIN after the cookies are written, so the session is linked either way.
  - A refresh that recognised nothing must NOT overwrite a good snapshot. An empty FIRST read is still reported.
  - POST /api must also SYNC the rail — write walletId onto the active destinations of the SHAM_CASH method. Without it an operator reads wallet A while collecting into wallet B, and every deposit lands somewhere verification never sees.
  - `parse` takes innerText, never HTML. Feeding it markup exercises a path that does not exist.

DEAD CODE WARNING: manager-account-dashboard/src/features/payment-methods/shamcash-card.tsx (and its .test.tsx) is the OLD cookie-session card. It imports useSetShamCashSession/useClearShamCashSession, which no longer exist anywhere in src/lib/api — `grep -rn "useSetShamCashSession" src/lib/api/` returns nothing. It is imported by nothing but its own test. Do NOT rebuild POST/DELETE /v1/admin/shamcash/session from it; those routes were deliberately deleted on 2026-09-03 along with the cookies they held. Only ShamCashApiCard is wired in (financial-page.tsx:11,80).

CROSS-DOMAIN COUPLING a rebuilder must know about:
  - platform-finance (GET /v1/admin/finance/balances, POST /v1/admin/finance/tenants/:id/refresh) embeds `shamCash: ShamCashCell = { status:'not_loaded' } | ShamCashReadResult`. The refresh route calls the same balance reader. See docs/API-CONTRACT.md:1124-1162 and manager-account-dashboard/src/types/platform-finance.ts:84-99.
  - The withdrawal payout-wallet check branches on `method.code === 'SHAM_CASH'` and reports `not_configured` when the account is unlinked (manager-account-dashboard/src/mocks/db.ts:720-724).
  - NotificationCategory.SHAM_CASH_DEPOSIT / SHAM_CASH_WITHDRAWAL are subscribable but have no producer by design (docs/API-CONTRACT.md:1231) — Sham Cash is a read-only balance surface with no transaction feed. Do not build a producer for them.

TIMING FACTS WORTH CARRYING INTO THE REBUILD (measured, from the contract): a cold shamcash.sy page load is 55-90s, first visible text at 54.7s. That cost is paid once per browser, which is why the QR link hands its browser to the account service instead of closing it, and why GET /account touches no browser at all. Each held browser is 300-500MB, carries a 20-minute idle timer, and must be closed in onModuleDestroy so `--watch` does not leak a Chromium per reload. Pairings carry a 3-minute force-close timer and only one may be live at a time — a second POST /qr closes the first.

**Verification**

Searched exhaustively and refuted nothing — all 13 claimed endpoints are genuinely absent. Method: (1) case-insensitive grep for shamcash / sham_cash / sham-cash / shamCash across src, prisma and test — zero hits (empty output, exit 0); (2) enumerated all 15 @Controller decorators and confirmed none carries a shamcash segment, then checked composed paths by reading the only other @Controller('v1/admin'), admin-payment-method.controller.ts:49-130, which exposes strictly payment-methods CRUD (59-90), method destinations (101-110) and payment-destinations (120-130) — no shamcash sub-resource hiding under a composed prefix; (3) confirmed there is NO global prefix or versioning — main.ts:262 carries an explicit comment that setGlobalPrefix('v1') is deliberately not called because each controller spells out its own v1 path, so the previous agent's path reconstruction was correct; (4) intent-based greps for handlers by behaviour rather than name: playwright/puppeteer/chromium/screenshot/qrCode/qrImage/pairing/proxy, walletId/wallet_id/x-api-key/apiKeyEnc, parseShamCashHome, NOT_LINKED/503 — all negative for this domain; (5) read the full model and enum list out of schema.prisma before agreeing Tenant and NotificationCategory are missing. Total route decorators in the backend: 56, none shamcash. Cross-checked the dashboard side: the 13 endpoints match exactly the shamcash surface in manager-account-dashboard/src/lib/api/endpoints.ts:467-652 and docs/API-CONTRACT.md:841-1002 — the first agent missed no endpoint. Two corrections worth carrying into the rebuild: it claimed 'no destinationIsPlaceholder computation anywhere in the backend' (it exists at prisma/seed/payment-method.seed.ts:86,166 — just seed-local, not exposed), and it did not notice that the two hardest-looking pieces already have working in-repo templates: playwright is already a dependency (package.json:108) with a real Chromium transport at src/core/ichancy/transport/browser.transport.ts, and AES-256-GCM-under-HKDF sealing is fully implemented at src/modules/player/utils/secret-box.util.ts. Suggested rebuild order: Tenant model + AdminRole.PLATFORM_ADMIN + env vars, then the pure parser (parse-shamcash-home.ts, zero dependencies), then status/api/balance/test on the new HTTP client, then the in-memory account service, then the QR bench last.

</details>

<details>
<summary><b>reconciliation</b> — 8 gaps</summary>

**Rebuild from these dashboard files:**

- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:673-728 (agent float + reconciliation section — authoritative paths, BreakView, enums, rail-ageing row, invariant violation)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:165-166 (reconciliation.read / reconciliation.act role matrix)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/endpoints.ts:538-591 (agentFloatApi + reconciliationApi — every path and body)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/reconciliation.ts (reconciliationBreakSchema, floatSyncResultSchema, floatCorrectionSchema, railAgeingReportSchema, invariantReportSchema, BreakListQuery, ResolveBreakBody)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/agent-float.ts (agentFloatSchema — the missing endpoint's exact response contract)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/handlers.ts:1927-2001 (MSW handlers: filtering semantics, default status set, error codes, status transitions)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/db.ts:1548-1618 (agentFloatView, syncAgentFloat, correctFloat — concrete response JSON)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/fixtures.ts:1483-1594 (mockBreaks) and :1596-1680 (mockRailAgeing bucket shape)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/enums.ts:442-500 (BREAK_CATEGORIES, BREAK_STATUSES, TERMINAL_BREAK_STATUSES)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/queries.ts:1019-1113 (useBreaks/useBreak/useRailAgeing/useAssignBreak/useResolveBreak/useCorrectFloat/useSyncFloat/useRunInvariants) and :1555-1578 (useAgentFloat)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/components/layout/agent-float-pill.tsx (the consumer of the missing endpoint, incl. its strict integer-string requirement)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/app/search-schemas.ts:194-201 (reconciliationSearchSchema: tab, status CSV, category CSV, minSeverity 1..5, selected)

**Findings**

HEADLINE: reconciliation is by far the healthiest domain of the three repos. 8 of the 9 endpoints the dashboard calls are already implemented, correctly, at exactly the paths and shapes the contract states. There is exactly ONE missing route — GET /v1/admin/reconciliation/agent-float — plus one cross-cutting tenancy gap and three small contract mismatches. Do not rewrite this module; add one handler and fix three details.

WHY THE ONE GAP IS A BLOCKER DESPITE BEING ONE ROUTE: the AgentFloatPill is mounted in the top bar (topbar.tsx:138), so it renders above EVERY route in the console. Today it 404s on every screen for every admin who has reconciliation.read, in every open tab, every 2 minutes. It fails silently by design (retry:false, renders null on isPending||isError — agent-float-pill.tsx:53-60), so nobody sees an error; they just never see the operator's own balance. That balance is the pool every player credit is paid out of, and the only other way to learn it is empty is a deposit failing with AGENT_FLOAT_INSUFFICIENT on a player who has already sent money.

WHICH NUMBER THE ENDPOINT MUST RETURN — there is a live contradiction in the sources, and the contract wins. API-CONTRACT.md:684 and endpoints.ts:551-553 both say this is the LEDGER float (the ICHANCY_AGENT_FLOAT:<currency> account balance), read cheaply, "not an Ichancy round trip", which is the whole reason a top bar is allowed to poll it. The MSW fixture comment (db.ts:1549-1555) says the opposite — it deliberately returns the ICHANCY side so the mock shows drift. Build the LEDGER read; the mock's choice is a fixture-authoring decision about making drift visible in dev, not the wire contract. USDT-RAILS-STATE.md:115-118 independently confirms the ledger reading and spells out why it must not go through the sync path (a pill on every screen routed through the sync would file a reconciliation break per page load and bury the real ones).

PATH HISTORY — do not "fix" this back: the pill originally called /v1/admin/agent-float, which 404s. The dashboard's latest commit moved it to /v1/admin/reconciliation/agent-float (endpoints.ts:551-553, API-CONTRACT.md:675-677). USDT-RAILS-STATE.md still names the old path because it predates that move. Implement the reconciliation-prefixed path. There is also an endpoints.contract.test.ts in the dashboard that greps every path out of endpoints.ts and asserts it appears in API-CONTRACT.md (TASKS.md:430), so the paths in that doc are mechanically kept honest and are the best single source.

WHAT IS ALREADY RIGHT AND SHOULD BE LEFT ALONE:
- BreakView (dtos/break.view.ts:41-63) is a field-for-field match with reconciliationBreakSchema, including the {minor, amount} money pair on expected/actual/delta.
- The default status filter (OPEN + INVESTIGATING) is implemented identically on both sides: controller :77-80 and break-display.ts:18 / handlers.ts:1934-1937.
- CSV array params round-trip: client.ts:66-69 joins with commas, ListBreaksQueryDto's toArray transform (break-query.dto.ts:13-20) splits and upper-cases.
- Cursor envelope matches: backend cursorPage returns { limit, nextCursor, hasMore } (common/dtos/paginated.dto.ts:59-72), which is exactly what requestCursorPage/cursorMetaSchema parse (client.ts:254-266) and what getNextPageParam reads (queries.ts:1029).
- BigInt safety is handled globally: main.ts:6 installs BigInt.prototype.toJSON, so the invariant report's raw bigints reach the wire as strings — and invariantViolationSchema accepts string|number for exactly that reason.
- correct-float already refuses non-AGENT_FLOAT_MISMATCH breaks (agent-float-sync.service.ts:216-221) and zero deltas (:223-225), matching the UI which only offers the button when row.category === 'AGENT_FLOAT_MISMATCH' (break-detail-sheet.tsx:123).
- assign already sets status=INVESTIGATING alongside the assignee (reconciliation-break.service.ts:175-190), matching the mock at handlers.ts:1972-1974.

ROLE GATING is already correct for the four roles that exist: VIEW_ROLES = SUPER_ADMIN/FINANCE_ADMIN/REVIEWER/VIEWER, ACT_ROLES = SUPER_ADMIN/FINANCE_ADMIN (reconciliation.controller.ts:43-50), and SUPPORT is correctly excluded. Only PLATFORM_ADMIN is missing, and only because the Prisma enum lacks it. Apply @AdminAuth(...VIEW_ROLES) to the new agent-float GET.

TESTING DEBT the rebuilder inherits: TASKS.md:501-560 (CC-006) says reconciliation has component tests for every part but has NEVER been covered by Playwright — e2e/reconciliation.spec.ts does not exist. If the backend is being rebuilt against this spec, that e2e file is the cheapest way to prove the three tabs, the URL contract (?tab=breaks|ageing|ledger, status/category/minSeverity/selected in the query string) and the write actions actually line up.

**Verification**

I could refute NOTHING — all five claimed gaps and all three data-model claims survive verification. What I did to try: enumerated every @Controller() in the backend (15 classes, listed above) and every route on ReconciliationController by reading the decorators rather than grepping; confirmed main.ts:262 deliberately does NOT call setGlobalPrefix and there is no enableVersioning, so no composed path could have been missed; grepped 'float' across all controllers; grepped agent-float in every casing across src; grepped 'tenant' case-insensitively across src AND prisma (zero hits, which is unusually conclusive).

Two corrections to the previous agent's work, neither of which changes a verdict:
1. Gap 5's evidence is partly wrong. resolve() is NOT broken — reconciliation-break.service.ts:125-131 does findUnique + `throw new NotFoundError(ReconciliationErrorCodes.BREAK_NOT_FOUND, ...)` correctly. The leak is on GET breaks/:id (controller:109 findUniqueOrThrow) and, unreported, on POST breaks/:id/assign (service:177 bare update). I filed assign separately.
2. Gap 3 is one name worse than claimed: the backend union has FOUR members, not three — I1_SINGLE_SIDED (invariants.service.ts:97) has no console counterpart at all, on top of the I1/I2 name mismatch.

Things I checked that are genuinely FINE and should not be re-flagged: BreakView (dtos/break.view.ts:19-64) produces every field of reconciliationBreakSchema (types/reconciliation.ts:12-32) with the same {minor, amount} money pairs; RailAgeingReport/Row/Bucket (services/rail-ageing.service.ts:40-67) match railAgeingReportSchema field-for-field; BreakCategory (schema.prisma:213-224) and BreakStatus (:227-234) match BREAK_CATEGORIES/BREAK_STATUSES (types/enums.ts:442-475) member-for-member; cursorPage/CursorQueryDto (common/dtos) match the console's cursor paging; VIEW_ROLES/ACT_ROLES match the console's reconciliation.read/.act capability table (lib/auth/permissions.ts:95-150) for the four roles that exist; BigInt serialisation is handled globally (common/helpers/bigint-json.ts imported first at main.ts:6) so the invariant report's bigints reach the wire as strings.

</details>

<details>
<summary><b>stats</b> — 6 gaps</summary>

**Rebuild from these dashboard files:**

- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:1071-1124 — the authoritative Statistics section: the two routes, the TenantStats/StatsBlock/StatsMethodRow/PlatformStats shapes, the basis table, the verified-over-claimed money rule, the UTC window rule, and the 'a zero in profit is usually a setting' rule.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/stats.ts — the complete zod schemas (looseObject) for StatsBasis, StatsBlock, StatsMethodRow, StatsPeriod, StatsProfit, TenantStats, PlatformStats, plus STATS_PERIODS. This is the response validator the backend must satisfy exactly.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/stats.ts — a WORKING reference implementation of both endpoints (mockPeriodRange, block(), byMethod(), tenantStatsView(), platformStatsView()). It states at line 31 that it MIRRORS the API's own report-period.util.ts, and reproduces the server's status sets: WAITING=['SUBMITTED','UNDER_REVIEW','PENDING_SECOND_APPROVAL'], ATTENTION=['CREDIT_FAILED','NEEDS_RECONCILIATION'], PENDING_WITHDRAWALS=['REQUESTED','APPROVED','DEBITING','DEBITED']. Port this file to NestJS almost line for line.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/handlers.ts:950-972 — the two MSW route handlers, incl. the 403 INSUFFICIENT_ROLE rule on /stats/tenants and the periodParam() default-to-month rule at :210-213.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/endpoints.ts:655-687 — statsApi.mine / statsApi.everyTenant, with a long header explaining why this is not a deposit-queue call with a bigger limit.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/queries.ts:1483-1533 — useTenantStats / usePlatformStats, STATS_STALE_MS = 30_000, keepPreviousData, enabled/retry:false on the platform hook.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/features/stats/stats-page.tsx, stats-tiles.tsx, method-breakdown.tsx, tenant-stats-table.tsx — exactly which fields are rendered and in what order.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/features/stats/stats-page.test.tsx — asserts the rendered figures against tenantStatsView(), so it doubles as an acceptance test for the computation rules.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/features/overview/overview-data.ts — every query object the /overview page issues, with the sample limits and thresholds.
- C:/Users/dell/Desktop/bot/Telegram-mini-app/src/modules/admin/services/activity-report.service.ts — the backend's OWN existing implementation of ~70% of this math (UTC reportRange at :128-145, creditedByMethod at :281-340, countAndSumDeposits at :342-363, the WAITING_STATUSES/ATTENTION_STATUSES constants at :42-57). The fastest rebuild path is to extract this into a shared read service and give it an HTTP face.

**Findings**

HEADLINE: the backend exposes ZERO stats/aggregation endpoints. Not one. `grep -rn "stats"` over C:/Users/dell/Desktop/bot/Telegram-mini-app/src returns nothing at all, and the 15 registered controllers (health, telegram/webhook, admin×3, deposit×2, payment-method×2, player×3, reconciliation, wallet) contain no aggregation route. Both /v1/admin/stats and /v1/admin/stats/tenants are 100% missing. The /stats page is completely non-functional against the live API.

THE GOOD NEWS — most of the math already exists, just not over HTTP. C:/Users/dell/Desktop/bot/Telegram-mini-app/src/modules/admin/services/activity-report.service.ts is the Telegram `/report` renderer and it already computes: the same UTC day/week/month windows (reportRange, :128-145 — identical to mockPeriodRange in the dashboard's mock, which even says it MIRRORS the API's report-period.util.ts), new players / total players, credited-by-method with the exact verified-over-claimed COALESCE precedence (creditedByMethod, :281-340 — it splits into two groupBy partitions because Prisma cannot COALESCE inside _sum; the biggest-first-then-name sort is already there too), rejected count+sum on decidedAt, and the current-state waiting/attention counts using the same two status lists. What it does NOT do: `all` period, expired block, opened block, lifetimeCount, profit/fees, per-method fees, withdrawals, or any tenant dimension. The correct rebuild is to lift this into a shared read service (or a new modules/stats) and add the missing blocks, NOT to write it from scratch — and note the eslint-plugin-boundaries constraint the file's header calls out: modules/admin -> modules/deposit is a BUILD FAILURE, so a stats module reading DepositRequest needs either its own module placement or a published read port.

THREE TRAPS a rebuilder will otherwise fall into:
1. `basis` is not decoration and the blocks do NOT add up. Six deposit blocks are computed on FOUR different clocks (createdAt / creditedAt / decidedAt / current). opened and credited are not two views of one set. Each block must return its own `basis` string so the UI can print it — stats-tiles.tsx renders that footnote specifically to pre-empt "your totals are wrong" bug reports.
2. Money is COALESCE(verifiedAmountMinor, claimedAmountMinor), NEVER creditedAmountMinor. creditedAmountMinor is verified−fee; using it would make credited.total incomparable with opened.total. Fees are reported separately under `profit`.
3. `waiting`, `attention` and `withdrawals.pending` are deliberately NOT period-bound — they are current state, so money stuck since last week still shows in today's figures.

TENANCY IS THE STRUCTURAL BLOCKER. The backend has no tenant concept whatsoever — zero files mention "tenant", zero `tenantId` columns. But TenantStats requires tenantId, slug, displayName and currency as non-nullable fields, and the whole /stats/tenants endpoint is cross-tenant by definition. Interim path: implement /v1/admin/stats now and answer with a single synthetic tenant row (the dashboard mock does exactly this — TENANT_ZERO_ID = '00000000-0000-0000-0000-000000000000', slug 'tenant-zero', displayName 'Head office', currency from config), which unblocks the entire /stats page; defer /stats/tenants until the Tenant model lands. Also note AdminRole in prisma lacks PLATFORM_ADMIN, so the 403 gate on /stats/tenants has nothing to gate on yet.

WITHDRAWALS ARE A HARD DEPENDENCY OF THIS DOMAIN. TenantStats.withdrawals.{paid,pending} and profit.withdrawalFees have no data source: there is no WithdrawalRequest model and no withdrawal module. Until that exists, the honest answer is zero blocks with the correct `basis` values ('paidAt' / 'current') — which is exactly what the dashboard mock does and what activity-report.service.ts:184 explicitly refuses to fake in the Telegram report. Do NOT omit the keys; the zod schema requires them.

/overview HAS NO ENDPOINTS OF ITS OWN. It is composed entirely from other domains: 5 deposit-queue reads, 2 reconciliation reads, 1 withdrawals read. Three of those four backends exist. The withdrawals tile is dead (no endpoint). Two deposit-queue features the overview depends on need verifying in the deposits domain: `unclaimedOnly=true` and `sort=oldest` — without them the "unclaimed" tile and the whole oldest-waiting panel are silently wrong rather than empty. The counts on /overview are honest samples (limit 20, printed as "20+" when a cursor page has more) precisely because the deposit queue sends no total; the withdrawals tile is the only exact one because that list is offset-paginated with a real `total`.

MISC CONTRACT DETAILS worth not losing: an unknown or absent `period` must fall back to 'month' and must NOT 400 (a stale bookmarked link has to stay a working screen). The window is echoed back from the server and printed verbatim by the header — the browser never recomputes it, because the same boundaries are quoted by the Telegram /report message and a client-side recut would disagree by up to a day. Response schemas are z.looseObject, so extra fields are safe to add but every documented field must be present. period.key is validated as a plain string (not the enum) so an older console can render a period a newer server added. The dashboard caches for 30s (STATS_STALE_MS) and does not poll.

TASKS.md contains no stats section at all (`grep -ni stat docs/TASKS.md` finds only unrelated words) — API-CONTRACT.md §Statistics and src/mocks/stats.ts are the only specifications of this domain.

**Verification**

Adversarial verification result: 0 of 3 claimed gaps refuted. I did not take the first agent's greps on faith — I re-derived every composed route by dumping @Controller + every @Get/@Post/@Patch/@Delete decorator across all 15 controllers and reconstructing full paths, and confirmed via main.ts:262 that there is NO global prefix or versioning that could hide a path (each controller declares its own 'v1/...'). The complete admin surface that exists today is: /v1/admin/auth/bot-code, /v1/admin/admins (CRUD + :id/approval-limits + DELETE approval-limits/:id), /v1/admin/deposits (list, :id, claim, release, approve, reject, retry-credit, proof url/content, maintenance/sweep), /v1/admin/payment-methods + /v1/admin/payment-destinations, /v1/admin/players (list, :id, :id/ichancy-account), /v1/admin/reconciliation (breaks, breaks/:id, resolve, assign, agent-float/sync, correct-float, rail-ageing, invariants/run). Nothing statistical, nothing tenant-scoped, nothing withdrawal-shaped. I searched by intent as well as by name (metric/analytic/aggregat/summar/report/dashboard/overview/kpi/totals; payout/cashout/negative-deposit; tenant/operator/merchant/organization) — the only true positives were ActivityReportService (Telegram-only) and the Ichancy outbound withdraw wire calls, neither of which is an HTTP route. Good news for the rebuild: the hard part of /v1/admin/stats is already written and tested inside src/modules/admin/services/activity-report.service.ts — the UTC window resolver, the byMethod groupBy with the verified-over-claimed COALESCE partitioning, the ungrouped count+sum, and the WAITING/ATTENTION status sets. The genuinely missing pieces are the HTTP shell, the Tenant model, and the tenant request-context plumbing that API-CONTRACT.md section 5 documents as having been completed on 2026-08-25 and which the two surviving migrations (latest: 20260820120000) prove never reached this repo. One correction to the first agent's framing of gap 3: the overview tile reads `meta.total`, so the withdrawals list must use the existing OFFSET helper (offsetPage, src/common/dtos/paginated.dto.ts:39) rather than the cursor helper the deposit queue uses — a cursor page carries no total by design.

</details>

<details>
<summary><b>telegram-bot-config</b> — 23 gaps</summary>

**Rebuild from these dashboard files:**

- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:414-498 — the bot menu, the kind/payload table, the reorder transaction rule, the gate, and the two runtime settings
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:1195-1330 — telegram destinations (the full refusal-reason table), /telegram/chats (why it exists), and /reports/activity/publish
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/bot-menu.ts — every entity shape + all four request bodies (CreateNodeBody, UpdateNodeBody, CreateButtonBody, UpdateButtonBody, ReorderButtonsBody, UpdateGateBody, UpdateBotSettingsBody)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/telegram-destination.ts — TelegramDestination, DiscoveredChat, TelegramDestinationCheck, PublishReportResult, the NOTIFICATION_CATEGORIES / LIVE_CATEGORIES / TELEGRAM_BOT_CHAT_STATUSES vocabularies, and the two create/update bodies
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/endpoints.ts:812-948 — telegramDestinationsApi, telegramChatsApi, reportsApi, botMenuApi with the reasoning comments for each route
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/handlers.ts:2144-2600 — the concrete request/response JSON and every status code and error code, route by route
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/handlers.ts:398-520 — resolveMockChat (the exact URL-resolution decision tree and which reason each input produces) and checkOrTest (the check/test response body)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/db.ts:808-968 — the server-side invariants restated as code: requiredActionLeftWithout, buttonPayload (one column per kind), menuNodeStillLinkedFrom, reorderMenuButtons, botSettingsView/updateBotSettings
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/fixtures.ts:1360-1475 — mockBuiltinActions (the ten-action catalogue with its Arabic descriptions), REQUIRED_BUILTIN_ACTIONS, the default menu tree (PLAYER_MENU_ROWS as planted), and mockBotMenuGate
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/fixtures.ts:1953-2078 — mockTelegramDestinations and mockDiscoveredChats: one row per state the server must be able to produce
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/bot-menu-handlers.test.ts — 20 executable assertions of the bot-menu contract; use it as the backend's acceptance list
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/features/bot-config/flow-panel.tsx — how the tree is consumed and which mutation each control fires

**Findings**

ALL 19 endpoints this domain needs are missing. The backend implements exactly one telegram route — POST /telegram/webhook/:token. There is no partial implementation to extend: `grep -rni "bot-menu|botMenu|bot_menu|menuNode|builtinAction"` and `grep -rni "telegramDestination|notificationCategory|discoveredChat"` over src/ and prisma/ both return ZERO hits.

WHAT SURVIVED AND SHOULD BE REUSED, NOT REWRITTEN:
1. src/modules/admin/services/activity-report.service.ts:162 — ActivityReportService.buildReport(period, now) returns the rendered Telegram HTML, and ReportPeriodKey = 'day'|'week'|'month' already matches the contract. POST /v1/admin/reports/activity/publish is a thin fan-out over it; nothing about the report itself needs rebuilding.
2. src/core/telegram/telegram.constants.ts:48 — 'my_chat_member' is already in TELEGRAM_ALLOWED_UPDATES, and src/core/telegram/services/update-dedupe.service.ts:57-62 already classifies and persists it into telegram_updates. GET /telegram/chats is roughly one worker branch plus one table away; the expensive half is done.
3. src/core/telegram/services/bot.service.ts — sendMessage/sendPhoto/editMessage/webhook plumbing all survive.
4. src/core/telegram/commands/setup-bot.command.ts:25-136 — PLAYER_COMMANDS and ADMIN_EXTRA_COMMANDS still exist and match src/features/bot-config/bot-surface.ts:43-59 one-for-one (15 commands, same order, same Arabic). Use that agreement to date the loss: the command menu is intact, the reply-keyboard menu is gone.

WHAT MUST BE BUILT FROM SCRATCH, IN DEPENDENCY ORDER:
(a) BotService.getChat + BotService.getChatMember. Neither exists (`grep -rn "getChat\b|getChatMember" src` -> nothing). Every destination route — create, check, test — is blocked on these two calls, and the three separate booleans (isMember / isAdministrator / canPost) must stay three facts: the console prints a different sentence and names a different fixer for each, and collapsing them is the exact failure the feature was written to remove.
(b) The bot-menu RUNTIME, which is the largest hidden item and is not an endpoint at all. The contract says the menu is a ReplyKeyboardMarkup whose button label IS the routing key — an inbound tap is a plain text message whose body is the label. The surviving backend does the opposite: src/modules/player/telegram/player.handlers.ts routes via @OnCommand and @OnCallback(MENU_NS) over an INLINE keyboard built from hardcoded handlers. So rebuilding the admin CRUD alone gives an editor over a menu the bot does not render. The bot side needs: render the root node's active buttons as a reply keyboard on /start, match inbound text against (node, label), maintain a per-player screen stack for BACK, and dispatch BUILTIN labels to the existing handlers.
(c) A builtin-action REGISTRY. The GET tree must answer builtinActions: [{action, description}]; the contract's rule is "an action is a method — an operator may move, rename, hide or delete a button but cannot invent a ninth action". The catalogue the dashboard expects is in src/mocks/fixtures.ts:1360-1371 (deposit, withdraw, balance, profile, deposits, methods, miniapp, support, terms, about). Note the backend has NO withdraw and NO miniapp handler today — both are named in API-CONTRACT.md:497 as newly added, and `withdraw` is in REQUIRED_BUILTIN_ACTIONS, so seeding a default tree against today's backend would immediately violate the BUTTON_REQUIRED invariant.
(d) Tenancy. Every route here is tenant-scoped with NO tenantId in any path or body — the operator is resolved from the session plus the X-Tenant-Id override, and the contract expects a Prisma tenant-scope extension that turns another operator's id into a 404. prisma/schema.prisma has no Tenant model, AdminRole has no PLATFORM_ADMIN, and BotService reads adminChatId/feedChatId from config.telegram (the ENV) at bot.service.ts:209,223. Coordinate with whoever owns the tenants domain before writing these routes; a single-tenant implementation will need re-cutting.
(e) The destination fan-out. The five live categories already have producers, all hardwired to env chats: deposit-notify.service.ts:98,234,306,367, agent-float-sync.service.ts:304, ichancy-health.cron.ts:123, invariant-check.cron.ts:147, report-schedule.cron.ts:219-226. Rebuilding destinations means routing those through a category-aware publisher instead of notifyAdmins/notifyFeed, and stamping lastPublishedAt/lastError per row — which is what makes the table's freshness column honest.

CONTRACT DETAILS EASY TO GET WRONG:
- chatId and gate channelId cross the wire as DECIMAL STRINGS in both directions (signed 64-bit; -1001234567890 exceeds JS safe-integer range). Same rule money follows.
- DELETE on a destination deactivates. POST on a chat that already has a deactivated row REVIVES that row rather than colliding with the (tenantId, chatId) unique index — the console never renders a bare unique-constraint error.
- PATCH on a destination cannot change the chat, by design.
- categories may never be empty — enforced in the DTO, in the service, AND by a CHECK constraint.
- Reorder is one transaction over the whole screen, never a sequence of PATCHes.
- PATCH settings is true PATCH semantics: absent key leaves the value alone, miniAppUrl:null clears. https is required. chatMenuButtonSet is REPORTED, not assumed — setChatMenuButton can fail on its own while the URL saved, and the card must be able to say "the URL is set, but the button under the text box is not".
- failure-sentence.ts knows two reasons the contract's table omits: SEND_FAILED and UNDELIVERABLE. Emit those from /test rather than inventing new strings — an unknown reason degrades the console to the server's English message.
- src/mocks/bot-menu-handlers.test.ts is effectively the backend's acceptance suite already written; port its 20 cases.

DOMAIN BOUNDARY: POST /v1/admin/tenants/:id/webhook, DELETE .../webhook, POST .../bot-setup and PATCH .../bot (endpoints.ts:775-797) are telegram bot configuration but sit under the tenants domain — they are also entirely missing (no modules/tenant in the backend). docs/TASKS.md CC-016 (line 1278) is a SUPERSEDED ticket: it proposes per-tenant adminChatId/feedChatId with a test endpoint, and cites backend files that no longer exist (src/core/telegram/services/tenant-bot.registry.ts, src/modules/tenant/controllers/tenant-admin.controller.ts). The telegram_destinations design in API-CONTRACT.md replaced it — build the contract, not the ticket.

**Verification**

I could not refute a single claim. Verification performed: (1) `grep -rn "@Controller" src` returns exactly 15 controllers - health, telegram/webhook, v1/admin (approval-limit), v1/admin/auth, v1/admin/admins, v1/admin/deposits, v1/deposits, v1/admin (payment-method), v1/payment-methods, v1/admin/players, v1/auth, v1, v1/admin/reconciliation, v1/wallet. (2) I enumerated every @Get/@Post/@Patch/@Delete inside the two bare `@Controller('v1/admin')` controllers - the likeliest place a route could hide behind a composed prefix: admin-approval-limit exposes only admins/:adminUserId/approval-limits and approval-limits/:id; admin-payment-method exposes only payment-methods*, payment-methods/:id/destinations and payment-destinations/:id. No bot-menu, telegram, or reports route is reachable under any prefix. (3) src/main.ts:262 explicitly documents that setGlobalPrefix is NOT used - each controller spells its own 'v1/...' path - so there is no prefix trick that could have hidden these routes. (4) Intent-level greps came back empty: replyKeyboard/keyboardButton/menuButton/chatMenuButton/miniAppUrl/web_app matched only the auth HMAC constant 'WebAppData', the CLI setup-bot command at setup-bot.command.ts:135-136, and one inline web_app cashier button at player.handlers.ts:1598-1611; gate/channelUsername/getChatMember/getChat matched only unrelated words (gateway, negate, navigate, subscription); withdrawalMode/depositMode/tenant/botSettings/notificationCategory/discoveredChat matched nothing at all. (5) `find src prisma -iname "*menu*" -o -iname "*destination*" -o -iname "*chat*" -o -iname "*report*"` returns only payment-destination files and the two activity-report files. (6) The dashboard's own route inventory (docs/API-CONTRACT.md:414-430, 1195-1215, 1266-1273, 1312-1315 and src/lib/api/endpoints.ts:823-946) enumerates exactly the 19 routes claimed and no more, so the first agent's route list for this domain is complete as well as correct. Severities are as claimed and I agree with them. The one substantive correction: the settings payload should carry depositMode as well as withdrawalMode (src/types/bot-menu.ts:72), which the contract prose at line 429 omits.

</details>

<details>
<summary><b>wallet-and-rates</b> — 8 gaps</summary>

**Rebuild from these dashboard files:**

- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:599-629 — GET /v1/admin/payment-destinations/:id/balance, authoritative: the three-answer rule, 409/404, the never-zero rule, why `scale` travels
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:804-840 — the crypto rate section: both routes, ExchangeRateView, the role boundary, the four guards, versioning, why null rather than 404
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:676-690 — GET /v1/admin/reconciliation/agent-float response and the isLow rule
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/USDT-RAILS-STATE.md — the handoff note naming the exact lost backend files (core/chain/*, core/payments/wallet-address.ts, destination-balance.service.ts, agent-float-read.service.ts, core/http/cors-methods.ts) and the three migrations; lines 50-90 list the six live bugs whose fixes must not be lost with them
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/payment-method.ts:144-219 — exchangeRateSchema, SetExchangeRateBody, USDT_SCALE, chainNetworkSchema, walletBalanceSchema, each with the reasoning for every nullable field
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/db.ts:1240-1318 — RATE_MAX_JUMP_BPS (2000), RATE_MAX_AGE_HOURS (24), MockExchangeRate, usdtRateView(), setUsdtRate(): the exact server validation order and the bigint bps arithmetic
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/wallet-balance.ts — the complete balance-read behaviour: the two address regexes, the chain-name table, both problem codes and their verbatim detail sentences
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/handlers.ts:714-753 — the two exchange-rate MSW handlers with concrete status codes and error bodies
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/handlers.ts:1786-1829 — the wallet-balance MSW handler: rail gate, 409/404, address-derived network
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/rate-handlers.test.ts — 14 executable acceptance cases for both rate routes
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/wallet-balance-handlers.test.ts — 9 executable acceptance cases for the balance route incl. the code-keyed-lookup regression pin
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/endpoints.ts:449-454, 495-504, 550-558 — the exact paths, verbs and parsers

**Findings**

THE BACKEND HAS NOTHING IN THIS DOMAIN. `grep -rn 'rateMinor|quoteAsset|USDT|usdt'` across the entire backend src/ AND prisma/ returns zero lines; so does `grep -rni 'exchangerate|exchange_rate|exchange-rate'`; so does `grep -rln 'detectWalletNetwork|ChainVerifier|DestinationBalance|USDT_DECIMALS|TRC20|BEP20|ChainSettlement'`. src/core/ has no `chain/`, `payments/` or `http/` directory. All four dashboard endpoints are missing outright — this is not a drift problem, it is a from-scratch build. The only thing named `wallet` on the backend is `modules/wallet`, which is the MINI-APP's `GET /v1/wallet` (player's own three-number balance: ledger owed, casino live, pending) — unrelated to the dashboard's payout-wallet reads and NOT a starting point for them.

WHAT THE DASHBOARD'S `PaymentRail.CRYPTO` ALREADY HAS: the enum value exists (schema.prisma:64-72) and the rails driver registry has `crypto-manual.driver.ts`, so a CRYPTO method/destination can already be created. Everything that makes it a real crypto rail — reading the chain, pricing at a rate, replay protection — is gone.

THE SINGLE MOST IMPORTANT RULE TO CARRY ACROSS, stated three separate times in the console and once in the contract: an unread balance MUST NOT render or serialize as zero. The wallet-balance response, the agent-float pill, the Sham Cash read, the deposit `walletCheck` and the platform finance cells all follow it. The server side of it is structural, not careful: model ChainBalance as a UNION so `balance ?? 0n` is unwriteable (USDT-RAILS-STATE.md:112-114), and answer 200 + `balanceMinor: null` + a `problem` code rather than a 5xx, because the request was fine and it is the ANSWER that is missing.

THE SECOND RULE: NEVER KEY LOGIC ON A PAYMENT METHOD CODE. The operator's live rail is coded plain `USDT`, not `USDT_TRC20`. A `WALLET_NETWORK_BY_METHOD_CODE` table made the whole chain-check answer "skipped" for every real deposit for months, silently, and the same table is STILL live in this checkout at `C:/Users/dell/Desktop/bot/Telegram-mini-app/src/modules/payment-method/services/payment-destination.service.ts:40-43` and `:214-215` (`const network = WALLET_NETWORK_BY_METHOD_CODE[method.code]; if (network === undefined) return;`) — so a payout address on the operator's own rail gets no validation at all on create, and `accountIdentifier` is immutable, so a bad paste is permanent. That is TASKS.md CC-019 and it is a live hole today, independent of the missing endpoints. Delete the table; gate on `method.rail === 'CRYPTO'` and take the network from the address. The wallet-balance service must take an ADDRESS and never be told the method — the mock's signature `mockWalletBalance(address, checkedAt)` deliberately mirrors that so it cannot answer a question the server would not have been asked.

THREE PAST BUGS THAT WILL RECUR IF THE REBUILD IS NAIVE, all verified live once: (1) BSC USDT has 18 decimals, not 6 — applying USDT_SCALE=6 to both chains credits BEP20 deposits 10^12x their value; read the contract's `decimals()` and normalise with a `toCanonicalUsdtMinor()` before the response's `scale: 6`. (2) TronGrid `/transactions/trc20` returns EVENTS, not payments — an `Approval` has the same shape and moves nothing, and anyone can emit one for ten million USDT naming the operator's wallet for a few cents; check `type === 'Transfer'`, the contract address, and the destination in code. (3) Unconfirmed blocks — pass `only_confirmed=true`. Both (1) and (2) passed their full test suites because the fixtures encoded the same wrong assumption as the code.

RATE ARITHMETIC PRECISION: `rate` carries at most the CURRENCY's decimals (2 for NSP), not USDT's 6 — the DTO and the parser disagreeing about this (six accepted by validation, two by arithmetic) is a named past bug and rate-handlers.test.ts pins '13200.005' as a 400. `movedPercent` must be computed as `Number((|delta| * 10000n) / prevRateMinor) / 100` so that 13200.00 -> 132.00 yields exactly 99. Pricing FLOORS, so a remainder can only ever under-credit, and the console's preview reimplements the identical floor (`(BigInt(usdt) * unit * rateMinor) / unit`) — a server that rounded differently would preview a credit nobody receives.

ROLE MODEL CONFLICT TO RESOLVE BEFORE WRITING THE GUARDS: API-CONTRACT.md:818 says 'PLATFORM_ADMIN reads and does not write' the rate, but permissions.ts:53-69 makes PLATFORM_ADMIN the owner superset holding every capability, and rate-handlers.test.ts asserts a PLATFORM_ADMIN token saves successfully. permissions.ts is the newer source and its comment says the backend was changed to match ('PLATFORM_ADMIN now satisfies every role list'). The contract line is stale. Separately, PLATFORM_ADMIN is not in the backend's AdminRole enum at all, so none of this can be expressed yet. Reader gate for both GET routes = PAYMENT_METHOD_READER_ROLES (REVIEWER and SUPPORT must pass — TASKS.md TC-21.3); writer gate for the rate POST = PAYMENT_METHOD_MANAGER_ROLES; the `confirmLargeChange` override narrows further to SUPER_ADMIN only.

VERB: the rate setter is POST. `@Put('usdt')` was the only PUT in ~75 routes and main.ts:180 allows only GET/POST/PATCH/DELETE/OPTIONS, so rate editing died with a CORS error in the browser while passing every backend test. The lost tree added `core/http/cors-methods.ts` plus a spec that walks every route decorator and fails the build on an unreachable verb — that guard is gone too and is worth rebuilding first, since it is ~30 lines and protects every future route.

OVERLAP WITH OTHER DOMAINS, so nothing gets built twice or dropped: `GET /v1/admin/reconciliation/agent-float` is listed here as a gap because it is a ledger balance read, but it lives on the reconciliation controller — coordinate. `PATCH /v1/admin/payment-destinations/:id/declared-balance` and the four PaymentDestination columns belong to payment-methods; they sit on the same card as the live chain balance and must stay visibly distinct from it (declared is hand-typed, always shown WITH a timestamp, and a static test asserted it is never read by any deposit/credit/ledger/reconciliation code). `GET /v1/admin/deposits/:id/chain-check` (deposits domain) is the rate's main consumer — it prices chain truth at `rateMinor` with asymmetric tolerance (any shortfall -> human, small overage -> auto), so the ExchangeRate model must land before that endpoint can be rebuilt. `GET /v1/admin/finance/balances` and `POST /v1/admin/finance/tenants/:id/refresh` (platform-finance) re-read the same USDT wallets per tenant and carry the same never-zero union (`not_loaded | loaded | unavailable | expired`) — build one chain-balance service and have both call it. `GET /v1/admin/players/:id/balance` is also missing from the backend (player-admin controller has only GET /, GET /:id, POST /:id/ichancy-account) — players domain.

SUGGESTED BUILD ORDER: (1) core/http/cors-methods.ts + spec; (2) ExchangeRate model + migration + the two rate routes with all four guards — this unblocks the deposit chain path and is pure local logic with no third-party dependency; (3) core/payments/wallet-address.ts with detectWalletNetwork(), then fix CC-019 in payment-destination.service.ts (a live security hole that needs no new endpoint); (4) core/chain verifiers + destination-balance.service.ts with the 30s success-only cache; (5) agent-float-read.service.ts on the reconciliation controller.

**Verification**

Zero of the four claimed gaps could be refuted — every one is genuinely absent, and the prior agent's evidence was accurate in each case. I verified independently rather than re-running its greps: I enumerated all 15 @Controller decorators, read the route decorators of the three controllers that could plausibly host these paths (reconciliation, admin-payment-method, admin-approval-limit) line by line, and enumerated every model and enum in schema.prisma with line numbers. Two points that strengthen the confirmations: (1) main.ts:262 carries an explicit comment that setGlobalPrefix('v1') is NOT called because each controller declares its own 'v1/...' path — so there is no hidden prefix that could make a missing route actually exist under another reconstruction; (2) the backend has no tenancy concept at all (zero hits for tenant/Tenant/PLATFORM_ADMIN across src and prisma), which is a deeper hole than the AdminRole enum gap suggests and gates the platform-finance surface entirely. The domain's two cheapest wins are the agent-float read (no schema change; ichancyAgentFloatCode + AccountRegistryService.computeBalanceFromEntries already exist, only a service and a @Get on the existing ReconciliationController are missing) and the exchange-rate pair (a near-mechanical copy of AdminApprovalLimit's versioning, which is the schema's own stated template for it). The chain balance is the most expensive: it needs a whole src/core/chain/ that does not exist, including address-based network detection and a third-party explorer client with the three-arm nullable response.

</details>

<details>
<summary><b>settings-misc-health</b> — 8 gaps</summary>

**Rebuild from these dashboard files:**

- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/client.ts (the whole file — it IS the client-conventions spec: envelope unwrapping at :199-204, header set at :114-134, error mapping at :147-165, correlation id at :100-105, retry-after at :107-112, acceptErrorBody at :86-87,191-197, page/cursor meta at :238-266, bearer-protected blob fetch at :275-302)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/client.test.ts (executable spec for all of the above, incl. the terminus-503 case at :282-297, the 429/retry-after case at :207-228, the VALIDATION_FAILED details.fields case at :182-204, the NETWORK_UNREACHABLE/CORS case at :251-266, the non-JSON-proxy-page case at :268-281)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/errors.ts (ApiError shape, NETWORK_UNREACHABLE, isRetryable predicate that the query retry policy keys off)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/api.ts (envelope, apiMetaSchema, pageMetaSchema, cursorMetaSchema, moneyViewSchema, breakMoneySchema)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/health.ts (livenessSchema, readinessSchema, HealthSnapshot)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/endpoints.ts:160-167 (healthApi), :205 (sweep)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/queries.ts:120-215 (poll-interval constants + the reasoning), :1537-1551 (useHealth), :389-391 (useSweepDeposits)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/polling.test.ts (the pinned budget: QUEUE 30s, OVERVIEW 120s, HEALTH 120s, AGENT_FLOAT >= HEALTH, <=5 req/min at rest, refetchOnWindowFocus true, staleTime>0, retry predicate table)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/app/query-client.ts (retry predicate, retryDelay cap 8s, mutations retry:false, 5xx-on-stale-data toast)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/handlers.ts:120-141 (the `ok`/`fail` envelope helpers = exact success and error body shapes), :525-536 (health)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/features/settings/settings-connection.tsx + settings-connection.test.tsx (the readiness contract, including the 503 body at test :18-36)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/features/settings/settings-maintenance.tsx (the sweep call + its three-count report)

**Findings**

SUMMARY: this domain has NO missing endpoints. All three routes the console calls here — GET /health/live, GET /health/ready, POST /v1/admin/deposits/maintenance/sweep — exist on the backend and the sweep's shape matches field-for-field (`{expired, released, reaped}`, deposit-sweep.service.ts:53-56 vs sweepReportSchema at src/types/deposit.ts:104-109). What is missing is cross-cutting BEHAVIOUR, and one of those items breaks the entire console.

RANKED, WHAT A REBUILDER MUST FIX:
1. (BLOCKER, one line) src/main.ts:181 — add `'x-tenant-id'` to CORS `allowedHeaders`. `.env.example` ships `VITE_TENANT_HEADER_ENABLED=true`, so the console sends the header on every admin request; the preflight rejects it and every screen shows "Could not reach the API". Nothing else in this domain matters until this is done.
2. (MAJOR) /health/ready degraded path — the global exception filter swallows the terminus body. See the gap entry; the fix is either excluding `/health/*` from `GlobalExceptionFilter` or detecting a `HealthCheckResult` payload in `fromHttpException` and re-emitting it as `{success:true, data:<result>}` at 503. Backend has no test for this path; add one.
3. (MAJOR) `@Idempotent(...)` on the admin money-path controllers. The machinery, the error codes, the 24h store, the reaper and the Prisma model all exist and are wired — only the decorators are absent.

WHAT IS FINE AND SHOULD NOT BE TOUCHED: the success envelope (transform.interceptor.ts:26-54) and error envelope (global-exception.filter.ts:151-158) already emit exactly `{success,data,error,meta:{correlationId,timestamp}}`, page metas are merged into `meta` not nested under `data` (transform.interceptor.ts:37-45) which is precisely what requestPage/requestCursorPage read, `VALIDATION_FAILED` already hoists ValidationPipe's `string[]` into `details.fields` (filter :363-373) which is what `ApiError.fieldErrors` reads, `x-correlation-id` is minted pre-guard so even 401s carry it (correlation-id.interceptor.ts header comment) and is CORS-exposed alongside `retry-after` and `x-ratelimit-*` (main.ts:184-190). Money-as-strings, health routes @Public and unthrottled (`skipIf` — throttle-routes.ts:44-48), no global `/v1` prefix (main.ts:261-265) — all as the contract describes.

AUDIT LOG: the console does NOT call any audit endpoint. I grepped `audit` across all of `src` in the dashboard — every hit is prose in a comment, a translation string, or the MSW fixture username `audit_bot`. So there is no gap to close today. The backend's `AuditService` is write-only by design (in-transaction, append-only trigger, no update/delete — audit.service.ts header). If an audit-log screen is on the roadmap, the read endpoint does not exist and the model needs a `tenantId` first (see dataModelGaps).

ERROR CODES: `CommonErrorCodes` (src/common/exceptions/error-codes.ts) covers everything this domain needs — VALIDATION_FAILED, RATE_LIMITED, INTERNAL_ERROR, SERVICE_UNAVAILABLE, INSUFFICIENT_ROLE, UNAUTHENTICATED, ADMIN_NOT_FOUND, ADMIN_INACTIVE, DUPLICATE_RESOURCE, RESOURCE_NOT_FOUND, WRITE_CONFLICT. I probed the backend for every SCREAMING_SNAKE code the dashboard switches on; the ones with no definition anywhere in the backend belong to OTHER domains and should be picked up there, but listing them here so none is lost: `ADMIN_CREDENTIALS_INVALID`, `ADMIN_OPERATOR_AMBIGUOUS`, `ADMIN_OPERATOR_NOT_ACTIVE`, `AGENT_CREDENTIALS_INVALID`, `AGENT_OPERATOR_AMBIGUOUS`, `AGENT_OPERATOR_HAS_NO_OWNER`, `AGENT_OPERATOR_NOT_ACTIVE` (auth); `TENANT_NOT_FOUND`, `TELEGRAM_CHAT_REJECTED` (tenants/telegram); `SHAMCASH_NOT_LINKED` (shamcash); `DEPOSIT_NOT_REVIEWABLE`, `DUPLICATE_PROOF`, `DUPLICATE_CREDIT` (deposits); `METHOD_IN_USE`, `DESTINATION_IN_USE`, `PAYMENT_METHOD_HAS_HISTORY` (payment methods); `BOT_MENU_*` (bot config). `NETWORK_UNREACHABLE` and `HTTP_<status>` are client-minted and correctly have no backend counterpart.

TWO ADJACENT GAPS THAT SHOW UP ON THE SETTINGS/CHROME SURFACE BUT BELONG TO OTHER DOMAINS — flagging so they are not lost between agents:
 • `GET /v1/admin/reconciliation/agent-float` does not exist. The reconciliation controller has `@Post('agent-float/sync')` (reconciliation.controller.ts:149) but NO GET. The console calls it from the TOP BAR on every screen (src/lib/api/endpoints.ts:549-556, `agentFloatApi` — deliberately kept OUT of `reconciliationApi` because it is chrome) and queries.ts:1559-1563 already documents "the backend endpoint does not exist yet", which is why `retry:false` is on it. This is a permanent 404 per screen per tab. Reconciliation domain, but it is chrome, so it disfigures every page including Settings.
 • `POST /v1/admin/auth/credentials` does not exist — the backend only has `POST /v1/admin/auth/bot-code` (admin-auth.controller.ts:35,45). That is the console's ONLY sign-in (endpoints.ts:154, contract §2a), so nobody can reach the Settings page at all. Auth domain; listing it because Settings > Profile/Access render entirely from that session object (`useAuth()` — admin, role, expiresAt, expiringSoon) and make no backend call of their own.

POLLING BUDGET (no backend work, but it is the load contract a rebuilt backend will see): at rest, one open console costs ~5 requests/minute total — health 2 probes / 120s, overview 2 tiles / 120s, agent float 1 / 120s, plus deposit queue 1 / 30s only while that screen is open. `refetchOnWindowFocus: true` with `staleTime: 15s` is what replaced the old 25 req/min; retries are 2 max with exponential backoff capped at 8s, and only for status 0, 429, or >=500. Settings > Connection and the top-bar pill both subscribe to the SAME query key (`['health','snapshot']`), so having both mounted costs one tick, not two.

MISC (src/features/misc/): `not-found-page.tsx` and `route-error-page.tsx` are pure client-side router surfaces with no API calls. Settings > Profile, Access and Appearance likewise (useAuth / useTheme / localStorage only). The only Settings surface that touches the backend is Connection (health) and Maintenance (sweep).

**Verification**

All five claimed gaps CONFIRMED; nothing refuted. Searches actually run against C:/Users/dell/Desktop/bot/Telegram-mini-app: (a) `grep -rin tenant src/ prisma/` -> 0 hits, which independently verifies both the CORS blocker and the whole tenant data-model claim; (b) `grep -rn '@Idempotent|IDEMPOTENCY_HEADER|IdempotencyInterceptor|idempotency' src/ --include=*.ts` -> among controllers only deposit.controller.ts:51; (c) `grep -rn '@Controller(' src/` -> the complete route surface is health, telegram/webhook, v1/admin (approval-limits), v1/admin/auth, v1/admin/admins, v1/admin/deposits, v1/deposits, v1/admin (payment-method), v1/payment-methods, v1/admin/players, v1/auth, v1, v1/admin/reconciliation, v1/wallet; (d) `grep -rn PLATFORM_ADMIN src/ prisma/` -> 0; (e) read the full AuditLog, IdempotencyKey and AdminUser models, the AdminRole enum, and the complete model/enum list in prisma/schema.prisma; (f) read main.ts CORS+OpenAPI block, health.controller.ts in full, transform.interceptor.ts in full, and global-exception.filter.ts around lines 120-200 and 350-400. ROUTE-PREFIX CHECK: there is NO setGlobalPrefix — src/main.ts:261-265 explains versioning is per-controller (@Controller('v1/...')) and that /health/* plus the Telegram webhook are deliberately unversioned, so the dashboard's '/health/live' and '/health/ready' paths do resolve; the previous agent reconstructed paths correctly. TWO CORRECTIONS to the previous agent's framing, neither of which rescues a gap: (1) on gap 2, the 200 path is genuinely correct — TransformInterceptor passes the raw HealthCheckResult through as `data` and it matches readinessSchema (status/info/error/details) field-for-field — so the fix is strictly a 503-path fix inside HealthController, and patching global-exception.filter.ts:375 would be the WRONG fix because that destructure deliberately drops `error` for every exception in the system; (2) I verified the one nearby thing that could have been a false gap and it is NOT one — `POST /v1/admin/deposits/maintenance/sweep` (dashboard endpoints.ts:205, useSweepDeposits) DOES exist at src/modules/deposit/controllers/deposit-admin.controller.ts:283-287, and its SweepReport `{expired, released, reaped}` (deposit-sweep.service.ts:53-57) matches sweepReportSchema (dashboard src/types/deposit.ts:104-108) exactly, so Settings > Maintenance is the one settings screen whose backend is intact.

</details>

<details>
<summary><b>data-model</b> — 29 gaps</summary>

**Rebuild from these dashboard files:**

- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/tenant.ts
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/withdrawal.ts
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/enums.ts
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/bot-menu.ts
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/telegram-destination.ts
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/player.ts
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/payment-method.ts
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/deposit.ts
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/admin.ts
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/shamcash.ts
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/shamcash-dev.ts
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/platform-finance.ts

**Findings**

SCALE OF THE LOSS. The backend schema in this repo is 970 lines with 21 models and 16 enums, last migrated 2026-08-20. docs/TASKS.md quotes the LOST schema with line numbers — PaymentDestination at :495-526, ExchangeRate at :715-748, DepositRequest.decidedByAdminId at :794, PlayerDebit at :988-1001, ReconciliationBreak at :1347-1363, SelfExclusion at :1433-1439 — so the schema that was lost was roughly 1450+ lines. About a third of the data model is gone, and it is the third everything built after 2026-08-20 depends on.

TWO MIGRATIONS WERE WRITTEN AND NEVER APPLIED, one was applied and is lost. USDT-RAILS-STATE.md:37-41 is the record: 20260826120000_exchange_rates (APPLIED — so the operator's live database has an exchange_rates table this repo's schema knows nothing about), 20260826140000_chain_settlements (written, not applied), 20260827100000_declared_account_balance (written, not applied). prisma/migrations here contains only 20260813101853_init and 20260820120000_player_link_backfill. Anyone rebuilding MUST inspect the operator's live database before writing a migration — `prisma migrate diff --from-schema-datasource` against the running instance is the only honest starting point, or `prisma migrate deploy` will collide with a table that already exists.

THE ORDER OF RECONSTRUCTION IS NOT NEGOTIABLE. Tenant first, then tenantId + the unique-key rewrites everywhere, then AdminUser (PLATFORM_ADMIN, per-tenant username) because it gates every admin route, then the enums (DepositMode, WithdrawalMode, PlayerSource, ChainNetwork), then PlayerDebit, then Withdrawal (it holds an FK to PlayerDebit), then BotMenu, TelegramDestination, TelegramDiscoveredChat, ExchangeRate, ChainSettlement. Building Withdrawal before PlayerDebit or either before Tenant produces a schema that has to be rewritten.

THE TENANT BACKFILL IS THE RISKY MIGRATION. Twenty tables gain a NOT NULL tenant_id under existing rows, and eight global unique indexes are dropped and re-created as composites. Do it in three migrations, not one: (1) create tenants + platform_defaults, insert tenant zero; (2) add tenant_id nullable everywhere, UPDATE … SET tenant_id = <zero>, then SET NOT NULL; (3) drop and re-create the unique indexes. Step 3 is the one that fails on real data if two operators' rows were ever merged.

WHAT IS ALREADY RIGHT AND MUST NOT BE DISTURBED. The money rules are intact and load-bearing: BigInt *Minor columns only (no Decimal, no Float anywhere), the append-only ledger with its deferrable balance trigger (prisma/sql/001), the immutability triggers (002), the role grants (003), the partial unique on external_reference (004) and the four-eyes CHECK (005). Every new model follows the same conventions — @map snake_case, @db.Timestamptz(6), gen_random_uuid() ids, BigInt for Telegram ids and for money. The new money columns (withdrawal amount, player debit amount, declared balance, rate) are all BigInt minor units; the only place a scale travels is USDT at 6, which is exactly why ChainSettlement and DepositRequest carry an explicit `scale` column rather than assuming one — BSC's USDT contract reports 18 and a scale taken on faith once credited 10^12 times the value.

THREE PLACES WHERE A ZERO WOULD BE A LIE, and the schema has to keep them distinguishable. Withdrawal.walletCheckAvailableMinor is NULL for UNKNOWN and NOT_CONFIGURED (never 0); PaymentDestination.declaredBalanceMinor >= 0 because a cash drawer legitimately holds nothing; ChainSettlement.amountMinor > 0 strictly because a zero-value transfer settles nothing. Copying one CHECK onto another of these is a real and easy mistake — docs/TASKS.md:1961 flags it explicitly.

CHAIN_SETTLEMENTS MUST STAY TENANT-BLIND. It is the one new model that does NOT get a tenant_id, and the reason is a bug that was already found and fixed once: keying replay protection on payment_method_id (per-operator) let the same USDT transfer be credited once per operator. USDT-RAILS-STATE.md:124 notes there was a spec asserting the absence 'so nobody fixes it back into the hole'. Rebuild that spec with the model.

WHAT IS NOT A PERSISTED ENTITY, despite having a dashboard type. Do not create tables for: ShamCash balances or transactions (read live from the vendor — persisting them creates a stale second truth about somebody else's money); the ShamCash developer bench's five session values (they travel in one request body and are dropped with it — the column that held them was deliberately removed and the cookies destroyed); ShamCashPairing (a live headless browser held in memory, handed over exactly once); TenantWebhook / TenantBotHealth / TenantIchancyHealth (computed live from getWebhookInfo, getMe and a real signin — the tenant row carries only the path token and the config); TenantProvisioning (the report of what a create call managed, not a record); the player's menu back-stack (server-side per-session state, Redis); AdminSession (there is no admin refresh token — the access token is a signed JWT carrying `tid`, and the bot-code login and its AdminLoginCode Redis key were retired on 2026-09-05, so BOT_CODE_INVALID/BOT_CODE_EXPIRED must not be reused); stats (summed per request, no rollup table until it is measured slow).

TWO FIELDS THAT LOOK LIKE DUPLICATES AND ARE NOT. Tenant.depositMode/withdrawalMode/miniAppUrl are ALSO served by /v1/admin/bot-menu/settings — that is one setting seen from two sides (platform and operator), not two rows; keep them on Tenant and have the bot-menu settings endpoint read and write the tenant row. And Withdrawal.mode is a THIRD copy on purpose: it is frozen at request time so changing the operator setting cannot re-explain a decision already taken.

A CONSTRAINT THE ENUM CANNOT EXPRESS. WalletCheckStatus is written UPPERCASE in Prisma above but the console's wire values are lowercase ('ok' | 'insufficient' | 'unknown' | 'not_configured', src/types/enums.ts WALLET_CHECK_STATUSES). Either map at the view layer or declare the enum members lowercase — but decide once, because a mismatch here renders every withdrawal's wallet check as an unknown string.

ROLE DATA THE SCHEMA CANNOT ENFORCE, worth writing down beside it. PLATFORM_ADMIN short-circuits every role list in the RolesGuard, so the per-route constants describe a TENANT's roles and the platform superset is expressed once. The database's only job here is prisma/sql/006's CHECK keeping a PLATFORM_ADMIN row out of any tenant but zero.

**Verification**

METHOD: I read prisma/schema.prisma structurally (all 36 model/enum declarations enumerated by `grep -n '^model \\|^enum '`), then read in full every model and enum a claim touched — PaymentMethod:275-310, PaymentDestination:312-338, Player:341-393, AdminUser:420-444, AdminApprovalLimit:446-470, DepositRequest:473-566, LedgerAccount:628-663, LedgerTransaction:665-700, OutboxMessage:732-756, IdempotencyKey:758-782, TelegramUpdate:784-803, AuditLog:840-865, ReconciliationBreak:867-916, and all 16 enums at :35-249. I also grepped the entire src/ tree case-insensitively for each identifier in kebab/camel/snake and singular/plural form, enumerated all 14 @Controller decorators, read prisma/sql/004, prisma/seed/ (5 files), src/core/config/env.schema.ts and config.service.ts, and checked prisma/migrations.

RESULT: 24 of 24 claims CONFIRMED, 0 refuted. I could not find a single implementation to point at. This is unusual for an adversarial pass, and the reason is structural rather than sloppiness on the original audit's part: `grep -ril tenant src/` over the whole NestJS source returns ZERO files. The backend is not a partially-multi-tenant system with gaps — it is a complete, well-built SINGLE-tenant system. Every one of these 24 items is downstream of that one fact.

THREE THINGS I VERIFIED THAT SHARPEN THE PICTURE:

1. Intent-based searches found near-misses, not implementations. Withdrawal exists only as Ichancy RPC verbs (IchancyOperation.WITHDRAW_FROM_AGENT :177, WITHDRAW_FROM_PLAYER :182) — the outbound capability is wired at the adapter layer (src/core/ichancy/ichancy.port.ts) but has no domain model, no ledger kind, no controller. my_chat_member is already parsed and discarded (src/core/telegram/services/update-dedupe.service.ts:57-61). The agent float watermark is fully implemented and enforced (src/modules/deposit/services/deposit-review.service.ts:598) — just from env, once, globally. So several gaps are 'one column away' rather than greenfield.

2. Two claims are worse than 'missing a feature'. PaymentMethod.requiresProof (gap 13) is declared NON-optional by the console (payment-method.ts:6), so today's backend response fails Zod parsing and blanks the rails screen — that is a live break, not a future one. Player.telegramUserId (gap 14) is BigInt NOT NULL at schema.prisma:344, so an ICHANCY_IMPORT or ADMIN player physically cannot be inserted; the import path is blocked at the database, not at the API.

3. ExchangeRate (gap 10) means this repo's schema is BEHIND the operator's live database, not merely behind the dashboard. Its migration was applied on the lost machine, so the exchange_rates table exists in production while prisma/migrations here stops at 20260820120000. Any `prisma migrate` run from this repo will fight that. Rebuild its migration with the original 20260826120000 timestamp, and treat 20260826140000 (chain_settlements) and 20260827100000 (declared_account_balance) as written-but-unapplied — those two are safe to re-create.

REBUILD ORDERING: gaps 1 -> 2 -> 3 -> 16 are one indivisible change (Tenant model, tenantId everywhere, composite uniques, AdminUser rescoping, and the tenant-scope Prisma extension + runWithTenant context). Gap 21's indexes and gap 22's per-tenant ledger account codes should land inside that same migration rather than after it. Only then are gaps 5/6 (Withdrawal, PlayerDebit) and 10/11 (ExchangeRate, ChainSettlement) buildable. Gaps 12, 13, 15, 19, 20, 24 are column additions that can ride along at any point. Note that gap 18's enum members are the easy half — the load-bearing work is the per-kind sign guard in src/core/ledger/posting-rules.ts and its spec.

</details>

<details>
<summary><b>mini-app</b> — 15 gaps</summary>

**Rebuild from these dashboard files:**

- C:/Users/dell/Desktop/bot/telegram-balance-bot/src/lib/miniapp-data.ts — the complete list of every value the UI needs, as hardcoded fixtures. This is the best available spec of the mini-app's required view models; map each constant to a backend DTO.
- C:/Users/dell/Desktop/bot/telegram-balance-bot/src/components/miniapp/HomeTab.tsx — balance + method picker + recent-operations screen
- C:/Users/dell/Desktop/bot/telegram-balance-bot/src/components/miniapp/DepositTab.tsx — the 3-step deposit flow (method, amount, proof) plus history
- C:/Users/dell/Desktop/bot/telegram-balance-bot/src/components/miniapp/AccountTab.tsx — profile, referral, casino credentials, terms
- C:/Users/dell/Desktop/bot/telegram-balance-bot/src/components/miniapp/SupportTab.tsx — service-status board and support entry points
- C:/Users/dell/Desktop/bot/Telegram-mini-app/src/modules/wallet/dtos/wallet.view.ts — authoritative balance response shape, including the never-render-0 rule
- C:/Users/dell/Desktop/bot/Telegram-mini-app/src/modules/deposit/dtos/deposit.view.ts — DepositView / DepositDestinationView, the money dual-representation convention
- C:/Users/dell/Desktop/bot/Telegram-mini-app/src/modules/deposit/dtos/create-deposit.dto.ts and submit-proof.dto.ts — exact request shapes for the two deposit POSTs
- C:/Users/dell/Desktop/bot/Telegram-mini-app/src/modules/player/dtos/auth.dto.ts — initData exchange contract and AuthTokensView
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:499-563 — the withdrawal domain (admin side, but it defines the status machine, money movements and view shape the player endpoints must agree with)
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md:429-495 — bot-menu settings: miniAppUrl and withdrawalMode AUTO\|MANUAL, plus the REQUIRED_BUILTIN_ACTIONS list that includes 'withdraw' and 'miniapp'

**Findings**

HOW MUCH IS REAL VS DESIGN-ONLY: the mini-app is 100% design-only. Not "partially wired", not "behind" — it has never made a single HTTP request. Evidence, all verified: (1) grep for fetch(/axios/useQuery/useMutation/import.meta.env/VITE_ across src/ matches nothing inside src/components/miniapp/ — only template scaffolding in router.tsx, __root.tsx and server.ts; (2) the entire data layer is src/lib/miniapp-data.ts, 129 lines of hardcoded module-level constants (balance:24, paymentMethods:30, deposits:47, profile:90 — which hardcodes a literal plaintext password — health:104); (3) no .env file and no base-URL constant anywhere in the repo; (4) no Telegram SDK dependency and no telegram-web-app.js script tag, so initData is unobtainable and authentication is impossible; (5) the deposit submit button (DepositTab.tsx:140) is a bare type="button" with no onClick, the reference input (:116) is uncontrolled with no state, and the file input (:126) has no onChange — the form collects nothing and submits nowhere; (6) src/routeTree.gen.ts declares exactly two routes, __root__ and '/', with tab switching done by useState — nothing is addressable or deep-linkable. @tanstack/react-query is installed and QueryClientProvider is mounted in __root.tsx, but zero hooks consume it. The git history matches: the final substantive commit is literally "Added Telegram Mini App design", preceded by Lovable "Changes" auto-commits. Conclusion: no mini-app API work was lost in the unpushed-work incident, because none was ever written. This domain is a greenfield build, not a recovery.

THE GOOD NEWS — INVERTED RISK PROFILE: unlike the dashboard domains, here the BACKEND is ahead of the client. The backend already ships a complete, carefully designed, player-facing API: initData auth with refresh rotation, GET /v1/me with an eligibility block, GET /v1/wallet, the payment-method catalogue with sticky 24h destination assignment, and the full deposit lifecycle including idempotent creation, base64 proof upload, cancel and client-enforceable limits. Roughly 85% of the mini-app's screens can be wired to endpoints that exist TODAY with zero backend work. The DTO files carry unusually explicit WHY-comments that read as a written contract — treat them as the spec.

FASTEST CORRECT PATH TO REBUILDING THE API LAYER (ordered, each step independently shippable):
1. Telegram bootstrap first, because everything else is @PlayerAuth() gated. Add the telegram-web-app.js script to __root.tsx head (or @telegram-apps/sdk), read WebApp.initData, call WebApp.ready()/expand(), POST to /v1/auth/telegram, hold the token pair in memory with a refresh scheduled off accessTokenExpiresAt (NOT by decoding the JWT — the backend returns the timestamp precisely so you don't have to). Do not use cookies: player-auth.controller.ts documents that Telegram in-app webviews silently drop them on some Android builds. Keep POST /v1/auth/bot-code as the fallback path for native clients.
2. Build src/lib/api/client.ts — one typed fetch wrapper that injects the bearer token, handles the error envelope, and retries once on 401 via /v1/auth/refresh. Generate the TypeScript types by copying the backend's view interfaces verbatim (wallet.view.ts, player.view.ts, deposit.view.ts) rather than hand-writing them; they are already exported interfaces and will not drift.
3. Replace miniapp-data.ts constant-by-constant with react-query hooks. The provider is already mounted, so this is a mechanical swap and each screen can migrate independently: balance -> useWallet(), paymentMethods -> usePaymentMethods(), deposits -> useDeposits(), profile -> useMe(). Delete each constant as its consumer migrates.
4. Fix the deposit flow's blocking design hole BEFORE polishing anything: after POST /v1/deposits, render the returned destination (accountIdentifier, accountHolder, instructions). The current design never shows the player where to send money, so the flow is physically uncompletable as drawn. This is the single highest-value change in the domain.
5. Wire the proof upload: FileReader.readAsDataURL -> POST the data-URL straight through. The backend's SubmitProofDto strips the data: prefix server-side on purpose, so do NOT strip it client-side. Gate on GET /v1/deposits/limits/proof first.
6. Generate an Idempotency-Key (crypto.randomUUID) per deposit attempt and persist it across retries within that attempt — the backend's UNIQUE column is what stops a flaky-network retry from opening a second deposit for money sent once.
7. Only then start the withdrawal work, which is the one genuine full-stack blocker: it needs the WithdrawalRequest model, the WithdrawalStatus enum, player endpoints, the admin queue, AND a new mini-app screen. Sequence it behind the deposit path and behind the admin-withdrawal domain, and note the contract's hard rule — no payout rail can send money over an API, so even AUTO mode ends with a human pressing mark-paid.

TWO DECISIONS TO ESCALATE RATHER THAN BUILD: (a) The Account tab displays the player's ichancy.com password in plaintext. The backend refuses this deliberately and structurally — PlayerView omits ichancyLogin, it exists only on AdminPlayerView, and serialize.interceptor.ts exists specifically to keep ichancyPasswordEnc off the wire. Do not add an endpoint to satisfy the mockup; get a product/security ruling first, and if it proceeds it needs audit logging and a reveal-once pattern. (b) The Support tab's status board wants per-service latency for four named services and a version string; /health/ready returns 503 when degraded, which is right for a k8s probe and wrong for a UI. Add a separate public GET /v1/status rather than repurposing the probe — otherwise a degraded payment gateway makes the mini-app's own status screen unreachable.

**Verification**

ADVERSARIAL VERDICT: 0 of 15 claims refuted, 15 of 15 confirmed. I could not find a backend or mini-app implementation for any of them, and I searched hard for each.

What I actually did, so the null result is credible:
- Enumerated EVERY route decorator across all 14 controllers (`grep -rn "@Controller(|@Get(|@Post(|@Patch(|@Put(|@Delete(" --include="*.controller.ts" src`) and reconstructed the composed paths rather than trusting file names. Full route surface: /health/{live,ready}; /telegram/webhook/:token; /v1/admin/{admins,admins/:id/approval-limits,approval-limits/:id,auth/bot-code,deposits/*,payment-methods/*,payment-destinations/:id,players,players/:id,players/:id/ichancy-account,reconciliation/*}; /v1/auth/{telegram,bot-code,refresh,logout}; /v1/deposits{,:shortId,:shortId/proof,:shortId/cancel,limits/proof}; /v1/payment-methods{,:code}; /v1/me; /v1/wallet. Nothing withdrawal-, referral-, status- or FAQ-shaped hides inside an existing controller under a composed prefix.
- Confirmed the prefix question: main.ts:262 documents that setGlobalPrefix('v1') is deliberately NOT called because each controller carries its own `v1/` segment. So the previous agent's path reconstruction was correct, and /health/* is genuinely unversioned — a real mismatch with the contract's /v1/status.
- Searched by INTENT, not name, for withdrawals: withdraw|payout|cashout|cash_out across src/ and prisma/. Every hit is Ichancy RPC plumbing (core/ichancy/*, where `withdrawFromPlayer` is the casino-side debit call) or prose. No negative-deposit modelling, no payout entity. src/modules/admin/services/activity-report.service.ts:189 settles it in the codebase's own words: "there is deliberately NO withdrawals section — withdrawals do not exist in this system yet".
- Read prisma/schema.prisma's full model/enum list before agreeing any model was missing.
- Verified the mini-app side independently rather than taking the claims on trust: `find src -type f` (58 files: 4 miniapp tabs + primitives, 49 shadcn/ui components, 5 lib files, 2 routes, the generated route tree, router/server/start), `grep -rniE 'fetch\(|axios|useQuery|useMutation|VITE_|import.meta.env'` (2 hits, both src/server.ts), `grep -rniE 'telegram|initData|WebApp'` (2 hits, both static strings), and read routeTree.gen.ts:35 where the route id union is literally `'__root__' | '/'`.

One correction to the evidence, not the verdict: claim 1's evidence says the only matches are router.tsx/__root.tsx/server.ts; the actual grep hits only src/server.ts:48,51. The conclusion is unchanged and in fact slightly stronger — @tanstack/react-query is installed and a QueryClient exists in the template scaffolding, but no component anywhere issues a request.

Severity note on #9: I am confirming it as a gap in the literal sense (no endpoint exists) but the backend's refusal is three-layer and deliberate (player.view.ts's hand-written allow-list, serialize.interceptor.ts's second allow-list, and the schema comment at :359). Do not let a rebuild sweep it in with the rest — it needs an explicit product decision, and the current mini-app fixture hardcoding a plaintext password (miniapp-data.ts:98) should not be read as prior art.

Scale of the rebuild for this domain: the mini-app is essentially a static Lovable design mock, not a half-wired client. There is no partial API layer to extend. The backend is in much better shape — deposits, wallet, payment methods, auth, eligibility and proof limits are all complete and well-documented — so the mini-app work is mostly "wire the UI to endpoints that already exist" (claims 1, 2, 7, 12, 13, 14, 15), while withdrawals (3, 4, 5, 6) plus referral (8), status (10) and FAQ (11) need genuine backend construction.

</details>

<details>
<summary><b>gap-window-history</b> — 33 gaps</summary>

**Rebuild from these dashboard files:**

- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/USDT-RAILS-STATE.md — THE single most valuable file for this domain. It is a handoff note written ON the lost PC that inventories the backend working tree by filename: src/core/chain/*, deposit-chain-check.service.ts, auto-credit-decision.ts, deposit-auto-credit.service.ts, ChainWatchProcessor, destination-balance.service.ts, agent-float-read.service.ts, core/payments/wallet-address.ts, core/http/cors-methods.ts, the three pending migrations, the new env flags, and six already-fixed bugs with their root causes. It also records the verified state at stop: backend 1787 tests / 114 suites passing.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/API-CONTRACT.md — the authoritative endpoint contract as of 2026-09-09, with dated change notes (2026-09-03 session removed, 2026-09-04 player sources, 2026-09-05 credentials + staff passwords, 2026-09-07 dev bench, 2026-09-08 QR observation) that reconstruct the last week of lost backend work almost day by day.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/TASKS.md — sections 3 and 4. CC-016/017/018/019/020/021 are each marked 'Repo: backend + console' and each quotes backend source with file AND line number, so they double as a directory listing of the lost backend tree.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/docs/TENANT-OPERATIONS.md — tenant claim, per-tenant staff uniqueness, Ichancy session keying, and what provisioning made stale.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/api/endpoints.ts — every path, verb and zod response schema the UI expects; line numbers given in dashboardExpects above.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/handlers.ts — MSW handlers, +1190 lines in dfaa738 alone; concrete request AND response bodies for every window feature.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/fixtures.ts and src/mocks/db.ts — the in-memory data model the console was developed against; db.ts gained +564 lines in dfaa738, which is effectively a draft of the missing Prisma tables.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/types/ — withdrawal.ts, bot-menu.ts, stats.ts, shamcash.ts, shamcash-dev.ts, telegram-destination.ts, platform-finance.ts, agent-float.ts, tenant.ts, player.ts, enums.ts.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/features/bot-config/bot-surface.ts — transcribes the bot's own commands, /start keyboard and message bundle from the backend as of 2026-09-01; the best available reconstruction of core/telegram/bot-menu.constants.ts, which is itself lost.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/mocks/ handler test files, which are executable contract tests: deposit-chain-check-handlers.test.ts, wallet-balance-handlers.test.ts, rate-handlers.test.ts, withdrawal-handlers.test.ts, player-admin-handlers.test.ts, bot-menu-handlers.test.ts.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/lib/auth/permissions.ts — transcribes the backend's role constants (README rule 3), so it names the backend role sets that must be recreated: PAYMENT_METHOD_MANAGER_ROLES, WITHDRAWAL_READER_ROLES, WITHDRAWAL_DECIDE_ROLES, BOT_MENU_MANAGER_ROLES, PLAYER_BLOCK_ROLES, PLAYER_CREATE_ROLES, PLAYER_IMPORT_ROLES.
- C:/Users/dell/Desktop/bot/manager-account-dashboard/src/test/api-drift.ts and src/lib/api/endpoints.contract.test.ts — a build-time check that every path in endpoints.ts appears in API-CONTRACT.md; run it to confirm the rebuilt backend covers the contract.

**Findings**

CHRONOLOGY OF THE LOST WINDOW (2026-08-20 backend HEAD `8125cc8` -> 2026-09-09 dashboard HEAD `dfaa738`)

The dashboard has ten commits total; SIX of them are inside the window, and they are enormous. Roughly 70,000 net lines of dashboard code were written after the backend's last push, and every one of them is an API client for a backend that no longer exists here.

2026-08-21 `36a40c3` Initial commit (dashboard repo created the day after the backend's last push — the whole console is window-era).

2026-08-22 `a8740b1` "feat creating multi-tenants dashboard" — 267 files, +44,478. The console is born multi-tenant: src/features/tenants/*, src/types/tenant.ts, and nine /v1/admin/tenants endpoints. THIS IS THE ROOT GAP. The backend has no Tenant model and no tenant module; every later feature assumes one.

2026-08-24 `a3d9f75` "fixes" — tenant bot-token and Ichancy dialogs, the concurrency limiter (src/lib/concurrency.ts, four concurrent Ichancy balance reads), and the first sketch of player credit/debit/balance.

2026-08-25 `2cd2463` "feat(auth): sign in with an Ichancy agent account, or a bot code" — POST /v1/admin/auth/ichancy. The tenant claim is declared "closed 2026-08-25" in API-CONTRACT §5. TASKS.md's baseline table is pinned to this commit: 81 test files, 1042 tests, 90.86% statements. Everything after this is the true unrecoverable delta.

2026-08-27 `737a811` "feat usdt tracking" — 148 files, +10,130. The biggest single feature landing. On the console: chain-verdict.tsx, wallet-balance.tsx, usdt-rate-panel.tsx, wallet-address.ts, method-account-card.tsx, financial-page.tsx, agent-float-pill.tsx, seed-placeholder.ts. It also created docs/TASKS.md (1,685 lines) and docs/USDT-RAILS-STATE.md (220 lines) in one go. The state doc says the backend side at that moment was 1787 tests / 114 suites passing, uncommitted, with src/core/chain/ (Tron + BSC verifiers), deposit-chain-check.service.ts, auto-credit-decision.ts, deposit-auto-credit.service.ts, a new `chain` BullMQ queue, destination-balance.service.ts, agent-float-read.service.ts, core/payments/wallet-address.ts, core/http/cors-methods.ts, and two migrations (20260826120000_exchange_rates applied, 20260826140000_chain_settlements written). ALL OF THAT IS GONE. So are six documented bug fixes whose value is mostly the investigation: BSC USDT has 18 decimals not 6 (would have credited 10^12x); TRC20 `Approval` events were being credited as payments (a forgeable ten-million-USDT event for a few cents); the whole chain-check was inert because networkFor() keyed on the seeded codes USDT_TRC20/USDT_BEP20 while the operator's real rail is coded plain `USDT`; the rate PUT was unreachable through CORS; replay via case-variant tx hashes and across tenants; unconfirmed blocks.

2026-08-28 `dfb41f7` "shamcash-fix" — declared account balance (CC-020), COMPLETE on both sides per the state doc: four nullable PaymentDestination columns, migration 20260827100000_declared_account_balance, PATCH .../declared-balance, and a static test proving the figure never enters a money path. Same commit added the first Sham Cash integration, the headless-browser session (POST/GET/DELETE /v1/admin/shamcash/session). Also the CC-021 security fix: PATCH /v1/admin/payment-destinations/:id had NO role guard — any authenticated VIEWER could re-route player deposits. That guard is still missing in the backend today; it is the single most urgent item in this report.

2026-08-30 `6ec810a` "feat fixes" — platform finance (/v1/admin/finance/balances + per-tenant refresh), the agent-float pill repointed from the 404ing /v1/admin/agent-float to /v1/admin/reconciliation/agent-float, and CC-002 resolved by moving manual credit off the never-built POST /players/:id/credit onto POST /v1/admin/deposits/manual (a MANUAL_CREDIT rail riding the existing deposit -> approve -> credit spine, so it inherits admin_approval_limits and the four-eyes rule).

2026-08-31 `f120f49` "fixes ui" — CC-016 delivered, and generalised well past the ticket: a whole Telegram destinations feature (+4,408 lines) with getChat/getChatMember proof-before-write, seven distinct refusal reasons, and — crucially — GET /v1/admin/telegram/chats, backed by a new consumer for the `my_chat_member` update that the backend was already receiving, already persisting, already deduping, and throwing away. Without that consumer a private Telegram group cannot be bound at all.

2026-09-01 `5fcbed5` "feat auto bot config" — the bot-config screen, and NOTABLY ZERO NEW ENDPOINTS. Its own header explains why: "There is no endpoint that returns the bot's menu, its main keyboard or its message bundle", so bot-surface.ts transcribes them from the API repo's core/telegram/bot-menu.constants.ts and modules/player/telegram/player.handlers.ts and presents them as a READING of the bot rather than a form. This is the one commit in the window that is self-contained and fully recoverable — and it is also the best surviving snapshot of the bot's compiled-in menu, since bot-menu.constants.ts itself does not exist in the backend either.

2026-09-01 -> 2026-09-09: EIGHT SILENT DAYS, then `dfaa738` with an empty commit message — 176 files, +21,841/-1,212. This is not one feature, it is roughly a week of work dumped in one commit, and the internal date stamps in API-CONTRACT.md let it be unpacked almost day by day:
  · 2026-09-03 — the Sham Cash browser session is DELETED (migration 20260903140000_drop_shamcash_session) and replaced by the vendor's real HTTP API: /shamcash/status|balance|test|api with a per-tenant sealed key, plus a rail SYNC that writes the wallet id onto the SHAM_CASH destinations so the account read and the account players pay into cannot diverge.
  · 2026-09-04 — players stop being Telegram accounts: telegramUserId goes nullable, PlayerSource (TELEGRAM|ICHANCY_IMPORT|ADMIN) arrives, POST /v1/admin/players registers a player from the console, PATCH /players/:id/telegram attaches an id later, POST /players/import pulls the operator's "old players" from Ichancy.
  · 2026-09-05 — the auth model is replaced. Staff become username+password rows (scrypt, per-tenant unique, hasPassword on the view, telegramUserId refused outright); POST /v1/admin/auth/credentials tries the console password then the Ichancy agent and never says which answered; POST /v1/admin/auth/bot-code and the bot's /console command are deleted outright.
  · 2026-09-07 — the headless reader returns as a flagged-OFF developer bench (/shamcash/dev/browser-check, /dev/parse).
  · 2026-09-08 — QR pairing added after observing a linked session with storageKeys: [] (the PIN screen appears AFTER the cookies are written, so the site never wrote the hash the reader needed).
  · Undated but in the same commit: the entire WITHDRAWALS domain (17 console files, ~3,400 lines — the whole money-out half of the product, which the backend has zero of), the editable BOT MENU graph (nodes/buttons/gate/settings, replacing 5fcbed5's read-only transcription), player BLOCKING, and STATISTICS (/v1/admin/stats, because GET /v1/admin/deposits is a work list and the credited deposits — most of them — appeared on no screen).

WHAT THE ROADMAP SAID AT THE STOP
docs/TASKS.md is a console backlog (baseline 2026-08-25) and uses no TODO/DONE checkboxes — its status lives in the "Blocked by" rows and in section-4 test tables whose Level column reads `backend`. Nothing in it is blocked on backend work in the sense of "waiting"; the pattern is the opposite, and it matters: CC-016/017/018/020 are all marked "Repo: backend + console", and by 2026-09-09 the console half of every one of them had shipped. Only CC-019 (validate a payout address on every crypto rail, P1) and CC-021 (guard the unprotected PATCH, P1) are pure-backend items, and USDT-RAILS-STATE.md records CC-021 as already fixed on the lost machine while CC-019 was still open. The other open backend items in that doc's "adversarial findings": Tron reports a fabricated confirmation depth so `pending` is unreachable on TRC20; the auto-credit kill switch is env-only so disabling it needs a redeploy of every worker; the auto-credit ceilings are deployment-global env values in a per-tenant, multi-currency system.

HOW MUCH IS RECOVERABLE
High. The dashboard is unusually well documented for this purpose: TASKS.md and USDT-RAILS-STATE.md quote the lost backend by FILE AND LINE NUMBER, which is how the missing-file list in the gaps above was produced rather than guessed. Fourteen backend source paths are cited in the docs and are absent from the repo (src/modules/tenant/{services/tenant.service.ts, services/tenant-operations.service.ts, services/platform-defaults.service.ts, controllers/tenant-admin.controller.ts, dtos/tenant.dto.ts, dtos/tenant.view.ts, dtos/tenant-operations.view.ts}, src/core/telegram/services/tenant-bot.registry.ts, src/core/payments/default-payment-methods.ts, src/modules/deposit/services/deposit-chain-check.service.ts, src/modules/payment-method/services/destination-balance.service.ts, two spec files, and prisma/migrations/20260826140000_chain_settlements/migration.sql), and the whole of src/core/chain/ and src/core/http/ besides.

SUGGESTED REBUILD ORDER (dependency-first, not chronological)
1. Tenant model + tenantId fan-out + the Prisma tenant-scope extension + the `tid` token claim and X-Tenant-Id override. Nothing else compiles without it.
2. AdminUser credentials (username/passwordHash required, per-tenant unique; telegramUserId nullable) + POST /v1/admin/auth/credentials; delete bot-code. The console literally cannot sign in otherwise.
3. Player schema: nullable telegramUserId, PlayerSource, blocking columns, PlayerStatus.BLOCKED — plus the register/block/unblock/attach-telegram/import routes.
4. ExchangeRate + core/chain + chain-check + chain_settlements + auto-credit. Restore the six documented bug fixes as tests FIRST, since USDT-RAILS-STATE.md warns that the original fixtures encoded the same wrong assumption as the code ("a test that agrees with the code about the world proves only that they agree").
5. Withdrawals (largest single greenfield domain; depends on 1 and 3 and on the ledger).
6. Bot menu tables + the handler-dispatch rewrite that reads them, then bot settings (miniAppUrl couples to the third repo).
7. Telegram destinations + discovered chats + the my_chat_member consumer + the report cron tenant fix.
8. Stats, platform finance, platform defaults, Sham Cash API. Sham Cash dev bench last, and only behind its flag.
Immediately, before any of that: add the missing role guard to PATCH /v1/admin/payment-destinations/:id in the backend as it stands. It is exploitable today and the one-line fix does not depend on any of the above.

TWO WARNINGS FOR THE REBUILDER
· The docs are the spec of a backend that ALSO had a working tree ahead of its own last commit. USDT-RAILS-STATE.md says plainly "Committed: Nothing since 2cd2463. Everything below is working-tree only." So the gap is not "backend HEAD vs dashboard HEAD" — it is "backend HEAD vs a backend working tree with 1787 passing tests that nobody ever committed."
· The mini-app (telegram-balance-bot, last commit 2026-08-26) sits between the two. Anything in this report touching miniAppUrl, withdrawalMode, the bot menu's `miniapp` builtin action, or the player-facing withdrawal flow has a third lost half over there; treat those four as cross-repo before implementing."

**Verification**

METHOD: I enumerated the backend exhaustively rather than spot-checking. I listed all 14 controllers and grepped every @Controller/@Get/@Post/@Patch/@Put/@Delete decorator in one pass — the backend has 47 routes total and I have the complete list, so no claimed endpoint can be hiding under a composed prefix. I also confirmed there is no setGlobalPrefix and no enableVersioning (src/main.ts:262 explicitly says each controller declares its own 'v1/...' path), so the reconstructed paths are literal. I read prisma/schema.prisma's full model/enum index (21 models, 17 enums) and read the Player, AdminUser, PlayerStatus, AdminRole and PaymentRail bodies directly.

RESULT: 33 of 34 claimed gaps CONFIRMED. Only one refutation, and it matters because it was rated blocker and described as a live security hole: PATCH /v1/admin/payment-destinations/:id IS role-guarded (SUPER_ADMIN, FINANCE_ADMIN) — every mutating route on that controller names a role. Do not schedule emergency work on CC-021; only its regression spec is missing.

The confirmations are unusually solid because the backend is not merely missing features, it is demonstrably a coherent PRE-window snapshot: working tree clean, last commit 8125cc8 dated 2026-08-20, and the code contains its own statements of the old world — activity-report.service.ts:189 'there is deliberately NO withdrawals section — withdrawals do not exist', AdminUser's 'Optional panel login … Telegram identity alone is enough for the bot', report-schedule.cron.ts:221 reading config.telegram. Zero occurrences of tenant, USDT, exchange, shamcash, stats, withdrawal-as-a-model, PLATFORM_ADMIN, or menu anywhere in src or prisma.

I corrected several cited line numbers and two claims that were understated: (a) report-schedule.cron.ts's env-reading bug is at line 221, not 230; (b) gap 14 is worse than claimed — payment-destination.service.ts has no network concept at all, not even the broken code-keyed table, so that table was itself lost work; (c) gap 27 is worse than claimed — even the compiled-in bot-menu constants file the dashboard transcribed from is gone, so the current menu must be re-derived from player.handlers.ts before it can be replaced.

Three findings materially help a rebuild and are recorded in rebuildNotes: the agent-float READ (gap 13) and most of the stats arithmetic (gap 33) already exist inside activity-report.service.ts and need extracting, not writing; the manual-credit rail (gap 23) needs no enum change because PaymentRail.INTERNAL is already there; and the discovered-chats premise (gap 25) is exactly right — my_chat_member is already subscribed, parsed and deduped, and then dropped because no processor branch consumes it.

Two prerequisites the first agent did not surface as items in their own right: enum AdminRole has no PLATFORM_ADMIN (blocks gaps 3, 19, 22, 33 outright), and the queue-name set is closed and type-checked (blocks gap 8's chain queue until both queue.constants.ts and queue.types.ts are extended).

Suggested rebuild order: gap 1 (tenant core) -> 5 (credentials) -> 30/31 (player shape) -> 29 (withdrawals) -> 10/6/7/8/9 (rates then chain) -> 24/25/27/28 (telegram + bot menu) -> 33/22 (stats, finance) -> 18 must be SKIPPED entirely, including its drop migration.

**Refuted (these already exist — do not rebuild):**

- `FEATURE Role guard on PATCH /v1/admin/payment-destinations/:id (CC-021 security fix)` — REFUTED — the route IS role-guarded in the backend as it stands today; this is NOT a live vulnerability. The decorator reads `@AdminAuth(...PAYMENT_METHOD_MANAGER_ROLES)` directly above `@Patch('payment-destinations/:id')`, and PAYMENT_METHOD_MANAGER_ROLES is Object.freeze(['SUPER_ADMIN','FINANCE_ADMIN']) at src/modules/payment-method/payment-method.constants.ts:53-56. VIEWER/SUPPORT/REVIEWER are in PAYMENT_METHOD_READER_ROLES (:59-64) and cannot pass. I checked the decorator is real enforcement, not documentation: src/common/decorators/auth.decorator.ts:34 sets AUTH_REQUIREMENT_KEY {kind:'ADMIN', roles} which RolesGuard (src/core/auth/guards/roles.guard.ts) consumes, and the AuthGuard is registered globally so an undecorated route 401s rather than opening. Every one of the six mutating routes on that controller names a role (lines 70, 79, 89, 109, 119, 129) — so the dashboard's CC-021 write-up describes a state this repo is not in (it was presumably fixed pre-window, or CC-021 was filed against a snapshot). CAVEAT for the rebuilder: what IS genuinely missing is the regression spec — `find src -name '*roles*'` returns only src/core/auth/guards/roles.guard.ts, so admin-payment-method-roles.spec.ts (the reflection test that walks every route and fails the build on a guardless mutator) does not exist and should still be written. → `src/modules/payment-method/controllers/admin-payment-method.controller.ts:119-126 (guard), src/modules/payment-method/payment-method.constants.ts:53 (role set)`

</details>

---

## 6. Things the audit says to NOT do

- **Do not rebuild `POST /v1/admin/auth/bot-code`.** It was deliberately removed on 2026-09-05
  ("a bot that hands out console credentials leaves them in a chat log"). `BOT_CODE_INVALID` /
  `BOT_CODE_EXPIRED` are retired and must not be reused. The **player**-side `/v1/auth/bot-code` stays.
- **Do not add an admin refresh token.** Admins get an access token only; the dashboard is built
  around its absence (sessionStorage, expiry countdown, central 401 → sign-out).
- **Do not emergency-fix `PATCH /v1/admin/payment-destinations/:id`.** It was flagged as an
  unguarded route but is in fact role-guarded; only its regression test is missing.

## 7. Work that already exists and only needs extracting

- The **agent-float read** and most **stats arithmetic** already live inside
  `activity-report.service.ts` — extract, do not rewrite.
- **Manual-credit rail** needs no enum change: `PaymentRail.INTERNAL` already exists.
- **Discovered chats**: `my_chat_member` is already subscribed, parsed and deduped, then dropped
  because no processor branch consumes it. Add the branch.
