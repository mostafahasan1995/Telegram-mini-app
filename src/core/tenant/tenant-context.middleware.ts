/**
 * WHY MIDDLEWARE AND NOT AN INTERCEPTOR: this has to run BEFORE any guard. AuthGuard resolves the
 * admin identity through AdminIdentityService, which looks the row up by (tenantId, telegramUserId)
 * — so the tenant has to be established before the guard, and Nest runs middleware first.
 * An interceptor runs AFTER guards and would be too late to be the thing authority is measured in.
 *
 * WHY IT VERIFIES THE TOKEN ITSELF instead of reading something AuthGuard left behind: same reason.
 * Nothing has authenticated yet at this point in the chain. Decoding without verifying would make
 * the tenant — and therefore the tenant that identity is resolved in — attacker-controlled, which
 * is an authentication bypass wearing a header. The verification is pinned to HS256 against the
 * same secret as SessionService, and JwtModule's `verifyOptions` pins it a second time.
 *
 * WHY A BAD TOKEN IS NOT REJECTED HERE: a 401 thrown from middleware bypasses the exception filter
 * that builds the response envelope, so the client would get a bare Express error instead of
 * `{ success: false, error: { code, message }, meta: {...} }`. Anything not verifiable is simply
 * left without a tenant context; AuthGuard then produces the canonical 401 a moment later. The
 * only requests that legitimately arrive with no token are @Public() ones — health, the Telegram
 * webhook (which resolves its own tenant from the path token) and the sign-in routes.
 */
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { NextFunction, Request, Response } from 'express';

import { AppConfigService } from '../config/config.service';

import { createTenantContext, runWithTenantStore } from './tenant.storage';

interface TenantClaims {
  tid?: unknown;
}

function extractBearerToken(request: Request): string | null {
  const raw = request.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== 'string') return null;

  // Split on whitespace rather than slicing at index 7 — matches AuthGuard, which accepts
  // "Bearer  x" and a lowercase scheme because real clients send both.
  const [scheme, token] = header.split(/\s+/);
  if (scheme === undefined || token === undefined) return null;
  if (scheme.toLowerCase() !== 'bearer' || token.length === 0) return null;
  return token;
}

@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  use(request: Request, _response: Response, next: NextFunction): void {
    const token = extractBearerToken(request);
    if (token === null) {
      next();
      return;
    }

    let claims: TenantClaims;
    try {
      claims = this.jwt.verify<TenantClaims>(token, {
        algorithms: ['HS256'],
        secret: this.config.jwt.secret,
      });
    } catch {
      // Expired, forged, or simply the wrong shape. AuthGuard owns the error response.
      next();
      return;
    }

    const tid = claims.tid;
    if (typeof tid !== 'string' || tid.length === 0) {
      // A token minted before the tenant claim existed. It will fail the guard's shape check.
      next();
      return;
    }

    // Express runs the remainder of the chain — guards, interceptors, the handler — inside this
    // call, so AsyncLocalStorage propagates to all of it.
    runWithTenantStore(createTenantContext(tid), () => {
      next();
    });
  }
}
