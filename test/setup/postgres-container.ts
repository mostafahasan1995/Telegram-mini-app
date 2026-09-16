/**
 * A real PostgreSQL 17 for the integration suite — schema pushed AND `prisma/sql/001..006` applied.
 *
 * WHY the hand-written SQL is applied here and not left to a developer's memory: those six files
 * are where the cashier's actual guarantees live (the ledger balances at COMMIT, the ledger is
 * append-only, one credit per deposit, four eyes really means two people, and one operator cannot
 * reach into another's rows). Prisma will never run
 * them and `prisma db push` does not know they exist, so a test database without them looks
 * identical and silently asserts nothing. That is not hypothetical: the shared dev container this
 * project was built against has all 21 tables and zero of these triggers.
 *
 * WHY a module-level singleton rather than a container per test: starting Postgres costs
 * seconds and truncating costs milliseconds, so `truncateAll()` between tests is what keeps
 * tests isolated.
 *
 * WHAT IT SPANS — ONE CONTAINER PER SUITE, NOT PER WORKER: Jest gives every test FILE a fresh
 * module registry, so each file that calls `startPostgres()` gets its own `handle`, and its own
 * container, even at `maxWorkers: 1`. Workers never share state either way. So a suite that
 * never calls `stopPostgres()` leaves its container running until the process exits, and the
 * integration job pays for one container per suite — which is why that job's timeout is set the
 * way it is (.github/workflows/ci.yml).
 *
 * The `ichancy_app` role is created before 003 runs so the least-privilege grants are actually
 * exercised. Tests connect as the OWNER by default (they need to truncate); `appUrl` is there for
 * the tests that want to prove the app role cannot rewrite the ledger.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

export interface PostgresHandle {
  /** Owner connection string — what the tests and `truncateAll` use. */
  url: string;
  /** Restricted application role, as production runs it (SELECT+INSERT on the ledger). */
  appUrl: string;
  /** null when POSTGRES_TEST_URL pointed us at a database somebody else is managing. */
  container: StartedPostgreSqlContainer | null;
  stop: () => Promise<void>;
}

const APP_ROLE = 'ichancy_app';
const APP_PASSWORD = 'ichancy_app';

/**
 * Applied in this order — 003 needs the tables, 004/005 need them too, and 006 needs `tenant_id`
 * to exist before it can build foreign keys against it.
 *
 * 006 matters here for the same reason the other five do: without it a test database looks
 * identical and silently asserts nothing. A cross-tenant deposit would insert happily, and an
 * integration test written to prove isolation would pass while proving the opposite.
 */
const SQL_FILES = [
  '001_ledger_balanced_trigger.sql',
  '002_immutability.sql',
  '003_app_role_grants.sql',
  '004_partial_indexes.sql',
  '005_four_eyes_check.sql',
  '006_tenant_isolation.sql',
] as const;

const PROJECT_ROOT = join(__dirname, '..', '..');

/** Module-level, therefore one per Jest worker process. */
let handle: PostgresHandle | null = null;
let starting: Promise<PostgresHandle> | null = null;

function buildUrl(container: StartedPostgreSqlContainer, user: string, password: string): string {
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  return `postgresql://${user}:${password}@${host}:${port}/${container.getDatabase()}?schema=public`;
}

