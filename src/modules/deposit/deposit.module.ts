/**
 * WHY the processors and the cron are conditional on APP_ROLE: a BullMQ `@Processor` becomes a live
 * Redis consumer the moment it is a provider — there is no runtime switch that un-consumes a queue —
 * and `@Interval` fires wherever ScheduleModule is imported. So "only the worker consumes" has to be
 * decided while the module graph is being BUILT, not afterwards. workerOnlyProviders does exactly
 * that, using the already-validated role rather than reading process.env a second time.
 *
 * WHY the Telegram handlers are worker-only too: TelegramHandlerRegistrar only scans for
 * @OnCommand/@OnCallback/@OnMessage in the worker (the api role never calls bot.handleUpdate), so
 * registering them in the api process would build a dispatch table that can never fire.
 *
 * WHY DepositOutboxHandler is exported: OutboxModule.forWorker() assembles the OUTBOX_HANDLERS
 * array from handler classes the worker root passes in (see worker.module.ts) — and injecting a
 * class across modules requires the owning module to export it. The token itself is bound inside
 * OutboxModule, next to the processor that consumes it; a root-module binding would be invisible
 * to that processor's injector.
 *
 * WHAT THIS MODULE DOES NOT PROVIDE, AND MUST NOT:
 *   PLAYER_LINK_PORT     provided by modules/player
 *   PAYMENT_METHOD_PORT  provided by modules/payment-method
 *   APPROVAL_LIMIT_PORT  provided by modules/admin
 *
 * They are injected here by string token (see ./ports) and bound by the ROOT module, which is the
 * only place allowed to see every feature module. Providing a fallback for any of them here would be
 * worse than a missing binding: Nest resolves a token from the consuming module first, so a local
 * "default" would silently win and the system would run two implementations of a non-idempotent
 * registration call. A missing binding fails loudly at boot; a duplicate one fails quietly in
 * production.
 */
import { Module, type DynamicModule, type Provider } from '@nestjs/common';

import type { AppRole } from '@core/config/config.service';
import { FileModule } from '@core/file/file.module';
import { IchancyModule } from '@core/ichancy/ichancy.module';
import { workerOnlyProviders } from '@core/queue/worker-only.util';
import { TelegramModule } from '@core/telegram/telegram.module';
import { AuthModule } from '@core/auth/auth.module';

import { DepositAdminController } from './controllers/deposit-admin.controller';
import { DepositController } from './controllers/deposit.controller';
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

/** Present in both roles: services, repositories, the state machine, the outbox route. */
const SHARED_PROVIDERS: Provider[] = [
  DepositRepository,
  DepositStateMachine,
  DepositPolicyService,
  ProofDuplicateService,
  ProofIngestService,
  DepositService,
  DepositReviewService,
  DepositRetryService,
  DepositCreditService,
  DepositNotifyService,
  // The sweep WORK is shared; only its @Interval wrapper is worker-only. The admin panel can run a
  // sweep on demand, and that endpoint is served by the api.
  DepositSweepService,
  DepositOutboxHandler,
];

/** Queue consumers, the cron schedule, and the bot handlers. Worker role only — see the header. */
const WORKER_PROVIDERS: Provider[] = [
  CreditDepositProcessor,
  IngestProofProcessor,
  NotifyProcessor,
  DepositExpiryCron,
  DepositTelegramHandlers,
];

/** Shared between the static decorator and forWorker(); Nest does not inherit `exports`. */
const DEPOSIT_EXPORTS = [
  DepositService,
  DepositReviewService,
  DepositRetryService,
  DepositCreditService,
  DepositNotifyService,
  DepositRepository,
  DepositOutboxHandler,
];

@Module({
  imports: [
    // FileModule is @Global, but importing it here documents the dependency and keeps the module
    // usable in a test that composes only what it needs.
    FileModule,
    IchancyModule,
    TelegramModule,
    // AuthModule provides AdminIdentityService, which every Telegram callback re-resolves through.
    AuthModule,
  ],
  controllers: [DepositController, DepositAdminController],
  providers: SHARED_PROVIDERS,
  exports: DEPOSIT_EXPORTS,
})
export class DepositModule {
  /**
   * The worker composition, mirroring `OutboxModule.forWorker()`:
   *
   *   api entrypoint    -> imports DepositModule              (producers + HTTP only)
   *   worker entrypoint -> imports DepositModule.forWorker()  (adds consumers, cron, bot handlers)
   *
   * `workerOnlyProviders` is still applied inside, with the role the CALLER already validated, so
   * calling forWorker() from an api process is a no-op rather than a live queue consumer.
   */
  static forWorker(role: AppRole = 'worker'): DynamicModule {
    return {
      module: DepositModule,
      imports: [FileModule, IchancyModule, TelegramModule, AuthModule],
      providers: [...SHARED_PROVIDERS, ...workerOnlyProviders(role, WORKER_PROVIDERS)],
      exports: DEPOSIT_EXPORTS,
    };
  }
}
