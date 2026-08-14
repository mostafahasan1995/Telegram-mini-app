-- =============================================================================
-- 004 — partial indexes Prisma cannot express
--
-- Prisma's @@unique/@@index have no WHERE clause, but every constraint below is only meaningful on
-- a subset of rows. Writing them by hand here keeps the schema honest instead of pushing these
-- rules into application code where a race can slip past them.
-- =============================================================================

-- 1. The same bank/wallet reference must not be claimed twice on the same rail.
--    Scoped to non-REJECTED rows so a player whose typo was rejected can retype the real reference.
--    This is a UNIQUE INDEX, i.e. it survives concurrent submissions; the app-level check is only
--    there to produce a nicer error message.
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_external_reference_active
  ON deposit_requests (payment_method_id, external_reference)
  WHERE external_reference IS NOT NULL
    AND status <> 'REJECTED'::deposit_status;

-- 2. The outbox relay polls only PENDING rows that are due. A partial index keeps that scan O(due)
--    instead of O(history) once the table has millions of SENT rows.
CREATE INDEX IF NOT EXISTS ix_outbox_pending_due
  ON outbox_messages (available_at, id)
  WHERE status = 'PENDING'::outbox_status;

-- 3. Open deposits: the expiry cron and the "does this player already have one in flight?" check
--    both look only at non-terminal rows.
CREATE INDEX IF NOT EXISTS ix_deposit_requests_open
  ON deposit_requests (expires_at, id)
  WHERE status IN (
    'DRAFT'::deposit_status,
    'AWAITING_PROOF'::deposit_status,
    'SUBMITTED'::deposit_status,
    'UNDER_REVIEW'::deposit_status,
    'PENDING_SECOND_APPROVAL'::deposit_status,
    'APPROVED'::deposit_status,
    'CREDITING'::deposit_status
  );

CREATE INDEX IF NOT EXISTS ix_deposit_requests_player_open
  ON deposit_requests (player_id, created_at DESC)
  WHERE status IN (
    'DRAFT'::deposit_status,
    'AWAITING_PROOF'::deposit_status,
    'SUBMITTED'::deposit_status,
    'UNDER_REVIEW'::deposit_status,
    'PENDING_SECOND_APPROVAL'::deposit_status,
    'APPROVED'::deposit_status,
    'CREDITING'::deposit_status
  );

-- 4. At most ONE credit posting per deposit, ever. Since the Ichancy API has no idempotency key,
--    a duplicated worker run is a realistic failure mode; this makes the second T2 posting fail at
--    the database instead of double-crediting a player.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_credit_tx_per_deposit
  ON ledger_transactions (deposit_request_id)
  WHERE deposit_request_id IS NOT NULL
    AND kind = 'DEPOSIT_CREDIT'::ledger_tx_kind;

-- 5. Same idea for the claim posting (T1).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_claim_tx_per_deposit
  ON ledger_transactions (deposit_request_id)
  WHERE deposit_request_id IS NOT NULL
    AND kind = 'DEPOSIT_CLAIM'::ledger_tx_kind;

-- 6. Exactly one active self-exclusion per player (open-ended or not yet revoked).
CREATE UNIQUE INDEX IF NOT EXISTS uq_self_exclusion_active_per_player
  ON self_exclusions (player_id)
  WHERE revoked_at IS NULL;

-- 7. Unprocessed Telegram updates, for the retry sweeper.
CREATE INDEX IF NOT EXISTS ix_telegram_updates_unprocessed
  ON telegram_updates (received_at)
  WHERE processed_at IS NULL;
