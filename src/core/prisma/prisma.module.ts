/**
 * WHY @Global: PrismaService holds the connection pool. A second instance would mean a second pool
 * (and DB_POOL_MAX would quietly become 2 × DB_POOL_MAX), so it is provided once and shared.
 * Repositories therefore never import this module — they just inject PrismaService.
 */
import { Global, Module } from '@nestjs/common';

import { ActorContextModule } from '@core/actor-context/actor-context.module';

import { PrismaService } from './prisma.service';

@Global()
@Module({
  // WHY the import: the actor-stamp extension reads the AsyncLocalStorage context. Nothing here
  // injects the service, but declaring the dependency keeps the wiring honest for whoever composes
  // AppModule — Prisma without the actor context silently stops stamping audit rows.
  imports: [ActorContextModule],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
