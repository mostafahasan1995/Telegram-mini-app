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
import {
  Global,
  Module,
  type DynamicModule,
  type ForwardReference,
  type Provider,
  type Type,
} from '@nestjs/common';

import { QueueModule } from '@core/queue/queue.module';
import { OutboxDispatchProcessor } from './outbox-dispatch.processor';
import { OutboxRelayService } from './outbox-relay.service';
import { OutboxService } from './outbox.service';
import { OUTBOX_HANDLERS, type OutboxTopicHandler } from './outbox.types';

const BASE_PROVIDERS: Provider[] = [OutboxService, OutboxRelayService];

export interface OutboxWorkerOptions {
  /** Modules that provide-and-export the handler classes listed in `handlers`. */
  imports?: (Type<unknown> | DynamicModule | ForwardReference)[];
  /** The topic handlers the dispatch processor fans out to. One entry per feature module. */
  handlers: Type<OutboxTopicHandler>[];
}

@Global()
@Module({
  imports: [QueueModule],
  providers: BASE_PROVIDERS,
  exports: [OutboxService, OutboxRelayService],
})
export class OutboxModule {
  /**
   * Adds the single consumer of the `outbox` queue, WITH its handler table.
   *
   * WHY the handlers are assembled HERE and not in the root module: constructor injection resolves
   * in the injector of the module that declares the provider. OutboxDispatchProcessor is declared
   * by this (global) module, so a root-module `{ provide: OUTBOX_HANDLERS, ... }` is simply not
   * visible to it — root providers are not global — and the processor's `@Optional()` inject would
   * quietly degrade to an empty table. That exact bug shipped once: every outbox job failed with
   * OUTBOX_NO_HANDLER after 8 attempts while the worker booted green. Binding the token in the
   * same module as its consumer makes the wiring impossible to get wrong from the outside.
   */
  static forWorker(options: OutboxWorkerOptions): DynamicModule {
    return {
      module: OutboxModule,
      global: true,
      imports: [QueueModule, ...(options.imports ?? [])],
      providers: [
        ...BASE_PROVIDERS,
        OutboxDispatchProcessor,
        {
          provide: OUTBOX_HANDLERS,
          inject: options.handlers,
          useFactory: (...handlers: OutboxTopicHandler[]): OutboxTopicHandler[] => handlers,
        },
      ],
      exports: [OutboxService, OutboxRelayService],
    };
  }
}
