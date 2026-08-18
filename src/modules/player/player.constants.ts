/**
 * WHY the error codes live next to the module rather than in @common/exceptions/error-codes:
 * that map owns the codes the EDGES throw (auth, transport, persistence). These are domain codes —
 * the mini-app switches on them to decide what to render, and support quotes them. Same rules
 * apply: SCREAMING_SNAKE, never renamed, never reused, no values baked into the code itself.
 */

export const PlayerErrorCodes = {
  PLAYER_NOT_FOUND: 'PLAYER_NOT_FOUND',
  /** Account is SUSPENDED/CLOSED: authenticated, but may not transact. */
  PLAYER_NOT_ACTIVE: 'PLAYER_NOT_ACTIVE',
  PLAYER_SELF_EXCLUDED: 'PLAYER_SELF_EXCLUDED',

  /** Ichancy definitively refused to register/resolve the mirror account. */
  ICHANCY_LINK_REJECTED: 'ICHANCY_LINK_REJECTED',
  /** We could not determine whether the mirror exists. Retryable, never a silent success. */
  ICHANCY_LINK_AMBIGUOUS: 'ICHANCY_LINK_AMBIGUOUS',
  /** Another request is already linking this player. */
  ICHANCY_LINK_IN_PROGRESS: 'ICHANCY_LINK_IN_PROGRESS',

  /**
   * The one-time bot code is unknown, already used, expired, or was minted in the admin scope.
   * Deliberately ONE code for all four: telling a caller that a code was real but late confirms a
   * guess, which turns the exchange route into an oracle for the code space.
   */
  BOT_CODE_INVALID: 'BOT_CODE_INVALID',

  REFERRAL_ALREADY_BOUND: 'REFERRAL_ALREADY_BOUND',
  REFERRAL_SELF: 'REFERRAL_SELF',
  REFERRAL_UNKNOWN_REFERRER: 'REFERRAL_UNKNOWN_REFERRER',
  REFERRAL_PAYLOAD_INVALID: 'REFERRAL_PAYLOAD_INVALID',
} as const;

export type PlayerErrorCode = (typeof PlayerErrorCodes)[keyof typeof PlayerErrorCodes];

/**
 * Domain of the synthetic mailbox we hand Ichancy. The address must be syntactically valid (their
 * API validates it) but must never be deliverable — the player never sees these credentials and no
 * mail may ever reach a real inbox from them.
 *
 * A `.invalid` TLD is reserved by RFC 2606 exactly for this: guaranteed never to resolve.
 */
export const ICHANCY_PLAYER_EMAIL_DOMAIN = 'players.ichancy-cashier.invalid';

/** Derivation labels. Distinct labels are what make reusing one root secret safe. */
export const CREDENTIAL_INFO_LOGIN = 'ichancy-player-login:v1';
export const CREDENTIAL_INFO_PASSWORD = 'ichancy-player-password:v1';
export const CREDENTIAL_INFO_ENCRYPTION = 'ichancy-player-password-enc:v1';

/**
 * Held across the whole ensurePlayer round trip. Registration is not idempotent on their side in
 * any way we can key on, so two concurrent linkers would issue two registerPlayer calls for the
 * same login; the second gets "Duplicate login" and both then resolve the same id. Harmless but
 * wasteful, and it doubles the ichancy_calls noise on the one endpoint we most need to read.
 */
export const PLAYER_LINK_LOCK_TTL_MS = 30_000;

export const playerLinkLockKey = (playerId: string): string => `player-link:${playerId}`;

/** Guards the read-then-write of the once-only referral binding. */
export const REFERRAL_BIND_LOCK_TTL_MS = 5_000;

export const referralBindLockKey = (playerId: string): string => `player-referral:${playerId}`;
