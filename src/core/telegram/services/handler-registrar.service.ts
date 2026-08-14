/**
 * WHY a discovery scan: handlers belong next to their feature, but grammY needs every listener
 * attached to one Bot before the first update is dispatched. Without this, each new feature module
 * would have to remember to register itself in a shared file — and the failure mode of forgetting
 * is a handler that exists, compiles, is unit-tested, and is never called.
 *
 * WHY only in the worker role: the api process persists and enqueues updates but never calls
 * `bot.handleUpdate()`. Attaching listeners there would build a dispatch table that can never fire
 * and would make the api boot depend on handler wiring it does not use.
 *
 * Handlers are wrapped so a thrown error is logged and swallowed. grammY would otherwise propagate
 * it out of `handleUpdate()` into the queue processor, which would retry the whole update — and
 * replaying an update whose money side-effect already happened is precisely what the dedupe layer
 * exists to prevent.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { Bot, type Context } from 'grammy';
import { type FilterQuery } from 'grammy';
import { AppConfigService } from '../../config/config.service';
import {
  TELEGRAM_CALLBACK_METADATA,
  TELEGRAM_COMMAND_METADATA,
  TELEGRAM_MESSAGE_METADATA,
} from '../decorators/handlers.decorator';
import { TELEGRAM_BOT } from '../telegram.constants';

type HandlerMethod = (ctx: Context) => unknown;

/** Escapes a namespace so `dep` cannot accidentally match `dep.x` through regex metacharacters. */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

@Injectable()
export class TelegramHandlerRegistrar implements OnModuleInit {
  private readonly logger = new Logger(TelegramHandlerRegistrar.name);
  private registered = 0;

  constructor(
    @Inject(TELEGRAM_BOT) private readonly bot: Bot,
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

    // A handler that throws past our wrapper (or a grammY internal error) must not take the
    // process down with an unhandled rejection.
    this.bot.catch((error) => {
      this.logger.error(
        `Unhandled error while dispatching update ${error.ctx.update.update_id}: ${error.message}`,
        error.error instanceof Error ? error.error.stack : undefined,
      );
    });

    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as Record<string, unknown> | null | undefined;
      if (instance === null || instance === undefined || typeof instance !== 'object') continue;

      const prototype: object | null = Object.getPrototypeOf(instance) as object | null;
      if (prototype === null) continue;

      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        this.registerMethod(instance, methodName);
      }
    }

    this.logger.log(`Registered ${this.registered} Telegram handler(s)`);
  }

  private registerMethod(instance: Record<string, unknown>, methodName: string): void {
    const method = instance[methodName];
    if (typeof method !== 'function') return;

    const target = method as HandlerMethod;
    const label = `${instance.constructor?.name ?? 'Unknown'}.${methodName}`;

    const commands = Reflect.getMetadata(TELEGRAM_COMMAND_METADATA, target) as string[] | undefined;
    if (commands !== undefined && commands.length > 0) {
      this.bot.command(commands, this.wrap(instance, target, label));
      this.logger.debug(`/${commands.join(', /')} -> ${label}`);
      this.registered += 1;
    }

    const namespace = Reflect.getMetadata(TELEGRAM_CALLBACK_METADATA, target) as string | undefined;
    if (typeof namespace === 'string' && namespace.length > 0) {
      // Prefix match: one handler owns a whole namespace and decodes the action itself.
      this.bot.callbackQuery(
        new RegExp(`^${escapeRegExp(namespace)}:`),
        this.wrap(instance, target, label),
      );
      this.logger.debug(`callback ${namespace}:* -> ${label}`);
      this.registered += 1;
    }

    const filters = Reflect.getMetadata(TELEGRAM_MESSAGE_METADATA, target) as
      FilterQuery[] | undefined;
    if (filters !== undefined && filters.length > 0) {
      this.bot.on(filters, this.wrap(instance, target, label));
      this.logger.debug(`on(${filters.join(', ')}) -> ${label}`);
      this.registered += 1;
    }
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
