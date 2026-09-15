/**
 * Every operator's Ichancy calls are made with THAT operator's own agent — proven at the HTTP level.
 *
 * The real api (AppModule, middleware, guards, pipes, Postgres, Redis) with ICHANCY_FAKE=0: the real
 * HttpIchancyAdapter, the real per-agent IchancySessionService with its Redis locks and token pairs,
 * the real IchancyHttpClient and call log. Only the TRANSPORT is replaced (ICHANCY_TRANSPORT), by a
 * stub Ichancy that holds agent accounts per host and login, answers signin with a token pair, kills
 * the previous pair on every sign-in (one token pair per agent, as Ichancy does), and records the
 * URL, the login presented and the bearer token of every request. So a test can say exactly which
 * agent account each call was made as. ICHANCY_FAKE would prove none of this: the fake adapter never
 * touches the session layer.
 *
 * Telegram is the offline fake (test/setup/telegram-fixtures.ts) injected into TenantBotRegistry, as
 * in tenant-provisioning.int.spec.ts. Nothing can reach Ichancy or Telegram.
 *
 * What only this level proves:
 *  - activation signs in with the operator's own username and password at its own base URL, moves
 *    SUSPENDED to ACTIVE, audits it as a sign-in and evicts the registry; wrong credentials leave it
 *    SUSPENDED with a 422;
 *  - two operators sharing one agent reuse ONE session and ONE sign-in, while each registration still
 *    carries its own operator's agent id; an operator naming the same login with another password is
 *    never lent that session;
 *  - PATCH /:id/ichancy verifies before saving, seals the new password, moves the session with the
 *    login, and refuses an agent id change under players;
 *  - import-players creates, then finds existing, answers 409 under the lock and 200 with `error`
 *    when Ichancy refuses;
 *  - provisioning activates a created operator and then imports its players, or reports both steps
 *    as not done when the sign-in is refused;
 *  - a deposit credit for operator B, end to end through DepositCreditService, is made entirely with
 *    B's agent (host, token, agent id, float) and never touches operator A's.
 *
 * `tenants`, `platform_defaults` and `currencies` survive truncateAll, so the operators this suite adds
 * carry a run-unique slug prefix and are deleted in afterAll, after a reset has cleared the append-only
 * rows holding them in place.
 *
 * Run with the escape hatch (no testcontainers):
 *   POSTGRES_TEST_URL=... REDIS_TEST_URL=... TEST_REDIS_URL=... TEST_DATABASE_URL=... \
 *     npx jest --config jest-int.config.cjs --runInBand src/modules/tenant/tenant-ichancy.int.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { AdminRole, DepositStatus, LedgerTxKind, PlayerSource, TenantStatus } from '@prisma/client';
import request from 'supertest';
import { z } from 'zod';

import { SYSTEM_ACTOR } from '@common/types/actor.type';
import { PasswordHasherService } from '@core/auth/services/password-hasher.service';
import { CacheService } from '@core/cache/cache.service';
import { LockService } from '@core/cache/lock.service';
import { RedisService } from '@core/cache/redis.service';
import {
  ICHANCY_AGENT_RESOLVER,
  ichancyAgentKey,
  type IchancyAgentResolver,
} from '@core/ichancy/ichancy-agent';
import { IchancySessionService, ichancyTokensKey } from '@core/ichancy/ichancy-session.service';
import { ICHANCY_PORT, type IchancyPort } from '@core/ichancy/ichancy.port';
import {
  ICHANCY_TRANSPORT,
  type IchancyTransport,
  type IchancyTransportRequest,
  type IchancyTransportResponse,
} from '@core/ichancy/transport/ichancy-transport';
import {
  LedgerService,
  depositApproved,
  houseRoundingCode,
  ichancyAgentFloatCode,
} from '@core/ledger';
import {
  OPERATOR_DEFAULT_PAYMENT_METHODS,
  ensurePaymentMethods,
} from '@core/payment-rails/default-payment-methods';
import { PrismaService } from '@core/prisma/prisma.service';
import { TelegramHandlerRegistrar } from '@core/telegram/services/handler-registrar.service';
import { TenantBotRegistry } from '@core/telegram/services/tenant-bot-registry.service';
import { TenantRegistryService } from '@core/tenant/services/tenant-registry.service';
import { TenantSecretService } from '@core/tenant/services/tenant-secret.service';
import { TENANT_ZERO_ID, tenantRegistryKey } from '@core/tenant/tenant.constants';

import { createTestApp, type TestApp } from '../../../test/setup/app-factory';
import { createFakeTelegram, testBotInfo } from '../../../test/setup/telegram-fixtures';
import type { DepositCreditService } from '../deposit/services/deposit-credit.service';
import type { PlayerService } from '../player/services/player.service';

import {
  DEFAULT_PLAYER_IMPORT_LIMITS,
  PLAYERS_NOT_IMPORTED_MESSAGE,
  TENANT_IMPORT_LIMITS,
  importPlayersCursorKey,
  importPlayersLockKey,
} from './tenant-admin.constants';

jest.setTimeout(240_000);

// ── The console's contract, copied from manager-account-dashboard src/types ─────────────────────
const tenantSchema = z.looseObject({ id: z.string(), status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']) });
const provisioningSchema = z.looseObject({
  activated: z.boolean(),
  activationError: z.string().nullable(),
  playersImported: z.number(),
  playersImportError: z.string().nullable(),
  ichancyFake: z.boolean(),
});
const tenantCreatedSchema = tenantSchema.extend({ provisioning: provisioningSchema });
const playerImportSummarySchema = z.looseObject({
  scanned: z.number(),
  created: z.number(),
  existing: z.number(),
  error: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string(),
  ichancyFake: z.boolean(),
});
const ichancyHealthSchema = z.looseObject({
  ichancy: z.looseObject({
    ok: z.boolean(),
    fake: z.boolean(),
    baseUrl: z.string(),
    username: z.string(),
    agentId: z.string(),
    checkedAt: z.string(),
    error: z.string().nullable(),
    floatMinor: z.string().nullable(),
    belowWatermark: z.boolean(),
    sharesAgentWith: z.array(z.string()),
  }),
});
const errorEnvelopeSchema = z.looseObject({
  success: z.literal(false),
  error: z.looseObject({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

const RUN = Date.now().toString(36);
const SLUG_PREFIX = 'p11-int-';
const PASSWORD = 'Correct-Horse-11';
const API_BASE_URL = 'https://api.p11-int.example';
const HOST_A = 'https://agents-a.p11-int.example';
const HOST_B = 'https://agents-b.p11-int.example';
const PLATFORM_TELEGRAM_ID = 7_200_000_000n + BigInt(Date.now() % 1_000_000);
const agentLogin = (name: string): string => `p11-${RUN}-${name}`;

type Body = { success: boolean; data: unknown; error: unknown };

// ── The stub Ichancy ─────────────────────────────────────────────────────────────────────────────

interface StubPlayer {
  id: string;
  login: string;
  email: string | null;
  balanceMinor: bigint;
  /** The agent id it was registered under; null models a listing that does not say. */
  parentId: string | null;
}

