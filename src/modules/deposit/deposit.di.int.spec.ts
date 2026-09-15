/**
 * Does Nest actually BUILD the deposit, wallet and reconciliation modules?
 *
 * `tsc` cannot answer that. A provider that is exported but never provided, a constructor that
 * injects a token nobody binds, a `@Processor` registered in the wrong composition — all of them
 * compile cleanly and fail at boot, in production, on the money path. This spec resolves the graph
 * for BOTH roles and asserts that every service comes out of the container.
 *
 * The three cross-module ports (see ./ports) are bound here with stubs, exactly as the ROOT module
 * binds them with the real implementations from modules/player, modules/admin and
 * modules/payment-method. That is also the point: if this file did not have to bind them, this
 * module would be providing its own — which is precisely the duplicate-implementation failure the
 * ports exist to prevent.
 *
 * Postgres and Redis come from the shared harness (test/setup): throwaway containers under
 * `npm run test:int`, or the escape hatch when both variables are set:
 *   POSTGRES_TEST_URL=... REDIS_TEST_URL=... npx jest --config jest-int.config.cjs \
 *     --runInBand src/modules/deposit/deposit.di.int.spec.ts
 */
process.env['APP_ROLE'] = 'api';
process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '3000';
process.env['API_BASE_URL'] = 'http://localhost:3000';
// DATABASE_URL and REDIS_URL are NOT set here: they are the harness's addresses, applied in beforeAll
// before the graph is imported. No address is guessed, and a developer's DATABASE_URL is never used:
// localhost:55432 is also where a live cashier stack publishes Postgres on a developer machine.
process.env['JWT_SECRET'] = 'integration-test-secret-value-32-chars';
process.env['MINI_APP_ORIGIN'] = 'http://localhost:5173';
process.env['ICHANCY_BASE_URL'] = 'http://localhost:9';
process.env['ICHANCY_USERNAME'] = 'agent';
process.env['ICHANCY_PASSWORD'] = 'agent-password';
process.env['ICHANCY_AGENT_ID'] = 'AGENT-1';
process.env['ICHANCY_CURRENCY'] = 'NSP';
process.env['S3_ENDPOINT'] = 'http://localhost:9000';
process.env['S3_BUCKET'] = 'proofs';
process.env['S3_ACCESS_KEY'] = 'minio';
process.env['S3_SECRET_KEY'] = 'minio-secret';
process.env['DUAL_APPROVAL_THRESHOLD_MINOR'] = '100000';
process.env['DEPOSIT_EXPIRY_MINUTES'] = '60';
process.env['AGENT_FLOAT_LOW_WATERMARK_MINOR'] = '500000';
// No test may ever reach the real agent API, and none may need a bucket.
process.env['ICHANCY_FAKE'] = '1';
process.env['FILE_STORAGE_DRIVER'] = 'local';

