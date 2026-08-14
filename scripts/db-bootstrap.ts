/**
 * One-time (idempotent) database bootstrap: create the restricted application role, then apply the
 * hand-written guarantees in prisma/sql/ that Prisma Migrate will never run for us.
 *
 * WHY this exists: prisma/sql/README.md documents applying those five files with `psql`. A Windows
 * dev box has no psql, and every one of those files is load-bearing — without them the ledger has
 * no balance trigger, the append-only tables are freely UPDATE-able, and the partial unique index
 * that stops a bank reference being credited twice is simply absent. A setup path that silently
 * skips them produces a cashier that looks fine and cannot be trusted with money.
 *
 * Connection roles (see prisma/sql/README.md):
 *   MIGRATE_DATABASE_URL -> schema OWNER. Runs migrations and this script.
 *   DATABASE_URL         -> restricted app role. This script CREATES it, matching that URL exactly,
 *                           so the two can never drift apart.
 * If MIGRATE_DATABASE_URL is unset we fall back to DATABASE_URL and warn loudly: a single-role
 * setup means 003's REVOKEs are a no-op (an owner keeps implicit privileges) and the ledger is then
 * protected by the 002 triggers alone.
 *
 * Safe to re-run: every statement here and every file in prisma/sql/ is idempotent.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Client } from 'pg';

const SQL_DIR = path.resolve(__dirname, '..', 'prisma', 'sql');
const SQL_FILES = [
  '001_ledger_balanced_trigger.sql',
  '002_immutability.sql',
  '003_app_role_grants.sql',
  '004_partial_indexes.sql',
  '005_four_eyes_check.sql',
] as const;

interface AppRole {
  user: string;
  password: string;
  database: string;
}

/** Pull the app role's credentials straight out of DATABASE_URL so they cannot disagree with it. */
function parseAppRole(rawUrl: string): AppRole {
  const url = new URL(rawUrl);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));

  if (user.length === 0) {
    throw new Error('DATABASE_URL has no username; cannot determine the application role to create.');
  }
  if (password.length === 0) {
    throw new Error(
      `DATABASE_URL has no password for role "${user}". The app role must authenticate with one.`,
    );
  }
  return { user, password, database };
}

function redact(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.password) url.password = '***';
  return url.toString();
}

async function main(): Promise<void> {
  if (!process.env.SKIP_DOTENV) {
    try {
      process.loadEnvFile('.env');
    } catch {
      // No .env (containers pass real env vars). Not an error.
    }
  }

  const appUrl = process.env.DATABASE_URL;
  if (!appUrl) throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');

  const ownerUrl = process.env.MIGRATE_DATABASE_URL ?? appUrl;
  const singleRole = ownerUrl === appUrl;

  const app = parseAppRole(appUrl);

  console.log(`→ owner connection : ${redact(ownerUrl)}`);
  console.log(`→ application role : ${app.user}`);
  if (singleRole) {
    console.warn(
      '\n!  MIGRATE_DATABASE_URL is not set, so the app connects as the schema owner.\n' +
        '!  A table owner keeps implicit privileges, so 003_app_role_grants.sql cannot revoke\n' +
        '!  anything. The ledger will be protected by the 002 triggers alone. Fine for local dev,\n' +
        '!  NOT acceptable in production.\n',
    );
  }

  const client = new Client({ connectionString: ownerUrl, application_name: 'ichancy-db-bootstrap' });
  await client.connect();

  try {
    // ── 1. the application role ───────────────────────────────────────────────────────────────
    // ALTER on every run keeps the password in step with .env after a rotation.
    if (!singleRole) {
      // NOTE: a DO block cannot take bind parameters — its body is a single string literal, so
      // passing $1/$2 fails with "bind message supplies 2 parameters, but prepared statement
      // requires 0". CREATE/ALTER ROLE cannot be parameterised either. Hence explicit quoting.
      const ident = quoteIdent(app.user);
      const roleLit = quoteLiteral(app.user);
      const pwLit = quoteLiteral(app.password);
      await client.query(
        `DO $do$
         BEGIN
           IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${roleLit}) THEN
             ALTER ROLE ${ident} LOGIN PASSWORD ${pwLit};
           ELSE
             CREATE ROLE ${ident} LOGIN PASSWORD ${pwLit};
           END IF;
         END
         $do$;`,
      );
      await client.query(`GRANT CONNECT ON DATABASE ${quoteIdent(app.database)} TO ${quoteIdent(app.user)}`);
      console.log(`✓ role ${app.user} ready (created or password synced)`);
    } else {
      console.log('· skipping role creation (single-role setup)');
    }

    // ── 2. the guarantees ─────────────────────────────────────────────────────────────────────
    // Order matters: 001 → 002 → 003 → 004 → 005. Each file runs in its own transaction so a
    // failure names the file that failed instead of rolling back the whole batch invisibly.
    for (const file of SQL_FILES) {
      const sql = await readFile(path.join(SQL_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        // 003 reads this GUC to learn which role to grant to; harmless for the other four.
        await client.query(`SET LOCAL ichancy.app_role_name = ${quoteLiteral(app.user)}`);
        await client.query(sql);
        await client.query('COMMIT');
        console.log(`✓ applied ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`${file} failed: ${(error as Error).message}`, { cause: error });
      }
    }

    console.log('\nDatabase bootstrap complete.');
  } finally {
    await client.end();
  }
}

/** Postgres identifier quoting — doubling embedded quotes, same rule as quote_ident(). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Postgres string-literal quoting, same rule as quote_literal(). */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
