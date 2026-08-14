/**
 * WHY: one image, two entrypoints. A BullMQ `@Processor` class becomes a live Redis consumer the
 * moment it is a provider in the module graph — there is no runtime flag that turns it off. So
 * "only the worker consumes queues" cannot be a convention; it has to be a decision made while the
 * module is being built.
 *
 * Both helpers take the role explicitly instead of reading process.env, because only
 * @core/config is allowed to read the environment, and the root module already has the validated
 * value when it composes itself.
 */
import type { DynamicModule, Provider, Type } from '@nestjs/common';
import type { AppRole } from '@core/config/config.service';

type ModuleImport = Type<unknown> | DynamicModule | Promise<DynamicModule>;

/**
 * Use for `@Processor` classes and anything else that must consume rather than produce:
 *   providers: [...workerOnlyProviders(role, [DepositCreditProcessor])]
 */
export function workerOnlyProviders(role: AppRole, providers: readonly Provider[]): Provider[] {
  return role === 'worker' ? [...providers] : [];
}

/** Same idea for whole modules (ScheduleModule, processor modules, the outbox relay module). */
export function workerOnlyImports(role: AppRole, imports: readonly ModuleImport[]): ModuleImport[] {
  return role === 'worker' ? [...imports] : [];
}

export function apiOnlyProviders(role: AppRole, providers: readonly Provider[]): Provider[] {
  return role === 'api' ? [...providers] : [];
}
