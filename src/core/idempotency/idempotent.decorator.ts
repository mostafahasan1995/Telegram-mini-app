/**
 * WHY the scope is mandatory and positional: two endpoints must never share a key namespace. A
 * client that generates one UUID per user action and sends it to both `POST /deposits` and
 * `POST /deposits/:id/proof` would otherwise get the deposit's cached response back from the proof
 * endpoint. Scoping by endpoint makes that impossible without asking clients to be careful.
 *
 *   @Post()
 *   @Idempotent('deposit.create')
 *   create(@Body() dto: CreateDepositDto) { ... }
 */
import { SetMetadata, UseInterceptors, applyDecorators } from '@nestjs/common';

import { DEFAULT_IDEMPOTENCY_TTL_SECONDS, IDEMPOTENT_METADATA } from './idempotency.constants';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import type { IdempotentOptions } from './idempotency.types';

export interface IdempotentDecoratorOptions {
  /**
   * false lets a caller without the header through unprotected. Only for endpoints being migrated;
   * anything that moves money should keep the default.
   */
  required?: boolean;
  ttlSeconds?: number;
}

export function Idempotent(scope: string, options: IdempotentDecoratorOptions = {}) {
  const metadata: IdempotentOptions = {
    scope,
    required: options.required ?? true,
    ttlSeconds: options.ttlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  };

  return applyDecorators(
    SetMetadata(IDEMPOTENT_METADATA, metadata),
    UseInterceptors(IdempotencyInterceptor),
  );
}
