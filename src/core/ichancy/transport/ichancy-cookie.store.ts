/**
 * The current Cloudflare clearance, shared across processes.
 *
 * WHY REDIS AND NOT .env: the clearance expires every ~30 minutes (`__cf_bm`'s fixed TTL, measured
 * twice on 2026-08-19/20), so it is not configuration — it is a rotating credential with a shorter
 * life than a deploy. A value in .env cannot reach a running process, and the api and the worker
 * both make agent-API calls, so a per-process copy would leave one of them challenged while the
 * other worked.
 *
 * WHY A TTL SHORTER THAN "FOREVER" AND LONGER THAN 30 MINUTES: an expired clearance is worse than no
 * clearance — it is a request that will certainly be challenged — so Redis drops it on its own if
 * the harvester dies. The grace beyond 30 minutes exists because `__cf_bm` is refreshed by the far
 * side on every ACCEPTED call, so a busy system's jar outlives its nominal expiry.
 */
import { Injectable, Logger } from '@nestjs/common';

import { RedisService } from '@core/cache/redis.service';

/** One harvest: everything a request needs to look like the browser that earned the clearance. */
export interface HarvestedCookies {
  /** Ready-made `Cookie:` header value. */
  readonly cookie: string;
  /**
   * The User-Agent of the browser that earned it. NOT optional and NOT configurable: Cloudflare
   * binds a clearance to the UA, and presenting it under a different one fails exactly as if no
   * cookie had been sent. Two outages on 2026-08-19 were this and nothing else.
   */
  readonly userAgent: string;
  readonly harvestedAt: string;
}

export const ICHANCY_COOKIE_KEY = 'ichancy:cookies:v1';

/** Beyond `__cf_bm`'s 30 minutes — see the header for why it is bounded at all. */
export const COOKIE_TTL_MS = 45 * 60_000;

@Injectable()
export class IchancyCookieStore {
  private readonly logger = new Logger(IchancyCookieStore.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * The stored harvest, or null. Never throws: a Redis hiccup must degrade to "no cookie" (the
   * request is then challenged and reported as such) rather than fail a money call with a cache
   * error, which would be the wrong story in the log.
   */
  async read(): Promise<HarvestedCookies | null> {
    try {
      const raw = await this.redis.get(ICHANCY_COOKIE_KEY);
      if (raw === null) return null;

      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;

      const candidate = parsed as Partial<HarvestedCookies>;
      if (typeof candidate.cookie !== 'string' || candidate.cookie.length === 0) return null;
      if (typeof candidate.userAgent !== 'string' || candidate.userAgent.length === 0) return null;

      return {
        cookie: candidate.cookie,
        userAgent: candidate.userAgent,
        harvestedAt: typeof candidate.harvestedAt === 'string' ? candidate.harvestedAt : '',
      };
    } catch (error: unknown) {
      this.logger.warn(
        `Could not read the harvested cookies: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /** Never logs a VALUE — a clearance cookie is a credential. */
  async write(value: HarvestedCookies): Promise<void> {
    await this.redis.set(ICHANCY_COOKIE_KEY, JSON.stringify(value), 'PX', COOKIE_TTL_MS);
    this.logger.log(`Stored a fresh Cloudflare clearance (valid for ~30 minutes)`);
  }
}
