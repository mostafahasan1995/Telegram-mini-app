-- =============================================================================
-- 006 — tenant isolation
--
-- WHY at the database: `tenant_id` on twenty tables is a column, not a guarantee. Nothing in the
-- schema language stops a deposit in operator A pointing at a player in operator B, and nothing
-- stops a PLATFORM_ADMIN row being written inside a customer's tenant. Both are one ordinary bug
-- away — a service that builds a `where` from the wrong variable, a seed run against the wrong
-- tenant — and neither is visible afterwards. Application code cannot be the only thing standing
-- between two operators' money.
--
-- WHAT PRISMA ALREADY COVERS, so it is absent here:
--   - `tenant_id NOT NULL` and the FK to `tenants` on every scoped table.
--   - The composite unique keys (`@@unique([tenantId, …])`), so the same person can be a player at
--     two operators while being a player twice at one is impossible.
-- This file adds the two classes it CANNOT express: cross-row tenant agreement, and CHECKs.
--
-- Order: after 001-005 and after the multi-tenant migration. Idempotent, like its siblings.
-- =============================================================================

-- ---- 1. the platform_defaults singleton -------------------------------------------------
--
-- One row, id 1, forever. Without this a second row is a silent fork: two answers to "what does
-- the next operator inherit", and whichever one a query happens to read wins.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_defaults_singleton_check'
      AND conrelid = 'platform_defaults'::regclass
  ) THEN
    ALTER TABLE platform_defaults
      ADD CONSTRAINT platform_defaults_singleton_check CHECK (id = 1);
  END IF;
END;
$$;

-- ---- 2. PLATFORM_ADMIN lives only in tenant zero ----------------------------------------
--
-- THE CONSTRAINT THIS FILE EXISTS FOR. A PLATFORM_ADMIN row inside an operator is a tenant login
-- holding platform authority: it would pass every role check, and TenantOverrideInterceptor's
-- X-Tenant-Id would then be honoured for someone whose identity was resolved inside a customer's
-- tenant. The interceptor tests `isPlatformHome` for exactly this reason — but a control that
-- depends on a row never being written should also make writing it impossible.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'admin_users_platform_admin_tenant_zero_check'
      AND conrelid = 'admin_users'::regclass
  ) THEN
    ALTER TABLE admin_users
      ADD CONSTRAINT admin_users_platform_admin_tenant_zero_check
      CHECK (
        role <> 'PLATFORM_ADMIN'
        OR tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
      );
  END IF;
END;
$$;

-- ---- 3. parent keys the composite foreign keys can point at ------------------------------
--
-- `id` is already the primary key, so `(tenant_id, id)` is unique for free. Postgres still needs
-- the index to exist before it will accept a FOREIGN KEY against those two columns.
CREATE UNIQUE INDEX IF NOT EXISTS players_tenant_id_id_key
  ON players (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_methods_tenant_id_id_key
  ON payment_methods (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_destinations_tenant_id_id_key
  ON payment_destinations (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS deposit_requests_tenant_id_id_key
  ON deposit_requests (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_transactions_tenant_id_id_key
  ON ledger_transactions (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_accounts_tenant_id_id_key
  ON ledger_accounts (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_tenant_id_id_key
  ON admin_users (tenant_id, id);

-- ---- 4. cross-row tenant agreement -------------------------------------------------------
--
-- Each of these says: this child's tenant must be the SAME as its parent's. The pair is what makes
-- it impossible — not merely wrong — for operator A's deposit to reference operator B's player.
--
-- Read them as the money path: a deposit belongs to a player, a method and a destination; its
-- proofs and transitions belong to it; a ledger entry belongs to a transaction and an account. If
-- any one of those joins could cross operators, so could a balance.
DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      -- child table,             child column,              parent table,          on delete
      ('payment_destinations',    'payment_method_id',       'payment_methods',     'RESTRICT'),
      ('deposit_requests',        'player_id',               'players',             'RESTRICT'),
      ('deposit_requests',        'payment_method_id',       'payment_methods',     'RESTRICT'),
      ('deposit_requests',        'payment_destination_id',  'payment_destinations','RESTRICT'),
      ('deposit_proofs',          'deposit_request_id',      'deposit_requests',    'CASCADE'),
      ('deposit_transitions',     'deposit_request_id',      'deposit_requests',    'CASCADE'),
      ('ledger_entries',          'ledger_transaction_id',   'ledger_transactions', 'RESTRICT'),
      ('ledger_entries',          'ledger_account_id',       'ledger_accounts',     'RESTRICT'),
      ('ledger_accounts',         'player_id',               'players',             'RESTRICT'),
      ('admin_approval_limits',   'admin_user_id',           'admin_users',         'CASCADE'),
      ('player_sessions',         'player_id',               'players',             'CASCADE'),
      ('player_limits',           'player_id',               'players',             'CASCADE'),
      ('self_exclusions',         'player_id',               'players',             'RESTRICT')
    ) AS t(child_table, child_column, parent_table, on_delete)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = fk.child_table || '_' || fk.child_column || '_tenant_fkey'
        AND conrelid = fk.child_table::regclass
    ) THEN
      -- NOT VALID keeps this cheap on a large existing table: new and updated rows are checked
      -- immediately, and the VALIDATE pass below scans the backlog without holding a write lock.
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, %I) '
        || 'REFERENCES %I (tenant_id, id) ON DELETE %s NOT VALID',
        fk.child_table,
        fk.child_table || '_' || fk.child_column || '_tenant_fkey',
        fk.child_column,
        fk.parent_table,
        fk.on_delete
      );
      EXECUTE format(
        'ALTER TABLE %I VALIDATE CONSTRAINT %I',
        fk.child_table,
        fk.child_table || '_' || fk.child_column || '_tenant_fkey'
      );
    END IF;
  END LOOP;
END;
$$;

-- ---- 5. tenant zero takes no money -------------------------------------------------------
--
-- The platform is not an operator. It has no players and no deposits, and a row that says
-- otherwise means something resolved the wrong tenant — most likely a worker that never entered
-- runWithTenant() and fell back to the platform. Catching it here turns a silent mis-attribution
-- into a failed write with a name on it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'deposit_requests_not_tenant_zero_check'
      AND conrelid = 'deposit_requests'::regclass
  ) THEN
    ALTER TABLE deposit_requests
      ADD CONSTRAINT deposit_requests_not_tenant_zero_check
      CHECK (tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid);
  END IF;
END;
$$;
