/**
 * ONE OPERATOR MUST NEVER READ OR CHANGE ANOTHER OPERATOR'S ROWS BY ID — through the real entrypoints.
 *
 * Every scoped model's primary key is a bare uuid, and a lookup by that id alone reached every
 * operator. This suite drives each confirmed hole through the path an attacker would use — an HTTP
 * route with a signed-in staff token of operator A, an update from A's own bot, a queue job running as
 * A — aims it at operator B's row, and proves three things each time:
 *
 *   - the answer is the same one an id that never existed gets (status, code, message), so ids
 *     cannot be probed;
 *   - B's row, and B's audit, outbox, transition and ledger trail, are exactly as they were;
 *   - the owner still reaches it: B's own staff, or a PLATFORM_ADMIN pointing X-Tenant-Id at B, with
 *     the audit row landing in B.
 *
 * Operator A is the bootstrap operator (the only one whose players can sign in to the mini app);
 * B and C are created here with a run-unique slug. C owns a bot, built on the offline Telegram fake,
 * so a callback button can be tapped for real. Under NODE_ENV=test the tenant-scope extension THROWS
 * on an unpinned unique selector, so any path this suite exercises that forgot its tenant fails here
 * rather than passing on one operator's fixtures.
 *
 * Run with the escape hatch (no testcontainers):
 *   POSTGRES_TEST_URL=... REDIS_TEST_URL=... \
 *     npx jest --config jest-int.config.cjs --runInBand src/modules/tenant-isolation.int.spec.ts
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AdminRole,
  BreakCategory,
  DepositStatus,
  ProofSource,
  TenantStatus,
  type Prisma,
} from '@prisma/client';
import { Bot } from 'grammy';
import { type Update } from 'grammy/types';
import sharp from 'sharp';
import request from 'supertest';
import { z } from 'zod';

import { formatMinorToDecimal } from '@common/helpers/money.util';
import { AdminIdentityService } from '@core/auth/services/admin-identity.service';
import { PasswordHasherService } from '@core/auth/services/password-hasher.service';
import { SessionService } from '@core/auth/services/session.service';
import { CacheService } from '@core/cache/cache.service';
import { LockService } from '@core/cache/lock.service';
import { RedisService } from '@core/cache/redis.service';
import { type AppConfigService } from '@core/config/config.service';
import { FILE_STORAGE, type FileStorage } from '@core/file/file.types';
import { rawProofKey } from '@core/file/storage-key.util';
import { TelegramFileService } from '@core/file/telegram-file.service';
import { type IchancyClassification } from '@core/ichancy/error-map';
import { ICHANCY_DOWN_THRESHOLD, IchancyHealthService } from '@core/ichancy/ichancy-health.service';
import { PrismaService } from '@core/prisma/prisma.service';
import { BotService } from '@core/telegram/services/bot.service';
import { TelegramHandlerRegistrar } from '@core/telegram/services/handler-registrar.service';
import { TenantBotRegistry } from '@core/telegram/services/tenant-bot-registry.service';
import { type TenantRegistryService } from '@core/tenant/services/tenant-registry.service';
import { TenantSecretService } from '@core/tenant/services/tenant-secret.service';
import { TENANT_BOOTSTRAP_ID, TENANT_HEADER, TENANT_ZERO_ID } from '@core/tenant/tenant.constants';
import { runWithTenant } from '@core/tenant/tenant.storage';

import { createTestApp, type TestApp } from '../../test/setup/app-factory';
import { createFakeTelegram, testBotInfo } from '../../test/setup/telegram-fixtures';

jest.setTimeout(240_000);

const RUN = Date.now().toString(36);
const SLUG_PREFIX = 'iso-';
const PASSWORD = 'Isolation-Pass-77';
const login = (name: string): string => `iso-${RUN}-${name}`;
const shortIdFor = (name: string): string => `IS${RUN}${name}`.toUpperCase().slice(0, 12);

const OPERATOR_A = TENANT_BOOTSTRAP_ID;

// The envelope always carries both keys: `error` is null on success, `data` is null on a refusal.
const envelopeSchema = z.looseObject({
  success: z.boolean(),
  data: z.unknown().nullish(),
  error: z
    .looseObject({ code: z.string(), message: z.string(), details: z.unknown().optional() })
    .nullish(),
});
const withId = z.looseObject({ id: z.string() });

interface Refusal {
  status: number;
  success: boolean;
  code: string | undefined;
  message: string | undefined;
  details: unknown;
}

const refusalOf = (response: request.Response): Refusal => {
  const envelope = envelopeSchema.parse(response.body);
  return {
    status: response.status,
    success: envelope.success,
    code: envelope.error?.code,
    message: envelope.error?.message,
    details: envelope.error?.details ?? null,
  };
};

/** Another operator's id answers EXACTLY like one that never existed, and that answer is a 404. */
function expectLikeMissing(
  probe: string,
  foreign: request.Response,
  missing: request.Response,
  code: string,
): void {
  expect({ probe, ...refusalOf(foreign) }).toEqual({ probe, ...refusalOf(missing) });
  expect({ probe, status: foreign.status, code: refusalOf(foreign).code }).toEqual({
    probe,
    status: 404,
    code,
  });
}

