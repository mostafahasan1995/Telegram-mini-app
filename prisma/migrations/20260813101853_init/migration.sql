-- CreateEnum
CREATE TYPE "player_status" AS ENUM ('PENDING_ICHANCY', 'ACTIVE', 'SUSPENDED', 'SELF_EXCLUDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "admin_role" AS ENUM ('SUPER_ADMIN', 'FINANCE_ADMIN', 'REVIEWER', 'SUPPORT', 'VIEWER');

-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('PLAYER', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "payment_rail" AS ENUM ('BANK_TRANSFER', 'MOBILE_WALLET', 'CASH_OFFICE', 'CRYPTO', 'INTERNAL');

-- CreateEnum
CREATE TYPE "verification_mode" AS ENUM ('MANUAL_PROOF', 'REFERENCE_MATCH', 'AUTO_STATEMENT', 'NONE');

-- CreateEnum
CREATE TYPE "deposit_status" AS ENUM ('DRAFT', 'AWAITING_PROOF', 'SUBMITTED', 'UNDER_REVIEW', 'PENDING_SECOND_APPROVAL', 'APPROVED', 'CREDITING', 'CREDITED', 'CREDIT_FAILED', 'NEEDS_RECONCILIATION', 'REJECTED', 'EXPIRED', 'REVERSED');

-- CreateEnum
CREATE TYPE "rejection_code" AS ENUM ('DUPLICATE_PROOF', 'PROOF_UNREADABLE', 'PROOF_MISSING', 'AMOUNT_MISMATCH', 'REFERENCE_NOT_FOUND', 'WRONG_DESTINATION', 'SENDER_MISMATCH', 'SUSPECTED_FRAUD', 'LIMIT_EXCEEDED', 'PLAYER_INELIGIBLE', 'EXPIRED', 'OTHER');

-- CreateEnum
CREATE TYPE "proof_source" AS ENUM ('PLAYER_UPLOAD', 'ADMIN_UPLOAD', 'TELEGRAM_PHOTO', 'TELEGRAM_DOCUMENT', 'SYSTEM_IMPORT');

-- CreateEnum
CREATE TYPE "ledger_account_kind" AS ENUM ('RAIL_CLEARING', 'HOUSE_CASH', 'PLAYER_LIABILITY', 'ICHANCY_AGENT_FLOAT', 'CASINO_MIRROR', 'SUSPENSE_UNIDENTIFIED', 'HOUSE_ROUNDING');

-- CreateEnum
CREATE TYPE "ledger_tx_kind" AS ENUM ('DEPOSIT_CLAIM', 'DEPOSIT_CREDIT', 'DEPOSIT_REVERSAL', 'AGENT_FLOAT_TOPUP', 'AGENT_FLOAT_SYNC', 'FEE', 'ROUNDING', 'MANUAL_ADJUSTMENT', 'RECONCILIATION_WRITEOFF');

-- CreateEnum
CREATE TYPE "ichancy_operation" AS ENUM ('SIGNIN', 'REFRESH_TOKEN', 'GET_AGENT_ALL_WALLETS', 'DEPOSIT_TO_AGENT', 'WITHDRAW_FROM_AGENT', 'GET_CHILDREN', 'REGISTER_PLAYER', 'GET_PLAYERS_FOR_CURRENT_AGENT', 'DEPOSIT_TO_PLAYER', 'WITHDRAW_FROM_PLAYER', 'GET_PLAYER_BALANCE_BY_ID');

-- CreateEnum
CREATE TYPE "ichancy_outcome" AS ENUM ('OK', 'REJECTED', 'TOKEN_EXPIRED', 'AMBIGUOUS', 'TIMEOUT', 'TRANSPORT_ERROR');

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('PENDING', 'IN_FLIGHT', 'SENT', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "break_category" AS ENUM ('AGENT_FLOAT_MISMATCH', 'PLAYER_BALANCE_MISMATCH', 'MISSING_CREDIT', 'DUPLICATE_CREDIT', 'UNIDENTIFIED_RECEIPT', 'LEDGER_IMBALANCE', 'ORPHAN_ICHANCY_CALL', 'STUCK_DEPOSIT');

-- CreateEnum
CREATE TYPE "break_status" AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED', 'WRITTEN_OFF', 'FALSE_POSITIVE');

-- CreateEnum
CREATE TYPE "credit_verified_by" AS ENUM ('API_OK', 'BALANCE_DELTA', 'MANUAL');

-- CreateTable
CREATE TABLE "currencies" (
    "code" VARCHAR(3) NOT NULL,
    "name" TEXT NOT NULL,
    "scale" INTEGER NOT NULL,
    "symbol" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "rail" "payment_rail" NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "verification_mode" "verification_mode" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "min_amount_minor" BIGINT NOT NULL,
    "max_amount_minor" BIGINT NOT NULL,
    "fee_fixed_minor" BIGINT NOT NULL DEFAULT 0,
    "fee_bps" INTEGER NOT NULL DEFAULT 0,
    "requires_reference" BOOLEAN NOT NULL DEFAULT false,
    "reference_pattern" TEXT,
    "instructions" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_destinations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payment_method_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "account_identifier" TEXT NOT NULL,
    "account_holder" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "daily_cap_minor" BIGINT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_destinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "players" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "telegram_user_id" BIGINT NOT NULL,
    "telegram_username" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "language_code" TEXT,
    "phone" TEXT,
    "status" "player_status" NOT NULL DEFAULT 'PENDING_ICHANCY',
    "currency_code" VARCHAR(3) NOT NULL DEFAULT 'NSP',
    "ichancy_player_id" TEXT,
    "ichancy_login" TEXT,
    "ichancy_email" TEXT,
    "ichancy_password_enc" TEXT,
    "ichancy_registered_at" TIMESTAMPTZ(6),
    "last_seen_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "player_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "replaced_by_session_id" UUID,
    "ip" INET,
    "user_agent" TEXT,
    "telegram_auth_date" TIMESTAMPTZ(6),

    CONSTRAINT "player_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "telegram_user_id" BIGINT NOT NULL,
    "username" TEXT,
    "display_name" TEXT NOT NULL,
    "role" "admin_role" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "password_hash" TEXT,
    "totp_secret_enc" TEXT,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_approval_limits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "admin_user_id" UUID NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "max_single_approval_minor" BIGINT NOT NULL,
    "max_daily_approval_minor" BIGINT NOT NULL,
    "second_approval_above_minor" BIGINT,
    "effective_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_approval_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "short_id" TEXT NOT NULL,
    "player_id" UUID NOT NULL,
    "payment_method_id" UUID NOT NULL,
    "payment_destination_id" UUID,
    "currency_code" VARCHAR(3) NOT NULL,
    "claimed_amount_minor" BIGINT NOT NULL,
    "verified_amount_minor" BIGINT,
    "fee_minor" BIGINT NOT NULL DEFAULT 0,
    "credited_amount_minor" BIGINT,
    "status" "deposit_status" NOT NULL DEFAULT 'DRAFT',
    "external_reference" TEXT,
    "sender_account" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "submitted_at" TIMESTAMPTZ(6),
    "review_started_at" TIMESTAMPTZ(6),
    "decided_at" TIMESTAMPTZ(6),
    "second_approved_at" TIMESTAMPTZ(6),
    "credited_at" TIMESTAMPTZ(6),
    "decided_by_admin_id" UUID,
    "second_approver_admin_id" UUID,
    "rejection_code" "rejection_code",
    "rejection_note" TEXT,
    "idempotency_key" TEXT,
    "credit_key_epoch" INTEGER NOT NULL DEFAULT 0,
    "credit_attempts" INTEGER NOT NULL DEFAULT 0,
    "credit_verified_by" "credit_verified_by",
    "balance_before_minor" BIGINT,
    "balance_after_minor" BIGINT,
    "ledger_claim_tx_id" UUID,
    "ledger_credit_tx_id" UUID,
    "admin_chat_id" BIGINT,
    "admin_message_id" BIGINT,
    "admin_thread_id" BIGINT,
    "source" VARCHAR(32),
    "ip_address" INET,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "deposit_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_proofs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deposit_request_id" UUID NOT NULL,
    "source" "proof_source" NOT NULL,
    "bucket" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "telegram_file_id" TEXT,
    "uploaded_by_type" "actor_type" NOT NULL,
    "uploaded_by_id" UUID,
    "ocr_text" TEXT,
    "ocr_amount_minor" BIGINT,
    "ocr_reference" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_proofs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_transitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deposit_request_id" UUID NOT NULL,
    "from_status" "deposit_status",
    "to_status" "deposit_status" NOT NULL,
    "actor_type" "actor_type" NOT NULL,
    "actor_id" UUID,
    "reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "kind" "ledger_account_kind" NOT NULL,
    "name" TEXT NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "player_id" UUID,
    "payment_method_id" UUID,
    "is_debit_normal" BOOLEAN NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "cached_balance_minor" BIGINT NOT NULL DEFAULT 0,
    "cached_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" "ledger_tx_kind" NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "posted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "description" TEXT NOT NULL,
    "actor_type" "actor_type" NOT NULL,
    "actor_id" UUID,
    "deposit_request_id" UUID,
    "external_ref" TEXT,
    "reverses_tx_id" UUID,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ledger_transaction_id" UUID NOT NULL,
    "ledger_account_id" UUID NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "memo" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "outbox_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(6),
    "locked_by" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "dedupe_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'IN_FLIGHT',
    "response_body" JSONB,
    "result_ref" TEXT,
    "locked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_updates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "update_id" BIGINT NOT NULL,
    "kind" VARCHAR(32),
    "chat_id" BIGINT,
    "from_user_id" BIGINT,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "handler" TEXT,
    "processing_error" TEXT,

    CONSTRAINT "telegram_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ichancy_calls" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "operation" "ichancy_operation" NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "http_status" INTEGER,
    "outcome" "ichancy_outcome" NOT NULL,
    "request_body" JSONB NOT NULL,
    "response_body" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "duration_ms" INTEGER NOT NULL,
    "deposit_request_id" UUID,
    "player_id" UUID,
    "correlation_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ichancy_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_type" "actor_type" NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" INET,
    "user_agent" TEXT,
    "correlation_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_breaks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "category" "break_category" NOT NULL,
    "status" "break_status" NOT NULL DEFAULT 'OPEN',
    "severity" INTEGER NOT NULL DEFAULT 3,
    "currency_code" VARCHAR(3) NOT NULL,
    "expected_minor" BIGINT,
    "actual_minor" BIGINT,
    "delta_minor" BIGINT,
    "deposit_request_id" UUID,
    "player_id" UUID,
    "ledger_account_id" UUID,
    "ichancy_call_id" UUID,
    "detail" JSONB,
    "dedupe_key" TEXT,
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_to_admin_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by_admin_id" UUID,
    "resolution_note" TEXT,
    "resolution_tx_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reconciliation_breaks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_limits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "player_id" UUID NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "daily_deposit_cap_minor" BIGINT,
    "weekly_deposit_cap_minor" BIGINT,
    "monthly_deposit_cap_minor" BIGINT,
    "max_single_deposit_minor" BIGINT,
    "cooldown_minutes" INTEGER,
    "set_by_type" "actor_type" NOT NULL,
    "set_by_id" UUID,
    "effective_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "self_exclusions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "player_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMPTZ(6),
    "reason" TEXT,
    "requested_by_type" "actor_type" NOT NULL,
    "requested_by_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_admin_id" UUID,
    "revocation_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "self_exclusions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_code_key" ON "payment_methods"("code");

-- CreateIndex
CREATE INDEX "payment_methods_is_active_sort_order_idx" ON "payment_methods"("is_active", "sort_order");

-- CreateIndex
CREATE INDEX "payment_methods_currency_code_idx" ON "payment_methods"("currency_code");

-- CreateIndex
CREATE INDEX "payment_destinations_payment_method_id_is_active_priority_idx" ON "payment_destinations"("payment_method_id", "is_active", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "payment_destinations_payment_method_id_account_identifier_key" ON "payment_destinations"("payment_method_id", "account_identifier");

-- CreateIndex
CREATE UNIQUE INDEX "players_telegram_user_id_key" ON "players"("telegram_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "players_ichancy_player_id_key" ON "players"("ichancy_player_id");

-- CreateIndex
CREATE UNIQUE INDEX "players_ichancy_login_key" ON "players"("ichancy_login");

-- CreateIndex
CREATE UNIQUE INDEX "players_ichancy_email_key" ON "players"("ichancy_email");

-- CreateIndex
CREATE INDEX "players_status_idx" ON "players"("status");

-- CreateIndex
CREATE INDEX "players_created_at_idx" ON "players"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "player_sessions_refresh_token_hash_key" ON "player_sessions"("refresh_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "player_sessions_replaced_by_session_id_key" ON "player_sessions"("replaced_by_session_id");

-- CreateIndex
CREATE INDEX "player_sessions_player_id_expires_at_idx" ON "player_sessions"("player_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_telegram_user_id_key" ON "admin_users"("telegram_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_username_key" ON "admin_users"("username");

-- CreateIndex
CREATE INDEX "admin_users_role_is_active_idx" ON "admin_users"("role", "is_active");

-- CreateIndex
CREATE INDEX "admin_approval_limits_admin_user_id_effective_to_idx" ON "admin_approval_limits"("admin_user_id", "effective_to");

-- CreateIndex
CREATE UNIQUE INDEX "admin_approval_limits_admin_user_id_currency_code_effective_key" ON "admin_approval_limits"("admin_user_id", "currency_code", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_requests_short_id_key" ON "deposit_requests"("short_id");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_requests_idempotency_key_key" ON "deposit_requests"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_requests_ledger_claim_tx_id_key" ON "deposit_requests"("ledger_claim_tx_id");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_requests_ledger_credit_tx_id_key" ON "deposit_requests"("ledger_credit_tx_id");

-- CreateIndex
CREATE INDEX "deposit_requests_player_id_created_at_idx" ON "deposit_requests"("player_id", "created_at");

-- CreateIndex
CREATE INDEX "deposit_requests_status_created_at_idx" ON "deposit_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "deposit_requests_payment_method_id_status_idx" ON "deposit_requests"("payment_method_id", "status");

-- CreateIndex
CREATE INDEX "deposit_requests_short_id_idx" ON "deposit_requests"("short_id");

-- CreateIndex
CREATE INDEX "deposit_proofs_sha256_idx" ON "deposit_proofs"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_proofs_deposit_request_id_sha256_key" ON "deposit_proofs"("deposit_request_id", "sha256");

-- CreateIndex
CREATE INDEX "deposit_transitions_deposit_request_id_created_at_idx" ON "deposit_transitions"("deposit_request_id", "created_at");

-- CreateIndex
CREATE INDEX "deposit_transitions_to_status_created_at_idx" ON "deposit_transitions"("to_status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_code_key" ON "ledger_accounts"("code");

-- CreateIndex
CREATE INDEX "ledger_accounts_kind_currency_code_idx" ON "ledger_accounts"("kind", "currency_code");

-- CreateIndex
CREATE INDEX "ledger_accounts_player_id_kind_idx" ON "ledger_accounts"("player_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_reverses_tx_id_key" ON "ledger_transactions"("reverses_tx_id");

-- CreateIndex
CREATE INDEX "ledger_transactions_kind_posted_at_idx" ON "ledger_transactions"("kind", "posted_at");

-- CreateIndex
CREATE INDEX "ledger_transactions_deposit_request_id_idx" ON "ledger_transactions"("deposit_request_id");

-- CreateIndex
CREATE INDEX "ledger_transactions_posted_at_idx" ON "ledger_transactions"("posted_at");

-- CreateIndex
CREATE INDEX "ledger_entries_ledger_account_id_created_at_idx" ON "ledger_entries"("ledger_account_id", "created_at");

-- CreateIndex
CREATE INDEX "ledger_entries_ledger_transaction_id_idx" ON "ledger_entries"("ledger_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_ledger_transaction_id_sequence_key" ON "ledger_entries"("ledger_transaction_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_messages_dedupe_key_key" ON "outbox_messages"("dedupe_key");

-- CreateIndex
CREATE INDEX "outbox_messages_status_available_at_idx" ON "outbox_messages"("status", "available_at");

-- CreateIndex
CREATE INDEX "outbox_messages_aggregate_type_aggregate_id_idx" ON "outbox_messages"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_scope_key_key" ON "idempotency_keys"("scope", "key");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_updates_update_id_key" ON "telegram_updates"("update_id");

-- CreateIndex
CREATE INDEX "telegram_updates_received_at_idx" ON "telegram_updates"("received_at");

-- CreateIndex
CREATE INDEX "telegram_updates_processed_at_idx" ON "telegram_updates"("processed_at");

-- CreateIndex
CREATE INDEX "ichancy_calls_operation_created_at_idx" ON "ichancy_calls"("operation", "created_at");

-- CreateIndex
CREATE INDEX "ichancy_calls_deposit_request_id_created_at_idx" ON "ichancy_calls"("deposit_request_id", "created_at");

-- CreateIndex
CREATE INDEX "ichancy_calls_outcome_created_at_idx" ON "ichancy_calls"("outcome", "created_at");

-- CreateIndex
CREATE INDEX "ichancy_calls_correlation_id_idx" ON "ichancy_calls"("correlation_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_created_at_idx" ON "audit_logs"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_type_actor_id_created_at_idx" ON "audit_logs"("actor_type", "actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_breaks_dedupe_key_key" ON "reconciliation_breaks"("dedupe_key");

-- CreateIndex
CREATE INDEX "reconciliation_breaks_status_detected_at_idx" ON "reconciliation_breaks"("status", "detected_at");

-- CreateIndex
CREATE INDEX "reconciliation_breaks_category_status_idx" ON "reconciliation_breaks"("category", "status");

-- CreateIndex
CREATE INDEX "reconciliation_breaks_deposit_request_id_idx" ON "reconciliation_breaks"("deposit_request_id");

-- CreateIndex
CREATE INDEX "player_limits_player_id_effective_to_idx" ON "player_limits"("player_id", "effective_to");

-- CreateIndex
CREATE UNIQUE INDEX "player_limits_player_id_currency_code_effective_from_key" ON "player_limits"("player_id", "currency_code", "effective_from");

-- CreateIndex
CREATE INDEX "self_exclusions_player_id_starts_at_idx" ON "self_exclusions"("player_id", "starts_at");

-- CreateIndex
CREATE INDEX "self_exclusions_ends_at_idx" ON "self_exclusions"("ends_at");

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_destinations" ADD CONSTRAINT "payment_destinations_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_sessions" ADD CONSTRAINT "player_sessions_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_sessions" ADD CONSTRAINT "player_sessions_replaced_by_session_id_fkey" FOREIGN KEY ("replaced_by_session_id") REFERENCES "player_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_approval_limits" ADD CONSTRAINT "admin_approval_limits_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_approval_limits" ADD CONSTRAINT "admin_approval_limits_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_requests" ADD CONSTRAINT "deposit_requests_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_requests" ADD CONSTRAINT "deposit_requests_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_requests" ADD CONSTRAINT "deposit_requests_payment_destination_id_fkey" FOREIGN KEY ("payment_destination_id") REFERENCES "payment_destinations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_requests" ADD CONSTRAINT "deposit_requests_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_requests" ADD CONSTRAINT "deposit_requests_decided_by_admin_id_fkey" FOREIGN KEY ("decided_by_admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_requests" ADD CONSTRAINT "deposit_requests_second_approver_admin_id_fkey" FOREIGN KEY ("second_approver_admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_requests" ADD CONSTRAINT "deposit_requests_ledger_claim_tx_id_fkey" FOREIGN KEY ("ledger_claim_tx_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_requests" ADD CONSTRAINT "deposit_requests_ledger_credit_tx_id_fkey" FOREIGN KEY ("ledger_credit_tx_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_proofs" ADD CONSTRAINT "deposit_proofs_deposit_request_id_fkey" FOREIGN KEY ("deposit_request_id") REFERENCES "deposit_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_transitions" ADD CONSTRAINT "deposit_transitions_deposit_request_id_fkey" FOREIGN KEY ("deposit_request_id") REFERENCES "deposit_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_deposit_request_id_fkey" FOREIGN KEY ("deposit_request_id") REFERENCES "deposit_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_reverses_tx_id_fkey" FOREIGN KEY ("reverses_tx_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_ledger_transaction_id_fkey" FOREIGN KEY ("ledger_transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_ledger_account_id_fkey" FOREIGN KEY ("ledger_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ichancy_calls" ADD CONSTRAINT "ichancy_calls_deposit_request_id_fkey" FOREIGN KEY ("deposit_request_id") REFERENCES "deposit_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ichancy_calls" ADD CONSTRAINT "ichancy_calls_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_breaks" ADD CONSTRAINT "reconciliation_breaks_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_breaks" ADD CONSTRAINT "reconciliation_breaks_deposit_request_id_fkey" FOREIGN KEY ("deposit_request_id") REFERENCES "deposit_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_breaks" ADD CONSTRAINT "reconciliation_breaks_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_breaks" ADD CONSTRAINT "reconciliation_breaks_ledger_account_id_fkey" FOREIGN KEY ("ledger_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_breaks" ADD CONSTRAINT "reconciliation_breaks_ichancy_call_id_fkey" FOREIGN KEY ("ichancy_call_id") REFERENCES "ichancy_calls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_breaks" ADD CONSTRAINT "reconciliation_breaks_assigned_to_admin_id_fkey" FOREIGN KEY ("assigned_to_admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_breaks" ADD CONSTRAINT "reconciliation_breaks_resolved_by_admin_id_fkey" FOREIGN KEY ("resolved_by_admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_breaks" ADD CONSTRAINT "reconciliation_breaks_resolution_tx_id_fkey" FOREIGN KEY ("resolution_tx_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_limits" ADD CONSTRAINT "player_limits_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_limits" ADD CONSTRAINT "player_limits_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "self_exclusions" ADD CONSTRAINT "self_exclusions_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "self_exclusions" ADD CONSTRAINT "self_exclusions_revoked_by_admin_id_fkey" FOREIGN KEY ("revoked_by_admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
