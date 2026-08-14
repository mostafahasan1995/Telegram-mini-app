/**
 * THE API COMPOSITION. One image, two roles: this module is the `api` half — it serves HTTP and
 * produces work. Its counterpart, WorkerModule, consumes that work. The two share every core module
 * so the business rules cannot drift between them; what differs is exactly and only who CONSUMES.
 *
 * WHAT IS DELIBERATELY ABSENT HERE, and why it is not an oversight:
 *   ScheduleModule          — `@Interval`/`@Cron` fire wherever ScheduleModule is imported. Without
 *                             it the cron classes in this graph are inert objects, which is what we
 *                             want: two replicas both sweeping expired deposits is a race.
 *   BullMQ @Processor-s     — `DepositModule` (not `.forWorker()`) and `OutboxModule` (not
 *                             `.forWorker()`) leave the consumers out. A @Processor becomes a live
 *                             Redis consumer the moment it is a provider; there is no runtime flag.
 *   Ichancy sign-in         — only one accessToken/refreshToken pair is valid per agent and a second
 *                             signIn kills the first, so N api replicas signing in would knock each
 *                             other out. The api reads tokens from Redis; the worker owns them.
 *
 * GLOBAL GUARD ORDER IS SIGNIFICANT and is set by the order of this imports array. Nest applies
 * APP_GUARD providers in module-scan order, so AuthModule (AuthGuard, then RolesGuard) must be
 * listed before AppThrottlerModule (ThrottlerGuard): the throttler keys its counters on the
 * authenticated principal when there is one, which only exists after AuthGuard has run. The
 * throttler degrades to the client IP if that order ever changes, so this is an accuracy
 * requirement rather than a correctness one — but it is why the order is written down.
 */
import { Module } from '@nestjs/common';

import { ActorContextModule } from '@core/actor-context/actor-context.module';
import { AuditModule } from '@core/audit/audit.module';
import { AuthModule } from '@core/auth/auth.module';
import { CacheModule } from '@core/cache/cache.module';
import { AppConfigModule } from '@core/config/config.module';
import { FileModule } from '@core/file/file.module';
import { HealthModule } from '@core/health/health.module';
import { IchancyModule } from '@core/ichancy/ichancy.module';
import { IdempotencyModule } from '@core/idempotency/idempotency.module';
import { LedgerModule } from '@core/ledger/ledger.module';
import { LoggingModule } from '@core/logging/logging.module';
import { OutboxModule } from '@core/outbox/outbox.module';
import { PrismaModule } from '@core/prisma/prisma.module';
import { QueueModule } from '@core/queue/queue.module';
import { TelegramModule } from '@core/telegram/telegram.module';
import { AppThrottlerModule } from '@core/throttler/throttler.module';

import { AdminModule } from '@modules/admin/admin.module';
import { DepositModule } from '@modules/deposit/deposit.module';
import { PaymentMethodModule } from '@modules/payment-method/payment-method.module';
import { PlayerModule } from '@modules/player/player.module';
import { ReconciliationModule } from '@modules/reconciliation/reconciliation.module';
import { WalletModule } from '@modules/wallet/wallet.module';

import { FeaturePortsModule } from './feature-ports.module';

@Module({
  imports: [
    // ---- configuration and observability ------------------------------------------------
    // AppConfigModule first: every module below reads AppConfigService, and a bad .env must fail
    // here rather than halfway through building a Redis connection.
    AppConfigModule,
    LoggingModule,

    // ---- infrastructure (all @Global; listed to document the dependency, not to scope it) --
    ActorContextModule,
    PrismaModule,
    CacheModule,
    QueueModule,
    AuditModule,
    LedgerModule,
    // Producer + relay. OutboxRelayService guards on APP_ROLE itself and exposes statusCounts()
    // for health, which the api genuinely wants; the dispatch PROCESSOR is worker-only.
    OutboxModule,
    IdempotencyModule,
    IchancyModule,
    FileModule,
    TelegramModule,
    HealthModule,

    // ---- authentication, then rate limiting (see the header on ordering) -------------------
    AuthModule,
    AppThrottlerModule,

    // ---- feature modules -------------------------------------------------------------------
    // FeaturePortsModule re-exports Player/Admin/PaymentMethod from a @Global module, which is what
    // publishes PLAYER_LINK_PORT / APPROVAL_LIMIT_PORT / PAYMENT_METHOD_PORT to DepositModule.
    // Nest resolves a token from the CONSUMING module, never from the root's provider list, so
    // without that bridge the api process does not boot. The three are ALSO listed directly below
    // so this array reads as the complete inventory of what this process serves.
    FeaturePortsModule,
    PlayerModule,
    AdminModule,
    PaymentMethodModule,
    DepositModule,
    WalletModule,
    ReconciliationModule,
  ],
})
export class AppModule {}
