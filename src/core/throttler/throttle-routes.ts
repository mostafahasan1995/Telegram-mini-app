/**
 * WHY the rules match on METHOD + PATH instead of decorating the handlers:
 *
 * `@Throttle()` would be the obvious answer, but the handlers that need throttling live in
 * `modules/player` and `modules/deposit`, and `core` may not import `modules` (eslint-plugin-
 * boundaries, and rightly so). Matching on the class/handler NAME would work without an import but
 * is silently broken by any rename. The URL is the one part of a controller that is a published
 * contract — the mini-app depends on it — so it is the part least likely to move without anybody
 * noticing.
 *
 * "Least likely" is still not "never", which is why `findUnmatchedRules()` exists and is called at
 * boot against the router's real route table. A rule that matches nothing is a rate limit that has
 * silently turned itself off; this makes that a loud startup error instead of a discovery made
 * during an incident.
 *
 * WHY the limits are per-minute and fairly generous: a large share of this product's users reach us
 * through carrier-grade NAT, where thousands of real people share one source IP. A tight per-IP
 * limit on the login exchange would lock out a whole city rather than an attacker. The two deposit
 * rules are keyed on the authenticated player instead (see `throttleTracker`), so they can afford to
 * be strict — they are protecting against one looping client, not a crowd.
 */
import type { ExecutionContext } from '@nestjs/common';

import { REQUEST_ADMIN_KEY, REQUEST_PLAYER_KEY } from '@common/decorators/auth.types';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

export interface ThrottleRule {
  /** Appears in logs and in the boot-time self-check; not part of the storage key. */
  readonly name: string;
  readonly method: string;
  readonly pattern: RegExp;
  /** Requests allowed per window. */
  readonly limit: number;
  /** Window length in milliseconds (@nestjs/throttler v5+ takes ms, not seconds). */
  readonly ttlMs: number;
  /** How long a caller stays rejected once they cross the limit. */
  readonly blockMs: number;
  /** A concrete path this rule must match — the fixture for findUnmatchedRules(). */
  readonly samplePath: string;
}

/**
 * The three surfaces named in the spec. Everything else is deliberately unthrottled: an admin
 * working through a review queue and a cron reading /health must never be rate limited, and a
 * blanket default is how that happens by accident.
 */
export const THROTTLE_RULES: readonly ThrottleRule[] = Object.freeze([
  {
    name: 'auth-exchange',
    method: 'POST',
    // Both routes that mint credentials: the initData exchange and refresh-token rotation.
    pattern: /^\/v1\/auth\/(telegram|refresh)$/,
    limit: 30,
    ttlMs: MINUTE,
    blockMs: MINUTE,
    samplePath: '/v1/auth/telegram',
  },
  {
    name: 'deposit-create',
    method: 'POST',
    pattern: /^\/v1\/deposits$/,
    limit: 12,
    ttlMs: MINUTE,
    blockMs: MINUTE,
    samplePath: '/v1/deposits',
  },
  {
    name: 'proof-upload',
    method: 'POST',
    // Proof bodies are base64 images: the most expensive thing an authenticated player can POST.
    pattern: /^\/v1\/deposits\/[^/]+\/proof$/,
    limit: 10,
    ttlMs: MINUTE,
    blockMs: 2 * MINUTE,
    samplePath: '/v1/deposits/0123456789/proof',
  },
]);

interface PathBearingRequest {
  method?: unknown;
  originalUrl?: unknown;
  url?: unknown;
  [REQUEST_PLAYER_KEY]?: { playerId?: unknown };
  [REQUEST_ADMIN_KEY]?: { adminUserId?: unknown };
  ip?: unknown;
  ips?: unknown;
}

/** Strips the query string and any trailing slash so `/v1/deposits/?x=1` still matches. */
export function normalizePath(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return '';
  const withoutQuery = rawUrl.split('?')[0] ?? '';
  if (withoutQuery.length > 1 && withoutQuery.endsWith('/')) return withoutQuery.slice(0, -1);
  return withoutQuery;
}

export function matchRule(method: unknown, rawUrl: unknown): ThrottleRule | undefined {
  if (typeof method !== 'string') return undefined;
  const upperMethod = method.toUpperCase();
  const path = normalizePath(rawUrl);
  if (path === '') return undefined;
  return THROTTLE_RULES.find((rule) => rule.method === upperMethod && rule.pattern.test(path));
}

export function ruleForContext(context: ExecutionContext): ThrottleRule | undefined {
  if (context.getType() !== 'http') return undefined;
  const request = context.switchToHttp().getRequest<PathBearingRequest>();
  return matchRule(request.method, request.originalUrl ?? request.url);
}

/**
 * The tracker is the identity a limit is counted against.
 *
 * The authenticated player (or admin) is preferred over the IP because it is the accurate unit of
 * abuse AND because it is immune to carrier NAT: one looping mini-app gets throttled without
 * touching the thousands of unrelated users sharing its public address. The IP is the fallback for
 * the auth exchange, where by definition there is no principal yet.
 *
 * Falling back to IP also means this works no matter where the ThrottlerGuard lands relative to the
 * AuthGuard in the global-guard order: with a principal it is precise, without one it is still safe.
 */
export function throttleTracker(request: unknown): string {
  const req = request as PathBearingRequest | null | undefined;

  const playerId = req?.[REQUEST_PLAYER_KEY]?.playerId;
  if (typeof playerId === 'string' && playerId.length > 0) return `player:${playerId}`;

  const adminUserId = req?.[REQUEST_ADMIN_KEY]?.adminUserId;
  if (typeof adminUserId === 'string' && adminUserId.length > 0) return `admin:${adminUserId}`;

  // `ips` is populated by express only when `trust proxy` is on, and its first entry is the
  // client-most address. Falling back to `ip` keeps this correct when running without a proxy.
  const forwarded = req?.ips;
  if (Array.isArray(forwarded) && typeof forwarded[0] === 'string' && forwarded[0].length > 0) {
    return `ip:${forwarded[0]}`;
  }
  return typeof req?.ip === 'string' && req.ip.length > 0 ? `ip:${req.ip}` : 'ip:unknown';
}

/**
 * Returns the rules whose pattern matches none of the application's registered routes.
 *
 * `registeredRoutes` are route templates in either the express (`/v1/deposits/:shortId/proof`) or
 * the OpenAPI (`/v1/deposits/{shortId}/proof`) dialect — the caller decides which route table it
 * can get hold of. Both are reduced to a concrete example path before testing, which is what lets a
 * static regex be checked against a parameterised route.
 */
export function findUnmatchedRules(
  registeredRoutes: readonly { method: string; path: string }[],
): ThrottleRule[] {
  const concrete = registeredRoutes.map((route) => ({
    method: route.method.toUpperCase(),
    path: normalizePath(route.path.replace(/\{[^}]+\}/g, 'x').replace(/:[^/]+/g, 'x')),
  }));

  return THROTTLE_RULES.filter(
    (rule) =>
      !concrete.some((route) => route.method === rule.method && rule.pattern.test(route.path)),
  );
}
