/**
 * WHY topics, task ids, lock keys and TTLs live in one file: every one of them is a CONTRACT between
 * two processes that never call each other. The api writes an outbox row with a topic; the worker's
 * dispatcher looks that topic up. The review service names a lock key; the credit worker takes it.
 * A typo in any of them is not a crash — it is a deposit that is accepted, committed, and then
 * silently never credited. Keeping them together makes both sides of each contract visible at once.
 */

/** Outbox topics this module produces. Handled by DepositOutboxHandler on the worker. */
export const DEPOSIT_TOPICS = {
  /** Approved and T1 posted; the credit worker may now call Ichancy. */
  CREDIT_REQUESTED: 'deposit.credit_requested',
  /** A proof arrived — post (or refresh) the admin review card. */
  NOTIFY_ADMIN: 'deposit.notify_admin',
  /** Redraw an existing admin card after a state change. */
  CARD_UPDATE: 'deposit.card_update',
  /** Tell the player something happened to their deposit. */
  NOTIFY_PLAYER: 'deposit.notify_player',
  /** Normalize + hash + duplicate-check a proof that was streamed in from Telegram. */
  PROOF_INGEST: 'deposit.proof_ingest',
  /** Operator-facing alert. Never a player message; goes to the admin chat. */
  ALERT: 'deposit.alert',
  /**
   * The credited ops card: a NEW admin-chat message per CREDITED deposit (Mafia-Bot style, with the
   * agent-float before/after from the T2 posting). Separate from CARD_UPDATE on purpose — the
   * review card is edited in place and ends as a receipt of the DECISION; this one is the money
   * record of the CREDIT and is appended, never edited.
   */
  OPS_CARD: 'deposit.ops_card',
} as const;

export type DepositTopic = (typeof DEPOSIT_TOPICS)[keyof typeof DEPOSIT_TOPICS];

/** Prefix every deposit topic shares, so the outbox handler can subscribe once. */
export const DEPOSIT_TOPIC_PREFIX = 'deposit.';

/** Aggregate name written to outbox_messages.aggregate_type. */
export const DEPOSIT_AGGREGATE = 'DepositRequest';

/** Idempotency scope for POST /v1/deposits. Never reuse it for another endpoint. */
export const DEPOSIT_CREATE_SCOPE = 'deposit.create';

/**
 * Idempotency scope guarding the credited ops card (key = deposit id). The outbox delivers
 * at-least-once and the card is a fresh sendMessage — there is nothing to edit in place, so the
 * insert-first idempotency_keys record is what makes a redelivered row a no-op instead of a
 * duplicate card in the admin group. One T2 per deposit forever ⇒ one ops card per deposit forever.
 */
export const OPS_CARD_IDEMPOTENCY_SCOPE = 'deposit.ops_card';

/** Telegram callback namespaces. Kept to 3 characters — callback_data has a 64 BYTE budget. */
export const DEPOSIT_CALLBACK = {
  CLAIM: 'd:c',
  APPROVE: 'd:a',
  REJECT: 'd:r',
} as const;

/** grammY routes callbacks by namespace, i.e. everything before the first ':'. */
export const DEPOSIT_CALLBACK_NS = 'd';

/**
 * How long an admin's soft claim on a deposit lasts. Long enough to read a receipt and check a bank
 * app, short enough that a reviewer who closed their laptop does not park a payment for a shift.
 */
export const REVIEW_CLAIM_MINUTES = 10;

/**
 * Per-player credit mutex. NOTE the key has no creditKeyEpoch in it, even though the schema comment
 * suggests one: the mutex exists to make the BALANCE DELTA meaningful, and a delta is only
 * interpretable if NOTHING else is moving that player's Ichancy balance. Putting the epoch in the
 * key would let a deliberate re-run (epoch 1) execute concurrently with a first attempt (epoch 0) on
 * the same player and destroy exactly the property the lock is for. The epoch instead guards
 * staleness: the worker re-reads it from the row and aborts if the job carries an older one.
 */
export const playerCreditLockKey = (playerId: string): string => `lock:player-credit:${playerId}`;

/** TTL of that mutex. Extended across the verify window rather than set long up front. */
export const CREDIT_LOCK_TTL_MS = 60_000;
/** How many times we push the TTL out while waiting for Ichancy to settle. */
export const CREDIT_LOCK_EXTEND_MS = 60_000;
/** Fail fast on contention: another worker already owns this player, and BullMQ will retry us. */
export const CREDIT_LOCK_RETRIES = 2;
export const CREDIT_LOCK_RETRY_DELAY_MS = 250;

/**
 * Pause between an ambiguous credit call and the balance re-read. Ichancy's write is not guaranteed
 * to be visible to a read issued in the same second; re-reading immediately would report "no delta"
 * for a credit that did land and push us into an unnecessary retry.
 */
export const BALANCE_VERIFY_DELAY_MS = 4_000;

/** Extra delay before the second (post-retry) verification read. */
export const BALANCE_VERIFY_RETRY_DELAY_MS = 6_000;

/**
 * Deterministic BullMQ job id, so a re-published outbox row cannot enqueue a second credit.
 *
 * '-' separators, never ':': BullMQ rejects custom job ids containing ':' except through a
 * three-segment compatibility loophole its own code marks for removal. This id only worked because
 * it happened to have exactly three segments; the sibling two-segment ids in the outbox handler
 * threw "Custom Id cannot contain :" on every dispatch. See deposit-outbox.handler.ts.
 */
export const creditJobId = (depositRequestId: string, creditKeyEpoch: number): string =>
  `deposit-credit-${depositRequestId}-${creditKeyEpoch}`;

/** Cross-player proof matching window. 180 days is the fraud-review horizon the product asked for. */
export const PROOF_DUPLICATE_WINDOW_DAYS = 180;
export const PROOF_DUPLICATE_WINDOW_MS = PROOF_DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Hamming threshold on the 64-bit dHash. 6 is the value the banded index below is built for: with
 * 8 bands, two hashes within 6 bits must share at least 2 whole bands, so the index has no false
 * negatives at this threshold and would start missing matches above it.
 */
export const PROOF_DUPLICATE_MAX_DISTANCE = 6;
export const PROOF_HASH_BAND_COUNT = 8;

/** Redis key for one band of the perceptual index. */
export const proofBandKey = (band: string): string => `proof:phash:band:${band}`;

/** Redis key holding the full record of one indexed proof. */
export const proofRecordKey = (proofId: string): string => `proof:phash:rec:${proofId}`;

/** Presigned proof URLs are bearer credentials for a document identifying a real person. */
export const PROOF_URL_TTL_SECONDS = 300;

/** Maximum proofs a single deposit may carry. Stops an upload loop from filling a bucket. */
export const MAX_PROOFS_PER_DEPOSIT = 5;

/** Rolling window for the per-player deposit cap enforced by DepositPolicyService. */
export const DEPOSIT_CAP_WINDOW_HOURS = 24;

/** Deposits allowed to be open (not terminal) per player at once. */
export const MAX_OPEN_DEPOSITS_PER_PLAYER = 3;

/** A deposit parked in CREDITING longer than this is stuck — its worker died mid-flight. */
export const CREDITING_STUCK_MINUTES = 20;
