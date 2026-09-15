/**
 * The tenancy seed's secret handling, without a database: what it seals goes through
 * TenantSecretService, so the runtime opens it; what it cannot seal lands as a placeholder that the
 * runtime refuses. The Prisma client is a stub that records the upserts, since sealing is the only
 * behaviour under test here.
 */
import { TenantStatus, type PrismaClient } from '@prisma/client';

import {
  TenantSecretError,
  TenantSecretErrorCodes,
  TenantSecretService,
} from '@core/tenant/services/tenant-secret.service';
import { TENANT_BOOTSTRAP_ID } from '@core/tenant/tenant.constants';

import { seedTenancy } from '../../prisma/seed/tenant.seed';

const ROOT = 'seed-spec-root-secret-0123456789abcdef';
const PASSWORD = 'agent-password-from-env';

interface TenantUpsertArgs {
  where: { id: string };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

interface ExistingBootstrapRow {
  id: string;
  status: TenantStatus;
  adminChatId: bigint;
  ichancyUsername: string;
  ichancyPasswordEnc: string;
  ichancyAgentId: string;
}

/** What `20260911090000_multi_tenant_core` leaves in the bootstrap operator's row. */
const MIGRATED_BOOTSTRAP: ExistingBootstrapRow = {
  id: TENANT_BOOTSTRAP_ID,
  status: TenantStatus.SUSPENDED,
  // 0 is "no staff group": the migration cannot know one.
  adminChatId: 0n,
  ichancyUsername: 'REPLACE-ME',
  ichancyPasswordEnc: 'REPLACE-ME-ICHANCY-PASSWORD',
  ichancyAgentId: 'REPLACE-ME',
};

async function runSeed(
  env: NodeJS.ProcessEnv,
  existingBootstrap: ExistingBootstrapRow | null = null,
): Promise<TenantUpsertArgs> {
  return (await runSeedAll(env, existingBootstrap)).bootstrap;
}

async function runSeedAll(
  env: NodeJS.ProcessEnv,
  existingBootstrap: ExistingBootstrapRow | null = null,
): Promise<{ bootstrap: TenantUpsertArgs; upserts: TenantUpsertArgs[] }> {
  const upserts: TenantUpsertArgs[] = [];
  const stub = {
    tenant: {
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(args.where.id === TENANT_BOOTSTRAP_ID ? existingBootstrap : null),
      upsert: (args: TenantUpsertArgs) => {
        upserts.push(args);
        return Promise.resolve({ id: args.where.id });
      },
    },
    platformDefaults: {
      findUnique: () => Promise.resolve(null),
      upsert: () => Promise.resolve({ id: 1 }),
    },
  };

  await seedTenancy(stub as unknown as PrismaClient, 'NSP', env);

  const bootstrap = upserts.find((args) => args.where.id === TENANT_BOOTSTRAP_ID);
  if (bootstrap === undefined) throw new Error('the seed never upserted the bootstrap operator');
  return { bootstrap, upserts };
}

function openedPassword(stored: unknown): string {
  if (typeof stored !== 'string') throw new Error('ichancyPasswordEnc was not written');
  return new TenantSecretService(ROOT).openIchancyPassword({
    id: TENANT_BOOTSTRAP_ID,
    ichancyPasswordEnc: stored,
  });
}

function refusalCode(action: () => unknown): string {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof TenantSecretError) return error.code;
    throw error;
  }
  throw new Error('expected a TenantSecretError');
}

