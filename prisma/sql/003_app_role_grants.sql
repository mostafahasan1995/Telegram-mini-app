-- =============================================================================
-- 003 — least privilege for the application role
--
-- WHY: the app has no legitimate reason to ever UPDATE or DELETE a ledger row or an audit log.
-- Removing the privilege turns "a bug could rewrite history" into "a bug gets a permission error".
--
-- IMPORTANT: a table OWNER always keeps implicit privileges, and REVOKE against the owner is a
-- no-op. So the application MUST connect as a role that does NOT own the schema:
--   migrations run as the owner (e.g. `ichancy_migrator`), the app runs as `ichancy_app`.
-- DATABASE_URL in .env.example already points at the non-owner role.
--
-- The role name is configurable: run with `-v app_role=<name>` or set the GUC
-- `ichancy.app_role_name`. Default: ichancy_app.
-- =============================================================================

DO $$
DECLARE
  v_role text := COALESCE(current_setting('ichancy.app_role_name', true), 'ichancy_app');
  v_protected text[] := ARRAY['ledger_entries', 'ledger_transactions', 'audit_logs'];
  v_table text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
    RAISE NOTICE
      'Role % does not exist; skipping grants. Create it and re-run 003_app_role_grants.sql.',
      v_role;
    RETURN;
  END IF;

  -- Baseline: the app can read everything and write everywhere it is supposed to.
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', v_role);
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', v_role);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', v_role);

  -- Then take back what must never happen.
  FOREACH v_table IN ARRAY v_protected LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = v_table
    ) THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.%I FROM %I', v_table, v_role);
      EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO %I', v_table, v_role);
      RAISE NOTICE 'Locked % to SELECT/INSERT for %', v_table, v_role;
    ELSE
      RAISE NOTICE 'Table % not found; run migrations first.', v_table;
    END IF;
  END LOOP;

  -- Future tables created by the migrator inherit the same baseline.
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    v_role);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', v_role);
END;
$$;
