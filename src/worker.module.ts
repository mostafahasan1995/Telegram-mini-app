/**
 * THE WORKER COMPOSITION. Same business code as AppModule, none of the HTTP, and everything that
 * must happen exactly once in the cluster.
 *
 * This process, and only this process:
 *   - consumes the five BullMQ queues (deposit credit, media, telegram, outbox, recon)
 *   - runs the outbox relay and every `@Interval`/`@Cron`
 *   - dispatches Telegram updates into grammY (`TelegramUpdateProcessor`)
 *   - signs in to Ichancy — only ONE accessToken/refreshToken pair is valid per agent, and a second
 *     signIn kills the first, so this cannot be shared with the api role
 *
 * WHY ScheduleModule.forRoot() lives here and NOWHERE else: `@Interval` and `@Cron` are inert
 * decorators until something scans for them, and that something is ScheduleModule. Importing it in
 * the api graph would start the deposit sweep and the invariant checks on every web replica.
 *
 * WHY there is no HealthModule: this module is bootstrapped as an application CONTEXT — there is no
 * HTTP server to serve /health from. Liveness for the worker is process liveness; readiness is
 * visible in the queue depths and in `outbox_messages.status`.
 *
 * The `*.forWorker()` calls are what add the consumers. Calling the plain module instead would give
 * a worker that produces jobs nobody drains — which is the current failure this composition fixes.
 */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { ActorContextModule } from '@core/actor-context/actor-context.module';
import { AuditModule } from '@core/audit/audit.module';
import { AuthModule } from '@core/auth/auth.module';
import { CacheModule } from '@core/cache/cache.module';
import { AppConfigModule } from '@core/config/config.module';
import { FileModule } from '@core/file/file.module';
import { IchancyModule } from '@core/ichancy/ichancy.module';
import { IdempotencyModule } from '@core/idempotency/idempotency.module';
import { LedgerModule } from '@core/ledger/ledger.module';
import { LoggingModule } from '@core/logging/logging.module';
import { OutboxModule } from '@core/outbox/outbox.module';
import { OUTBOX_HANDLERS, type OutboxTopicHandler } from '@core/outbox/outbox.types';
import { PrismaModule } from '@core/prisma/prisma.module';
import { QueueModule } from '@core/queue/queue.module';
import { TelegramModule } from '@core/telegram/telegram.module';
import { TelegramUpdateProcessor } from '@core/telegram/processors/telegram-update.processor';

import { AdminModule } from '@modules/admin/admin.module';
import { DepositModule } from '@modules/deposit/deposit.module';
import { DepositOutboxHandler } from '@modules/deposit/outbox/deposit-outbox.handler';
import { PaymentMethodModule } from '@modules/payment-method/payment-method.module';
import { PlayerModule } from '@modules/player/player.module';
import { ReconciliationModule } from '@modules/reconciliation/reconciliation.module';

import { FeaturePortsModule } from './feature-ports.module';
import { WorkerBootstrapService } from './worker-bootstrap.service';

@Module({
  imports: [
    AppConfigModule,
    LoggingModule,

    // The one line that turns every @Interval/@Cron in this graph from decoration into behaviour.
    ScheduleModule.forRoot(),

    ActorContextModule,
    PrismaModule,
    CacheModule,
    QueueModule,
    AuditModule,
    LedgerModule,
    // forWorker() adds OutboxDispatchProcessor, the single consumer of the `outbox` queue.
    OutboxModule.forWorker(),
    IdempotencyModule,
    IchancyModule,
    FileModule,
    TelegramModule,

    // No HTTP here, so the global guards AuthModule registers never fire. It is imported because
    // AdminIdentityService is what every Telegram callback re-resolves an admin through — a bot
    // button is an unauthenticated channel until that lookup says otherwise.
    AuthModule,

    // Publishes PLAYER_LINK_PORT / APPROVAL_LIMIT_PORT / PAYMENT_METHOD_PORT globally. The credit
    // processor and the approval path inject those tokens and cannot import the owning modules.
    FeaturePortsModule,
    PlayerModule,
    AdminModule,
    PaymentMethodModule,

    // The consumers: credit-deposit, ingest-proof, notify, the expiry cron, the bot handlers.
    DepositModule.forWorker(),
    // The consumers: recon queue, invariant checks, agent-float sync, rail ageing.
    ReconciliationModule.forWorker(),
  ],
  providers: [
    // Drains `telegram-updates` into grammY. Without it every button press in the review group is
    // persisted, enqueued, and never handled — with no error anywhere to show for it.
    TelegramUpdateProcessor,

    // Nest does not merge providers across modules, so the ROOT assembles the handler array. Add a
    // second handler by adding it to both `inject` and the module that exports it.
    {
      provide: OUTBOX_HANDLERS,
      inject: [DepositOutboxHandler],
      useFactory: (...handlers: OutboxTopicHandler[]): OutboxTopicHandler[] => handlers,
    },

    WorkerBootstrapService,
  ],
})
export class WorkerModule {}
