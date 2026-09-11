/**
 * Seed entrypoint:  npm run seed
 *
 * ORDER IS A DEPENDENCY, not a preference:
 *   1. currency        — every other table has a currency_code foreign key
 *   2. tenants         — every tenant-scoped table has a tenant_id foreign key, so nothing below
 *                        this line can be inserted until the two baseline operators exist
 *   3. payment methods — each rail's UUID is the scope of three ledger accounts
 *   4. ledger accounts — codes are built from those UUIDs
 *   5. admin           — needs the currency for its approval limit, and both tenants to exist
 *
 * WHY THIS REFUSES TO RUN IN PRODUCTION BY DEFAULT: seeding creates payment destinations holding
 * PLACEHOLDER account numbers and re-activates the owner account. Both are exactly right on a
 * developer's machine and exactly wrong on a live cashier, where a re-activated admin or a
 * placeholder destination is a real incident. Production runs it deliberately:
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
// its own did not. Load it explicitly so both paths behave the same.
if (!process.env.SKIP_DOTENV && existsSync('.env')) {
  process.loadEnvFile('.env');
}

import { createSeedClient } from './seed/client';
import { seedAdmin } from './seed/admin.seed';
import { seedCurrency } from './seed/currency.seed';
import { seedLedgerAccounts } from './seed/ledger-account.seed';
import { seedPaymentMethods } from './seed/payment-method.seed';
import { seedTenancy } from './seed/tenant.seed';

function assertNotProduction(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'production') return;
  if (env.SEED_ALLOW_PRODUCTION === '1' || env.SEED_ALLOW_PRODUCTION === 'true') return;

  throw new Error(
    'Refusing to seed with NODE_ENV=production. The seed writes placeholder payment ' +
      'destinations and re-activates the owner admin. Set SEED_ALLOW_PRODUCTION=1 if that is ' +
      'genuinely what you want.',
  );
}

async function main(): Promise<void> {
  assertNotProduction(process.env);

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

    const admin = await seedAdmin(prisma, currency.code);
    if (admin.skipped) {
      console.warn(`[seed] admin SKIPPED — ${admin.reason ?? 'no reason given'}`);
      console.warn('[seed] set SEED_ADMIN_TELEGRAM_ID to create the first SUPER_ADMIN.');
    } else {
      console.warn(
        `[seed] admin ${String(admin.telegramUserId)} ` +
          `(${admin.created ? 'created' : 'already present'}), ` +
          `approval limit ${admin.limitCreated ? 'created' : 'already present'}`,
      );
      console.warn(
        `[seed] platform admin in tenant zero ` +
          `(${admin.platformAdminCreated ? 'created' : 'already present'}) — ` +
          'the only role that may reach /v1/admin/tenants',
      );
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

    // The other thing an operator cannot discover on their own: a tenant whose sealed columns hold
    // placeholders looks completely normal until the bot fails to answer.
    if (tenancy.secretsArePlaceholders) {
      console.warn('');
      console.warn('[seed] ############################################################');
      console.warn('[seed] # THE BOOTSTRAP OPERATOR HOLDS PLACEHOLDER SECRETS.        #');
      console.warn('[seed] # Its bot cannot answer and Ichancy cannot be signed into. #');
      console.warn('[seed] # Set TELEGRAM_BOT_TOKEN / ICHANCY_PASSWORD / JWT_SECRET   #');
      console.warn('[seed] # and replace them through the platform console —          #');
      console.warn('[seed] # RE-RUNNING THIS SEED WILL NOT REPAIR THEM. Every tenant  #');
      console.warn('[seed] # upsert has an empty update clause on purpose, so that a  #');
      console.warn('[seed] # redeploy cannot revert an audited operator decision.     #');
      console.warn('[seed] ############################################################');
    }

    console.warn('[seed] done');
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error('[seed] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
