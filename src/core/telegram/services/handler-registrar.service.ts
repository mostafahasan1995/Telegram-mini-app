/**
 * WHY a discovery scan: handlers belong next to their feature, but grammY needs every listener
 * attached before the first update is dispatched. Without this, each new feature module would have
 * to remember to register itself in a shared file — and the failure mode of forgetting is a handler
 * that exists, compiles, is unit-tested, and is never called.
 *
 * WHY ONE COMPOSER AND NOT ONE BOT: every operator has its own Bot, built on demand by
 * TenantBotRegistry. The listeners are the same for all of them, so they are collected once into a
 * grammY Composer and every tenant's Bot is given that same Composer. The handlers are stateless per
 * update (everything they need arrives on `ctx`, and the operator is the ambient tenant the update
 * processor entered), so sharing them between bots shares nothing that belongs to one operator.
 *
 * WHY only in the worker role: the api process persists and enqueues updates but never calls
 * `bot.handleUpdate()`. Attaching listeners there would build a dispatch table that can never fire
 * and would make the api boot depend on handler wiring it does not use.
 *
 * WHY IT IS BUILT LAZILY AS WELL AS AT INIT: `onModuleInit` builds it so the boot log shows the
 * handler count, but queue consumers can be started by another module's init hook before this one
 * has run. `middleware()` therefore builds it on first use too. Every provider instance already
 * exists by then, which is all the scan needs.
 *
 * Handlers are wrapped so a thrown error is logged and swallowed. grammY would otherwise propagate
 * it out of `handleUpdate()` into the queue processor, which would retry the whole update — and
 * replaying an update whose money side-effect already happened is precisely what the dedupe layer
 * exists to prevent.
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { Composer, type Context, type FilterQuery } from 'grammy';
import { AppConfigService } from '../../config/config.service';
import {
  TELEGRAM_CALLBACK_METADATA,
  TELEGRAM_COMMAND_METADATA,
  TELEGRAM_MESSAGE_METADATA,
} from '../decorators/handlers.decorator';

type HandlerMethod = (ctx: Context) => unknown;

/** Escapes a namespace so `dep` cannot accidentally match `dep.x` through regex metacharacters. */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

@Injectable()
export class TelegramHandlerRegistrar implements OnModuleInit {
  private readonly logger = new Logger(TelegramHandlerRegistrar.name);
  private composer: Composer<Context> | null = null;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    if (!this.config.app.isWorker) {
      this.logger.log(
        'Skipping Telegram handler registration (api role does not dispatch updates)',
      );
      return;
    }
    this.middleware();
  }

  /**
   * The handler composition every tenant's Bot is given. Null in the api role, which builds bots
   * only to send.
   */
  middleware(): Composer<Context> | null {
    if (!this.config.app.isWorker) return null;
    if (this.composer !== null) return this.composer;

    const composer = new Composer<Context>();
    let registered = 0;

    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as Record<string, unknown> | null | undefined;
      if (instance === null || instance === undefined || typeof instance !== 'object') continue;

      const prototype: object | null = Object.getPrototypeOf(instance) as object | null;
      if (prototype === null) continue;

      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        registered += this.registerMethod(composer, instance, methodName);
      }
    }

    this.composer = composer;
    this.logger.log(`Registered ${registered} Telegram handler(s)`);
    return composer;
  }

  /** Attaches whatever listeners one method declares. Returns how many it attached. */
  private registerMethod(
    composer: Composer<Context>,
    instance: Record<string, unknown>,
    methodName: string,
  ): number {
    const method = instance[methodName];
    if (typeof method !== 'function') return 0;

    const target = method as HandlerMethod;
    const label = `${instance.constructor?.name ?? 'Unknown'}.${methodName}`;
    let registered = 0;

    const commands = Reflect.getMetadata(TELEGRAM_COMMAND_METADATA, target) as string[] | undefined;
    if (commands !== undefined && commands.length > 0) {
      composer.command(commands, this.wrap(instance, target, label));
      this.logger.debug(`/${commands.join(', /')} -> ${label}`);
      registered += 1;
    }

    const namespace = Reflect.getMetadata(TELEGRAM_CALLBACK_METADATA, target) as string | undefined;
    if (typeof namespace === 'string' && namespace.length > 0) {
      // Prefix match: one handler owns a whole namespace and decodes the action itself.
      composer.callbackQuery(
        new RegExp(`^${escapeRegExp(namespace)}:`),
        this.wrap(instance, target, label),
      );
      this.logger.debug(`callback ${namespace}:* -> ${label}`);
      registered += 1;
    }

    const filters = Reflect.getMetadata(TELEGRAM_MESSAGE_METADATA, target) as
      FilterQuery[] | undefined;
    if (filters !== undefined && filters.length > 0) {
      composer.on(filters, this.wrap(instance, target, label));
      this.logger.debug(`on(${filters.join(', ')}) -> ${label}`);
      registered += 1;
    }

    return registered;
  }

  /** Binds `this` back to the provider and contains any error the handler throws. */
  private wrap(
    instance: Record<string, unknown>,
    method: HandlerMethod,
    label: string,
  ): (ctx: Context) => Promise<void> {
    return async (ctx: Context): Promise<void> => {
      try {
        await method.call(instance, ctx);
      } catch (error: unknown) {
        this.logger.error(
          `Telegram handler ${label} failed for update ${ctx.update.update_id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    };
  }
}
