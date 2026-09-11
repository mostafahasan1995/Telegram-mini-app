-- =============================================================================
-- MULTI-TENANT CORE
--
-- Introduces the Tenant root and scopes all 20 operational tables to it.
--
-- WHY THIS IS NOT PRISMA'S RAW DIFF: the generated script adds
-- `tenant_id UUID NOT NULL` directly, which succeeds only on an EMPTY database. On a
-- deployment that already holds players, deposits and a ledger it aborts on the first table.
-- So the column lands NULLABLE, every existing row is backfilled onto the bootstrap operator,
-- and NOT NULL is asserted afterwards — at which point it is a cheap validation rather than an
-- impossible one.
--
-- THE TWO SEEDED TENANTS ARE NOT INTERCHANGEABLE:
--   00000000-0000-0000-0000-000000000000  tenant zero — the PLATFORM. Holds PLATFORM_ADMIN logins
--     and nothing operational. prisma/sql/006 refuses to let a PLATFORM_ADMIN row live
--     anywhere else.
--   00000000-0000-0000-0000-000000000001  the bootstrap operator. Every row that existed
--     before multi-tenancy is backfilled here, because those rows belonged to the deployment
--     that was actually taking deposits. Putting them in tenant zero would give every existing
--     player a platform login's tenant.
--
-- ⚠ AFTER APPLYING THIS, AN OPERATOR MUST REPLACE THE PLACEHOLDER SECRETS on the bootstrap
--   tenant row: bot_token_enc, ichancy_password_enc and ichancy_agent_id are written as
--   'REPLACE-ME…' sentinels because a migration cannot read the deployment's environment.
--   See docs/RUNBOOK.md. The row lands SUSPENDED so it cannot serve until that is done.
-- =============================================================================

-- ---- 1. enums ---------------------------------------------------------------------------
--
-- ALTER TYPE ... ADD VALUE is permitted inside a transaction on PostgreSQL 12+, and the new
-- value is deliberately NOT used anywhere below: it cannot be referenced until this
-- transaction commits. The platform admin row is created by the seed, not here.
-- CreateEnum
CREATE TYPE "tenant_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "deposit_mode" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "withdrawal_mode" AS ENUM ('AUTO', 'MANUAL');

-- AlterEnum
ALTER TYPE "admin_role" ADD VALUE 'PLATFORM_ADMIN';

-- ---- 2. the tenant tables --------------------------------------------------------------
-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "tenant_status" NOT NULL DEFAULT 'SUSPENDED',
    "bot_token_enc" TEXT NOT NULL,
    "bot_username" TEXT,
    "webhook_path_token" TEXT,
    "webhook_secret_enc" TEXT,
    "admin_chat_id" BIGINT NOT NULL,
    "feed_chat_id" BIGINT,
    "ichancy_base_url" TEXT NOT NULL,
    "ichancy_username" TEXT NOT NULL,
    "ichancy_password_enc" TEXT NOT NULL,
    "ichancy_agent_id" TEXT NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "dual_approval_threshold_minor" BIGINT NOT NULL,
    "agent_float_low_watermark_minor" BIGINT NOT NULL,
    "deposit_expiry_minutes" INTEGER NOT NULL,
    "deposit_mode" "deposit_mode" NOT NULL DEFAULT 'MANUAL',
    "withdrawal_mode" "withdrawal_mode" NOT NULL DEFAULT 'MANUAL',
    "mini_app_url" TEXT,
    "shamcash_wallet_id" TEXT,
    "shamcash_api_key_enc" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_defaults" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "ichancy_base_url" TEXT NOT NULL,
    "ichancy_agent_id" TEXT,
    "currency_code" VARCHAR(3) NOT NULL,
    "dual_approval_threshold_minor" BIGINT NOT NULL,
    "agent_float_low_watermark_minor" BIGINT NOT NULL,
    "deposit_expiry_minutes" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "platform_defaults_pkey" PRIMARY KEY ("id")
);

