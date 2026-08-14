/**
 * A PrismaClient for the seed scripts, built the same way PrismaService builds the application's —
 * @prisma/adapter-pg over a pg.Pool — because Prisma 7 has no connection of its own to fall back on.
 *
 * WHY the seed may use a different connection string: `prisma/sql/003_app_role_grants.sql` runs the
 * application as a NON-OWNER role so that REVOKE actually bites (an owner keeps implicit
 * privileges). Seeding is an administrative act, so it accepts SEED_DATABASE_URL, then
 * MIGRATE_DATABASE_URL, before falling back to DATABASE_URL. Nothing seeded here touches the three
 * append-only tables, so the plain application role works too — the override exists for
 * environments that lock the app role down further than the checked-in script does.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import { buildPoolConfig } from '@core/prisma/pool-config.util';

export interface SeedClient {
  prisma: PrismaClient;
  close: () => Promise<void>;
  redactedUrl: string;
}

export function resolveSeedDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.SEED_DATABASE_URL ?? env.MIGRATE_DATABASE_URL ?? env.DATABASE_URL;
  if (url === undefined || url.trim().length === 0) {
    throw new Error(
      'No database URL. Set DATABASE_URL (or SEED_DATABASE_URL / MIGRATE_DATABASE_URL) before seeding.',
    );
  }
  return url;
}

export function createSeedClient(env: NodeJS.ProcessEnv = process.env): SeedClient {
  const parsed = buildPoolConfig(resolveSeedDatabaseUrl(env), {
    // A seed is sequential; more connections would only make a failure noisier.
    max: 2,
    applicationName: 'ichancy-seed',
  });

  const pool = new Pool(parsed.pool);
  const prisma = new PrismaClient({
    adapter: new PrismaPg(pool, { schema: parsed.schema, disposeExternalPool: false }),
    log: ['warn', 'error'],
  });

  return {
    prisma,
    redactedUrl: parsed.redactedUrl,
    close: async (): Promise<void> => {
      await prisma.$disconnect();
      await pool.end();
    },
  };
}
