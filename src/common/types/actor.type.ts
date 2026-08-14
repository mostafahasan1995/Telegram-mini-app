/**
 * WHY: every money movement and every state transition must name who caused it. Passing this one
 * shape around (instead of a loose `userId: string`) makes it impossible to write a ledger row or
 * an audit log without answering "player, admin, or the system itself?".
 *
 * `id` is null only for SYSTEM (cron, outbox relay, reconciliation) — never for PLAYER/ADMIN.
 */
export type Actor = { type: 'PLAYER' | 'ADMIN' | 'SYSTEM'; id: string | null };

/** The actor for anything triggered by a schedule, a queue processor, or the outbox relay. */
export const SYSTEM_ACTOR: Actor = Object.freeze({ type: 'SYSTEM', id: null });

export const playerActor = (playerId: string): Actor => ({ type: 'PLAYER', id: playerId });

export const adminActor = (adminUserId: string): Actor => ({ type: 'ADMIN', id: adminUserId });
