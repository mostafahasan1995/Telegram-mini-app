/**
 * WHY `SELECT 1` and not a real query: readiness must answer "can this process reach its database
 * and get a connection from the pool?" — nothing more. A probe that touches application tables
 * turns a slow query or a locked row into a false "not ready", and Kubernetes responds by removing
 * a perfectly healthy pod from service, which makes the original slowness worse.
 *
 * WHY the explicit timeout: a saturated pool does not reject, it QUEUES. Without a bound, the probe
 * hangs until the kubelet's own timeout, and the failure is reported as a timeout with no detail
 * instead of "the database did not answer in 2s".
 */
import { Injectable } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { PrismaService } from '../../prisma/prisma.service';

const PROBE_TIMEOUT_MS = 2_000;

@Injectable()
export class DatabaseHealthIndicator {
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
      return check.down({
        responseTimeMs: Date.now() - startedAt,
        // Safe to expose on an internal probe endpoint, and it is the whole value of the check.
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
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
