/**
 * WHY `SELECT 1` and not a real query: readiness must answer "can this process reach its database
 * and get a connection from the pool?" — nothing more. A probe that touches application tables
 * turns a slow query or a locked row into a false "not ready", and Kubernetes responds by removing
 * a perfectly healthy pod from service, which makes the original slowness worse.
 *
 * WHY the explicit timeout: a saturated pool does not reject, it QUEUES. Without a bound, the probe
 * hangs until the kubelet's own timeout, and the failure is reported as a timeout with no detail
 * instead of "the database did not answer in 2s".
 *
 * WHY the failure payload says only "database unreachable": /health/ready is @Public() and Caddy
 * forwards every path on the api host, so this payload reaches anonymous internet callers through
 * Terminus's 503 body. The raw driver message names the database host, the application role and the
 * exact failure mode (bad credentials, refused connection, saturated pool), which is reconnaissance for
 * whoever is timing an attack on the outage. The real error goes to the log, where operators look
 * anyway; the probe's consumers (Docker's healthcheck, scripts/deploy.sh, Uptime Kuma) read only the
 * status code, which is unchanged: still 503 on failure.
 */
import { Injectable, Logger } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { PrismaService } from '../../prisma/prisma.service';

const PROBE_TIMEOUT_MS = 2_000;

/** Public, fixed failure message. Deliberately carries nothing from the error itself. */
export const DATABASE_DOWN_MESSAGE = 'database unreachable';

@Injectable()
export class DatabaseHealthIndicator {
  private readonly logger = new Logger(DatabaseHealthIndicator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly indicator: HealthIndicatorService,
  ) {}

  async isHealthy(key = 'database'): Promise<HealthIndicatorResult> {
    const check = this.indicator.check(key);
    const startedAt = Date.now();

    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, PROBE_TIMEOUT_MS, 'database');
      return check.up({ responseTimeMs: Date.now() - startedAt });
    } catch (error: unknown) {
      const responseTimeMs = Date.now() - startedAt;
      this.logger.warn(
        `Readiness check "${key}" failed after ${responseTimeMs}ms: ${describeError(error)}`,
      );
      return check.down({ responseTimeMs, message: DATABASE_DOWN_MESSAGE });
    }
  }
}

/** The real failure, for the log only. Never put this in a probe response. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function withTimeout<T>(
  work: PromiseLike<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not respond within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    // Without this the process keeps an active timer per probe and cannot exit promptly.
    if (timer !== undefined) clearTimeout(timer);
  }
}
