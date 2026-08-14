/**
 * WHY @Global: Redis is infrastructure that half the codebase touches (session nonces, the Ichancy
 * session lock, the per-player credit mutex, admin identity caching, webhook dedupe). Threading a
 * CacheModule import through every feature module would be noise with no isolation benefit — there
 * is exactly one Redis connection per process and it is a singleton by construction.
 */
import { Global, Module } from '@nestjs/common';
import { CacheService } from './cache.service';
import { LockService } from './lock.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService, CacheService, LockService],
  exports: [RedisService, CacheService, LockService],
})
export class CacheModule {}
