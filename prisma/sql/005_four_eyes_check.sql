-- =============================================================================
-- 005 — four-eyes principle
--
-- WHY at the database: "a large deposit needs two different admins" is the single control that
-- stops one compromised or dishonest account from moving money out on its own. Any rule that lives
-- only in a service can be bypassed by the next endpoint someone adds. Here it cannot.
--
-- The constraint is written permissively on NULLs: a deposit below the dual-approval threshold has
-- no second approver at all, and that is legal. What is never legal is the same admin appearing in
-- both roles.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'deposit_requests_four_eyes_check'
      AND conrelid = 'deposit_requests'::regclass
  ) THEN
    ALTER TABLE deposit_requests
      ADD CONSTRAINT deposit_requests_four_eyes_check
      CHECK (
        second_approver_admin_id IS NULL
        OR decided_by_admin_id IS NULL
        OR second_approver_admin_id <> decided_by_admin_id
      );
  END IF;

  -- A second approval without a first decision is a state we should never be able to persist.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'deposit_requests_second_approval_order_check'
      AND conrelid = 'deposit_requests'::regclass
  ) THEN
    ALTER TABLE deposit_requests
      ADD CONSTRAINT deposit_requests_second_approval_order_check
      CHECK (
        second_approver_admin_id IS NULL
        OR decided_by_admin_id IS NOT NULL
      );
  END IF;

  -- Money columns are unsigned by intent; a negative claim is a bug, not a refund.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'deposit_requests_amounts_non_negative_check'
      AND conrelid = 'deposit_requests'::regclass
  ) THEN
    ALTER TABLE deposit_requests
      ADD CONSTRAINT deposit_requests_amounts_non_negative_check
      CHECK (
        claimed_amount_minor > 0
        AND (verified_amount_minor IS NULL OR verified_amount_minor >= 0)
        AND (credited_amount_minor IS NULL OR credited_amount_minor >= 0)
        AND fee_minor >= 0
      );
  END IF;
END;
$$;
