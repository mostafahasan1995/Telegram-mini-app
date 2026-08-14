/**
 * A real PostgreSQL 17 for the integration suite — schema pushed AND `prisma/sql/001..005` applied.
 *
 * WHY the hand-written SQL is applied here and not left to a developer's memory: those five files
 * are where the cashier's actual guarantees live (the ledger balances at COMMIT, the ledger is
 * append-only, one credit per deposit, four eyes really means two people). Prisma will never run
 * them and `prisma db push` does not know they exist, so a test database without them looks
 * identical and silently asserts nothing. That is not hypothetical: the shared dev container this
 * project was built against has all 21 tables and zero of these triggers.
 *
 * WHY one container per JEST WORKER rather than per file or per suite: starting Postgres costs
 * seconds and truncating costs milliseconds. Jest runs each worker in its own process, so a
 * module-level singleton is exactly "one per worker" — files in the same worker share it, and
 * workers never share state with each other. `truncateAll()` between tests is what keeps them
 * isolated.
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

/** Applied in this order — 003 needs the tables, 004/005 need them too. */
const SQL_FILES = [
  '001_ledger_balanced_trigger.sql',
  '002_immutability.sql',
  '003_app_role_grants.sql',
  '004_partial_indexes.sql',
  '005_four_eyes_check.sql',
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
  } finally {
    await client.end();
  }
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
