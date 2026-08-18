/**
 * The admin half of the bot-code login.
 *
 * The mechanism itself — generate, hash, store, redeem once — lives in `@core/auth`'s
 * LoginCodeService, because `modules/player` needs exactly the same thing and
 * `eslint-plugin-boundaries` forbids modules/player -> modules/admin. This class is the thin
 * admin-scoped face of it, so callers here cannot accidentally mint or redeem in the player scope.
 *
 * See `core/auth/services/login-code.service.ts` for why codes are hashed, why redemption is
 * GETDEL, and why the alphabet has no I/O/0/1.
 */
import { Injectable } from '@nestjs/common';

import type { AuthenticatedAdmin } from '@common/decorators/auth.types';
import {
  LoginCodeService,
  LOGIN_CODE_TTL_MINUTES,
  LOGIN_CODE_TTL_SECONDS,
  type MintedLoginCode,
} from '@core/auth/services/login-code.service';

export { LOGIN_CODE_TTL_MINUTES, LOGIN_CODE_TTL_SECONDS, type MintedLoginCode };

/** Scope constant, named once so a typo cannot silently mint into the wrong namespace. */
const SCOPE = 'admin' as const;

@Injectable()
export class AdminLoginCodeService {
  constructor(private readonly codes: LoginCodeService) {}

  /**
   * Issues a code for an already-authenticated admin.
   *
   * The stored subject is the TELEGRAM id, not the AdminUser id, so redemption goes back through
   * AdminIdentityService and re-checks `isActive`. An admin offboarded in the five minutes between
   * /login and sign-in is then refused at redemption — which is the whole point of resolving
   * authority on every request rather than trusting a snapshot.
   */
  async mint(admin: AuthenticatedAdmin): Promise<MintedLoginCode> {
    return this.codes.mint(SCOPE, admin.telegramUserId);
  }

  /** Redeems an ADMIN-scoped code exactly once. A player code will not resolve here. */
  async redeem(rawCode: string): Promise<bigint | null> {
    return this.codes.redeem(SCOPE, rawCode);
  }
}
