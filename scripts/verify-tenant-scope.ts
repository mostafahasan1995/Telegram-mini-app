/**
 * Proves the two claims tenantScopeExtension rests on, against a real database:
 *
 *   1. A list query inside runWithTenant() sees only that operator's rows.
 *   2. THE SAME IS TRUE INSIDE $transaction. This is the one that is not obvious — the guard on
 *      "is this the last SUPER_ADMIN" runs inside runInTransaction(), and if query extensions did
 *      not reach the transaction client it would count across every operator and either block a
 *      legitimate deactivation or allow the last one.
 *
 * Run:  npx ts-node -r tsconfig-paths/register scripts/verify-tenant-scope.ts
 * Needs DATABASE_URL pointing at a migrated database. Writes nothing it does not clean up.
 */
import '@common/helpers/bigint-json';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { tenantScopeExtension } from '@core/prisma/tenant-scope.extension';
import { runWithTenant } from '@core/tenant/tenant.storage';
import { TENANT_BOOTSTRAP_ID, TENANT_ZERO_ID } from '@core/tenant/tenant.constants';

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error('DATABASE_URL is required — point it at a migrated database.');
}

const base = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const prisma = base.$extends(tenantScopeExtension);

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string): void => {
  results.push({ name, pass, detail });
};

async function main(): Promise<void> {
  // Two players with the same Telegram id, one per operator — the scoping is only observable when
  // the rows are otherwise identical.
  const telegramUserId = 990000000000001n;
  for (const tenantId of [TENANT_ZERO_ID, TENANT_BOOTSTRAP_ID]) {
    await base.player.deleteMany({ where: { tenantId, telegramUserId } });
    await base.player.create({
      data: { tenantId, telegramUserId, status: 'ACTIVE', currencyCode: 'NSP' },
    });
  }

  try {
    const unscoped = await base.player.count({ where: { telegramUserId } });
    check('baseline: both rows exist', unscoped === 2, `unextended count = ${unscoped}`);

    // 1 — a plain list query inside a tenant context.
    const scoped = await runWithTenant(TENANT_BOOTSTRAP_ID, () =>
      prisma.player.count({ where: { telegramUserId } }),
    );
    check('findMany/count is scoped outside a transaction', scoped === 1, `count = ${scoped}`);

    // 2 — THE IMPORTANT ONE: the same query through the transaction client.
    const inTx = await runWithTenant(TENANT_BOOTSTRAP_ID, () =>
      prisma.$transaction(async (tx) => tx.player.count({ where: { telegramUserId } })),
    );
    check('findMany/count is scoped INSIDE $transaction', inTx === 1, `count = ${inTx}`);

    // 3 — an explicit tenantId must always win over the ambient one.
    const explicit = await runWithTenant(TENANT_BOOTSTRAP_ID, () =>
      prisma.player.count({ where: { telegramUserId, tenantId: TENANT_ZERO_ID } }),
    );
    check('an explicit tenantId overrides the context', explicit === 1, `count = ${explicit}`);

    // 4 — with no context at all nothing is injected (workers, crons, CLI).
    const noContext = await prisma.player.count({ where: { telegramUserId } });
    check('no context = no filter injected', noContext === 2, `count = ${noContext}`);

    // 5 — findMany, not just count.
    const rows = await runWithTenant(TENANT_ZERO_ID, () =>
      prisma.player.findMany({ where: { telegramUserId }, select: { tenantId: true } }),
    );
    check(
      'findMany returns only the context tenant',
      rows.length === 1 && rows[0]?.tenantId === TENANT_ZERO_ID,
      `${rows.length} row(s): ${rows.map((r) => r.tenantId).join(', ')}`,
    );
  } finally {
    for (const tenantId of [TENANT_ZERO_ID, TENANT_BOOTSTRAP_ID]) {
      await base.player.deleteMany({ where: { tenantId, telegramUserId } });
    }
    await base.$disconnect();
  }

  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  (${r.detail})`);
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