import { Global, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';

import { applyTestEnv } from '../../../test/setup/test-env';
import { startPostgres, stopPostgres } from '../../../test/setup/postgres-container';
import { startRedis, stopRedis } from '../../../test/setup/redis-container';

// Tokens and structural interfaces only: nothing here evaluates a Nest module.
import {
  APPROVAL_LIMIT_PORT,
  PAYMENT_METHOD_PORT,
  PLAYER_LINK_PORT,
  type ApprovalLimitPort,
  type PaymentMethodPort,
  type PlayerLinkPort,
} from './ports';

jest.setTimeout(60_000);

/** Starting the containers and pushing the schema on a cold runner; the int config's own default. */
const BOOT_TIMEOUT_MS = 120_000;

/**
 * The graph under test, imported once the environment is complete. @nestjs/config validates the
 * environment when config.module.ts is EVALUATED, so a static import would validate it before the
 * harness has given DATABASE_URL and REDIS_URL a value.
 */
async function loadGraph() {
  const { ActorContextModule } = await import('@core/actor-context/actor-context.module');
  const { AuditModule } = await import('@core/audit/audit.module');
  const { CacheModule } = await import('@core/cache/cache.module');
  const { AppConfigModule } = await import('@core/config/config.module');
  const { IdempotencyModule } = await import('@core/idempotency/idempotency.module');
  const { LedgerModule } = await import('@core/ledger');
  const { OutboxModule } = await import('@core/outbox/outbox.module');
  const { PrismaModule } = await import('@core/prisma/prisma.module');
  const { QueueModule } = await import('@core/queue/queue.module');

  const { DepositModule } = await import('./deposit.module');
  const { DepositStateMachine } = await import('./deposit-state.machine');
  const { DepositOutboxHandler } = await import('./outbox/deposit-outbox.handler');
  const { CreditDepositProcessor } = await import('./processors/credit-deposit.processor');
  const { IngestProofProcessor } = await import('./processors/ingest-proof.processor');
  const { NotifyProcessor } = await import('./processors/notify.processor');
  const { DepositRepository } = await import('./repositories/deposit.repository');
  const { DepositCreditService } = await import('./services/deposit-credit.service');
  const { DepositExpiryCron } = await import('./services/deposit-expiry.cron');
  const { DepositSweepService } = await import('./services/deposit-sweep.service');
  const { DepositNotifyService } = await import('./services/deposit-notify.service');
  const { DepositPolicyService } = await import('./services/deposit-policy.service');
  const { DepositRetryService } = await import('./services/deposit-retry.service');
  const { DepositReviewService } = await import('./services/deposit-review.service');
  const { DepositService } = await import('./services/deposit.service');
  const { ProofDuplicateService } = await import('./services/proof-duplicate.service');
  const { ProofIngestService } = await import('./services/proof-ingest.service');
  const { DepositTelegramHandlers } = await import('./telegram/deposit.handlers');

  const { WalletModule } = await import('../wallet/wallet.module');
  const { WalletService } = await import('../wallet/services/wallet.service');

  const { ReconciliationModule } = await import('../reconciliation/reconciliation.module');
  const { AgentFloatSyncService } = await import('../reconciliation/services/agent-float-sync.service');
  const { InvariantCheckCron } = await import('../reconciliation/services/invariant-check.cron');
  const { RailAgeingService } = await import('../reconciliation/services/rail-ageing.service');
  const { ReconciliationBreakService } =
    await import('../reconciliation/services/reconciliation-break.service');
  const { ReconProcessor } = await import('../reconciliation/processors/recon.processor');

  return {
    // The core every composition below stands on, in the order the root imports it.
    core: [
      AppConfigModule,
      PrismaModule,
      ActorContextModule,
      CacheModule,
      AuditModule,
      QueueModule,
      LedgerModule,
      // @Idempotent() on POST /v1/deposits expands to UseInterceptors(IdempotencyInterceptor), which
      // Nest resolves from the module declaring the controller. Without this the deposit controller
      // fails to build — a boot-time crash on the endpoint that opens deposits.
      IdempotencyModule,
      StubFeaturePortsModule,
    ],
    OutboxModule,
    DepositModule,
    DepositStateMachine,
    DepositOutboxHandler,
    CreditDepositProcessor,
    IngestProofProcessor,
    NotifyProcessor,
    DepositRepository,
    DepositCreditService,
    DepositExpiryCron,
    DepositSweepService,
    DepositNotifyService,
    DepositPolicyService,
    DepositRetryService,
    DepositReviewService,
    DepositService,
    ProofDuplicateService,
    ProofIngestService,
    DepositTelegramHandlers,
    WalletModule,
    WalletService,
    ReconciliationModule,
    AgentFloatSyncService,
    InvariantCheckCron,
    RailAgeingService,
    ReconciliationBreakService,
    ReconProcessor,
  };
}

type Graph = Awaited<ReturnType<typeof loadGraph>>;

/** Stand-ins for the three modules the root binds. Never exercised — only resolved. */
const playerLinkStub: PlayerLinkPort = {
  ensureLinked: (playerId) =>
    Promise.resolve({
      playerId,
      ichancyPlayerId: 'stub',
      ichancyLogin: 'stub',
      created: false,
    }),
};

const approvalLimitStub: ApprovalLimitPort = {
  evaluate: () => Promise.resolve('ALLOWED'),
};

const paymentMethodStub: PaymentMethodPort = {
  getActiveByCode: () => Promise.reject(new Error('not used')),
  getActiveById: () => Promise.reject(new Error('not used')),
  pickDestination: () => Promise.reject(new Error('not used')),
  checkSubmission: () => Promise.resolve({ ok: true }),
  renderInstructions: () => Promise.resolve('stub'),
};

/**
 * THE ROOT'S JOB, MODELLED.
 *
 * Nest resolves a token from the CONSUMING module and its imports — never from the root's provider
 * list. So binding these three at the top level is not enough, and DepositModule cannot import
 * PlayerModule/AdminModule/PaymentMethodModule (boundaries forbids modules/A -> modules/B). The only
 * correct bridge is a GLOBAL module in the composition root that re-exports the owners:
 *
 *   @Global()
 *   @Module({
 *     imports: [PlayerModule, AdminModule, PaymentMethodModule],
 *     exports: [PlayerModule, AdminModule, PaymentMethodModule],
 *   })
 *   export class FeaturePortsModule {}
 *
 * Re-exporting a module republishes what it exports (the three tokens), and `@Global` makes that
 * visible to every module without an import. This spec stands in for it with stubs; production
 * swaps the stubs for the real modules. Getting this wrong is a boot-time crash, which is exactly
 * why this file exists.
 */
@Global()
@Module({
  providers: [
    { provide: PLAYER_LINK_PORT, useValue: playerLinkStub },
    { provide: APPROVAL_LIMIT_PORT, useValue: approvalLimitStub },
    { provide: PAYMENT_METHOD_PORT, useValue: paymentMethodStub },
  ],
  exports: [PLAYER_LINK_PORT, APPROVAL_LIMIT_PORT, PAYMENT_METHOD_PORT],
})
class StubFeaturePortsModule {}

describe('deposit spine — dependency injection graph', () => {
  let graph: Graph;

  beforeAll(async () => {
    const [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    // The values above stay as this suite set them. The addresses are the harness's, and any other
    // variable the schema requires comes from the shared test defaults: CI has no .env to fill a gap.
    applyTestEnv({ DATABASE_URL: postgres.url, REDIS_URL: redis.url });
    graph = await loadGraph();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    // After both compositions have closed their modules, so nothing is still connected.
    await Promise.all([stopPostgres(), stopRedis()]);
  });

  describe('api composition', () => {
    let moduleRef: TestingModule;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [
          ...graph.core,
          graph.OutboxModule,
          graph.DepositModule,
          graph.WalletModule,
          graph.ReconciliationModule,
        ],
      }).compile();
    });

    afterAll(async () => {
      await moduleRef?.close();
    });

    it('resolves every deposit service', () => {
      expect(moduleRef.get(graph.DepositService)).toBeInstanceOf(graph.DepositService);
      expect(moduleRef.get(graph.DepositReviewService)).toBeInstanceOf(graph.DepositReviewService);
      expect(moduleRef.get(graph.DepositCreditService)).toBeInstanceOf(graph.DepositCreditService);
      expect(moduleRef.get(graph.DepositRetryService)).toBeInstanceOf(graph.DepositRetryService);
      expect(moduleRef.get(graph.DepositPolicyService)).toBeInstanceOf(graph.DepositPolicyService);
      expect(moduleRef.get(graph.DepositNotifyService)).toBeInstanceOf(graph.DepositNotifyService);
      expect(moduleRef.get(graph.ProofDuplicateService)).toBeInstanceOf(
        graph.ProofDuplicateService,
      );
      expect(moduleRef.get(graph.ProofIngestService)).toBeInstanceOf(graph.ProofIngestService);
      expect(moduleRef.get(graph.DepositStateMachine)).toBeInstanceOf(graph.DepositStateMachine);
      expect(moduleRef.get(graph.DepositRepository)).toBeInstanceOf(graph.DepositRepository);
      expect(moduleRef.get(graph.DepositOutboxHandler)).toBeInstanceOf(graph.DepositOutboxHandler);
      // Present in the api role even though its CRON is not — the admin panel can sweep on demand.
      expect(moduleRef.get(graph.DepositSweepService)).toBeInstanceOf(graph.DepositSweepService);
    });

    it('resolves the wallet and reconciliation services', () => {
      expect(moduleRef.get(graph.WalletService)).toBeInstanceOf(graph.WalletService);
      expect(moduleRef.get(graph.ReconciliationBreakService)).toBeInstanceOf(
        graph.ReconciliationBreakService,
      );
      expect(moduleRef.get(graph.AgentFloatSyncService)).toBeInstanceOf(
        graph.AgentFloatSyncService,
      );
      expect(moduleRef.get(graph.RailAgeingService)).toBeInstanceOf(graph.RailAgeingService);
      expect(moduleRef.get(graph.InvariantCheckCron)).toBeInstanceOf(graph.InvariantCheckCron);
    });

    it('does NOT provide the cross-module ports itself', () => {
      // A local fallback would silently win over the root's binding and give the system two
      // implementations of a non-idempotent registration call. See deposit.module.ts.
      expect(moduleRef.get(PLAYER_LINK_PORT)).toBe(playerLinkStub);
      expect(moduleRef.get(APPROVAL_LIMIT_PORT)).toBe(approvalLimitStub);
      expect(moduleRef.get(PAYMENT_METHOD_PORT)).toBe(paymentMethodStub);
    });

    it('starts NO queue consumer and NO cron in the api role', () => {
      // `strict: false` so this asks "is it in the graph at all?", not "is it in this module?".
      expect(() => moduleRef.get(graph.CreditDepositProcessor, { strict: false })).toThrow();
      expect(() => moduleRef.get(graph.IngestProofProcessor, { strict: false })).toThrow();
      expect(() => moduleRef.get(graph.NotifyProcessor, { strict: false })).toThrow();
      expect(() => moduleRef.get(graph.ReconProcessor, { strict: false })).toThrow();
      expect(() => moduleRef.get(graph.DepositExpiryCron, { strict: false })).toThrow();
      expect(() => moduleRef.get(graph.DepositTelegramHandlers, { strict: false })).toThrow();
    });
  });

  describe('worker composition', () => {
    let moduleRef: TestingModule;

    beforeAll(async () => {
      // ONE shared instance, exactly as worker.module.ts composes it: the handler classes must
      // resolve inside OutboxModule (which declares OUTBOX_HANDLERS), not in the root.
      const depositWorker = graph.DepositModule.forWorker('worker');
      moduleRef = await Test.createTestingModule({
        imports: [
          ...graph.core,
          graph.OutboxModule.forWorker({
            imports: [depositWorker],
            handlers: [graph.DepositOutboxHandler],
          }),
          depositWorker,
          graph.ReconciliationModule.forWorker('worker'),
        ],
      }).compile();
    });

    afterAll(async () => {
      await moduleRef?.close();
    });

    it('adds the queue consumers, the sweeper and the bot handlers', () => {
      expect(moduleRef.get(graph.CreditDepositProcessor)).toBeInstanceOf(
        graph.CreditDepositProcessor,
      );
      expect(moduleRef.get(graph.IngestProofProcessor)).toBeInstanceOf(graph.IngestProofProcessor);
      expect(moduleRef.get(graph.NotifyProcessor)).toBeInstanceOf(graph.NotifyProcessor);
      expect(moduleRef.get(graph.DepositExpiryCron)).toBeInstanceOf(graph.DepositExpiryCron);
      expect(moduleRef.get(graph.DepositTelegramHandlers)).toBeInstanceOf(
        graph.DepositTelegramHandlers,
      );
      expect(moduleRef.get(graph.ReconProcessor)).toBeInstanceOf(graph.ReconProcessor);
    });

    it('still resolves everything the api role had', () => {
      expect(moduleRef.get(graph.DepositService)).toBeInstanceOf(graph.DepositService);
      expect(moduleRef.get(graph.DepositCreditService)).toBeInstanceOf(graph.DepositCreditService);
      expect(moduleRef.get(graph.AgentFloatSyncService)).toBeInstanceOf(
        graph.AgentFloatSyncService,
      );
    });

    it('binds exactly ONE consumer per queue', () => {
      // Two @Processor classes on one queue would compete for the same jobs and each would get a
      // random half — the failure mode that looks like everything working until half the credits
      // disappear. One class per queue is the invariant; this pins the mapping.
      const consumers = [
        graph.CreditDepositProcessor,
        graph.IngestProofProcessor,
        graph.NotifyProcessor,
        graph.ReconProcessor,
      ];
      const queues = consumers.map(
        (consumer) =>
          Reflect.getMetadata('bullmq:processor_metadata', consumer) as
            { name?: string } | undefined,
      );
      const names = queues
        .map((meta) => meta?.name)
        .filter((name): name is string => name !== undefined);
      expect(new Set(names).size).toBe(names.length);
      expect(names.sort()).toEqual(['ichancy', 'media', 'recon', 'telegram']);
    });
  });
});
