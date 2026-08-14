/**
 * WHY this guard is global and @Public() is the only way out: with an opt-in guard, the failure
 * mode of forgetting a decorator is an unauthenticated endpoint. On a service whose endpoints list
 * deposits and move money, that is not an acceptable default. Here, forgetting a decorator produces
 * a 401 — loud, harmless, and fixed in one line.
 *
 * The guard AUTHENTICATES and decides WHICH principal to attach; RolesGuard (running after it)
 * decides whether that principal's role is enough. Splitting them keeps "who are you" separate from
 * "may you", which is what lets @AdminAuth() with no roles mean "any active admin".
 *
 * A route with NO auth decorator at all is still authenticated — any valid principal passes. That
 * is the fail-closed default; @PlayerAuth()/@AdminAuth() narrow it.
 */
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError, UnauthorizedError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import { AUTH_REQUIREMENT_KEY, IS_PUBLIC_KEY } from '@common/decorators/auth.decorator';
import {
  REQUEST_ADMIN_KEY,
  REQUEST_PLAYER_KEY,
  type AuthRequirement,
  type RequestPrincipals,
} from '@common/decorators/auth.types';
import { PLAYER_ROLE } from '../auth.types';
import { AdminIdentityService } from '../services/admin-identity.service';
import { SessionService } from '../services/session.service';

interface BearerRequest extends RequestPrincipals {
  headers?: Record<string, string | string[] | undefined>;
}

function extractBearerToken(request: BearerRequest): string | null {
  const raw = request.headers?.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== 'string') return null;

  // Split on whitespace rather than slicing at index 7, so "Bearer  x" and a lowercase scheme
  // (both of which real clients send) still work.
  const [scheme, token] = header.split(/\s+/);
  if (scheme === undefined || token === undefined) return null;
  if (scheme.toLowerCase() !== 'bearer' || token.length === 0) return null;
  return token;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly admins: AdminIdentityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Queue processors and CLI commands have no HTTP request to authenticate. They run as SYSTEM
    // and are unreachable from outside the process.
    if (context.getType() !== 'http') return true;

    const targets = [context.getHandler(), context.getClass()];

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets);
    if (isPublic === true) return true;

    const requirement = this.reflector.getAllAndOverride<AuthRequirement | undefined>(
      AUTH_REQUIREMENT_KEY,
      targets,
    );

    const request = context.switchToHttp().getRequest<BearerRequest>();

    const token = extractBearerToken(request);
    if (token === null) {
      throw new UnauthorizedError(
        CommonErrorCodes.UNAUTHENTICATED,
        'A bearer access token is required.',
      );
    }

    const claims = await this.sessions.verifyAccessToken(token);

    if (claims.role === PLAYER_ROLE) {
      // The token is signed and in date, but the session behind it may have been revoked (logout,
      // rotation, or refresh-token reuse). That check is one Redis lookup and fails closed.
      if (await this.sessions.isSessionRevoked(claims.sid)) {
        throw new UnauthorizedError(
          CommonErrorCodes.SESSION_REVOKED,
          'This session has been signed out. Please sign in again.',
        );
      }

      request[REQUEST_PLAYER_KEY] = {
        playerId: claims.sub,
        telegramUserId: BigInt(claims.tgid),
        sessionId: claims.sid,
      };
    } else {
      // Note what is NOT trusted here: `claims.role`. It only tells us to look the caller up as an
      // admin; the authoritative role comes from the database (60s cache).
      const admin = await this.admins.resolve(BigInt(claims.tgid));
      if (!admin) {
        throw new ForbiddenError(
          CommonErrorCodes.ADMIN_INACTIVE,
          'This administrator account is no longer active.',
        );
      }
      request[REQUEST_ADMIN_KEY] = admin;
    }

    return this.enforceRequirement(requirement, request);
  }

  private enforceRequirement(
    requirement: AuthRequirement | undefined,
    request: BearerRequest,
  ): boolean {
    if (requirement === undefined) return true;

    if (requirement.kind === 'PLAYER' && request[REQUEST_PLAYER_KEY] === undefined) {
      throw new ForbiddenError(
        CommonErrorCodes.WRONG_PRINCIPAL,
        'This endpoint is for player accounts.',
      );
    }

    if (requirement.kind === 'ADMIN' && request[REQUEST_ADMIN_KEY] === undefined) {
      throw new ForbiddenError(
        CommonErrorCodes.WRONG_PRINCIPAL,
        'This endpoint is for administrator accounts.',
      );
    }

    return true;
  }
}
