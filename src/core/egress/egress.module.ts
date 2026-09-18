/**
 * The one screen that answers "is the fix even applied": GET /v1/system/egress-status.
 *
 * Deliberately tiny. The api role is the only HTTP server; the worker builds the same AppModule as
 * an application context, where a controller is instantiated but never served. Splitting it into
 * api-only wiring would cost more than the one inert provider it saves.
 */
import { Module } from '@nestjs/common';

import { AppConfigModule } from '@core/config/config.module';

import { EgressStatusController } from './egress-status.controller';
import { EgressStatusService } from './egress-status.service';

@Module({
  imports: [AppConfigModule],
  controllers: [EgressStatusController],
  providers: [EgressStatusService],
  exports: [EgressStatusService],
})
export class EgressModule {}