-- ---- 3. bootstrap rows -----------------------------------------------------------------
--
-- The currency has to exist before a tenant can reference it, and on a FRESH database the
-- seed has not run yet. This insert is idempotent and matches prisma/seed/currency.seed.ts —
-- including scale 2, which is frozen the moment the first money row exists.
INSERT INTO "currencies" ("code", "name", "scale", "symbol", "is_active", "created_at", "updated_at")
VALUES ('NSP', 'New Syrian Pound', 2, 'NSP', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- Tenant zero. Its Ichancy and bot fields are inert: the platform does not take deposits, and
-- these columns are NOT NULL because an OPERATOR always has them.
INSERT INTO "tenants" (
  "id", "slug", "display_name", "status",
  "bot_token_enc", "admin_chat_id",
  "ichancy_base_url", "ichancy_username", "ichancy_password_enc", "ichancy_agent_id",
  "currency_code", "dual_approval_threshold_minor", "agent_float_low_watermark_minor",
  "deposit_expiry_minutes", "updated_at"
) VALUES (
  '00000000-0000-0000-0000-000000000000', 'platform', 'Platform', 'ACTIVE',
  'UNUSED-PLATFORM-TENANT', 0,
  'https://example.invalid', 'unused', 'UNUSED-PLATFORM-TENANT', 'unused',
  'NSP', 0, 0,
  30, CURRENT_TIMESTAMP
) ON CONFLICT ("id") DO NOTHING;

-- The bootstrap operator. SUSPENDED on purpose: the placeholders below are not credentials,
-- and an operator that could serve with them would fail against Telegram and Ichancy on its
-- first real request instead of at the moment somebody looks at it.
INSERT INTO "tenants" (
  "id", "slug", "display_name", "status",
  "bot_token_enc", "admin_chat_id",
  "ichancy_base_url", "ichancy_username", "ichancy_password_enc", "ichancy_agent_id",
  "currency_code", "dual_approval_threshold_minor", "agent_float_low_watermark_minor",
  "deposit_expiry_minutes", "updated_at"
) VALUES (
  '00000000-0000-0000-0000-000000000001', 'default', 'Default Operator', 'SUSPENDED',
  'REPLACE-ME-BOT-TOKEN', 0,
  'https://agents.ichancy.com', 'REPLACE-ME', 'REPLACE-ME-ICHANCY-PASSWORD', 'REPLACE-ME',
  'NSP', 0, 0,
  30, CURRENT_TIMESTAMP
) ON CONFLICT ("id") DO NOTHING;

-- The singleton every NEW operator inherits from. id is pinned to 1 by prisma/sql/006.
INSERT INTO "platform_defaults" (
  "id", "ichancy_base_url", "ichancy_agent_id", "currency_code",
  "dual_approval_threshold_minor", "agent_float_low_watermark_minor",
  "deposit_expiry_minutes", "updated_at"
) VALUES (
  1, 'https://agents.ichancy.com', NULL, 'NSP',
  0, 0,
  30, CURRENT_TIMESTAMP
) ON CONFLICT ("id") DO NOTHING;

-- ---- 4. tenant_id, nullable for now ----------------------------------------------------
ALTER TABLE "admin_approval_limits" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "admin_users" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "audit_logs" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "deposit_proofs" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "deposit_requests" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "deposit_transitions" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "ichancy_calls" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "idempotency_keys" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "ledger_accounts" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "ledger_entries" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "ledger_transactions" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "outbox_messages" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "payment_destinations" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "payment_methods" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "player_limits" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "player_sessions" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "players" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "reconciliation_breaks" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "self_exclusions" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "telegram_updates" ADD COLUMN "tenant_id" UUID;

-- ---- 5. backfill -----------------------------------------------------------------------
--
-- Everything that predates multi-tenancy belongs to the operator that was serving, NOT to the
-- platform. On a fresh database every one of these updates touches zero rows.
UPDATE "admin_approval_limits" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "admin_users" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "audit_logs" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "deposit_proofs" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "deposit_requests" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "deposit_transitions" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "ichancy_calls" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "idempotency_keys" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "ledger_accounts" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "ledger_entries" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "ledger_transactions" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "outbox_messages" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "payment_destinations" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "payment_methods" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "player_limits" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "player_sessions" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "players" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "reconciliation_breaks" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "self_exclusions" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "telegram_updates" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;

-- ---- 6. now it can be enforced ---------------------------------------------------------
ALTER TABLE "admin_approval_limits" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "admin_users" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "audit_logs" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "deposit_proofs" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "deposit_requests" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "deposit_transitions" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "ichancy_calls" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "idempotency_keys" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "ledger_accounts" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "ledger_entries" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "ledger_transactions" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "outbox_messages" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "payment_destinations" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "payment_methods" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "player_limits" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "player_sessions" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "players" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "reconciliation_breaks" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "self_exclusions" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "telegram_updates" ALTER COLUMN "tenant_id" SET NOT NULL;

-- ---- 7. retire the global unique keys and single-tenant indexes ------------------------
--
-- Each of these is replaced by a tenant-leading equivalent in step 8. A global UNIQUE on
-- telegram_user_id would stop the same person being a player at two operators, which is a
-- product decision the schema has no business making.
DROP INDEX "admin_approval_limits_admin_user_id_effective_to_idx";
DROP INDEX "admin_users_role_is_active_idx";
DROP INDEX "admin_users_telegram_user_id_key";
DROP INDEX "admin_users_username_key";
DROP INDEX "audit_logs_action_created_at_idx";
DROP INDEX "audit_logs_actor_type_actor_id_created_at_idx";
DROP INDEX "audit_logs_entity_type_entity_id_created_at_idx";
DROP INDEX "deposit_proofs_sha256_idx";
DROP INDEX "deposit_requests_idempotency_key_key";
DROP INDEX "deposit_requests_payment_method_id_status_idx";
DROP INDEX "deposit_requests_player_id_created_at_idx";
DROP INDEX "deposit_requests_short_id_idx";
DROP INDEX "deposit_requests_short_id_key";
DROP INDEX "deposit_requests_status_created_at_idx";
DROP INDEX "deposit_transitions_deposit_request_id_created_at_idx";
DROP INDEX "deposit_transitions_to_status_created_at_idx";
DROP INDEX "ichancy_calls_correlation_id_idx";
DROP INDEX "ichancy_calls_deposit_request_id_created_at_idx";
DROP INDEX "ichancy_calls_operation_created_at_idx";
DROP INDEX "ichancy_calls_outcome_created_at_idx";
DROP INDEX "idempotency_keys_expires_at_idx";
DROP INDEX "idempotency_keys_scope_key_key";
DROP INDEX "ledger_accounts_code_key";
DROP INDEX "ledger_accounts_kind_currency_code_idx";
DROP INDEX "ledger_accounts_player_id_kind_idx";
DROP INDEX "ledger_entries_ledger_account_id_created_at_idx";
DROP INDEX "ledger_entries_ledger_transaction_id_idx";
DROP INDEX "ledger_transactions_deposit_request_id_idx";
DROP INDEX "ledger_transactions_kind_posted_at_idx";
DROP INDEX "ledger_transactions_posted_at_idx";
DROP INDEX "outbox_messages_aggregate_type_aggregate_id_idx";
DROP INDEX "outbox_messages_dedupe_key_key";
DROP INDEX "outbox_messages_status_available_at_idx";
DROP INDEX "payment_destinations_payment_method_id_is_active_priority_idx";
DROP INDEX "payment_methods_code_key";
DROP INDEX "payment_methods_currency_code_idx";
DROP INDEX "payment_methods_is_active_sort_order_idx";
DROP INDEX "player_limits_player_id_effective_to_idx";
DROP INDEX "player_sessions_player_id_expires_at_idx";
DROP INDEX "players_created_at_idx";
DROP INDEX "players_ichancy_email_key";
DROP INDEX "players_ichancy_login_key";
DROP INDEX "players_ichancy_player_id_key";
DROP INDEX "players_status_ichancy_link_next_attempt_at_idx";
DROP INDEX "players_status_idx";
DROP INDEX "players_telegram_user_id_key";
DROP INDEX "reconciliation_breaks_category_status_idx";
DROP INDEX "reconciliation_breaks_dedupe_key_key";
DROP INDEX "reconciliation_breaks_deposit_request_id_idx";
DROP INDEX "reconciliation_breaks_status_detected_at_idx";
DROP INDEX "self_exclusions_ends_at_idx";
DROP INDEX "self_exclusions_player_id_starts_at_idx";
DROP INDEX "telegram_updates_processed_at_idx";
DROP INDEX "telegram_updates_received_at_idx";
DROP INDEX "telegram_updates_update_id_key";

-- ---- 8. tenant-leading indexes and composite unique keys -------------------------------
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");
CREATE UNIQUE INDEX "tenants_webhook_path_token_key" ON "tenants"("webhook_path_token");
CREATE INDEX "tenants_status_idx" ON "tenants"("status");
CREATE INDEX "admin_approval_limits_tenant_id_admin_user_id_effective_to_idx" ON "admin_approval_limits"("tenant_id", "admin_user_id", "effective_to");
CREATE INDEX "admin_approval_limits_tenant_id_idx" ON "admin_approval_limits"("tenant_id");
CREATE INDEX "admin_users_tenant_id_role_is_active_idx" ON "admin_users"("tenant_id", "role", "is_active");
CREATE INDEX "admin_users_tenant_id_idx" ON "admin_users"("tenant_id");
CREATE UNIQUE INDEX "admin_users_tenant_id_telegram_user_id_key" ON "admin_users"("tenant_id", "telegram_user_id");
CREATE UNIQUE INDEX "admin_users_tenant_id_username_key" ON "admin_users"("tenant_id", "username");
CREATE INDEX "audit_logs_tenant_id_entity_type_entity_id_created_at_idx" ON "audit_logs"("tenant_id", "entity_type", "entity_id", "created_at");
CREATE INDEX "audit_logs_tenant_id_actor_type_actor_id_created_at_idx" ON "audit_logs"("tenant_id", "actor_type", "actor_id", "created_at");
CREATE INDEX "audit_logs_tenant_id_action_created_at_idx" ON "audit_logs"("tenant_id", "action", "created_at");
CREATE INDEX "audit_logs_tenant_id_idx" ON "audit_logs"("tenant_id");
CREATE INDEX "deposit_proofs_tenant_id_sha256_idx" ON "deposit_proofs"("tenant_id", "sha256");
CREATE INDEX "deposit_proofs_tenant_id_idx" ON "deposit_proofs"("tenant_id");
CREATE INDEX "deposit_requests_tenant_id_player_id_created_at_idx" ON "deposit_requests"("tenant_id", "player_id", "created_at");
CREATE INDEX "deposit_requests_tenant_id_status_created_at_idx" ON "deposit_requests"("tenant_id", "status", "created_at");
CREATE INDEX "deposit_requests_tenant_id_payment_method_id_status_idx" ON "deposit_requests"("tenant_id", "payment_method_id", "status");
CREATE INDEX "deposit_requests_tenant_id_idx" ON "deposit_requests"("tenant_id");
CREATE UNIQUE INDEX "deposit_requests_tenant_id_short_id_key" ON "deposit_requests"("tenant_id", "short_id");
CREATE UNIQUE INDEX "deposit_requests_tenant_id_idempotency_key_key" ON "deposit_requests"("tenant_id", "idempotency_key");
CREATE INDEX "deposit_transitions_tenant_id_deposit_request_id_created_at_idx" ON "deposit_transitions"("tenant_id", "deposit_request_id", "created_at");
CREATE INDEX "deposit_transitions_tenant_id_to_status_created_at_idx" ON "deposit_transitions"("tenant_id", "to_status", "created_at");
CREATE INDEX "deposit_transitions_tenant_id_idx" ON "deposit_transitions"("tenant_id");
CREATE INDEX "ichancy_calls_tenant_id_operation_created_at_idx" ON "ichancy_calls"("tenant_id", "operation", "created_at");
CREATE INDEX "ichancy_calls_tenant_id_deposit_request_id_created_at_idx" ON "ichancy_calls"("tenant_id", "deposit_request_id", "created_at");
CREATE INDEX "ichancy_calls_tenant_id_outcome_created_at_idx" ON "ichancy_calls"("tenant_id", "outcome", "created_at");
CREATE INDEX "ichancy_calls_tenant_id_correlation_id_idx" ON "ichancy_calls"("tenant_id", "correlation_id");
CREATE INDEX "ichancy_calls_tenant_id_idx" ON "ichancy_calls"("tenant_id");
CREATE INDEX "idempotency_keys_tenant_id_expires_at_idx" ON "idempotency_keys"("tenant_id", "expires_at");
CREATE INDEX "idempotency_keys_tenant_id_idx" ON "idempotency_keys"("tenant_id");
CREATE UNIQUE INDEX "idempotency_keys_tenant_id_scope_key_key" ON "idempotency_keys"("tenant_id", "scope", "key");
CREATE INDEX "ledger_accounts_tenant_id_kind_currency_code_idx" ON "ledger_accounts"("tenant_id", "kind", "currency_code");
CREATE INDEX "ledger_accounts_tenant_id_player_id_kind_idx" ON "ledger_accounts"("tenant_id", "player_id", "kind");
CREATE INDEX "ledger_accounts_tenant_id_idx" ON "ledger_accounts"("tenant_id");
CREATE UNIQUE INDEX "ledger_accounts_tenant_id_code_key" ON "ledger_accounts"("tenant_id", "code");
CREATE INDEX "ledger_entries_tenant_id_ledger_account_id_created_at_idx" ON "ledger_entries"("tenant_id", "ledger_account_id", "created_at");
CREATE INDEX "ledger_entries_tenant_id_ledger_transaction_id_idx" ON "ledger_entries"("tenant_id", "ledger_transaction_id");
CREATE INDEX "ledger_entries_tenant_id_idx" ON "ledger_entries"("tenant_id");
CREATE INDEX "ledger_transactions_tenant_id_kind_posted_at_idx" ON "ledger_transactions"("tenant_id", "kind", "posted_at");
CREATE INDEX "ledger_transactions_tenant_id_deposit_request_id_idx" ON "ledger_transactions"("tenant_id", "deposit_request_id");
CREATE INDEX "ledger_transactions_tenant_id_posted_at_idx" ON "ledger_transactions"("tenant_id", "posted_at");
CREATE INDEX "ledger_transactions_tenant_id_idx" ON "ledger_transactions"("tenant_id");
CREATE INDEX "outbox_messages_tenant_id_status_available_at_idx" ON "outbox_messages"("tenant_id", "status", "available_at");
CREATE INDEX "outbox_messages_tenant_id_aggregate_type_aggregate_id_idx" ON "outbox_messages"("tenant_id", "aggregate_type", "aggregate_id");
CREATE INDEX "outbox_messages_tenant_id_idx" ON "outbox_messages"("tenant_id");
CREATE UNIQUE INDEX "outbox_messages_tenant_id_dedupe_key_key" ON "outbox_messages"("tenant_id", "dedupe_key");
CREATE INDEX "payment_destinations_tenant_id_payment_method_id_is_active__idx" ON "payment_destinations"("tenant_id", "payment_method_id", "is_active", "priority");
CREATE INDEX "payment_destinations_tenant_id_idx" ON "payment_destinations"("tenant_id");
CREATE INDEX "payment_methods_tenant_id_is_active_sort_order_idx" ON "payment_methods"("tenant_id", "is_active", "sort_order");
CREATE INDEX "payment_methods_tenant_id_currency_code_idx" ON "payment_methods"("tenant_id", "currency_code");
CREATE INDEX "payment_methods_tenant_id_idx" ON "payment_methods"("tenant_id");
CREATE UNIQUE INDEX "payment_methods_tenant_id_code_key" ON "payment_methods"("tenant_id", "code");
CREATE INDEX "player_limits_tenant_id_player_id_effective_to_idx" ON "player_limits"("tenant_id", "player_id", "effective_to");
CREATE INDEX "player_limits_tenant_id_idx" ON "player_limits"("tenant_id");
CREATE INDEX "player_sessions_tenant_id_player_id_expires_at_idx" ON "player_sessions"("tenant_id", "player_id", "expires_at");
CREATE INDEX "player_sessions_tenant_id_idx" ON "player_sessions"("tenant_id");
CREATE INDEX "players_tenant_id_status_idx" ON "players"("tenant_id", "status");
CREATE INDEX "players_tenant_id_created_at_idx" ON "players"("tenant_id", "created_at");
CREATE INDEX "players_tenant_id_status_ichancy_link_next_attempt_at_idx" ON "players"("tenant_id", "status", "ichancy_link_next_attempt_at");
CREATE INDEX "players_tenant_id_idx" ON "players"("tenant_id");
CREATE UNIQUE INDEX "players_tenant_id_telegram_user_id_key" ON "players"("tenant_id", "telegram_user_id");
CREATE UNIQUE INDEX "players_tenant_id_ichancy_player_id_key" ON "players"("tenant_id", "ichancy_player_id");
CREATE UNIQUE INDEX "players_tenant_id_ichancy_login_key" ON "players"("tenant_id", "ichancy_login");
CREATE UNIQUE INDEX "players_tenant_id_ichancy_email_key" ON "players"("tenant_id", "ichancy_email");
CREATE INDEX "reconciliation_breaks_tenant_id_status_detected_at_idx" ON "reconciliation_breaks"("tenant_id", "status", "detected_at");
CREATE INDEX "reconciliation_breaks_tenant_id_category_status_idx" ON "reconciliation_breaks"("tenant_id", "category", "status");
CREATE INDEX "reconciliation_breaks_tenant_id_deposit_request_id_idx" ON "reconciliation_breaks"("tenant_id", "deposit_request_id");
CREATE INDEX "reconciliation_breaks_tenant_id_idx" ON "reconciliation_breaks"("tenant_id");
CREATE UNIQUE INDEX "reconciliation_breaks_tenant_id_dedupe_key_key" ON "reconciliation_breaks"("tenant_id", "dedupe_key");
CREATE INDEX "self_exclusions_tenant_id_player_id_starts_at_idx" ON "self_exclusions"("tenant_id", "player_id", "starts_at");
CREATE INDEX "self_exclusions_tenant_id_ends_at_idx" ON "self_exclusions"("tenant_id", "ends_at");
CREATE INDEX "self_exclusions_tenant_id_idx" ON "self_exclusions"("tenant_id");
CREATE INDEX "telegram_updates_tenant_id_received_at_idx" ON "telegram_updates"("tenant_id", "received_at");
CREATE INDEX "telegram_updates_tenant_id_processed_at_idx" ON "telegram_updates"("tenant_id", "processed_at");
CREATE INDEX "telegram_updates_tenant_id_idx" ON "telegram_updates"("tenant_id");
CREATE UNIQUE INDEX "telegram_updates_tenant_id_update_id_key" ON "telegram_updates"("tenant_id", "update_id");

-- ---- 9. foreign keys -------------------------------------------------------------------
--
-- ON DELETE CASCADE from tenants: closing an operator is a status change, never a delete, so
-- this fires only when somebody deliberately removes a tenant row in development.
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_destinations" ADD CONSTRAINT "payment_destinations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "players" ADD CONSTRAINT "players_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "player_sessions" ADD CONSTRAINT "player_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_approval_limits" ADD CONSTRAINT "admin_approval_limits_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deposit_requests" ADD CONSTRAINT "deposit_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deposit_proofs" ADD CONSTRAINT "deposit_proofs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deposit_transitions" ADD CONSTRAINT "deposit_transitions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telegram_updates" ADD CONSTRAINT "telegram_updates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ichancy_calls" ADD CONSTRAINT "ichancy_calls_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reconciliation_breaks" ADD CONSTRAINT "reconciliation_breaks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "player_limits" ADD CONSTRAINT "player_limits_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "self_exclusions" ADD CONSTRAINT "self_exclusions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
