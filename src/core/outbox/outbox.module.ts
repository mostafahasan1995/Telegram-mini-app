/**
 * WHY two entrypoints instead of a role flag: a BullMQ `@Processor` opens a Redis consumer the
 * instant it becomes a provider — there is no runtime switch that un-consumes a queue. So the
 * consumer side has to be excluded while the module graph is being built, not afterwards.
 *
 *   api entrypoint    -> imports OutboxModule              (producer + relay, relay self-disables)
 *   worker entrypoint -> imports OutboxModule.forWorker()  (adds the dispatch processor)
 *
 * OutboxRelayService is present in both because it guards on APP_ROLE itself and exposes
 * statusCounts() for the health endpoint, which the api role does want.
 */
import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';

import { QueueModule } from '@core/queue/queue.module';
import { OutboxDispatchProcessor } from './outbox-dispatch.processor';
import { OutboxRelayService } from './outbox-relay.service';
import { OutboxService } from './outbox.service';

const BASE_PROVIDERS: Provider[] = [OutboxService, OutboxRelayService];

@Global()
@Module({
  imports: [QueueModule],
  providers: BASE_PROVIDERS,
  exports: [OutboxService, OutboxRelayService],
})
export class OutboxModule {
  /**
   * Adds the single consumer of the `outbox` queue. Register handlers from feature modules under
   * the OUTBOX_HANDLERS token — Nest does not merge providers, so the root assembles the array:
   *
   *   { provide: OUTBOX_HANDLERS,
   *     inject: [DepositOutboxHandler, TelegramOutboxHandler],
   *     useFactory: (...handlers: OutboxTopicHandler[]) => handlers }
   */
  static forWorker(): DynamicModule {
    return {
      module: OutboxModule,
      global: true,
      imports: [QueueModule],
      providers: [...BASE_PROVIDERS, OutboxDispatchProcessor],
      exports: [OutboxService, OutboxRelayService],
    };
  }
}