/** A player seeded onto a stub account: a bare login, or one with the agent id it hangs off. */
type StubSeed = string | { login: string; parentId: string | null };

interface StubAccount {
  readonly key: string;
  password: string;
  access: string | null;
  refresh: string | null;
  signIns: number;
  walletMinor: bigint;
  readonly players: Map<string, StubPlayer>;
}

interface StubRequest {
  readonly endpoint: string;
  readonly origin: string;
  /** The login a signin presented, else null. */
  readonly signinLogin: string | null;
  /** Whether a signin's password matched the account's, else null. */
  readonly passwordMatched: boolean | null;
  /** The account the bearer token belonged to when the request arrived, or null. */
  readonly bearerAccount: string | null;
  readonly body: Record<string, unknown>;
  readonly agentKey: string | null;
}

const decimalOf = (minor: bigint): string => {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const text = `${(absolute / 100n).toString()}.${(absolute % 100n).toString().padStart(2, '0')}`;
  return negative ? `-${text}` : text;
};

const minorOf = (amount: unknown): bigint =>
  typeof amount === 'number' ? BigInt(amount.toFixed(2).replace('.', '')) : 0n;

const reply = (status: number, envelope: Record<string, unknown>): IchancyTransportResponse => ({
  status,
  contentType: 'application/json',
  text: JSON.stringify(envelope),
});
const ok = (result: unknown): IchancyTransportResponse =>
  reply(200, { status: true, html: '', result, notification: [] });
const failure = (content: string): IchancyTransportResponse =>
  reply(200, { status: false, html: '', result: false, notification: [{ content, status: 'error' }] });
const UNAUTHORIZED = reply(201, {
  status: true,
  result: false,
  notification: [{ content: 'Invalid access', status: 'error' }],
});

class IchancyStub implements IchancyTransport {
  readonly name = 'stub';
  readonly requests: StubRequest[] = [];
  private readonly accounts = new Map<string, StubAccount>();
  private tokenSequence = 0;
  private playerSequence = 0;

  addAccount(
    baseUrl: string,
    login: string,
    password: string,
    options: { walletMinor?: bigint; players?: StubSeed[] } = {},
  ): StubAccount {
    const key = `${new URL(baseUrl).origin}|${login.toLowerCase()}`;
    const account: StubAccount = {
      key,
      password,
      access: null,
      refresh: null,
      signIns: 0,
      walletMinor: options.walletMinor ?? 5_000_000n,
      players: new Map(),
    };
    for (const seed of options.players ?? []) {
      const { login: seeded, parentId } = typeof seed === 'string' ? { login: seed, parentId: null } : seed;
      this.createPlayer(account, seeded, `${seeded}@stub.example`, parentId);
    }
    this.accounts.set(key, account);
    return account;
  }

  account(baseUrl: string, login: string): StubAccount {
    const found = this.accounts.get(`${new URL(baseUrl).origin}|${login.toLowerCase()}`);
    if (found === undefined) throw new Error(`stub has no account ${login} at ${baseUrl}`);
    return found;
  }

  post(request: IchancyTransportRequest): Promise<IchancyTransportResponse> {
    const url = new URL(request.url);
    const endpoint = url.pathname.split('/').pop() ?? '';
    const body = request.body;
    const bearer = [...this.accounts.values()].find(
      (account) => request.accessToken !== null && account.access === request.accessToken,
    );

    let signinLogin: string | null = null;
    let passwordMatched: boolean | null = null;
    let response: IchancyTransportResponse;

    if (endpoint === 'signin') {
      signinLogin = typeof body['username'] === 'string' ? body['username'] : null;
      const account = this.accounts.get(`${url.origin}|${(signinLogin ?? '').toLowerCase()}`);
      passwordMatched = account !== undefined && account.password === body['password'];
      if (account === undefined || !passwordMatched) {
        response = failure('Invalid username or password.');
      } else {
        response = ok(this.rotate(account));
        account.signIns += 1;
      }
    } else if (endpoint === 'refreshToken') {
      const account = [...this.accounts.values()].find((row) => row.refresh === body['refreshToken']);
      response = account === undefined ? failure('Invalid or expired refresh token') : ok(this.rotate(account));
    } else if (bearer === undefined || !bearer.key.startsWith(`${url.origin}|`)) {
      response = UNAUTHORIZED;
    } else {
      response = this.answer(bearer, endpoint, body);
    }

    this.requests.push({
      endpoint,
      origin: url.origin,
      signinLogin,
      passwordMatched,
      bearerAccount: bearer?.key ?? null,
      body,
      agentKey: request.agentKey,
    });
    return Promise.resolve(response);
  }

  private rotate(account: StubAccount): { accessToken: string; refreshToken: string } {
    this.tokenSequence += 1;
    // A new pair kills the previous one: one live pair per agent, as Ichancy does.
    account.access = `stub-access-${String(this.tokenSequence)}`;
    account.refresh = `stub-refresh-${String(this.tokenSequence)}`;
    return { accessToken: account.access, refreshToken: account.refresh };
  }

  private createPlayer(
    account: StubAccount,
    login: string,
    email: string | null,
    parentId: string | null,
  ): StubPlayer {
    this.playerSequence += 1;
    const player: StubPlayer = {
      id: `stub-${RUN}-${String(this.playerSequence)}`,
      login,
      email,
      balanceMinor: 0n,
      parentId,
    };
    account.players.set(player.id, player);
    return player;
  }

