/**
 * The ordinary transport: Node's fetch, browser-shaped headers, and a cookie jar per agent.
 *
 * This is the RIGHT transport once Ichancy allowlists a server IP, and the only one that makes sense
 * for a host with no bot protection. It is kept as it was when it lived inside IchancyHttpClient —
 * the cookie jar and its reasoning moved here, because the jar is a property of "how bytes travel",
 * not of what a credit means.
 *
 * ══ ONE JAR PER AGENT, AND THE HOST COMES FROM THE REQUEST ═══════════════════════════════════════
 * Operators carry their own Ichancy base URL and login. So:
 *  - `Origin`/`Referer` are derived from the URL being called, never from ICHANCY_BASE_URL: an
 *    operator on another Ichancy host must not announce this deployment's origin;
 *  - the jar (PHPSESSID, __cf_bm) is kept per agent key, so one agent's PHP session is never
 *    presented on another agent's calls;
 *  - ICHANCY_COOKIE and the harvested clearance belong to ICHANCY_BASE_URL's host — they were earned
 *    there — so they are only ever sent to that host. A request to another host carries only what
 *    that host itself set.
 */
import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '@core/config/config.service';

import { isCloudflareChallenge } from '../error-map';
import { originOf } from '../ichancy-agent';

import { CookieHarvesterService } from './cookie-harvester.service';
import { IchancyCookieStore, type HarvestedCookies } from './ichancy-cookie.store';

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
   * The cookies we present to Cloudflare and to their PHP session layer, one jar per agent key.
   *
   * WHY A JAR AND NOT JUST THE CONFIGURED STRING: `PHPSESSID` and `__cf_bm` are ROTATED by the far
   * side mid-session (__cf_bm lives about 30 minutes), and replaying a stale one is how a working
   * process starts getting challenged an hour after it booted. So the configured value seeds a jar
   * for the configured host, and every Set-Cookie we are handed updates the jar of the agent it was
   * handed to.
   *
   * In-memory on purpose: a restart re-seeds from config, and two processes each keeping their own
   * PHP session is exactly what the far side expects of two browsers.
   */
  private readonly jars = new Map<string, Map<string, string>>();
  private missingCookieWarned = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly store: IchancyCookieStore,
    private readonly harvester: CookieHarvesterService,
  ) {}

  async post(request: IchancyTransportRequest): Promise<IchancyTransportResponse> {
    const first = await this.send(request);
    if (!isCloudflareChallenge(first.status, first.text, first.contentType)) return first;

    // The harvester earns clearances for ICHANCY_BASE_URL's host only; a challenge elsewhere is
    // reported as it is.
    if (!this.isConfiguredHost(request.url)) return first;

    // CHALLENGED. When the harvester is enabled this is recoverable without a human: the clearance
    // has simply aged out, and a browser can earn a new one in seconds.
    //
    // WHY REPLAYING IS SAFE HERE: a challenge is Cloudflare's EDGE answering, with its own
    // interstitial as the body. The request never reached Ichancy, so nothing was registered and no
    // money moved. This is the one failure in this file that may be retried — anything else is
    // rethrown and classified as ambiguous. Compare BrowserIchancyTransport.post, which refuses to
    // replay after a dead browser for exactly the opposite reason.
    const harvested = await this.harvester.harvest();
    if (harvested === null) return first;

    this.logger.warn(
      'Cloudflare challenged the call; retrying once with a freshly harvested clearance',
    );
    return this.send(request);
  }

  private async send(request: IchancyTransportRequest): Promise<IchancyTransportResponse> {
    const jar = this.jarFor(request);
    const response = await fetch(request.url, {
      method: 'POST',
      headers: await this.buildHeaders(request, jar),
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(request.timeoutMs),
    });

    this.absorbCookies(response, jar);

    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      text: await response.text(),
    };
  }

  /**
   * The headers a browser would send, because that is what the far side is checking for.
   *
   * `origin` and `referer` are derived from the URL being called rather than hard-coded, so neither a
   * staging host nor another operator's host can end up announcing the wrong origin. The User-Agent
   * is configuration for one reason only: cf_clearance is issued against the UA that solved the
   * challenge, so a mismatch silently invalidates a cookie that looks perfectly valid in .env.
   */
  private async buildHeaders(
    request: IchancyTransportRequest,
    jar: Map<string, string>,
  ): Promise<Record<string, string>> {
    // The HARVESTED clearance wins over the jar, and brings its own User-Agent — on the host it was
    // harvested for, and nowhere else.
    //
    // WHY THE UA TRAVELS WITH THE COOKIE: Cloudflare binds a clearance to the browser that earned
    // it, so a harvested cookie sent under the configured UA fails exactly as if no cookie had been
    // sent. Keeping the pair together is what makes that impossible to get wrong — it was got wrong
    // twice on 2026-08-19, once as Chrome 140 vs 150 and once as Chrome vs Firefox.
    const harvested = this.isConfiguredHost(request.url) ? await this.harvestedCookies() : null;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': harvested?.userAgent ?? this.config.ichancy.userAgent,
    };

    if (request.accessToken) headers['authorization'] = `Bearer ${request.accessToken}`;

    const origin = originOf(request.url);
    if (origin !== null) {
      headers['origin'] = origin;
      headers['referer'] = `${origin}/`;
    }

    const cookie = harvested?.cookie ?? cookieHeaderOf(jar);
    if (cookie !== null) headers['cookie'] = cookie;

    return headers;
  }

  /** The harvester's current clearance, or null when the feature is off or nothing is stored. */
  private async harvestedCookies(): Promise<HarvestedCookies | null> {
    if (!this.config.ichancy.cookieHarvest) return null;
    return this.store.read();
  }

  /**
   * The jar of the agent making this call, created on first use. A jar for ICHANCY_BASE_URL's host is
   * seeded from ICHANCY_COOKIE; any other host starts empty.
   */
  private jarFor(request: IchancyTransportRequest): Map<string, string> {
    const key = request.agentKey ?? originOf(request.url) ?? request.url;
    const existing = this.jars.get(key);
    if (existing !== undefined) return existing;

    const jar = new Map<string, string>();
    this.jars.set(key, jar);

    if (this.isConfiguredHost(request.url)) {
      const configured = this.config.ichancy.cookie;
      if (configured !== null) {
        for (const [name, value] of parseCookieHeader(configured)) jar.set(name, value);
        this.logger.log(
          `Ichancy cookie jar seeded from ICHANCY_COOKIE (${String(jar.size)} cookie(s): ` +
            `${[...jar.keys()].join(', ')})`,
        );
      } else if (!this.missingCookieWarned) {
        this.missingCookieWarned = true;
        // Not an error: a host without bot protection needs none, and the browser transport owns its
        // own cookies. It IS the first thing to check when every call comes back CLOUDFLARE_CHALLENGE.
        this.logger.warn(
          'ICHANCY_COOKIE is not set — if the agent API is behind Cloudflare, every call will be ' +
            'answered with a challenge page instead of JSON. Consider ICHANCY_TRANSPORT=browser.',
        );
      }
    }
    return jar;
  }

  /**
   * Merge whatever the far side just set into the calling agent's jar. Never throws and never logs a
   * VALUE: a session cookie is a credential, and this codebase does not write credentials to logs.
   */
  private absorbCookies(response: Response, jar: Map<string, string>): void {
    // getSetCookie() splits correctly on the commas inside Expires=; a plain get('set-cookie')
    // returns them joined into one unparseable string.
    for (const line of response.headers.getSetCookie()) {
      const parsed = parseSetCookie(line);
      if (parsed === null) continue;
      // An empty value is a deletion. Dropping it beats sending `PHPSESSID=` back.
      if (parsed.value.length === 0) {
        jar.delete(parsed.name);
        continue;
      }
      jar.set(parsed.name, parsed.value);
    }
  }

  /** True when `url` is on ICHANCY_BASE_URL's host, the one the configured cookies were earned on. */
  private isConfiguredHost(url: string): boolean {
    const configured = originOf(this.config.ichancy.baseUrl);
    return configured !== null && originOf(url) === configured;
  }
}

/** Everything in a jar as one header, or null when there is nothing to send. */
function cookieHeaderOf(jar: Map<string, string>): string | null {
  if (jar.size === 0) return null;
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}
