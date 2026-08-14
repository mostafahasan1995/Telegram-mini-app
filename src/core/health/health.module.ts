/**
 * Terminus supplies the HealthCheckService/HealthIndicatorService plumbing; the indicators
 * themselves are ours because the bundled ones want a TypeORM/Mongoose connection, and we run
 * Prisma with a @prisma/adapter-pg pool.
 */
import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { DatabaseHealthIndicator } from './indicators/database.indicator';
import { RedisHealthIndicator } from './indicators/redis.indicator';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [DatabaseHealthIndicator, RedisHealthIndicator],
  exports: [DatabaseHealthIndicator, RedisHealthIndicator],
})
export class HealthModule {}