  private answer(account: StubAccount, endpoint: string, body: Record<string, unknown>): IchancyTransportResponse {
    const players = [...account.players.values()];
    switch (endpoint) {
      case 'registerPlayer': {
        const input = body['player'] as Record<string, unknown>;
        const login = String(input['login']);
        if (players.some((player) => player.login.toLowerCase() === login.toLowerCase())) {
          return failure('Duplicate login');
        }
        this.createPlayer(account, login, String(input['email']), String(input['parentId']));
        return ok(1);
      }
      case 'getPlayersForCurrentAgent': {
        const filter = (body['filter'] as Record<string, unknown> | undefined)?.['userName'] as
          | Record<string, unknown>
          | undefined;
        const wanted = typeof filter?.['value'] === 'string' ? filter['value'].toLowerCase() : null;
        const matched = players.filter((player) => wanted === null || player.login.toLowerCase() === wanted);
        const start = typeof body['start'] === 'number' ? body['start'] : 0;
        const limit = typeof body['limit'] === 'number' ? body['limit'] : 20;
        return ok({
          records: matched
            .slice(start, start + limit)
            .map((player) => ({
              playerId: player.id,
              username: player.login,
              email: player.email,
              // Omitted, not null, when unknown: a listing that simply does not say.
              ...(player.parentId === null ? {} : { parentId: player.parentId }),
            })),
          totalRecordsCount: String(matched.length),
        });
      }
      case 'getPlayerBalanceById': {
        const player = account.players.get(String(body['playerId']));
        return player === undefined
          ? ok([])
          : ok([{ balance: decimalOf(player.balanceMinor), currencyCode: 'NSP', main: true }]);
      }
      case 'depositToPlayer': {
        const player = account.players.get(String(body['playerId']));
        if (player === undefined) return failure('Wrong arguments');
        const amount = minorOf(body['amount']);
        player.balanceMinor += amount;
        account.walletMinor -= amount;
        return ok({ balance: decimalOf(player.balanceMinor) });
      }
      case 'getAgentAllWallets':
        return ok([
          {
            currencyCode: 'NSP',
            balance: decimalOf(account.walletMinor),
            availableWallet: decimalOf(account.walletMinor),
            mainCurrency: true,
          },
        ]);
      default:
        return ok(1);
    }
  }
}

// ── The suite ────────────────────────────────────────────────────────────────────────────────────