function pushSchema(url: string): void {
  // `db push` rather than `migrate deploy`: this project keeps its DDL in schema.prisma plus the
  // hand-written files in prisma/sql, and has no generated migration history to replay.
  //
  // Prisma 7 notes, both learned the hard way:
  //  - `--skip-generate` no longer exists on `db push`; passing it is a hard usage error.
  //  - the datasource URL comes from prisma.config.ts, NOT from DATABASE_URL, so `--url` is the
  //    only reliable way to point this at the container. SKIP_DOTENV additionally stops
  //    prisma.config.ts from loading a developer's .env over the top.
  execFileSync('npx', ['prisma', 'db', 'push', '--url', url, '--accept-data-loss'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL: url, MIGRATE_DATABASE_URL: url, SKIP_DOTENV: '1' },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
}

async function applyGuards(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // 003 skips with a NOTICE when the role is missing, which would quietly leave the grants
    // untested. Creating it first is what makes that file mean something here.
    await client.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
           CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}';
         END IF;
       END $$;`,
    );

    for (const file of SQL_FILES) {
      const sql = readFileSync(join(PROJECT_ROOT, 'prisma', 'sql', file), 'utf8');
      // Sent as one simple query: the DO $$ blocks contain semicolons that a naive split would
      // cut in half.
      await client.query(sql);
    }

    await seedBaselineTenancy(client);
  } finally {
    await client.end();
  }
}

/**
 * The two tenants every tenant-scoped row hangs off, plus the currency they reference.
 *
 * WHY THIS IS HERE AND NOT LEFT TO THE MIGRATION: this harness builds its schema with
 * `prisma db push`, which creates tables from schema.prisma and runs NO migrations. The rows that
 * `20260911090000_multi_tenant_core` inserts therefore do not exist, so `tenants` comes up EMPTY and
 * the first tenant-scoped insert in the suite dies on a foreign key — with an error naming the row
 * being inserted rather than the baseline that was never created.
 *
 * It runs on the POSTGRES_TEST_URL path too, where the rows usually DO already exist because a human
 * ran `migrate deploy`. Everything here is `ON CONFLICT DO NOTHING`, so that case is a no-op, and
 * truncateAll() preserves both tables between tests.
 *
 * The ids are literals rather than imports from '@core/tenant': this file is harness plumbing that
 * runs before any application module is loaded, and the values are equally hard-coded in the
 * migration and in prisma/sql/006's CHECK constraint. If they ever change, all three change together.
 */
async function seedBaselineTenancy(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO currencies (code, name, scale, symbol, is_active, created_at, updated_at)
    VALUES ('NSP', 'New Syrian Pound', 2, 'NSP', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (code) DO NOTHING;

    INSERT INTO tenants (
      id, slug, display_name, status, bot_token_enc, admin_chat_id,
      ichancy_base_url, ichancy_username, ichancy_password_enc, ichancy_agent_id,
      currency_code, dual_approval_threshold_minor, agent_float_low_watermark_minor,
      deposit_expiry_minutes, updated_at
    ) VALUES
      ('00000000-0000-0000-0000-000000000000', 'platform', 'Platform', 'ACTIVE',
       'TEST-PLATFORM-NO-BOT', 0, 'https://example.invalid', 'unused', 'TEST-PLATFORM-NO-AGENT',
       'unused', 'NSP', 0, 0, 30, CURRENT_TIMESTAMP),
      ('00000000-0000-0000-0000-000000000001', 'default', 'Default Operator', 'ACTIVE',
       'TEST-BOOTSTRAP-BOT', 0, 'https://example.invalid', 'test-agent', 'TEST-BOOTSTRAP-PASSWORD',
       '1', 'NSP', 0, 0, 30, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO platform_defaults (
      id, ichancy_base_url, ichancy_agent_id, currency_code,
      dual_approval_threshold_minor, agent_float_low_watermark_minor,
      deposit_expiry_minutes, updated_at
    ) VALUES (1, 'https://example.invalid', '1', 'NSP', 0, 0, 30, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO NOTHING;
  `);
}

export async function startPostgres(): Promise<PostgresHandle> {
  if (handle !== null) return handle;
  if (starting !== null) return starting;

  starting = (async (): Promise<PostgresHandle> => {
    /**
     * ESCAPE HATCH. `POSTGRES_TEST_URL` points the suite at a database that ALREADY has the schema,
     * skipping both the container and `prisma db push`. Two reasons it exists:
     *
     *  - speed: reusing a warm database turns a 30-second suite start into an instant one;
     *  - Prisma 7 refuses to run `db push` when it detects an AI coding agent invoked it, and
     *    demands explicit human consent. That guard is correct — `db push` destroys data — but it
     *    means an agent cannot bootstrap this harness on its own. Pointing at a database a human
     *    already migrated is the way through that does not involve faking consent.
     *
     * The guard SQL is still applied, because a database without prisma/sql/001..005 silently
     * asserts nothing. Everything in those files is idempotent, so re-applying is safe.
     */
    const external = process.env.POSTGRES_TEST_URL?.trim();
    if (external !== undefined && external.length > 0) {
      await applyGuards(external);
      const reused: PostgresHandle = {
        url: external,
        appUrl: external,
        container: null,
        stop: async (): Promise<void> => {
          handle = null;
          starting = null;
          await Promise.resolve();
        },
      };
      handle = reused;
      return reused;
    }

    const container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('ichancy')
      .withUsername('ichancy')
      .withPassword('ichancy')
      // The data is thrown away with the container; fsync costs seconds across a whole suite.
      .withCommand(['postgres', '-c', 'fsync=off', '-c', 'synchronous_commit=off'])
      .start();

    const url = buildUrl(container, 'ichancy', 'ichancy');

    pushSchema(url);
    await applyGuards(url);

    const started: PostgresHandle = {
      url,
      appUrl: buildUrl(container, APP_ROLE, APP_PASSWORD),
      container,
      stop: async (): Promise<void> => {
        handle = null;
        starting = null;
        await container.stop();
      },
    };

    handle = started;
    return started;
  })();

  return starting;
}

/** The already-started handle, or null. Use it to avoid starting a container you do not need. */
export function currentPostgres(): PostgresHandle | null {
  return handle;
}

export async function stopPostgres(): Promise<void> {
  if (handle !== null) await handle.stop();
}
