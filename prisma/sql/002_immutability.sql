-- =============================================================================
-- 002 — append-only enforcement
--
-- WHY: "we never edit the ledger" is worth nothing as a code-review convention. A mistaken
-- prisma.ledgerEntry.update() during an incident, or a well-meaning data fix in a psql session, is
-- exactly how an audit trail stops being one. Corrections are posted as REVERSAL transactions.
--
-- These triggers deny UPDATE and DELETE to EVERYONE, including the table owner and superusers, which
-- is why 003 (grants) is a complement rather than a duplicate: grants stop the app role, triggers
-- stop the humans. To perform a genuine emergency fix, a DBA must explicitly
-- `ALTER TABLE ... DISABLE TRIGGER`, which is loud and shows up in the audit of the database itself.
-- =============================================================================

CREATE OR REPLACE FUNCTION forbid_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'APPEND_ONLY_VIOLATION: % on % is not allowed; post a compensating entry instead',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS ledger_entries_append_only ON ledger_entries;
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS ledger_transactions_append_only ON ledger_transactions;
CREATE TRIGGER ledger_transactions_append_only
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW
  EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs;
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION forbid_mutation();

-- TRUNCATE bypasses row-level triggers completely, so `TRUNCATE ledger_entries` would happily
-- erase the ledger despite everything above. TRUNCATE triggers are statement-level by definition.
DROP TRIGGER IF EXISTS ledger_entries_append_only_stmt ON ledger_entries;
CREATE TRIGGER ledger_entries_append_only_stmt
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT
  EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS ledger_transactions_append_only_stmt ON ledger_transactions;
CREATE TRIGGER ledger_transactions_append_only_stmt
  BEFORE TRUNCATE ON ledger_transactions
  FOR EACH STATEMENT
  EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS audit_logs_append_only_stmt ON audit_logs;
CREATE TRIGGER audit_logs_append_only_stmt
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT
  EXECUTE FUNCTION forbid_mutation();
