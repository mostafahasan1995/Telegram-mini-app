/**
 * Development fixture seed:  npm run seed
 *
 * NOT how a deployment gets its first admin — that is `npm run seed:platform-admin`, which writes one
 * account and is safe anywhere. This one fills a developer's (or a test's) database with the
 * fixtures a flow needs end to end.
 *
 * ORDER IS A DEPENDENCY, not a preference:
 *   1. currency        — every other table has a currency_code foreign key
 *   2. tenants         — every tenant-scoped table has a tenant_id foreign key, so nothing below
 *                        this line can be inserted until the two baseline tenants exist
 *   3. payment methods — each rail's UUID is the scope of three ledger accounts
 *   4. ledger accounts — codes are built from those UUIDs
 *   5. platform admin  — only when SEED_PLATFORM_ADMIN_USERNAME / _PASSWORD are set
 *
 * WHY THIS REFUSES TO RUN IN PRODUCTION: it creates payment destinations holding PLACEHOLDER account
 * numbers. Exactly right on a developer's machine and exactly wrong on a live cashier, where a
 * player paying into a placeholder sends money nowhere. The guard reads NODE_ENV as the process
 * really has it — the npm script no longer forces `NODE_ENV=development`, which used to disarm this
 * check in the production tools image without anyone noticing. A deliberate production run:
 *
 *   SEED_ALLOW_PRODUCTION=1 npm run seed
 *
 * Everything here is an idempotent upsert, so re-running is safe by design — but "safe to re-run"
 * and "safe to run automatically on every deploy" are different claims, and only the first is true.
 */
import '@common/helpers/bigint-json';

import { existsSync } from 'node:fs';

// WHY: `npm run seed` invokes ts-node directly, which never reads prisma.config.ts — so the .env
// that config loads is absent here and every connection string is undefined. Prisma's own
// `migrate dev` seed hook happens to work because it loads the config first; running the seed on
// its own did not. Load it explicitly so both paths behave the same. A NODE_ENV in .env therefore
// arms the guard below too (loadEnvFile never overrides a variable already set).
if (!process.env.SKIP_DOTENV && existsSync('.env')) {
  process.loadEnvFile('.env');
}

import { PasswordHasherService } from '@core/auth/services/password-hasher.service';

import { createSeedClient } from './seed/client';
import { seedCurrency } from './seed/currency.seed';
import { seedLedgerAccounts } from './seed/ledger-account.seed';
import { seedPaymentMethods } from './seed/payment-method.seed';
import {
  PLATFORM_ADMIN_ENV,
  describeSeedFailure,
  readPlatformAdminInput,
  seedPlatformAdmin,
} from './seed/platform-admin.seed';
import { seedTenancy } from './seed/tenant.seed';

function assertNotProduction(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'production') return;
  if (env.SEED_ALLOW_PRODUCTION === '1' || env.SEED_ALLOW_PRODUCTION === 'true') return;

  throw new Error(
    'Refusing to run the development fixture seed with NODE_ENV=production: it writes placeholder ' +
      'payment destinations. To create the first platform admin, run `npm run seed:platform-admin`. ' +
      'Set SEED_ALLOW_PRODUCTION=1 only if the fixtures are genuinely what you want.',
  );
}

async function main(): Promise<void> {
  assertNotProduction(process.env);

  // Only when asked for. Validated up front, so a bad password fails before any fixture is written.
  const wantsPlatformAdmin =
    process.env[PLATFORM_ADMIN_ENV.username] !== undefined ||
    process.env[PLATFORM_ADMIN_ENV.password] !== undefined;
  const platformAdminInput = wantsPlatformAdmin ? readPlatformAdminInput(process.env) : null;

  const { prisma, close, redactedUrl } = createSeedClient();
  console.warn(`[seed] database: ${redactedUrl}`);

  try {
    const currency = await seedCurrency(prisma);
    console.warn(
      `[seed] currency ${currency.code} scale ${currency.scale} ` +
        `(${currency.created ? 'created' : 'already present'})`,
    );

    // Before everything below it: a tenant_id foreign key has to point at a row that exists.
    const tenancy = await seedTenancy(prisma, currency.code);
    console.warn(
      `[seed] tenant ${tenancy.platform.slug} ` +
        `(${tenancy.platform.created ? 'created' : 'already present'}), ` +
        `tenant ${tenancy.bootstrap.slug} ` +
        `(${tenancy.bootstrap.created ? 'created' : 'already present'}), ` +
        `platform defaults ${tenancy.defaultsCreated ? 'created' : 'already present'}`,
    );

    const methods = await seedPaymentMethods(prisma, currency.code);
    for (const method of methods) console.warn(`[seed] payment method ${method.code}`);

    const accounts = await seedLedgerAccounts(prisma, {
      currencyCode: currency.code,
      paymentMethodIds: methods.map((method) => method.id),
    });
    const createdAccounts = accounts.filter((account) => account.created).length;
    console.warn(
      `[seed] ledger accounts: ${accounts.length} total, ${createdAccounts} created ` +
        `(balances untouched)`,
    );

    if (platformAdminInput === null) {
      console.warn(
        `[seed] platform admin SKIPPED — set ${PLATFORM_ADMIN_ENV.username} and ` +
          `${PLATFORM_ADMIN_ENV.password} to create the console sign-in.`,
      );
    } else {
      const admin = await seedPlatformAdmin(
        prisma,
        platformAdminInput,
        new PasswordHasherService(),
      );
      console.warn(`[seed] platform admin ${admin.username}: ${admin.outcome}`);
    }

    // The single most consequential thing an operator can forget. Printed last so it is the line
    // still on screen when the command finishes.
    if (methods.some((method) => method.destinationIsPlaceholder)) {
      console.warn('');
      console.warn('[seed] ############################################################');
      console.warn('[seed] # PLACEHOLDER PAYMENT DESTINATIONS ARE ACTIVE.             #');
      console.warn('[seed] # A player paying into them sends money NOWHERE.           #');
      console.warn('[seed] # Replace them before accepting real deposits:             #');
      console.warn('[seed] #   POST /v1/admin/payment-methods/:id/destinations        #');
      console.warn('[seed] ############################################################');
    }

    console.warn('[seed] done');
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  const password = process.env[PLATFORM_ADMIN_ENV.password] ?? '';
  console.error(`[seed] failed: ${describeSeedFailure(error, [password])}`);
  process.exit(1);
});
