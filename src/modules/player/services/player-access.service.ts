/**
 * WHY a where-FRAGMENT instead of a boolean `canRead(playerId)` check:
 *
 * A boolean check protects the row you remembered to check. A fragment protects the QUERY, which
 * means it also protects the rows you did not think about — the list endpoint, the count, the
 * aggregate. The dangerous bug in a cashier backend is not "player A opened player B's profile"
 * (one check catches that), it is "the deposit list forgot the filter" and every player sees every
 * deposit. A scope you must pass to the query cannot be forgotten silently: there is nothing to
 * pass it to but the query.
 *
 * WHY `restrict()` exists and why nobody should spread the fragment by hand:
 *
 *     { ...callerWhere, ...scope }   // WRONG
 *
 * Object spread lets whichever side is written last win. If `callerWhere` carries an `id` from a
 * query string and the scope also constrains `id`, one of them is silently discarded — and which
 * one depends on the order someone typed. `restrict()` combines them with Prisma's AND, so both
 * constraints always survive and a caller filter can only ever NARROW the scope, never widen it.
 */
import { Injectable } from '@nestjs/common';
import type { AdminRole, Prisma } from '@prisma/client';

import { ForbiddenError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import type { AuthenticatedAdmin, AuthenticatedPlayer } from '@common/decorators/auth.types';

/**
 * Who is looking. SYSTEM is for cron/queue work that legitimately spans every player; it is a
 * separate case rather than "admin with no id" so that an unauthenticated request can never fall
 * through into it.
 */
export type PlayerViewer =
  | { readonly type: 'PLAYER'; readonly playerId: string }
  | { readonly type: 'ADMIN'; readonly adminUserId: string; readonly role: AdminRole }
  | { readonly type: 'SYSTEM' };

export const viewerFromPlayer = (player: AuthenticatedPlayer): PlayerViewer => ({
  type: 'PLAYER',
  playerId: player.playerId,
});

export const viewerFromAdmin = (admin: AuthenticatedAdmin): PlayerViewer => ({
  type: 'ADMIN',
  adminUserId: admin.adminUserId,
  role: admin.role,
});

export const SYSTEM_VIEWER: PlayerViewer = Object.freeze({ type: 'SYSTEM' });

/** Any where-input whose `AND` accepts an array — every generated Prisma *WhereInput qualifies. */
type AndableWhere<T> = T & { AND?: unknown };

@Injectable()
export class PlayerAccessService {
  /**
   * Scope for queries over `players` itself.
   * A player is pinned to their own row; staff and the system see everything.
   */
  playerScope(viewer: PlayerViewer): Prisma.PlayerWhereInput {
    return viewer.type === 'PLAYER' ? { id: viewer.playerId } : {};
  }

  /**
   * Scope for any table that has a `playerId` column (deposit_requests, player_limits,
   * self_exclusions, ledger_accounts…). Returned as a plain fragment so each module can apply it to
   * its own generated where-input without this service knowing those types.
   */
  ownedScope(viewer: PlayerViewer): { playerId?: string } {
    return viewer.type === 'PLAYER' ? { playerId: viewer.playerId } : {};
  }

  /**
   * Combines a caller-supplied filter with a scope so that the scope ALWAYS applies.
   * Use this instead of spreading — see the file header for why.
   */
  restrict<TWhere extends object>(where: TWhere | undefined, scope: object): TWhere {
    const scopeIsEmpty = Object.keys(scope).length === 0;
    if (scopeIsEmpty) return (where ?? {}) as TWhere;
    if (where === undefined || Object.keys(where).length === 0) return scope as TWhere;
    return { AND: [where, scope] } as AndableWhere<TWhere>;
  }

  /** `players` query, already scoped. The one-liner most call sites actually want. */
  scopedPlayerWhere(
    viewer: PlayerViewer,
    where?: Prisma.PlayerWhereInput,
  ): Prisma.PlayerWhereInput {
    return this.restrict(where, this.playerScope(viewer));
  }

  /** True when this viewer is allowed to see the given player's data at all. */
  canAccessPlayer(viewer: PlayerViewer, playerId: string): boolean {
    return viewer.type !== 'PLAYER' || viewer.playerId === playerId;
  }

  /**
   * Guard for the handful of paths that address a player directly and cannot express the rule as a
   * query filter (a Telegram handler, a presigned-URL issue). Everything that CAN use a filter
   * should use one — a filter cannot be skipped by an early return.
   */
  assertCanAccessPlayer(viewer: PlayerViewer, playerId: string): void {
    if (!this.canAccessPlayer(viewer, playerId)) {
      // Deliberately the same message a stranger's id produces, so this never confirms that a
      // given player id exists.
      throw new ForbiddenError(
        CommonErrorCodes.FORBIDDEN,
        'You are not allowed to access this player.',
      );
    }
  }
}
