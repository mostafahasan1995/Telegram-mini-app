/**
 * WHY liveness and readiness are genuinely different endpoints, and why /live touches NOTHING:
 *
 * A liveness probe answers "should this container be killed and restarted?". If it checked the
 * database, then a database outage would fail liveness on every replica at once, the orchestrator
 * would restart them all, and the restarts would add connection-storm load to a database that is
 * already struggling — turning a recoverable dependency blip into an outage of our own making.
 * Restarting a process never fixes someone else's database.
 *
 * A readiness probe answers "should this pod receive traffic right now?". THAT is where
 * dependencies belong: with Postgres or Redis unreachable the process cannot serve a deposit, so
 * it should be taken out of the load balancer — but left running, so it rejoins automatically when
 * the dependency returns.
 *
 * Both are @Public(): a probe cannot hold a bearer token, and the global AuthGuard fails closed.
 */
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, type HealthCheckResult } from '@nestjs/terminus';
import { Public } from '@common/decorators/auth.decorator';
import { AppConfigService } from '../config/config.service';
import { DatabaseHealthIndicator } from './indicators/database.indicator';
import { RedisHealthIndicator } from './indicators/redis.indicator';

interface LivenessResponse {
  status: 'ok';
  role: string;
  uptimeSeconds: number;
  timestamp: string;
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: DatabaseHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Liveness. No IO, no awaits, no dependencies — if the event loop can run this handler, the
   * process is alive and restarting it would achieve nothing.
   */
  @Public()
  @Get('live')
  live(): LivenessResponse {
    return {
      status: 'ok',
      role: this.config.app.role,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness. Returns 503 (via Terminus) when a dependency is down, which is what removes this
   * pod from the load balancer without killing it.
   */
  @Public()
  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.database.isHealthy('database'),
      () => this.redis.isHealthy('redis'),
    ]);
  }
}
