/**
 * WHY @Global: `@Idempotent(...)` expands to `UseInterceptors(IdempotencyInterceptor)`, and Nest
 * resolves a class-typed interceptor from the module that declares the controller. Without a global
 * export, every feature module that decorates one route would have to import this module, and
 * forgetting it fails at runtime with an obscure DI error on a money endpoint.
 *
 * The reaper is registered unconditionally and guards on APP_ROLE itself — it owns no queue
 * consumer, so there is nothing that has to be excluded at composition time.
 */
import { Global, Module } from '@nestjs/common';

import { IdempotencyReaperService } from './idempotency-reaper.service';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyService } from './idempotency.service';

@Global()
@Module({
  providers: [IdempotencyService, IdempotencyInterceptor, IdempotencyReaperService],
  exports: [IdempotencyService, IdempotencyInterceptor],
})
export class IdempotencyModule {}
