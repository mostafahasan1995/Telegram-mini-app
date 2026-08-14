/**
 * Reset the database between integration tests.
 *
 * THE NON-OBVIOUS PART: `ledger_entries`, `ledger_transactions` and `audit_logs` refuse TRUNCATE.
 * `prisma/sql/002_immutability.sql` installs BEFORE TRUNCATE statement triggers that raise for
 * EVERYONE — owner and superuser included — because "we never rewrite the ledger" is worthless if a
 * privileged session can. So the naive `TRUNCATE ... CASCADE` that resets every other project fails
 * here with APPEND_ONLY_VIOLATION, and the fix is to do exactly what a DBA would have to do in
 * production: disable the triggers, truncate, put them back. Doing it in one transaction means a
 * failed test can never leave a database whose ledger is writable.
 *
 * `currencies` is preserved by default. Its `scale` is frozen at seed time and every `*_minor`
 * column in the database is denominated in it, so re-seeding it per test buys nothing and risks a
 * test that passes only because it happened to run second.
 *
 * RESTART IDENTITY is included for completeness; every id in this schema is a UUID, so nothing
 * actually depends on it today.
 */
import { Client } from 'pg';

/** Tables whose append-only triggers must be lifted for the duration of the TRUNCATE. */
const APPEND_ONLY_TABLES = ['ledger_entries', 'ledger_transactions', 'audit_logs'] as const;

/** Never truncated: Prisma's own bookkeeping and the frozen currency definition. */
const DEFAULT_PRESERVED = ['_prisma_migrations', 'currencies'] as const;

export interface TruncateOptions {
  /** Extra tables to leave alone, e.g. ['payment_methods'] to keep a seeded rail between tests. */
  preserve?: readonly string[];
  schema?: string;
}

export async function truncateAll(
  connectionString: string,
  options: TruncateOptions = {},
): Promise<string[]> {
  const schema = options.schema ?? 'public';
  const preserved = new Set<string>([...DEFAULT_PRESERVED, ...(options.preserve ?? [])]);

  const client = new Client({ connectionString });
  await client.connect();

  try {
    const { rows } = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1`,
      [schema],
    );

    const targets = rows
      .map((row) => row.tablename)
      .filter((table) => !preserved.has(table))
      .sort();

    if (targets.length === 0) return [];

    const quoted = targets.map((table) => `"${schema}"."${table}"`).join(', ');
    // Only the append-only tables that are actually being truncated need their triggers lifted.
    const toUnlock = APPEND_ONLY_TABLES.filter((table) => !preserved.has(table));

    await client.query('BEGIN');
    try {
      for (const table of toUnlock) {
        await client.query(`ALTER TABLE "${schema}"."${table}" DISABLE TRIGGER USER`);
      }

      await client.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);

      for (const table of toUnlock) {
        await client.query(`ALTER TABLE "${schema}"."${table}" ENABLE TRIGGER USER`);
      }
      await client.query('COMMIT');
    } catch (error: unknown) {
      // The rollback restores the triggers along with everything else — the database can never be
      // left with an unprotected ledger because a truncate failed halfway.
      await client.query('ROLLBACK');
      throw error;
    }

    return targets;
  } finally {
    await client.end();
  }
}
