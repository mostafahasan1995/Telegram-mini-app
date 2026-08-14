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
 * Run with:  npx jest --runInBand src/modules/deposit/deposit.di.int.spec.ts
 * Requires the dev containers (docker compose up -d postgres redis).
 */
process.env['APP_ROLE'] = 'api';
process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '3000';
process.env['API_BASE_URL'] = 'http://localhost:3000';
process.env['DATABASE_URL'] ??= 'postgresql://ichancy:ichancy@localhost:55432/ichancy';
process.env['REDIS_URL'] ??= 'redis://localhost:6379';
process.env['JWT_SECRET'] = 'integration-test-secret-value-32-chars';
process.env['TELEGRAM_BOT_TOKEN'] = '123456:AAtest_token_for_integration_only';
process.env['TELEGRAM_WEBHOOK_SECRET'] = 'integration_webhook_secret_value';
process.env['TELEGRAM_WEBHOOK_PATH_TOKEN'] = 'inttestpath';
process.env['TELEGRAM_ADMIN_CHAT_ID'] = '-1001234567890';
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

import { ActorContextModule } from '@core/actor-context/actor-context.module';
import { AuditModule } from '@core/audit/audit.module';
import { CacheModule } from '@core/cache/cache.module';
import { AppConfigModule } from '@core/config/config.module';
import { IdempotencyModule } from '@core/idempotency/idempotency.module';
import { LedgerModule } from '@core/ledger';
import { OutboxModule } from '@core/outbox/outbox.module';
import { PrismaModule } from '@core/prisma/prisma.module';
import { QueueModule } from '@core/queue/queue.module';

import { DepositModule } from './deposit.module';
import { DepositStateMachine } from './deposit-state.machine';
import { DepositOutboxHandler } from './outbox/deposit-outbox.handler';
import { CreditDepositProcessor } from './processors/credit-deposit.processor';
import { IngestProofProcessor } from './processors/ingest-proof.processor';
import { NotifyProcessor } from './processors/notify.processor';
import { DepositRepository } from './repositories/deposit.repository';
import { DepositCreditService } from './services/deposit-credit.service';
import { DepositExpiryCron } from './services/deposit-expiry.cron';
import { DepositSweepService } from './services/deposit-sweep.service';
import { DepositNotifyService } from './services/deposit-notify.service';
import { DepositPolicyService } from './services/deposit-policy.service';
import { DepositRetryService } from './services/deposit-retry.service';
import { DepositReviewService } from './services/deposit-review.service';
import { DepositService } from './services/deposit.service';
import { ProofDuplicateService } from './services/proof-duplicate.service';
import { ProofIngestService } from './services/proof-ingest.service';
import { DepositTelegramHandlers } from './telegram/deposit.handlers';
import {
  APPROVAL_LIMIT_PORT,
  PAYMENT_METHOD_PORT,
  PLAYER_LINK_PORT,
  type ApprovalLimitPort,
  type PaymentMethodPort,
  type PlayerLinkPort,
} from './ports';

import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/services/wallet.service';

import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { AgentFloatSyncService } from '../reconciliation/services/agent-float-sync.service';
import { InvariantCheckCron } from '../reconciliation/services/invariant-check.cron';
import { RailAgeingService } from '../reconciliation/services/rail-ageing.service';
import { ReconciliationBreakService } from '../reconciliation/services/reconciliation-break.service';
import { ReconProcessor } from '../reconciliation/processors/recon.processor';

jest.setTimeout(60_000);

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

const CORE = [
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
];

