/**
 * Same composition rule as the deposit module: the crons and the queue consumer only exist in the
 * worker, because @Interval fires wherever ScheduleModule is imported and a @Processor becomes a
 * live consumer the moment it is a provider.
 *
 * The api role still gets ReconciliationBreakService, AgentFloatSyncService and RailAgeingService as
 * plain services — the controller needs them to answer "sync now" and "show me the ageing report".
 * Neither of those starts a schedule; only the @Interval decorators do, and those live on the cron
 * classes which the api composition also provides but ScheduleModule (worker-only in the root) never
 * scans. The role guard inside each `tick()` is the belt to that braces.
 */
import { Module, type DynamicModule, type Provider } from '@nestjs/common';

import type { AppRole } from '@core/config/config.service';
import { IchancyModule } from '@core/ichancy/ichancy.module';
import { workerOnlyProviders } from '@core/queue/worker-only.util';
import { TelegramModule } from '@core/telegram/telegram.module';

import { ReconciliationController } from './controllers/reconciliation.controller';
import { ReconProcessor } from './processors/recon.processor';
import { AgentFloatSyncService } from './services/agent-float-sync.service';
import { IchancyHealthAlertCron } from './services/ichancy-health.cron';
import { InvariantCheckCron } from './services/invariant-check.cron';
import { RailAgeingService } from './services/rail-ageing.service';
import { ReconciliationBreakService } from './services/reconciliation-break.service';

const SHARED_PROVIDERS: Provider[] = [
  ReconciliationBreakService,
  AgentFloatSyncService,
  RailAgeingService,
  InvariantCheckCron,
  // Same treatment as InvariantCheckCron: shared so an admin surface can read it, inert in the api
  // because ScheduleModule never scans that graph and tick() guards on isWorker anyway.
  IchancyHealthAlertCron,
];

const WORKER_PROVIDERS: Provider[] = [ReconProcessor];

const RECON_EXPORTS = [
  ReconciliationBreakService,
  AgentFloatSyncService,
  RailAgeingService,
  InvariantCheckCron,
  IchancyHealthAlertCron,
];

@Module({
  imports: [IchancyModule, TelegramModule],
  controllers: [ReconciliationController],
  providers: SHARED_PROVIDERS,
  exports: RECON_EXPORTS,
})
export class ReconciliationModule {
  static forWorker(role: AppRole = 'worker'): DynamicModule {
    return {
      module: ReconciliationModule,
      imports: [IchancyModule, TelegramModule],
      providers: [...SHARED_PROVIDERS, ...workerOnlyProviders(role, WORKER_PROVIDERS)],
      exports: RECON_EXPORTS,
    };
  }
}
