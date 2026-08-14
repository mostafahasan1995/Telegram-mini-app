/**
 * WHY this file exists: Prisma 7 removed `url` from the datasource block. Migrate/introspect read
 * the connection string from here, while the running app connects through @prisma/adapter-pg.
 *
 * The CLI no longer auto-loads .env either, so we do it explicitly with Node's built-in loader.
 * Containers set real environment variables and simply have no .env to load.
 *
 * NOTE: run migrations as the schema OWNER (see prisma/sql/README.md). DATABASE_URL points at the
 * restricted application role, so a dedicated MIGRATE_DATABASE_URL takes precedence when present.
 */
import { existsSync } from 'node:fs';

import { defineConfig } from 'prisma/config';

if (!process.env.SKIP_DOTENV && existsSync('.env')) {
  process.loadEnvFile('.env');
}

const migrateUrl = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  // Declared only when a URL is actually present: `prisma generate` and `prisma format` must keep
  // working in CI images that have no database credentials. `migrate` raises its own clear error.
  ...(migrateUrl
    ? {
        datasource: {
          url: migrateUrl,
          ...(process.env.SHADOW_DATABASE_URL
            ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL }
            : {}),
        },
      }
    : {}),
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node -r tsconfig-paths/register prisma/seed.ts',
  },
  // prisma/sql/ holds hand-written DDL (triggers, grants, partial indexes), NOT TypedSQL queries.
  // Point TypedSQL somewhere else so enabling that feature later cannot try to compile our DDL.
  typedSql: {
    path: 'prisma/typed-sql',
  },
});