describe('Per-operator Ichancy agents through an HTTP-level stub (integration)', () => {
  const stub = new IchancyStub();
  const telegram = createFakeTelegram();
  // The service holds this very object, so a test can page a five-player agent and restore it.
  const importLimits: { pageSize: number; maxPlayersPerRun: number } = { ...DEFAULT_PLAYER_IMPORT_LIMITS };

  let ctx: TestApp;
  let prisma: PrismaService;
  let cache: CacheService;
  let redis: RedisService;
  let secrets: TenantSecretService;
  let platformBearer: string;
  const envBefore: Record<string, string | undefined> = {};

  const api = () => request(ctx.httpServer);
  const errorOf = (body: unknown) => errorEnvelopeSchema.parse(body).error;
  const auditCount = (tenantId: string, action: string): Promise<number> =>
    prisma.auditLog.count({ where: { tenantId, action } });
  const signIns = (baseUrl: string, login: string) =>
    stub.requests.filter((row) => row.endpoint === 'signin' && row.origin === new URL(baseUrl).origin && row.signinLogin === login);

  let nextBot = 0;
  const newToken = (): { token: string; botId: number } => {
    nextBot += 1;
    const botId = 720_000_000 + nextBot;
    return { token: `${botId}:AAp11int${RUN}n${String(nextBot)}${'x'.repeat(30)}`, botId };
  };

  const createOperator = async (
    name: string,
    agent: { baseUrl: string; login: string; password: string; agentId: string; status?: TenantStatus },
  ): Promise<{ id: string; slug: string }> => {
    const { token, botId } = newToken();
    telegram.accept(token, testBotInfo(botId, `p11_${name.replace(/-/g, '_')}_${RUN}_bot`));
    return prisma.tenant.create({
      data: {
        slug: `${SLUG_PREFIX}${RUN}-${name}`,
        displayName: `P11 ${name}`,
        status: agent.status ?? TenantStatus.SUSPENDED,
        botTokenEnc: secrets.sealBotToken(token),
        botId: BigInt(botId),
        adminChatId: -1001234567890n,
        ichancyBaseUrl: agent.baseUrl,
        ichancyUsername: agent.login,
        ichancyPasswordEnc: secrets.sealIchancyPassword(agent.password),
        ichancyAgentId: agent.agentId,
        currencyCode: 'NSP',
        dualApprovalThresholdMinor: 100_000_000n,
        agentFloatLowWatermarkMinor: 50_000_000n,
        depositExpiryMinutes: 30,
      },
      select: { id: true, slug: true },
    });
  };

  const activate = (id: string): request.Test =>
    api().post(`/v1/admin/tenants/${id}/activate`).set('authorization', platformBearer);

  const removeSuiteRows = async (): Promise<void> => {
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  };

  beforeAll(async () => {
    for (const key of ['ICHANCY_FAKE', 'ICHANCY_TRANSPORT', 'API_BASE_URL']) envBefore[key] = process.env[key];

    ctx = await createTestApp({
      // The REAL adapter and session layer; the transport is the stub below, so nothing leaves.
      env: { ICHANCY_FAKE: '0', ICHANCY_TRANSPORT: 'fetch', API_BASE_URL },
      customize: (builder) => {
        builder.overrideProvider(ICHANCY_TRANSPORT).useValue(stub);
        builder.overrideProvider(TENANT_IMPORT_LIMITS).useValue(importLimits);
        builder.overrideProvider(TenantBotRegistry).useFactory({
          factory: (
            prismaService: PrismaService,
            cacheService: CacheService,
            secretService: TenantSecretService,
            registrar: TelegramHandlerRegistrar,
          ) =>
            new TenantBotRegistry(prismaService, cacheService, secretService, registrar, telegram.clientOptions),
          inject: [PrismaService, CacheService, TenantSecretService, TelegramHandlerRegistrar],
        });
      },
    });
    await new Promise<void>((resolve) => {
      ctx.httpServer.listen(0, '127.0.0.1', resolve);
    });

    prisma = ctx.app.get(PrismaService);
    cache = ctx.app.get(CacheService);
    redis = ctx.app.get(RedisService);
    secrets = ctx.app.get(TenantSecretService);

    await ctx.reset();
    await removeSuiteRows();

    const hash = await ctx.app.get(PasswordHasherService).hash(PASSWORD);
    await prisma.adminUser.create({
      data: {
        tenantId: TENANT_ZERO_ID,
        username: agentLogin('platform'),
        displayName: 'P11 platform admin',
        role: AdminRole.PLATFORM_ADMIN,
        isActive: true,
        passwordHash: hash,
        telegramUserId: PLATFORM_TELEGRAM_ID,
      },
    });
    const signedIn = await api()
      .post('/v1/admin/auth/credentials')
      .send({ username: agentLogin('platform'), password: PASSWORD })
      .expect(200);
    platformBearer = `Bearer ${z.looseObject({ accessToken: z.string() }).parse((signedIn.body as Body).data).accessToken}`;
  });

  afterAll(async () => {
    if (ctx !== undefined) {
      await ctx.reset();
      await removeSuiteRows();
      await ctx.close();
    }
    for (const [key, value] of Object.entries(envBefore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("activates with a real sign-in of the operator's own credentials at its own host, audits it and evicts the registry", async () => {
    const login = agentLogin('alpha');
    stub.addAccount(HOST_A, login, 'alpha-password');
    const alpha = await createOperator('alpha', { baseUrl: HOST_A, login, password: 'alpha-password', agentId: '5001' });

    const registry = ctx.app.get(TenantRegistryService);
    expect(await registry.find(alpha.id)).toMatchObject({ status: TenantStatus.SUSPENDED });

    const response = await activate(alpha.id).expect(200);
    expect(tenantSchema.parse((response.body as Body).data)).toMatchObject({ status: 'ACTIVE', ichancyFake: false });

    // Exactly one sign-in, at alpha's host, presenting alpha's login and alpha's password.
    expect(signIns(HOST_A, login).map((row) => row.passwordMatched)).toEqual([true]);
    expect(stub.account(HOST_A, login).signIns).toBe(1);
    const agentKey = ichancyAgentKey(HOST_A, login);
    expect(await redis.get(ichancyTokensKey(agentKey))).not.toBeNull();

    expect(await cache.get(tenantRegistryKey(alpha.id))).toBeNull();
    expect(await registry.find(alpha.id)).toMatchObject({ status: TenantStatus.ACTIVE });
    const activations = await prisma.auditLog.findMany({ where: { tenantId: alpha.id, action: 'tenant.activated' } });
    expect(activations).toHaveLength(1);
    expect(activations[0]?.after).toMatchObject({
      status: 'ACTIVE',
      $meta: { verification: 'signin', signIn: true, adapter: 'real', agentKey },
    });
    // The sign-in's call-log row is in alpha's log, and no credential is in any evidence or on the wire.
    const calls = await prisma.ichancyCall.findMany({ where: { tenantId: alpha.id, operation: 'SIGNIN' } });
    expect(calls).toHaveLength(1);
    const evidence = JSON.stringify([activations, calls, response.body]);
    expect(evidence).not.toContain('alpha-password');
    expect(evidence).not.toContain('stub-access-');
  });

  it('leaves an operator with wrong credentials SUSPENDED with 422, recording the refusal and nothing else', async () => {
    const login = agentLogin('wrong');
    stub.addAccount(HOST_A, login, 'the-right-password');
    const wrong = await createOperator('wrong', { baseUrl: HOST_A, login, password: 'a-wrong-password', agentId: '5002' });
    const before = stub.requests.length;

    const refused = await activate(wrong.id).expect(422);

    expect(errorOf(refused.body)).toMatchObject({
      code: 'ICHANCY_SIGNIN_FAILED',
      message: expect.stringContaining('The operator stays suspended.'),
    });
    expect(JSON.stringify(refused.body)).not.toContain('a-wrong-password');
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: wrong.id } })).status).toBe(TenantStatus.SUSPENDED);
    expect(await auditCount(wrong.id, 'tenant.activation.refused')).toBe(1);
    expect(await auditCount(wrong.id, 'tenant.activated')).toBe(0);
    // One sign-in attempt, with this operator's own login and its own (wrong) password, and nothing else.
    expect(stub.requests.slice(before).map((row) => [row.endpoint, row.signinLogin, row.passwordMatched])).toEqual([
      ['signin', login, false],
    ]);
    expect(await redis.get(ichancyTokensKey(ichancyAgentKey(HOST_A, login)))).toBeNull();
  });

  it('lets two operators sharing one agent reuse one session and one sign-in, each registering under its own agent id, and never lends the session to a different password', async () => {
    const login = agentLogin('shared');
    const account = stub.addAccount(HOST_B, login, 'shared-password', { walletMinor: 12_345_600n });
    const north = await createOperator('north', { baseUrl: HOST_B, login, password: 'shared-password', agentId: '6001' });
    const south = await createOperator('south', { baseUrl: HOST_B, login, password: 'shared-password', agentId: '6002' });
    const stale = await createOperator('stale', { baseUrl: HOST_B, login, password: 'an-old-password', agentId: '6003' });
    const port = ctx.app.get<IchancyPort>(ICHANCY_PORT);

    await activate(north.id).expect(200);
    expect(account.signIns).toBe(1);

    // South never signed in, yet its calls work: the session belongs to the login they share.
    const before = stub.requests.length;
    const wallet = await ctx.inTenant(() => port.getAgentWallet(), south.id);
    expect(wallet).toEqual({ kind: 'ok', data: { balanceMinor: 12_345_600n, availableMinor: 12_345_600n } });
    const southPlayer = await ctx.inTenant(
      () => port.ensurePlayer({ login: `p11s${RUN}`, email: `p11s${RUN}@players.example.com`, password: 'player-pw-1' }),
      south.id,
    );
    const northPlayer = await ctx.inTenant(
      () => port.ensurePlayer({ login: `p11n${RUN}`, email: `p11n${RUN}@players.example.com`, password: 'player-pw-2' }),
      north.id,
    );
    expect(southPlayer.kind).toBe('ok');
    expect(northPlayer.kind).toBe('ok');

    const made = stub.requests.slice(before);
    expect(account.signIns).toBe(1);
    expect(made.every((row) => row.bearerAccount === account.key && row.origin === new URL(HOST_B).origin)).toBe(true);
    expect(made.every((row) => row.agentKey === ichancyAgentKey(HOST_B, login))).toBe(true);
    const parents = made
      .filter((row) => row.endpoint === 'registerPlayer')
      .map((row) => (row.body['player'] as Record<string, unknown>)['parentId']);
    expect(parents).toEqual(['6002', '6001']);

    // One session for the login, verified to belong to exactly these credentials.
    const resolver = ctx.app.get<IchancyAgentResolver>(ICHANCY_AGENT_RESOLVER);
    const session = ctx.app.get(IchancySessionService);
    expect(await session.describe(await resolver.forTenant(south.id))).toMatchObject({
      hasSession: true,
      matchesCredentials: true,
    });

    // Same login, different stored password: the session is not lent, and nothing is sent for it.
    const staleBefore = stub.requests.length;
    const refused = await ctx.inTenant(() => port.getAgentWallet(), stale.id);
    expect(refused).toMatchObject({ kind: 'rejected', code: 'ICHANCY_SESSION_CREDENTIALS_CHANGED' });
    expect(stub.requests.length).toBe(staleBefore);

    // Health names the operators on the same login and reads the float without another sign-in.
    const health = ichancyHealthSchema.parse(
      ((await api().get(`/v1/admin/tenants/${north.id}/health`).set('authorization', platformBearer).expect(200))
        .body as Body).data,
    );
    expect(health.ichancy).toMatchObject({
      ok: true,
      // Real mode (ICHANCY_FAKE=0 for this suite): the flag is present and false.
      fake: false,
      baseUrl: HOST_B,
      username: login,
      agentId: '6001',
      error: null,
      floatMinor: '12345600',
      // 123,456.00 against this operator's own watermark of 500,000.00.
      belowWatermark: true,
      sharesAgentWith: [south.slug, stale.slug].sort(),
    });
    expect(account.signIns).toBe(1);
  });

  it('PATCH /ichancy verifies before saving, seals the new password, moves the session with the login, and refuses an agent id change under players', async () => {
    const login = agentLogin('edit');
    const first = stub.addAccount(HOST_A, login, 'first-password');
    const edit = await createOperator('edit', { baseUrl: HOST_A, login, password: 'first-password', agentId: '7001' });
    await activate(edit.id).expect(200);
    const patch = (body: Record<string, unknown>): request.Test =>
      api().patch(`/v1/admin/tenants/${edit.id}/ichancy`).set('authorization', platformBearer).send(body);
    const sealedBefore = (await prisma.tenant.findUniqueOrThrow({ where: { id: edit.id } })).ichancyPasswordEnc;

    // A password Ichancy refuses is never saved.
    const refused = await patch({ ichancyPassword: 'not-the-password' }).expect(422);
    expect(errorOf(refused.body)).toMatchObject({
      code: 'ICHANCY_SIGNIN_FAILED',
      message: expect.stringContaining('Nothing was saved.'),
    });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: edit.id } })).ichancyPasswordEnc).toBe(sealedBefore);
    // The refused edit is on record, naming what it tried to change and never the password it tried.
    const editRefused = await prisma.auditLog.findMany({ where: { tenantId: edit.id, action: 'tenant.ichancy.update.refused' } });
    expect(editRefused).toHaveLength(1);
    expect(editRefused[0]?.after).toMatchObject({
      $meta: { code: 'ICHANCY_SIGNIN_FAILED', fields: ['ichancyPassword'], targetOrigin: null },
    });
    expect(JSON.stringify(editRefused)).not.toContain('not-the-password');

    // The password changed at Ichancy: the new one is verified, sealed, and its session takes over.
    first.password = 'second-password';
    await patch({ ichancyPassword: 'second-password' }).expect(200);
    const row = await prisma.tenant.findUniqueOrThrow({ where: { id: edit.id } });
    expect(row.ichancyPasswordEnc).not.toContain('second-password');
    expect(secrets.openIchancyPassword(row)).toBe('second-password');
    const resolver = ctx.app.get<IchancyAgentResolver>(ICHANCY_AGENT_RESOLVER);
    const session = ctx.app.get(IchancySessionService);
    expect(await session.describe(await resolver.forTenant(edit.id))).toMatchObject({ matchesCredentials: true });
    const updated = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: edit.id, action: 'tenant.ichancy.updated' } });
    expect(updated.after).toMatchObject({ $meta: { passwordChanged: true, verification: 'signin' } });
    expect(JSON.stringify(updated)).not.toContain('second-password');

    // A move to another host WITHOUT the password is refused before anything is sent there: the stored
    // password never goes to a host the request names. The attempt, and the origin it named, is recorded.
    stub.addAccount(HOST_B, login, 'second-password');
    const hostBOrigin = new URL(HOST_B).origin;
    const beforeMove = stub.requests.length;
    const noPassword = await patch({ ichancyBaseUrl: `${HOST_B}/` }).expect(400);
    expect(errorOf(noPassword.body)).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: [expect.stringContaining('ichancyPassword is required')] },
    });
    expect(stub.requests.slice(beforeMove)).toEqual([]);
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: edit.id } })).ichancyBaseUrl).toBe(HOST_A);
    const moveRefused = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: edit.id, action: 'tenant.ichancy.update.refused' },
      orderBy: { createdAt: 'desc' },
    });
    expect(moveRefused.after).toMatchObject({
      $meta: { code: 'VALIDATION_FAILED', fields: ['ichancyBaseUrl'], targetOrigin: hostBOrigin },
    });
    expect(JSON.stringify(moveRefused)).not.toContain('second-password');

    // With the password, the operator moves: verified there, and the old agent's session is dropped.
    await patch({ ichancyBaseUrl: `${HOST_B}/`, ichancyPassword: 'second-password' }).expect(200);
    expect(
      stub.requests
        .slice(beforeMove)
        .filter((row) => row.endpoint === 'signin')
        .map((row) => [row.origin, row.passwordMatched]),
    ).toEqual([[hostBOrigin, true]]);
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: edit.id } })).ichancyBaseUrl).toBe(HOST_B);
    expect(await redis.get(ichancyTokensKey(ichancyAgentKey(HOST_A, login)))).toBeNull();
    expect(await redis.get(ichancyTokensKey(ichancyAgentKey(HOST_B, login)))).not.toBeNull();

    // Players hang off the agent: a new agent id under them is refused, before any sign-in.
    await prisma.player.create({
      data: { tenantId: edit.id, telegramUserId: 7_300_000_000n + BigInt(Date.now() % 1_000_000), currencyCode: 'NSP' },
    });
    const signInsBefore = stub.requests.filter((request) => request.endpoint === 'signin').length;
    const withPlayers = await patch({ ichancyAgentId: '7999' }).expect(422);
    expect(errorOf(withPlayers.body)).toMatchObject({ code: 'TENANT_AGENT_HAS_PLAYERS', details: { players: 1 } });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: edit.id } })).ichancyAgentId).toBe('7001');
    expect(stub.requests.filter((request) => request.endpoint === 'signin').length).toBe(signInsBefore);
  });

  it("imports the agent's players idempotently, answers 409 under the lock, and reports an Ichancy refusal in `error`", async () => {
    const login = agentLogin('import');
    stub.addAccount(HOST_A, login, 'import-password', { players: [`old1${RUN}`, `old2${RUN}`, `old3${RUN}`] });
    const importer = await createOperator('import', { baseUrl: HOST_A, login, password: 'import-password', agentId: '8001' });
    const importPlayers = (id: string): request.Test =>
      api().post(`/v1/admin/tenants/${id}/import-players`).set('authorization', platformBearer);

    // No session yet: the import proves the operator's credentials first, then reads its own agent.
    const first = playerImportSummarySchema.parse(((await importPlayers(importer.id).expect(200)).body as Body).data);
    expect(first).toMatchObject({ scanned: 3, created: 3, existing: 0, error: null });
    const rows = await prisma.player.findMany({ where: { tenantId: importer.id }, orderBy: { ichancyLogin: 'asc' } });
    expect(rows.map((player) => [player.ichancyLogin, player.source, player.telegramUserId, player.status])).toEqual([
      [`old1${RUN}`, PlayerSource.ICHANCY_IMPORT, null, 'ACTIVE'],
      [`old2${RUN}`, PlayerSource.ICHANCY_IMPORT, null, 'ACTIVE'],
      [`old3${RUN}`, PlayerSource.ICHANCY_IMPORT, null, 'ACTIVE'],
    ]);

    const second = playerImportSummarySchema.parse(((await importPlayers(importer.id).expect(200)).body as Body).data);
    expect(second).toMatchObject({ scanned: 3, created: 0, existing: 3, error: null });
    expect(await prisma.player.count({ where: { tenantId: importer.id } })).toBe(3);

    const locks = ctx.app.get(LockService);
    const held = await locks.acquire(importPlayersLockKey(importer.id), 60_000);
    try {
      const busy = await importPlayers(importer.id).expect(409);
      expect(errorOf(busy.body)).toEqual({
        code: 'IMPORT_ALREADY_RUNNING',
        message: 'An import is already running for this operator.',
      });
    } finally {
      if (held !== null) await locks.release(held);
    }

    // An operator whose credentials Ichancy refuses: 200, nothing created, and the reason in `error`.
    const broken = await createOperator('import-broken', {
      baseUrl: HOST_A,
      login: agentLogin('no-such-agent'),
      password: 'whatever',
      agentId: '8002',
    });
    const failed = playerImportSummarySchema.parse(((await importPlayers(broken.id).expect(200)).body as Body).data);
    expect(failed).toMatchObject({ scanned: 0, created: 0, existing: 0, error: expect.stringContaining('INVALID_CREDENTIALS') });
  });

  it('pages past the first page to the end, stops at the safety bound saying so, and the next run continues where it stopped', async () => {
    const importPlayers = (id: string): request.Test =>
      api().post(`/v1/admin/tenants/${id}/import-players`).set('authorization', platformBearer);
    const listingStarts = (account: { key: string }, from: number): unknown[] =>
      stub.requests
        .slice(from)
        .filter((row) => row.endpoint === 'getPlayersForCurrentAgent' && row.bearerAccount === account.key)
        .map((row) => row.body['start']);
    const five = (prefix: string): string[] => [1, 2, 3, 4, 5].map((n) => `${prefix}${String(n)}${RUN}`);

    try {
      importLimits.pageSize = 2;

      // Three pages of two: the run reads until Ichancy's short page, not until a fixed count.
      const pagedLogin = agentLogin('paged');
      const pagedAccount = stub.addAccount(HOST_A, pagedLogin, 'paged-password', { players: five('pg') });
      const paged = await createOperator('paged', { baseUrl: HOST_A, login: pagedLogin, password: 'paged-password', agentId: '8101' });
      const before = stub.requests.length;
      const whole = playerImportSummarySchema.parse(((await importPlayers(paged.id).expect(200)).body as Body).data);
      expect(whole).toMatchObject({ scanned: 5, created: 5, existing: 0, error: null });
      expect(listingStarts(pagedAccount, before)).toEqual([0, 2, 4]);
      expect(await redis.get(importPlayersCursorKey(paged.id))).toBeNull();

      // A bound of four: the run stops with a sentence instead of a silent success...
      importLimits.maxPlayersPerRun = 4;
      const cappedLogin = agentLogin('capped');
      const cappedAccount = stub.addAccount(HOST_A, cappedLogin, 'capped-password', { players: five('cp') });
      const capped = await createOperator('capped', { baseUrl: HOST_A, login: cappedLogin, password: 'capped-password', agentId: '8102' });
      const firstFrom = stub.requests.length;
      const first = playerImportSummarySchema.parse(((await importPlayers(capped.id).expect(200)).body as Body).data);
      expect(first).toMatchObject({
        scanned: 4,
        created: 4,
        existing: 0,
        error: expect.stringContaining('stopped after reading 4 players'),
      });
      expect(listingStarts(cappedAccount, firstFrom)).toEqual([0, 2]);
      expect(await redis.get(importPlayersCursorKey(capped.id))).not.toBeNull();

      // ...and the next run continues (one page early) and finishes, instead of re-reading 0..4 forever.
      const secondFrom = stub.requests.length;
      const second = playerImportSummarySchema.parse(((await importPlayers(capped.id).expect(200)).body as Body).data);
      expect(second).toMatchObject({ scanned: 3, created: 1, existing: 2, error: null });
      expect(listingStarts(cappedAccount, secondFrom)).toEqual([2, 4]);
      expect(await prisma.player.count({ where: { tenantId: capped.id } })).toBe(5);
      expect(await redis.get(importPlayersCursorKey(capped.id))).toBeNull();
    } finally {
      importLimits.pageSize = DEFAULT_PLAYER_IMPORT_LIMITS.pageSize;
      importLimits.maxPlayersPerRun = DEFAULT_PLAYER_IMPORT_LIMITS.maxPlayersPerRun;
    }
  });

  it("imports only its own agent id's players from a login shared under another agent id, and reports the ones Ichancy did not attribute", async () => {
    const login = agentLogin('shared-import');
    stub.addAccount(HOST_B, login, 'shared-import-password', {
      players: [
        { login: `sie1${RUN}`, parentId: '8201' },
        { login: `sie2${RUN}`, parentId: '8201' },
        { login: `siw1${RUN}`, parentId: '8202' },
        { login: `sio1${RUN}`, parentId: null },
      ],
    });
    const east = await createOperator('si-east', { baseUrl: HOST_B, login, password: 'shared-import-password', agentId: '8201' });
    const west = await createOperator('si-west', { baseUrl: HOST_B, login, password: 'shared-import-password', agentId: '8202' });
    const importPlayers = (id: string): request.Test =>
      api().post(`/v1/admin/tenants/${id}/import-players`).set('authorization', platformBearer);
    const loginsOf = async (tenantId: string): Promise<(string | null)[]> =>
      (await prisma.player.findMany({ where: { tenantId }, orderBy: { ichancyLogin: 'asc' } })).map((player) => player.ichancyLogin);

    const eastRun = playerImportSummarySchema.parse(((await importPlayers(east.id).expect(200)).body as Body).data);
    expect(eastRun).toMatchObject({ scanned: 4, created: 2, existing: 0 });
    expect(eastRun.error).toContain('1 player was not imported');
    expect(eastRun.error).toContain(west.slug);
    expect(await loginsOf(east.id)).toEqual([`sie1${RUN}`, `sie2${RUN}`]);

    const westRun = playerImportSummarySchema.parse(((await importPlayers(west.id).expect(200)).body as Body).data);
    expect(westRun).toMatchObject({ scanned: 4, created: 1, existing: 0 });
    expect(westRun.error).toContain(east.slug);
    // Neither operator holds the other's players, nor the one Ichancy did not attribute.
    expect(await loginsOf(west.id)).toEqual([`siw1${RUN}`]);
  });

  it('never imports one Ichancy account twice for operators sharing a login AND an agent id, and names the holder', async () => {
    const login = agentLogin('same-tree');
    stub.addAccount(HOST_B, login, 'same-tree-password', {
      players: [
        { login: `stA${RUN}`, parentId: '8301' },
        { login: `stB${RUN}`, parentId: '8301' },
      ],
    });
    const first = await createOperator('st-first', { baseUrl: HOST_B, login, password: 'same-tree-password', agentId: '8301' });
    const second = await createOperator('st-second', { baseUrl: HOST_B, login, password: 'same-tree-password', agentId: '8301' });
    const importPlayers = (id: string): request.Test =>
      api().post(`/v1/admin/tenants/${id}/import-players`).set('authorization', platformBearer);

    const firstRun = playerImportSummarySchema.parse(((await importPlayers(first.id).expect(200)).body as Body).data);
    expect(firstRun).toMatchObject({ scanned: 2, created: 2, existing: 0, error: null, ichancyFake: false });

    const secondRun = playerImportSummarySchema.parse(((await importPlayers(second.id).expect(200)).body as Body).data);
    expect(secondRun).toMatchObject({ scanned: 2, created: 0, existing: 0 });
    expect(secondRun.error).toContain('2 players were not imported');
    expect(secondRun.error).toContain(first.slug);
    expect(await prisma.player.count({ where: { tenantId: second.id } })).toBe(0);
    // The holder's own re-run is unaffected: its rows are its own, so they are `existing`.
    const again = playerImportSummarySchema.parse(((await importPlayers(first.id).expect(200)).body as Body).data);
    expect(again).toMatchObject({ scanned: 2, created: 0, existing: 2, error: null });
  });

  it('provisioning activates a created operator and imports its players, or reports both as not done when the sign-in is refused', async () => {
    const login = agentLogin('provisioned');
    stub.addAccount(HOST_A, login, 'provisioned-password', { players: [`prov1${RUN}`, `prov2${RUN}`] });
    const create = (password: string, name: string): request.Test => {
      const { token, botId } = newToken();
      telegram.accept(token, testBotInfo(botId, `p11_${name}_${RUN}_bot`));
      // A staff group the bot administers, named on the form and verified at create: without one an
      // operator is never activated, whatever Ichancy answers.
      const staffGroup = -1007_000_000_000n - BigInt(botId);
      telegram.setChat(staffGroup, { type: 'supergroup', title: `P11 ${name} staff` });
      telegram.setBotMember(token, staffGroup, { status: 'administrator' });
      return api()
        .post('/v1/admin/tenants')
        .set('authorization', platformBearer)
        .send({
          displayName: `P11 int ${RUN} ${name}`,
          slug: `${SLUG_PREFIX}${RUN}-${name}`,
          botToken: token,
          ichancyUsername: login,
          ichancyPassword: password,
          ichancyBaseUrl: HOST_A,
          ichancyAgentId: '9001',
          adminChatId: staffGroup.toString(),
        });
    };

    const activated = tenantCreatedSchema.parse(((await create('provisioned-password', 'prov-ok').expect(201)).body as Body).data);
    expect(activated.status).toBe('ACTIVE');
    expect(activated.provisioning).toMatchObject({
      activated: true,
      activationError: null,
      playersImported: 2,
      playersImportError: null,
      ichancyFake: false,
    });
    expect(await prisma.player.count({ where: { tenantId: activated.id, source: PlayerSource.ICHANCY_IMPORT } })).toBe(2);

    const refused = tenantCreatedSchema.parse(((await create('not-it', 'prov-refused').expect(201)).body as Body).data);
    expect(refused.status).toBe('SUSPENDED');
    expect(refused.provisioning).toMatchObject({
      activated: false,
      activationError: expect.stringMatching(/^Ichancy refused the sign-in with these credentials .*The operator stays suspended\.$/),
      playersImported: 0,
      playersImportError: PLAYERS_NOT_IMPORTED_MESSAGE,
    });
    expect(await prisma.player.count({ where: { tenantId: refused.id } })).toBe(0);
  });

  it("credits a deposit of operator B entirely with B's agent — host, token, agent id and float — and never touches operator A's", async () => {
    const loginA = agentLogin('credit-a');
    const loginB = agentLogin('credit-b');
    const accountA = stub.addAccount(HOST_A, loginA, 'credit-a-password', { walletMinor: 100_000_000n });
    const accountB = stub.addAccount(HOST_B, loginB, 'credit-b-password', { walletMinor: 100_000_000n });
    const operatorA = await createOperator('credit-a', { baseUrl: HOST_A, login: loginA, password: 'credit-a-password', agentId: '1111' });
    const operatorB = await createOperator('credit-b', { baseUrl: HOST_B, login: loginB, password: 'credit-b-password', agentId: '2222' });
    await activate(operatorA.id).expect(200);
    await activate(operatorB.id).expect(200);

    // Operator B's money setup: a rail, a player, an APPROVED deposit with its T1, and a funded float.
    await prisma.runInTransaction((tx) => ensurePaymentMethods(tx, operatorB.id, 'NSP', OPERATOR_DEFAULT_PAYMENT_METHODS));
    const method = await prisma.paymentMethod.findFirstOrThrow({ where: { tenantId: operatorB.id, code: 'EWALLET_MAIN' } });
    const { PlayerService: PlayerServiceClass } = await import('../player/services/player.service');
    const players: PlayerService = ctx.app.get(PlayerServiceClass);
    const { playerId } = await ctx.inTenant(
      () =>
        prisma.runInTransaction((tx) =>
          players.upsertFromTelegram(
            tx,
            operatorB.id,
            { telegramUserId: 7_400_000_000n + BigInt(Date.now() % 1_000_000), firstName: 'P11 credit' },
            'NSP',
          ),
        ),
      operatorB.id,
    );

    const amountMinor = 5_000n;
    const shortId = `P11${RUN.toUpperCase()}`.slice(0, 12);
    const deposit = await prisma.depositRequest.create({
      data: {
        tenantId: operatorB.id,
        shortId,
        playerId,
        paymentMethodId: method.id,
        currencyCode: 'NSP',
        claimedAmountMinor: amountMinor,
        verifiedAmountMinor: amountMinor,
        status: DepositStatus.APPROVED,
      },
    });
    const ledger = ctx.app.get(LedgerService);
    await ctx.inTenant(
      () =>
        prisma.runInTransaction(async (tx) => {
          const claim = await ledger.post(
            tx,
            depositApproved({
              depositId: deposit.id,
              shortId,
              playerId,
              paymentMethodId: method.id,
              amountMinor,
              currency: 'NSP',
              actor: SYSTEM_ACTOR,
            }),
          );
          await ledger.post(tx, {
            idempotencyKey: `ledger:p11-int-topup:${operatorB.id}`,
            kind: LedgerTxKind.AGENT_FLOAT_TOPUP,
            refType: 'AGENT_FLOAT',
            refId: randomUUID(),
            currency: 'NSP',
            entries: [
              { accountCode: ichancyAgentFloatCode('NSP'), amountMinor: 1_000_000n },
              { accountCode: houseRoundingCode('NSP'), amountMinor: -1_000_000n },
            ],
            description: 'P11 integration float top-up',
            actor: SYSTEM_ACTOR,
            allowNegative: true,
          });
          await tx.depositRequest.update({
            where: { id: deposit.id, tenantId: operatorB.id },
            data: { ledgerClaimTxId: claim.transactionId },
          });
        }),
      operatorB.id,
    );

    const requestsBefore = stub.requests.length;
    const signInsA = accountA.signIns;
    const walletA = accountA.walletMinor;

    // The worker's own entry point: no ambient tenant, the deposit row decides the operator.
    const { DepositCreditService: CreditClass } = await import('../deposit/services/deposit-credit.service');
    const credits: DepositCreditService = ctx.app.get(CreditClass);
    const outcome = await credits.credit({
      depositRequestId: deposit.id,
      shortId,
      creditKeyEpoch: deposit.creditKeyEpoch,
      amountMinor: amountMinor.toString(),
      correlationId: `p11-int-credit-${RUN}`,
    });

    expect(outcome).toMatchObject({ kind: 'credited' });
    expect((await prisma.depositRequest.findUniqueOrThrow({ where: { id: deposit.id } })).status).toBe(DepositStatus.CREDITED);

    const made = stub.requests.slice(requestsBefore);
    expect(made.map((row) => row.endpoint)).toEqual([
      'registerPlayer',
      'getPlayersForCurrentAgent',
      'getPlayerBalanceById',
      'depositToPlayer',
    ]);
    // Every request went to B's host with B's token, as B's agent.
    for (const row of made) {
      expect(row.origin).toBe(new URL(HOST_B).origin);
      expect(row.bearerAccount).toBe(accountB.key);
      expect(row.agentKey).toBe(ichancyAgentKey(HOST_B, loginB));
    }
    expect((made[0]?.body['player'] as Record<string, unknown>)['parentId']).toBe('2222');
    expect(made[3]?.body).toMatchObject({ amount: 50, currencyCode: 'NSP', comment: shortId });

    // B's float paid; A's agent saw nothing, not even a sign-in.
    expect(accountB.walletMinor).toBe(100_000_000n - amountMinor);
    expect(accountA.walletMinor).toBe(walletA);
    expect(accountA.signIns).toBe(signInsA);
    expect(made.some((row) => row.bearerAccount === accountA.key || row.origin === new URL(HOST_A).origin)).toBe(false);
    expect([...accountB.players.values()].map((player) => player.balanceMinor)).toEqual([amountMinor]);

    // The forensic rows are B's.
    const calls = await prisma.ichancyCall.findMany({ where: { depositRequestId: deposit.id }, select: { tenantId: true } });
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls.map((call) => call.tenantId))).toEqual(new Set([operatorB.id]));
  });
});
