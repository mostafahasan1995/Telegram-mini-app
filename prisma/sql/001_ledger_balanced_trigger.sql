-- =============================================================================
-- 001 — double-entry integrity
--
-- WHY a CONSTRAINT TRIGGER and not a CHECK: the invariant spans rows. A transaction is posted as
-- N entries, and after the first INSERT the sums are legitimately non-zero. DEFERRABLE INITIALLY
-- DEFERRED moves the verdict to COMMIT time, which is exactly the boundary our services own.
--
-- WHY per (transaction, currency): a single transaction may touch two currencies (never today, but
-- the ledger must not silently net USD against NSP if it ever does).
--
-- This is the last line of defence. Application code is expected to balance its own entries; this
-- trigger exists for the day it does not.
-- =============================================================================

CREATE OR REPLACE FUNCTION assert_ledger_transaction_balanced()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_tx_id      uuid;
  v_currency   varchar(3);
  v_sum        bigint;
  v_entry_count int;
BEGIN
  v_tx_id := COALESCE(NEW.ledger_transaction_id, OLD.ledger_transaction_id);

  -- The transaction may have been deleted wholesale in the same statement (should be impossible
  -- because 002 forbids deletes, but be explicit rather than raise a confusing error).
  IF NOT EXISTS (SELECT 1 FROM ledger_transactions t WHERE t.id = v_tx_id) THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_entry_count
  FROM ledger_entries e
  WHERE e.ledger_transaction_id = v_tx_id;

  IF v_entry_count < 2 THEN
    RAISE EXCEPTION
      'LEDGER_SINGLE_SIDED: transaction % has % entr(y|ies); a posting needs at least two sides',
      v_tx_id, v_entry_count
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT e.currency_code, sum(e.amount_minor)
    INTO v_currency, v_sum
  FROM ledger_entries e
  WHERE e.ledger_transaction_id = v_tx_id
  GROUP BY e.currency_code
  HAVING sum(e.amount_minor) <> 0
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'LEDGER_UNBALANCED: transaction % currency % sums to % minor units (must be 0)',
      v_tx_id, v_currency, v_sum
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

-- An entry's currency must match its account's currency, otherwise the grouping above could be
-- balanced per currency while the accounts themselves drift.
CREATE OR REPLACE FUNCTION assert_ledger_entry_currency_matches_account()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_account_currency varchar(3);
BEGIN
  SELECT a.currency_code INTO v_account_currency
  FROM ledger_accounts a
  WHERE a.id = NEW.ledger_account_id;

  IF v_account_currency IS DISTINCT FROM NEW.currency_code THEN
    RAISE EXCEPTION
      'LEDGER_CURRENCY_MISMATCH: entry currency % does not match account % currency %',
      NEW.currency_code, NEW.ledger_account_id, v_account_currency
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ledger_entries_balanced ON ledger_entries;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_ledger_transaction_balanced();

DROP TRIGGER IF EXISTS ledger_entries_currency_matches_account ON ledger_entries;
CREATE TRIGGER ledger_entries_currency_matches_account
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION assert_ledger_entry_currency_matches_account();
