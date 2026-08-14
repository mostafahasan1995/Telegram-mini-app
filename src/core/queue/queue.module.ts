/**
 * WHY global: producers live everywhere (a controller approving a deposit, a cron, a processor
 * chaining follow-up work) and threading a BullModule import through every feature module buys
 * nothing but noise. What is NOT global is consumption — see worker-only.util.ts; a `@Processor`
 * must be registered by the worker entrypoint only.
 *
 * The five queues are registered in BOTH roles on purpose: registering a queue only opens a
 * producer connection, it does not start a Worker. The api process must be able to enqueue.
 */
import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { AppConfigService } from '@core/config/config.service';
import { ALL_QUEUE_NAMES, BULLMQ_PREFIX, DEFAULT_JOB_OPTIONS } from './queue.constants';
import { TypedQueueService } from './typed-queue.service';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        connection: {
          url: config.redis.url,
          // BullMQ requires this for blocking commands; ioredis' default (20) makes a Worker throw
          // "max retries per request" during a routine Redis failover instead of reconnecting.
          maxRetriesPerRequest: null,
        },
        prefix: BULLMQ_PREFIX,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      }),
    }),
    BullModule.registerQueue(...ALL_QUEUE_NAMES.map((name) => ({ name }))),
  ],
  providers: [TypedQueueService],
  exports: [BullModule, TypedQueueService],
})
export class QueueModule {}
