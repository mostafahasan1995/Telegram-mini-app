/**
 * The ordinary transport: Node's fetch, browser-shaped headers, and a cookie jar.
 *
 * This is the RIGHT transport once Ichancy allowlists a server IP, and the only one that makes sense
 * for a host with no bot protection. It is kept exactly as it was when it lived inside
 * IchancyHttpClient — the cookie jar and its reasoning moved here verbatim, because the jar is a
 * property of "how bytes travel", not of what a credit means.
 */
import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '@core/config/config.service';

import {
  type IchancyTransport,
  type IchancyTransportRequest,
  type IchancyTransportResponse,
} from './ichancy-transport';

/** `a=1; b=2` -> Map. Tolerant of stray spaces and of a value containing '='. */
export function parseCookieHeader(raw: string): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name.length > 0) jar.set(name, value);
  }
  return jar;
}

/** `name=value` off the front of one Set-Cookie line; the attributes after the first ';' are ours to ignore. */
export function parseSetCookie(line: string): { name: string; value: string } | null {
  const firstPair = line.split(';', 1)[0] ?? '';
  const separator = firstPair.indexOf('=');
  if (separator <= 0) return null;
  const name = firstPair.slice(0, separator).trim();
  if (name.length === 0) return null;
  return { name, value: firstPair.slice(separator + 1).trim() };
}

@Injectable()
export class FetchIchancyTransport implements IchancyTransport {
  readonly name = 'fetch';

  private readonly logger = new Logger(FetchIchancyTransport.name);

  /**
   * The cookies we present to Cloudflare and to their PHP session layer.
   *
   * WHY A JAR AND NOT JUST THE CONFIGURED STRING: `PHPSESSID` and `__cf_bm` are ROTATED by the far
   * side mid-session (__cf_bm lives about 30 minutes), and replaying a stale one is how a working
   * process starts getting challenged an hour after it booted. So the configured value seeds the jar
   * and every Set-Cookie we are handed updates it.
   *
   * In-memory on purpose: a restart re-seeds from config, and two processes each keeping their own
   * PHP session is exactly what the far side expects of two browsers.
   */
  private readonly cookies = new Map<string, string>();
  private cookiesSeeded = false;

  constructor(private readonly config: AppConfigService) {}

  async post(request: IchancyTransportRequest): Promise<IchancyTransportResponse> {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: this.buildHeaders(request.accessToken),
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(request.timeoutMs),
    });

    this.absorbCookies(response);

    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      text: await response.text(),
    };
  }

  /**
   * The headers a browser would send, because that is what the far side is checking for.
   *
   * `origin` and `referer` are derived from ICHANCY_BASE_URL rather than hard-coded so a staging
   * host cannot end up announcing production's origin. The User-Agent is configuration for one
   * reason only: cf_clearance is issued against the UA that solved the challenge, so a mismatch
   * silently invalidates a cookie that looks perfectly valid in .env.
   */
  private buildHeaders(accessToken: string | null): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': this.config.ichancy.userAgent,
    };

    if (accessToken) headers['authorization'] = `Bearer ${accessToken}`;

    const origin = this.originOfBaseUrl();
    if (origin !== null) {
      headers['origin'] = origin;
      headers['referer'] = `${origin}/`;
    }

    const cookie = this.cookieHeader();
    if (cookie !== null) headers['cookie'] = cookie;

    return headers;
  }

  /** Everything in the jar, seeded from config on first use. Null when there is nothing to send. */
  private cookieHeader(): string | null {
    if (!this.cookiesSeeded) {
      this.cookiesSeeded = true;
      const configured = this.config.ichancy.cookie;
      if (configured !== null) {
        for (const [name, value] of parseCookieHeader(configured)) this.cookies.set(name, value);
        this.logger.log(
          `Ichancy cookie jar seeded from ICHANCY_COOKIE (${String(this.cookies.size)} cookie(s): ` +
            `${[...this.cookies.keys()].join(', ')})`,
        );
      } else {
        // Not an error: a host without bot protection needs none, and the browser transport owns its
        // own cookies. It IS the first thing to check when every call comes back CLOUDFLARE_CHALLENGE.
        this.logger.warn(
          'ICHANCY_COOKIE is not set — if the agent API is behind Cloudflare, every call will be ' +
            'answered with a challenge page instead of JSON. Consider ICHANCY_TRANSPORT=browser.',
        );
      }
    }

    if (this.cookies.size === 0) return null;
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /**
   * Merge whatever the far side just set into the jar. Never throws and never logs a VALUE: a
   * session cookie is a credential, and this codebase does not write credentials to logs.
   */
  private absorbCookies(response: Response): void {
    // getSetCookie() splits correctly on the commas inside Expires=; a plain get('set-cookie')
    // returns them joined into one unparseable string.
    for (const line of response.headers.getSetCookie()) {
      const parsed = parseSetCookie(line);
      if (parsed === null) continue;
      // An empty value is a deletion. Dropping it beats sending `PHPSESSID=` back.
      if (parsed.value.length === 0) {
        this.cookies.delete(parsed.name);
        continue;
      }
      this.cookies.set(parsed.name, parsed.value);
    }
  }

  /** `https://agents.ichancy.com` from the configured base URL, or null if it will not parse. */
  private originOfBaseUrl(): string | null {
    try {
      return new URL(this.config.ichancy.baseUrl).origin;
    } catch {
      return null;
    }
  }
}
