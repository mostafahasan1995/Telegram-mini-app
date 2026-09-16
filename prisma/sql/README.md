# Hand-written SQL

Prisma Migrate owns the tables. These six files own the guarantees Prisma's schema language cannot
express — the ones that keep a cashier honest when application code is wrong.

They are **not** applied automatically. Prisma will never run a file it did not generate, and it will
never diff against these objects either (they live outside the schema's knowledge, so `migrate dev`
leaves them alone).

| File | What it guarantees | Why it cannot live in schema.prisma |
| --- | --- | --- |
| `001_ledger_balanced_trigger.sql` | Signed `amount_minor` per `(ledger_transaction_id, currency_code)` sums to exactly 0, every posting has ≥ 2 sides, and an entry's currency matches its account. | Cross-row invariant. Uses a `DEFERRABLE INITIALLY DEFERRED` constraint trigger so it is checked at COMMIT, not after the first INSERT. |
| `002_immutability.sql` | `ledger_entries`, `ledger_transactions`, `audit_logs` reject UPDATE, DELETE and TRUNCATE — for everyone, owner included. Corrections are posted as reversals. | Prisma has no concept of append-only tables. |
| `003_app_role_grants.sql` | The application role holds only SELECT + INSERT on those three tables, plus a sane baseline elsewhere. | Grants are outside the schema entirely. |
| `004_partial_indexes.sql` | Partial UNIQUE on `(payment_method_id, external_reference)` for non-rejected deposits; one `DEPOSIT_CLAIM` and one `DEPOSIT_CREDIT` transaction per deposit; hot-path partial indexes for the outbox relay, open deposits, active self-exclusions and unprocessed Telegram updates. | `@@unique` / `@@index` have no `WHERE`. |
| `005_four_eyes_check.sql` | `second_approver_admin_id <> decided_by_admin_id`, no second approval without a first decision, and non-negative money columns. | Prisma has no CHECK constraints. |
| `006_tenant_isolation.sql` | A `PLATFORM_ADMIN` row can exist only in tenant zero; `platform_defaults` holds exactly one row; every child row's `tenant_id` must equal its parent's (13 composite foreign keys across the money path); tenant zero takes no deposits. | Prisma has no CHECK constraints, and `@relation` cannot express a foreign key on `(tenant_id, id)`. |

## Applying them

Order matters: **001 → 002 → 003 → 004 → 005 → 006**, and only after `prisma migrate` has created
the tables. Note that 002 must come before any attempt to backfill data, 003 needs the app role to
exist already, and **006 requires the `20260911090000_multi_tenant_core` migration** — it builds
foreign keys against `tenant_id`.

### Recommended: fold them into a Prisma migration

```bash
npm run prisma:migrate -- --create-only --name post_migration_guards
# then append the files, in order, to the generated migration.sql:
cat prisma/sql/00*.sql >> prisma/migrations/<timestamp>_post_migration_guards/migration.sql
npm run prisma:migrate
```

This keeps `prisma migrate deploy` as the single deployment command — production never runs a
loose script.

### Ad hoc (local / first-time setup)

```bash
for f in prisma/sql/0*.sql; do psql "$DATABASE_URL_MIGRATOR" -v ON_ERROR_STOP=1 -f "$f"; done
```

Use the **migrator/owner** connection string here, not the app one: 003 revokes privileges from the
app role, and a role cannot meaningfully revoke from itself.

## Role split this assumes

```
ichancy_migrator  -- owns the schema, runs prisma migrate deploy and these files
ichancy_app       -- what DATABASE_URL points at; SELECT/INSERT only on the protected tables
```

A table owner keeps implicit privileges no matter what is revoked, so running the app as the owner
silently disables 003. If you only have one role locally that is fine — just know that the ledger is
then protected by the triggers in 002 alone.

## Re-running

Every file is idempotent (`CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS`, `CREATE INDEX IF NOT
EXISTS`, `pg_constraint` guards), so re-applying after a `migrate reset` is safe and expected.

## Testing them

The integration suite (`npm run test:int`, testcontainers) is where these belong: spin up
postgres:17, apply the migrations plus these files, then assert that an unbalanced posting, a ledger
UPDATE, a duplicate reference and a self-approved deposit all raise. A guarantee nobody tested is a
guarantee nobody has.

For 006 specifically, the four cases that matter — each verified by hand against postgres:17 when
the file was written, and each belonging in the suite:

| Attempt | Expected |
| --- | --- |
| `PLATFORM_ADMIN` row with a `tenant_id` other than tenant zero | `admin_users_platform_admin_tenant_zero_check` |
| A deposit in operator A referencing a player in operator B | `deposit_requests_player_id_tenant_fkey` |
| A second `platform_defaults` row | `platform_defaults_singleton_check` |
| A deposit whose `tenant_id` is tenant zero | `deposit_requests_not_tenant_zero_check` |

The positive cases matter just as much: the same `telegram_user_id` registering as a player at two
different operators must SUCCEED, and it is the one behaviour that regresses silently if somebody
"fixes" a composite unique back to a global one.