const CHALLENGE: IchancyClassification = {
  outcome: 'ambiguous',
  code: 'CLOUDFLARE_CHALLENGE',
  message: 'Cloudflare answered with a challenge (HTTP 403) instead of the agent API.',
  rule: 'CLOUDFLARE_CHALLENGE',
};

/** A 64x64 gradient, and the same picture with one pixel changed: different bytes, same picture. */
async function receiptImages(): Promise<{ original: Buffer; variant: Buffer }> {
  const width = 64;
  const height = 64;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = (x * 4) % 256;
      pixels[offset + 1] = (y * 4) % 256;
      pixels[offset + 2] = ((x + y) * 2) % 256;
    }
  }
  const variantPixels = Buffer.from(pixels);
  variantPixels[0] = 255;
  variantPixels[1] = 255;
  variantPixels[2] = 255;
  const png = (raw: Buffer): Promise<Buffer> =>
    sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  return { original: await png(pixels), variant: await png(variantPixels) };
}

describe('tenant isolation of rows addressed by id (integration)', () => {
  const telegram = createFakeTelegram();

  let ctx: TestApp;
  let prisma: PrismaService;
  let storage: FileStorage;

  let operatorB: string;
  let operatorC: string;
  let platformAdminId: string;

  // Operator B's rows, the targets.
  let bMethodId: string;
  let bDestinationId: string;
  let bPlayerId: string;
  let bSecondPlayerId: string;
  let bSubmittedId: string;
  let bCreditFailedId: string;
  let bProofId: string;
  let bBreakId: string;

  // Operator C: owns a bot.
  let cToken: string;
  let cBotId: number;
  let cDepositId: string;
  const cReviewerTelegramId = 7_700_000_000 + (Date.now() % 1_000_000);

  const bearer: Record<
    'aOwner' | 'aFinance' | 'aReviewer' | 'aViewer' | 'bOwner' | 'bReviewer' | 'bViewer' | 'platform',
    string
  > = {
    aOwner: '',
    aFinance: '',
    aReviewer: '',
    aViewer: '',
    bOwner: '',
    bReviewer: '',
    bViewer: '',
    platform: '',
  };

  const as = (who: keyof typeof bearer) => ({
    get: (path: string) =>
      request(ctx.httpServer).get(path).set('authorization', `Bearer ${bearer[who]}`),
    post: (path: string) =>
      request(ctx.httpServer).post(path).set('authorization', `Bearer ${bearer[who]}`),
    patch: (path: string) =>
      request(ctx.httpServer).patch(path).set('authorization', `Bearer ${bearer[who]}`),
    delete: (path: string) =>
      request(ctx.httpServer).delete(path).set('authorization', `Bearer ${bearer[who]}`),
  });

  const createOperator = async (
    name: string,
    bot?: { token: string; botId: number },
  ): Promise<string> => {
    const secrets = ctx.app.get(TenantSecretService);
    const tenant = await prisma.tenant.create({
      data: {
        slug: `${SLUG_PREFIX}${RUN}-${name}`,
        displayName: `Isolation ${name}`,
        status: TenantStatus.ACTIVE,
        botTokenEnc: bot === undefined ? 'ISO-INT-NO-BOT' : secrets.sealBotToken(bot.token),
        ...(bot === undefined ? {} : { botId: BigInt(bot.botId) }),
        adminChatId: -1_001_000_000_000n,
        ichancyBaseUrl: 'https://example.invalid',
        ichancyUsername: 'unused',
        ichancyPasswordEnc: 'ISO-INT-NO-AGENT',
        ichancyAgentId: 'unused',
        currencyCode: 'NSP',
        dualApprovalThresholdMinor: 1_000_000_000n,
        agentFloatLowWatermarkMinor: 0n,
        depositExpiryMinutes: 30,
      },
      select: { id: true },
    });
    return tenant.id;
  };

  const createAdmin = async (
    tenantId: string,
    name: string,
    role: AdminRole,
    passwordHash: string,
    telegramUserId: bigint | null = null,
  ): Promise<string> => {
    const admin = await prisma.adminUser.create({
      data: {
        tenantId,
        username: login(name),
        displayName: `Isolation ${name}`,
        role,
        passwordHash,
        telegramUserId,
      },
      select: { id: true },
    });
    return admin.id;
  };

  const signIn = async (name: string): Promise<string> => {
    const response = await request(ctx.httpServer)
      .post('/v1/admin/auth/credentials')
      .send({ username: login(name), password: PASSWORD })
      .expect(200);
    return z.looseObject({ accessToken: z.string() }).parse(envelopeSchema.parse(response.body).data)
      .accessToken;
  };

  const createPlayer = async (tenantId: string, telegramUserId: bigint): Promise<string> =>
    (
      await prisma.player.create({
        data: { tenantId, telegramUserId, currencyCode: 'NSP', status: 'ACTIVE' },
        select: { id: true },
      })
    ).id;

  const createMethod = async (tenantId: string, code: string): Promise<string> =>
    (
      await prisma.paymentMethod.create({
        data: {
          tenantId,
          code,
          displayName: `Isolation ${code}`,
          rail: 'MOBILE_WALLET',
          currencyCode: 'NSP',
          verificationMode: 'MANUAL_PROOF',
          minAmountMinor: 100n,
          maxAmountMinor: 100_000_000n,
          instructions: 'Original instructions',
        },
        select: { id: true },
      })
    ).id;

  const createDeposit = async (
    data: Omit<Prisma.DepositRequestUncheckedCreateInput, 'currencyCode' | 'claimedAmountMinor'> & {
      claimedAmountMinor?: bigint;
    },
  ): Promise<string> =>
    (
      await prisma.depositRequest.create({
        data: { currencyCode: 'NSP', claimedAmountMinor: 1_000_000n, ...data },
        select: { id: true },
      })
    ).id;

  /** A raw (not yet normalized) proof, stored and recorded the way the Telegram photo path leaves one. */
  const createRawProof = async (
    tenantId: string,
    depositRequestId: string,
    playerId: string,
    image: Buffer,
  ): Promise<string> => {
    const stored = await storage.put({
      key: rawProofKey(depositRequestId, `${randomUUID()}.png`),
      body: image,
      contentType: 'image/png',
      contentLength: image.byteLength,
    });
    return (
      await prisma.depositProof.create({
        data: {
          tenantId,
          depositRequestId,
          source: ProofSource.TELEGRAM_PHOTO,
          bucket: stored.bucket,
          storageKey: stored.key,
          mimeType: 'image/png',
          sizeBytes: image.byteLength,
          sha256: createHash('sha256').update(image).digest('hex'),
          uploadedByType: 'PLAYER',
          uploadedById: playerId,
        },
        select: { id: true },
      })
    ).id;
  };

  /** Everything operator B has that a cross-operator call could have touched. */
  const trailOf = async (tenantId: string): Promise<Record<string, unknown>> => ({
    methods: await prisma.paymentMethod.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
    destinations: await prisma.paymentDestination.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
    }),
    deposits: await prisma.depositRequest.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
    proofs: await prisma.depositProof.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
    breaks: await prisma.reconciliationBreak.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
    transitions: await prisma.depositTransition.count({ where: { tenantId } }),
    audits: await prisma.auditLog.count({ where: { tenantId } }),
    outbox: await prisma.outboxMessage.count({ where: { tenantId } }),
    ledger: await prisma.ledgerTransaction.count({ where: { tenantId } }),
  });

  const removeSuiteOperators = async (): Promise<void> => {
    await prisma.adminApprovalLimit.deleteMany({
      where: { tenant: { slug: { startsWith: SLUG_PREFIX } } },
    });
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  };

  // The receipts this suite stores go to a throwaway directory, not to the local driver's default
  // `.storage` inside the repository.
  const storageDir = mkdtempSync(join(tmpdir(), 'iso-proofs-'));
  const storageDirBefore = process.env['FILE_STORAGE_LOCAL_DIR'];

  beforeAll(async () => {
    ctx = await createTestApp({
      env: { FILE_STORAGE_LOCAL_DIR: storageDir },
      customize: (builder) => {
        // The app's own registry, built with the offline Telegram as its client.
        builder.overrideProvider(TenantBotRegistry).useFactory({
          factory: (
            prismaService: PrismaService,
            cacheService: CacheService,
            secretService: TenantSecretService,
            registrar: TelegramHandlerRegistrar,
          ) =>
            new TenantBotRegistry(
              prismaService,
              cacheService,
              secretService,
              registrar,
              telegram.clientOptions,
            ),
          inject: [PrismaService, CacheService, TenantSecretService, TelegramHandlerRegistrar],
        });
      },
    });
    prisma = ctx.app.get(PrismaService);
    storage = ctx.app.get<FileStorage>(FILE_STORAGE);

    await ctx.reset();
    await removeSuiteOperators();

    const hash = await ctx.app.get(PasswordHasherService).hash(PASSWORD);

    operatorB = await createOperator('b');
    cBotId = 7_200_000_000 + (Date.now() % 1_000_000);
    cToken = `${cBotId}:AA${randomBytes(18).toString('hex')}`;
    telegram.accept(cToken, testBotInfo(cBotId, `iso_${RUN}_bot`));
    operatorC = await createOperator('c', { token: cToken, botId: cBotId });

    await createAdmin(OPERATOR_A, 'a-owner', AdminRole.SUPER_ADMIN, hash);
    await createAdmin(OPERATOR_A, 'a-finance', AdminRole.FINANCE_ADMIN, hash);
    await createAdmin(OPERATOR_A, 'a-reviewer', AdminRole.REVIEWER, hash);
    await createAdmin(OPERATOR_A, 'a-viewer', AdminRole.VIEWER, hash);
    await createAdmin(operatorB, 'b-owner', AdminRole.SUPER_ADMIN, hash);
    await createAdmin(operatorB, 'b-reviewer', AdminRole.REVIEWER, hash);
    await createAdmin(operatorB, 'b-viewer', AdminRole.VIEWER, hash);
    await createAdmin(operatorC, 'c-reviewer', AdminRole.REVIEWER, hash, BigInt(cReviewerTelegramId));
    platformAdminId = await createAdmin(TENANT_ZERO_ID, 'platform', AdminRole.PLATFORM_ADMIN, hash);

    // Operator B: a live rail with one receiving account, players, deposits, a receipt, a break.
    bMethodId = await createMethod(operatorB, `ISO_B_${RUN.toUpperCase()}`);
    bDestinationId = (
      await prisma.paymentDestination.create({
        data: {
          tenantId: operatorB,
          paymentMethodId: bMethodId,
          label: 'B wallet',
          accountIdentifier: `b-wallet-${RUN}`,
          accountHolder: 'Operator B',
          priority: 5,
        },
        select: { id: true },
      })
    ).id;
    bPlayerId = await createPlayer(operatorB, 7_300_000_000n + BigInt(Date.now() % 1_000_000));
    bSecondPlayerId = await createPlayer(operatorB, 7_310_000_000n + BigInt(Date.now() % 1_000_000));
    bSubmittedId = await createDeposit({
      tenantId: operatorB,
      shortId: shortIdFor('BS'),
      playerId: bPlayerId,
      paymentMethodId: bMethodId,
      paymentDestinationId: bDestinationId,
      status: DepositStatus.SUBMITTED,
      submittedAt: new Date(),
    });
    bCreditFailedId = await createDeposit({
      tenantId: operatorB,
      shortId: shortIdFor('BF'),
      playerId: bPlayerId,
      paymentMethodId: bMethodId,
      status: DepositStatus.CREDIT_FAILED,
      verifiedAmountMinor: 1_000_000n,
      creditedAmountMinor: 1_000_000n,
    });
    const { original } = await receiptImages();
    bProofId = await createRawProof(operatorB, bSubmittedId, bPlayerId, original);
    bBreakId = (
      await prisma.reconciliationBreak.create({
        data: {
          tenantId: operatorB,
          category: BreakCategory.STUCK_DEPOSIT,
          currencyCode: 'NSP',
          dedupeKey: `iso-${RUN}`,
          expectedMinor: 1_000_000n,
          actualMinor: 900_000n,
          deltaMinor: -100_000n,
          depositRequestId: bCreditFailedId,
          playerId: bPlayerId,
        },
        select: { id: true },
      })
    ).id;

    // Operator C: its own rail, player and deposit, for the bot's positive path.
    const cMethodId = await createMethod(operatorC, `ISO_C_${RUN.toUpperCase()}`);
    const cPlayerId = await createPlayer(operatorC, 7_400_000_000n + BigInt(Date.now() % 1_000_000));
    cDepositId = await createDeposit({
      tenantId: operatorC,
      shortId: shortIdFor('CS'),
      playerId: cPlayerId,
      paymentMethodId: cMethodId,
      status: DepositStatus.SUBMITTED,
      submittedAt: new Date(),
    });

    await ctx.redis.flush();
    bearer.aOwner = await signIn('a-owner');
    bearer.aFinance = await signIn('a-finance');
    bearer.aReviewer = await signIn('a-reviewer');
    bearer.aViewer = await signIn('a-viewer');
    bearer.bOwner = await signIn('b-owner');
    bearer.bReviewer = await signIn('b-reviewer');
    bearer.bViewer = await signIn('b-viewer');
    bearer.platform = await signIn('platform');
  });

  afterAll(async () => {
    try {
      if (ctx === undefined) return;
      jest.restoreAllMocks();
      try {
        // Truncate first: the audit rows this suite made in B and C are append-only and hold the
        // operators in place.
        await ctx.reset();
        await removeSuiteOperators();
      } finally {
        await ctx.close();
      }
    } finally {
      if (storageDirBefore === undefined) delete process.env['FILE_STORAGE_LOCAL_DIR'];
      else process.env['FILE_STORAGE_LOCAL_DIR'] = storageDirBefore;
      // Best effort: Windows can still hold a handle on a file the storage driver just wrote, and a
      // leftover temp directory must not fail a suite whose assertions all passed.
      try {
        rmSync(storageDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // The OS temp directory is cleaned independently.
      }
    }
  });

  beforeEach(async () => {
    // Sign-in throttles and the identity cache live in Redis; sessions are signed tokens and survive.
    await ctx.redis.flush();
  });

  it("C1: A's staff cannot add a receiving account to B's payment method; a platform admin in B can", async () => {
    const trailBefore = await trailOf(operatorB);
    const createdAuditsBefore = await prisma.auditLog.count({
      where: { action: 'payment_destination.created' },
    });
    const body = { label: 'Injected', accountIdentifier: `inject-${RUN}`, priority: 0 };

    expectLikeMissing(
      'A owner POST destination on B method',
      await as('aOwner').post(`/v1/admin/payment-methods/${bMethodId}/destinations`).send(body),
      await as('aOwner').post(`/v1/admin/payment-methods/${randomUUID()}/destinations`).send(body),
      'PAYMENT_METHOD_NOT_FOUND',
    );
    // A platform admin without X-Tenant-Id works in tenant zero, which owns no methods.
    expectLikeMissing(
      'platform POST destination without the header',
      await as('platform').post(`/v1/admin/payment-methods/${bMethodId}/destinations`).send(body),
      await as('platform').post(`/v1/admin/payment-methods/${randomUUID()}/destinations`).send(body),
      'PAYMENT_METHOD_NOT_FOUND',
    );

    expect(await trailOf(operatorB)).toEqual(trailBefore);
    expect(await prisma.auditLog.count({ where: { action: 'payment_destination.created' } })).toBe(
      createdAuditsBefore,
    );
    // B's players are still sent to B's own account.
    const DestinationPicker = (await import('./payment-method/services/destination-picker.service'))
      .DestinationPickerService;
    const picked = await ctx.inTenant(
      () => ctx.app.get(DestinationPicker).pickFor(bMethodId, bPlayerId),
      operatorB,
    );
    expect(picked.id).toBe(bDestinationId);

    // The owner path: a platform admin pointed at B. Inactive, so B's rotation is left as it was.
    const created = await as('platform')
      .post(`/v1/admin/payment-methods/${bMethodId}/destinations`)
      .set(TENANT_HEADER, operatorB)
      .send({ ...body, accountIdentifier: `platform-${RUN}`, isActive: false })
      .expect(201);
    const createdId = withId.parse(envelopeSchema.parse(created.body).data).id;
    expect((await prisma.paymentDestination.findUniqueOrThrow({ where: { id: createdId } })).tenantId).toBe(
      operatorB,
    );
    const audits = await prisma.auditLog.findMany({
      where: { action: 'payment_destination.created', entityId: createdId },
    });
    expect(audits.map((row) => [row.tenantId, row.actorId])).toEqual([[operatorB, platformAdminId]]);
  });

  it("C2: A's staff cannot rewrite or retire B's payment method; a platform admin in B can", async () => {
    const trailBefore = await trailOf(operatorB);
    const patch = { instructions: `Pay to operator A instead ${RUN}`, feeBps: 900 };

    expectLikeMissing(
      'A owner PATCH B method',
      await as('aOwner').patch(`/v1/admin/payment-methods/${bMethodId}`).send(patch),
      await as('aOwner').patch(`/v1/admin/payment-methods/${randomUUID()}`).send(patch),
      'PAYMENT_METHOD_NOT_FOUND',
    );
    expectLikeMissing(
      'A owner DELETE B method',
      await as('aOwner').delete(`/v1/admin/payment-methods/${bMethodId}`),
      await as('aOwner').delete(`/v1/admin/payment-methods/${randomUUID()}`),
      'PAYMENT_METHOD_NOT_FOUND',
    );
    expect(await trailOf(operatorB)).toEqual(trailBefore);

    await as('platform')
      .patch(`/v1/admin/payment-methods/${bMethodId}`)
      .set(TENANT_HEADER, operatorB)
      .send({ instructions: 'Edited by the platform' })
      .expect(200);
    const audits = await prisma.auditLog.findMany({
      where: { action: 'payment_method.updated', entityId: bMethodId },
    });
    expect(audits.map((row) => row.tenantId)).toEqual([operatorB]);
  });

  it("C3: A's staff cannot re-weight, relabel or retire B's receiving account", async () => {
    const trailBefore = await trailOf(operatorB);
    const patch = { isActive: false, priority: 10_000, accountHolder: 'Hijacked' };

    expectLikeMissing(
      'A owner PATCH B destination',
      await as('aOwner').patch(`/v1/admin/payment-destinations/${bDestinationId}`).send(patch),
      await as('aOwner').patch(`/v1/admin/payment-destinations/${randomUUID()}`).send(patch),
      'DESTINATION_NOT_FOUND',
    );
    expectLikeMissing(
      'A owner DELETE B destination',
      await as('aOwner').delete(`/v1/admin/payment-destinations/${bDestinationId}`),
      await as('aOwner').delete(`/v1/admin/payment-destinations/${randomUUID()}`),
      'DESTINATION_NOT_FOUND',
    );
    expect(await trailOf(operatorB)).toEqual(trailBefore);

    const DestinationPicker = (await import('./payment-method/services/destination-picker.service'))
      .DestinationPickerService;
    const picked = await ctx.inTenant(
      () => ctx.app.get(DestinationPicker).pickFor(bMethodId, randomUUID()),
      operatorB,
    );
    expect(picked.id).toBe(bDestinationId);

    await as('platform')
      .patch(`/v1/admin/payment-destinations/${bDestinationId}`)
      .set(TENANT_HEADER, operatorB)
      .send({ label: 'B wallet (platform)' })
      .expect(200);
  });

  it("C4: A's staff cannot read B's deposit detail; B's own viewer and a platform admin in B can", async () => {
    expectLikeMissing(
      'A viewer GET B deposit',
      await as('aViewer').get(`/v1/admin/deposits/${bSubmittedId}`),
      await as('aViewer').get(`/v1/admin/deposits/${randomUUID()}`),
      'DEPOSIT_NOT_FOUND',
    );

    const own = await as('bViewer').get(`/v1/admin/deposits/${bSubmittedId}`).expect(200);
    expect(withId.parse(envelopeSchema.parse(own.body).data).id).toBe(bSubmittedId);
    await as('platform')
      .get(`/v1/admin/deposits/${bSubmittedId}`)
      .set(TENANT_HEADER, operatorB)
      .expect(200);
  });

  it("C5: A's staff get neither a URL for nor the bytes of B's player's receipt, and storage is never asked", async () => {
    const presign = jest.spyOn(storage, 'presignGet');
    const stream = jest.spyOn(storage, 'getStream');

    for (const kind of ['url', 'content'] as const) {
      expectLikeMissing(
        `A viewer GET B proof ${kind}`,
        await as('aViewer').get(`/v1/admin/deposits/${bSubmittedId}/proofs/${bProofId}/${kind}`),
        await as('aViewer').get(`/v1/admin/deposits/${randomUUID()}/proofs/${randomUUID()}/${kind}`),
        'PROOF_NOT_FOUND',
      );
    }
    expect(presign).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();

    await as('bViewer').get(`/v1/admin/deposits/${bSubmittedId}/proofs/${bProofId}/url`).expect(200);
    await as('bViewer').get(`/v1/admin/deposits/${bSubmittedId}/proofs/${bProofId}/content`).expect(200);
    expect(presign).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledTimes(1);

    presign.mockRestore();
    stream.mockRestore();
  });

  it("C6: A's staff cannot read B's method configuration or use its destinations list as an oracle", async () => {
    expectLikeMissing(
      'A owner GET B method',
      await as('aOwner').get(`/v1/admin/payment-methods/${bMethodId}`),
      await as('aOwner').get(`/v1/admin/payment-methods/${randomUUID()}`),
      'PAYMENT_METHOD_NOT_FOUND',
    );
    expectLikeMissing(
      'A owner GET B method destinations',
      await as('aOwner').get(`/v1/admin/payment-methods/${bMethodId}/destinations`),
      await as('aOwner').get(`/v1/admin/payment-methods/${randomUUID()}/destinations`),
      'PAYMENT_METHOD_NOT_FOUND',
    );

    await as('bOwner').get(`/v1/admin/payment-methods/${bMethodId}`).expect(200);
    await as('bOwner').get(`/v1/admin/payment-methods/${bMethodId}/destinations`).expect(200);
  });

  it("C7: A's staff cannot read B's reconciliation break; B's viewer and a platform admin in B can", async () => {
    expectLikeMissing(
      'A viewer GET B break',
      await as('aViewer').get(`/v1/admin/reconciliation/breaks/${bBreakId}`),
      await as('aViewer').get(`/v1/admin/reconciliation/breaks/${randomUUID()}`),
      'BREAK_NOT_FOUND',
    );

    const own = await as('bViewer').get(`/v1/admin/reconciliation/breaks/${bBreakId}`).expect(200);
    expect(withId.parse(envelopeSchema.parse(own.body).data).id).toBe(bBreakId);
    await as('platform')
      .get(`/v1/admin/reconciliation/breaks/${bBreakId}`)
      .set(TENANT_HEADER, operatorB)
      .expect(200);
  });

  it("C9 (HTTP): claim, release, approve, reject and retry-credit on B's deposits answer like missing ones and write nothing", async () => {
    const trailBefore = await trailOf(operatorB);

    const probes: Array<[string, keyof typeof bearer, string, string, object]> = [
      ['claim', 'aReviewer', 'claim', bSubmittedId, {}],
      ['release', 'aReviewer', 'release', bSubmittedId, {}],
      ['approve', 'aReviewer', 'approve', bSubmittedId, {}],
      ['reject', 'aReviewer', 'reject', bSubmittedId, { rejectionCode: 'PROOF_UNREADABLE' }],
      ['retry-credit', 'aFinance', 'retry-credit', bCreditFailedId, {}],
    ];
    for (const [probe, who, action, depositId, body] of probes) {
      expectLikeMissing(
        `${who} ${probe}`,
        await as(who).post(`/v1/admin/deposits/${depositId}/${action}`).send(body),
        await as(who).post(`/v1/admin/deposits/${randomUUID()}/${action}`).send(body),
        'DEPOSIT_NOT_FOUND',
      );
    }

    expect(await trailOf(operatorB)).toEqual(trailBefore);

    // B's own reviewer takes the same deposit.
    const claimed = await as('bReviewer').post(`/v1/admin/deposits/${bSubmittedId}/claim`).send({}).expect(200);
    expect(z.looseObject({ kind: z.string() }).parse(envelopeSchema.parse(claimed.body).data).kind).toBe(
      'claimed',
    );
  });

  it("C9 (bot): a button naming B's deposit, tapped on C's own bot by C's reviewer, finds nothing and moves nothing", async () => {
    const { DepositTelegramHandlers } = await import('./deposit/telegram/deposit.handlers');
    const { DepositRepository } = await import('./deposit/repositories/deposit.repository');
    const { DepositService } = await import('./deposit/services/deposit.service');
    const { DepositReviewService } = await import('./deposit/services/deposit-review.service');
    // The handlers are a worker-role provider; this is the same object, built from the api's graph.
    const handlers = new DepositTelegramHandlers(
      prisma,
      ctx.app.get(DepositRepository),
      ctx.app.get(DepositService),
      ctx.app.get(DepositReviewService),
      ctx.app.get(AdminIdentityService),
      ctx.app.get(TelegramFileService),
      ctx.app.get(BotService),
    );
    const bot = new Bot(cToken, {
      botInfo: testBotInfo(cBotId, `iso_${RUN}_bot`),
      client: telegram.clientOptions,
    });
    bot.on('callback_query:data', (tgContext) => handlers.onDepositCallback(tgContext));

    let updateId = Date.now();
    const tap = async (action: string, depositId: string): Promise<void> => {
      updateId += 1;
      const update = {
        update_id: updateId,
        callback_query: {
          id: `cb-${String(updateId)}`,
          from: { id: cReviewerTelegramId, is_bot: false, first_name: 'Reviewer' },
          chat_instance: 'iso',
          data: `d:${action}:${depositId}`,
          message: {
            message_id: 77,
            date: Math.floor(Date.now() / 1000),
            chat: { id: -1_001_000_000_000, type: 'supergroup', title: 'Admins' },
            text: 'card',
          },
        },
      } as unknown as Update;
      // What TelegramUpdateProcessor does: the operator whose bot received the update.
      await runWithTenant(operatorC, () => bot.handleUpdate(update));
    };

    const trailBefore = await trailOf(operatorB);
    for (const action of ['c', 'a', 'r']) await tap(action, bSubmittedId);

    expect(await trailOf(operatorB)).toEqual(trailBefore);
    const answers = telegram
      .callsFor(cToken, 'answerCallbackQuery')
      .map((call) => call.payload['text']);
    expect(answers).toEqual(['Deposit not found.', 'Deposit not found.', 'Deposit not found.']);
    // The card is not redrawn with another operator's deposit on it.
    expect(telegram.callsFor(cToken, 'editMessageText')).toHaveLength(0);

    // C's own deposit, same reviewer, same bot.
    await tap('c', cDepositId);
    expect((await prisma.depositRequest.findUniqueOrThrow({ where: { id: cDepositId } })).status).toBe(
      DepositStatus.UNDER_REVIEW,
    );
    expect(telegram.callsFor(cToken, 'editMessageText')).toHaveLength(1);
  });

  it("C10: a bootstrap player posting B's method id gets the same 404 as an unknown id, and no deposit", async () => {
    const telegramUserId = 7_500_000_000n + BigInt(Date.now() % 1_000_000);
    const playerId = await createPlayer(OPERATOR_A, telegramUserId);
    const session = await ctx.app.get(SessionService).issueForPlayer(OPERATOR_A, playerId, telegramUserId);
    const create = (paymentMethodId: string, amount = '100.00'): request.Test =>
      request(ctx.httpServer)
        .post('/v1/deposits')
        .set('authorization', `Bearer ${session.accessToken}`)
        .set('idempotency-key', randomUUID())
        .send({ paymentMethodId, amount: { amount, currencyCode: 'NSP' } });

    expectLikeMissing(
      'player POST deposit on B method',
      await create(bMethodId),
      await create(randomUUID()),
      'PAYMENT_METHOD_NOT_FOUND',
    );
    expect(await prisma.depositRequest.count({ where: { playerId } })).toBe(0);

    // The player's own operator's method still opens a deposit.
    const ownMethods = await prisma.paymentMethod.findMany({
      where: { tenantId: OPERATOR_A, isActive: true, requiresReference: false },
      orderBy: { sortOrder: 'asc' },
    });
    let own: { id: string; minAmountMinor: bigint } | undefined;
    for (const method of ownMethods) {
      const destinations = await prisma.paymentDestination.count({
        where: { paymentMethodId: method.id, isActive: true },
      });
      if (destinations > 0) {
        own = method;
        break;
      }
    }
    if (own === undefined) throw new Error('the seed left the bootstrap operator no usable method');
    await create(own.id, formatMinorToDecimal(own.minAmountMinor)).expect(201);
    expect(await prisma.depositRequest.count({ where: { playerId } })).toBe(1);
  });

  it("C8: A's proof-ingest job does not match B's receipt; B's own second receipt does", async () => {
    const { ProofIngestService } = await import('./deposit/services/proof-ingest.service');
    const ingest = ctx.app.get(ProofIngestService);
    const { original, variant } = await receiptImages();
    const aMethod = await prisma.paymentMethod.findFirstOrThrow({ where: { tenantId: OPERATOR_A } });
    const aPlayerId = await createPlayer(OPERATOR_A, 7_600_000_000n + BigInt(Date.now() % 1_000_000));

    // B indexes a receipt.
    const bFirst = await createDeposit({
      tenantId: operatorB,
      shortId: shortIdFor('B1'),
      playerId: bPlayerId,
      paymentMethodId: bMethodId,
      status: DepositStatus.SUBMITTED,
    });
    const bFirstOutcome = await ingest.ingest(
      await createRawProof(operatorB, bFirst, bPlayerId, original),
    );
    expect(bFirstOutcome.status).toBe('normalized');

    // A's job, same picture, one pixel off.
    const aDeposit = await createDeposit({
      tenantId: OPERATOR_A,
      shortId: shortIdFor('A1'),
      playerId: aPlayerId,
      paymentMethodId: aMethod.id,
      status: DepositStatus.SUBMITTED,
    });
    const aOutcome = await ingest.ingest(await createRawProof(OPERATOR_A, aDeposit, aPlayerId, variant));
    expect(aOutcome.status).toBe('normalized');
    expect(aOutcome.riskFlags.filter((flag) => flag.startsWith('DUPLICATE_PROOF'))).toEqual([]);
    // Nothing of B's was written into A's evidence either.
    const aTransitions = await prisma.depositTransition.findMany({
      where: { depositRequestId: aDeposit },
    });
    expect(JSON.stringify(aTransitions.map((row) => row.metadata))).not.toContain(bFirst);

    // B's second player, same picture: the index still works inside B.
    const bSecond = await createDeposit({
      tenantId: operatorB,
      shortId: shortIdFor('B2'),
      playerId: bSecondPlayerId,
      paymentMethodId: bMethodId,
      status: DepositStatus.SUBMITTED,
    });
    const bSecondOutcome = await ingest.ingest(
      await createRawProof(operatorB, bSecond, bSecondPlayerId, variant),
    );
    expect(bSecondOutcome.riskFlags.some((flag) => flag.startsWith('DUPLICATE_PROOF'))).toBe(true);

    const keys = await ctx.app.get(RedisService).keys('proof:phash:*');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.includes(`:${operatorB}:`) || key.includes(`:${OPERATOR_A}:`))).toBe(
      true,
    );
  });

  it("C11: operator A's failing agent opens A's breaker only, and the alert job tells A only", async () => {
    const redis = ctx.app.get(RedisService);
    const config = { ichancy: { fake: false }, app: { isWorker: true } } as unknown as AppConfigService;
    const health = new IchancyHealthService(redis, config);

    for (let i = 0; i < ICHANCY_DOWN_THRESHOLD; i += 1) {
      await health.record(OPERATOR_A, 'getAgentAllWallets', CHALLENGE);
    }
    expect(await health.isDown(OPERATOR_A)).toBe(true);
    expect(await health.isDown(operatorB)).toBe(false);

    const told: Array<{ tenantId: string; text: string }> = [];
    const botStub = {
      chatsOf: () => Promise.resolve({ adminChatId: -1_001_000_000_000n, feedChatId: null }),
      notifyAdmins: (tenantId: string, text: string) => {
        told.push({ tenantId, text });
        return Promise.resolve({ message_id: told.length });
      },
    } as unknown as BotService;
    const tenantsStub = {
      listActiveOperators: () =>
        Promise.resolve([
          { id: OPERATOR_A, slug: 'bootstrap' },
          { id: operatorB, slug: 'b' },
        ]),
    } as unknown as TenantRegistryService;

    const { IchancyHealthAlertCron } = await import('./reconciliation/services/ichancy-health.cron');
    const cron = new IchancyHealthAlertCron(
      health,
      botStub,
      ctx.app.get(LockService),
      redis,
      prisma,
      tenantsStub,
      config,
    );
    await cron.tick();

    expect(told.map((entry) => entry.tenantId)).toEqual([OPERATOR_A]);
    expect(told[0]?.text).toContain('getAgentAllWallets');
  });
});