describe('seedTenancy secrets', () => {
  it('seals the Ichancy password so the runtime service opens it', async () => {
    const bootstrap = await runSeed({ JWT_SECRET: ROOT, ICHANCY_PASSWORD: PASSWORD });

    expect(bootstrap.create['ichancyPasswordEnc']).not.toContain(PASSWORD);
    expect(openedPassword(bootstrap.create['ichancyPasswordEnc'])).toBe(PASSWORD);
  });

  it('derives from the trimmed JWT_SECRET, the same root the runtime trims to', async () => {
    const bootstrap = await runSeed({ JWT_SECRET: `  ${ROOT}\n`, ICHANCY_PASSWORD: PASSWORD });
    expect(openedPassword(bootstrap.create['ichancyPasswordEnc'])).toBe(PASSWORD);
  });

  it('repairs the migration sentinel with a value the runtime opens, and keeps the row suspended while no staff group is bound', async () => {
    const bootstrap = await runSeed(
      { JWT_SECRET: ROOT, ICHANCY_PASSWORD: PASSWORD, ICHANCY_USERNAME: 'agent@example.com' },
      MIGRATED_BOOTSTRAP,
    );

    expect(openedPassword(bootstrap.update['ichancyPasswordEnc'])).toBe(PASSWORD);
    // An operator with no staff group may not serve: its review cards would go nowhere.
    expect(bootstrap.update['status']).toBeUndefined();
  });

  it('switches a repaired row on once a staff group is bound', async () => {
    const bootstrap = await runSeed(
      { JWT_SECRET: ROOT, ICHANCY_PASSWORD: PASSWORD, ICHANCY_USERNAME: 'agent@example.com' },
      { ...MIGRATED_BOOTSTRAP, adminChatId: -1001234567890n },
    );

    expect(bootstrap.update['status']).toBe(TenantStatus.ACTIVE);
  });

  it('creates the bootstrap operator SUSPENDED with no staff group, and tenant zero ACTIVE', async () => {
    const { bootstrap, upserts } = await runSeedAll({ JWT_SECRET: ROOT, ICHANCY_PASSWORD: PASSWORD });

    expect(bootstrap.create).toMatchObject({ status: TenantStatus.SUSPENDED, adminChatId: 0n });
    const platform = upserts.find((args) => args.where.id !== TENANT_BOOTSTRAP_ID);
    expect(platform?.create['status']).toBe(TenantStatus.ACTIVE);
  });

  it('writes a placeholder the runtime refuses when there is no JWT_SECRET', async () => {
    const bootstrap = await runSeed({ ICHANCY_PASSWORD: PASSWORD });

    expect(bootstrap.create['ichancyPasswordEnc']).toBe('SEED-PLACEHOLDER-ICHANCY-PASSWORD');
    expect(refusalCode(() => openedPassword(bootstrap.create['ichancyPasswordEnc']))).toBe(
      TenantSecretErrorCodes.TENANT_SECRET_UNCONFIGURED,
    );
  });

  it('does not seal a sentinel-looking ICHANCY_PASSWORD, and leaves a migrated row suspended', async () => {
    const bootstrap = await runSeed(
      { JWT_SECRET: ROOT, ICHANCY_PASSWORD: 'REPLACE-ME', ICHANCY_USERNAME: 'agent@example.com' },
      MIGRATED_BOOTSTRAP,
    );

    expect(bootstrap.create['ichancyPasswordEnc']).toBe('SEED-PLACEHOLDER-ICHANCY-PASSWORD');
    expect(bootstrap.update['ichancyPasswordEnc']).toBeUndefined();
    expect(bootstrap.update['status']).toBeUndefined();
  });

  it('never writes a bot token the runtime would open', async () => {
    const bootstrap = await runSeed({ JWT_SECRET: ROOT, ICHANCY_PASSWORD: PASSWORD });
    const botTokenEnc = bootstrap.create['botTokenEnc'];
    if (typeof botTokenEnc !== 'string') throw new Error('botTokenEnc was not written');

    expect(
      refusalCode(() =>
        new TenantSecretService(ROOT).openBotToken({ id: TENANT_BOOTSTRAP_ID, botTokenEnc }),
      ),
    ).toBe(TenantSecretErrorCodes.TENANT_SECRET_UNCONFIGURED);
  });
});