describe('deposit spine — dependency injection graph', () => {
  describe('api composition', () => {
    let moduleRef: TestingModule;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [...CORE, OutboxModule, DepositModule, WalletModule, ReconciliationModule],
      }).compile();
    });

    afterAll(async () => {
      await moduleRef?.close();
    });

    it('resolves every deposit service', () => {
      expect(moduleRef.get(DepositService)).toBeInstanceOf(DepositService);
      expect(moduleRef.get(DepositReviewService)).toBeInstanceOf(DepositReviewService);
      expect(moduleRef.get(DepositCreditService)).toBeInstanceOf(DepositCreditService);
      expect(moduleRef.get(DepositRetryService)).toBeInstanceOf(DepositRetryService);
      expect(moduleRef.get(DepositPolicyService)).toBeInstanceOf(DepositPolicyService);
      expect(moduleRef.get(DepositNotifyService)).toBeInstanceOf(DepositNotifyService);
      expect(moduleRef.get(ProofDuplicateService)).toBeInstanceOf(ProofDuplicateService);
      expect(moduleRef.get(ProofIngestService)).toBeInstanceOf(ProofIngestService);
      expect(moduleRef.get(DepositStateMachine)).toBeInstanceOf(DepositStateMachine);
      expect(moduleRef.get(DepositRepository)).toBeInstanceOf(DepositRepository);
      expect(moduleRef.get(DepositOutboxHandler)).toBeInstanceOf(DepositOutboxHandler);
      // Present in the api role even though its CRON is not — the admin panel can sweep on demand.
      expect(moduleRef.get(DepositSweepService)).toBeInstanceOf(DepositSweepService);
    });

    it('resolves the wallet and reconciliation services', () => {
      expect(moduleRef.get(WalletService)).toBeInstanceOf(WalletService);
      expect(moduleRef.get(ReconciliationBreakService)).toBeInstanceOf(ReconciliationBreakService);
      expect(moduleRef.get(AgentFloatSyncService)).toBeInstanceOf(AgentFloatSyncService);
      expect(moduleRef.get(RailAgeingService)).toBeInstanceOf(RailAgeingService);
      expect(moduleRef.get(InvariantCheckCron)).toBeInstanceOf(InvariantCheckCron);
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
      expect(() => moduleRef.get(CreditDepositProcessor, { strict: false })).toThrow();
      expect(() => moduleRef.get(IngestProofProcessor, { strict: false })).toThrow();
      expect(() => moduleRef.get(NotifyProcessor, { strict: false })).toThrow();
      expect(() => moduleRef.get(ReconProcessor, { strict: false })).toThrow();
      expect(() => moduleRef.get(DepositExpiryCron, { strict: false })).toThrow();
      expect(() => moduleRef.get(DepositTelegramHandlers, { strict: false })).toThrow();
    });
  });

  describe('worker composition', () => {
    let moduleRef: TestingModule;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [
          ...CORE,
          OutboxModule.forWorker(),
          DepositModule.forWorker('worker'),
          ReconciliationModule.forWorker('worker'),
        ],
      }).compile();
    });

    afterAll(async () => {
      await moduleRef?.close();
    });

    it('adds the queue consumers, the sweeper and the bot handlers', () => {
      expect(moduleRef.get(CreditDepositProcessor)).toBeInstanceOf(CreditDepositProcessor);
      expect(moduleRef.get(IngestProofProcessor)).toBeInstanceOf(IngestProofProcessor);
      expect(moduleRef.get(NotifyProcessor)).toBeInstanceOf(NotifyProcessor);
      expect(moduleRef.get(DepositExpiryCron)).toBeInstanceOf(DepositExpiryCron);
      expect(moduleRef.get(DepositTelegramHandlers)).toBeInstanceOf(DepositTelegramHandlers);
      expect(moduleRef.get(ReconProcessor)).toBeInstanceOf(ReconProcessor);
    });

    it('still resolves everything the api role had', () => {
      expect(moduleRef.get(DepositService)).toBeInstanceOf(DepositService);
      expect(moduleRef.get(DepositCreditService)).toBeInstanceOf(DepositCreditService);
      expect(moduleRef.get(AgentFloatSyncService)).toBeInstanceOf(AgentFloatSyncService);
    });

    it('binds exactly ONE consumer per queue', () => {
      // Two @Processor classes on one queue would compete for the same jobs and each would get a
      // random half — the failure mode that looks like everything working until half the credits
      // disappear. One class per queue is the invariant; this pins the mapping.
      const consumers = [
        CreditDepositProcessor,
        IngestProofProcessor,
        NotifyProcessor,
        ReconProcessor,
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
