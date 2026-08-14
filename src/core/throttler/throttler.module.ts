/**
 * Rate limiting for the three surfaces that can be abused before anyone is trusted: the initData
 * exchange, deposit creation, and proof upload. See ./throttle-routes.ts for why the rules match on
 * method+path and why the limits are shaped the way they are.
 *
 * WHY a single throttler whose limit/ttl are FUNCTIONS rather than three named throttlers:
 * ThrottlerGuard evaluates every configured throttler on every request, so three named throttlers
 * would mean a deposit POST is counted against the auth bucket and the proof bucket as well as its
 * own. One throttler that resolves its numbers from the matched rule gives per-route limits with
 * per-route buckets (the default key generator already includes the controller and handler names),
 * and `skipIf` makes every unmatched route free.
 *
 * The guard is registered here, with the module that configures it, for the same reason AuthModule
 * registers its own: a composition that imports the configuration but forgets the guard is a
 * composition with no rate limiting and no error to show for it.
 */
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule, type ThrottlerModuleOptions } from '@nestjs/throttler';

import { RedisService } from '@core/cache/redis.service';

import { RedisThrottlerStorage } from './redis-throttler.storage';
import { ruleForContext, throttleTracker } from './throttle-routes';

/**
 * Used only for the routes we do not throttle, which `skipIf` has already excluded. They exist
 * because ThrottlerOptions requires a limit and a ttl even when nothing will ever read them.
 */
const UNUSED_LIMIT = 1_000_000;
const UNUSED_TTL_MS = 60_000;

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [RedisService],
      useFactory: (redis: RedisService): ThrottlerModuleOptions => ({
        storage: new RedisThrottlerStorage(redis),

        getTracker: (request: Record<string, unknown>) => throttleTracker(request),

        // The whole policy in one line: if no rule matches this request, do not count it at all.
        skipIf: (context) => ruleForContext(context) === undefined,

        throttlers: [
          {
            // Named 'default' so the response headers stay `X-RateLimit-*` with no suffix.
            name: 'default',
            limit: (context) => ruleForContext(context)?.limit ?? UNUSED_LIMIT,
            ttl: (context) => ruleForContext(context)?.ttlMs ?? UNUSED_TTL_MS,
            blockDuration: (context) => ruleForContext(context)?.blockMs ?? UNUSED_TTL_MS,
          },
        ],
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppThrottlerModule {}
