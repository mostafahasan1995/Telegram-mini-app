/**
 * WHY @Public() is an opt-OUT rather than @Auth() being an opt-IN: the AuthGuard is registered
 * globally, so a route with no decorator at all is protected. Forgetting a decorator therefore
 * produces a 401 (annoying, visible, fixed in a minute) instead of an open endpoint over the
 * deposit queue (silent, catastrophic). Every @Public() route is a deliberate, reviewable line.
 *
 * @PlayerAuth() and @AdminAuth() do not add authentication — the global guard always authenticates.
 * They declare WHICH principal the route expects, which is what decides whether `req.player` or
 * `req.admin` gets populated and which one the caller must be.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import { type AdminRole } from '@prisma/client';
import { type AuthRequirement } from './auth.types';

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const AUTH_REQUIREMENT_KEY = 'auth:requirement';

/**
 * Skip authentication entirely. Reserved for: the Telegram webhook (authenticated by its own
 * secret-token header), /health/*, and the login/refresh endpoints that mint tokens.
 */
export const Public = (): CustomDecorator<string> => SetMetadata(IS_PUBLIC_KEY, true);

/** Route is for mini-app players. Populates `req.player`; an admin token is rejected. */
export const PlayerAuth = (): CustomDecorator<string> =>
  SetMetadata<string, AuthRequirement>(AUTH_REQUIREMENT_KEY, { kind: 'PLAYER' });

/**
 * Route is for staff. Populates `req.admin`.
 * With no arguments any active admin passes; with roles, RolesGuard additionally requires one of
 * them. SUPER_ADMIN is NOT implicitly granted — list it explicitly where it should pass, so a read
 * of the decorator tells the whole truth.
 */
export const AdminAuth = (...roles: AdminRole[]): CustomDecorator<string> =>
  SetMetadata<string, AuthRequirement>(AUTH_REQUIREMENT_KEY, { kind: 'ADMIN', roles });
