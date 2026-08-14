/**
 * WHY a port with a STRING token, when PlayerLinkService is a perfectly good class:
 *
 * The credit worker must guarantee an Ichancy mirror exists before the first depositToPlayer, and
 * that worker does not live in this module. `eslint-plugin-boundaries` forbids modules/A importing
 * modules/B — correctly, because a Telegram handler reaching into deposit internals is exactly the
 * failure this project is built to prevent. But that rule also blocks the legitimate direction, and
 * "just import it anyway" would be a build failure, while "duplicate the linking logic" would be
 * two implementations of a non-idempotent registration call.
 *
 * A plain string token needs no import at all. Another module writes
 *
 *     @Inject('PLAYER_LINK_PORT') private readonly playerLink: PlayerLinkPort
 *
 * with its own structurally-identical local interface, and the binding is made in the root module,
 * which is allowed to see everything. No layering violation, one implementation.
 *
 * PROPER FIX (for whoever owns src/core): promote `PlayerLinkPort` + the token into
 * `src/core/player-link/` the way `ICHANCY_PORT` already lives in core. Then consumers import the
 * type from `@core/...` and nobody hand-copies an interface. This file is shaped so that move is a
 * re-export, not a rewrite.
 */

/** DI token. Deliberately a string literal so it can be referenced without importing this file. */
export const PLAYER_LINK_PORT = 'PLAYER_LINK_PORT';

export interface LinkedIchancyAccount {
  /** OUR Player.id. */
  readonly playerId: string;
  /** The id inside Ichancy — resolved via lookup, because registerPlayer only ever returns `1`. */
  readonly ichancyPlayerId: string;
  /** The login we registered, kept so a human can find the account in their back-office. */
  readonly ichancyLogin: string;
  /** True only when THIS call created the mirror; false when it already existed. */
  readonly created: boolean;
}

export interface PlayerLinkPort {
  /**
   * Idempotent. Returns the existing mirror, or creates one, or throws:
   *  - 422 ICHANCY_LINK_REJECTED  — Ichancy definitively refused. Do not retry unchanged.
   *  - 503 ICHANCY_LINK_AMBIGUOUS — we cannot tell whether the account exists. Retryable.
   *  - 409 ICHANCY_LINK_IN_PROGRESS — another call holds the per-player lock. Retryable.
   *
   * It NEVER returns a partially-linked player: either `ichancyPlayerId` is persisted and returned,
   * or it throws.
   */
  ensureLinked(playerId: string, correlationId?: string | null): Promise<LinkedIchancyAccount>;
}
