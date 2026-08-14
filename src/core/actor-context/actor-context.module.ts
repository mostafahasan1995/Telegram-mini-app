/**
 * WHY @Global + APP_INTERCEPTOR: the actor context is only useful if it is ALWAYS there. A module
 * that has to remember to import it is a module whose audit rows say "SYSTEM" for a player action.
 * Importing this once in AppModule wires the interceptor for every HTTP route.
 *
 * The worker imports it too — not for the interceptor (there are no requests) but for
 * ActorContextService, which job processors use to open a SYSTEM context per job.
 */
import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { ActorContextInterceptor } from './actor-context.interceptor';
import { ActorContextService } from './actor-context.service';

@Global()
@Module({
  providers: [
    ActorContextService,
    ActorContextInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: ActorContextInterceptor },
  ],
  exports: [ActorContextService, ActorContextInterceptor],
})
export class ActorContextModule {}
