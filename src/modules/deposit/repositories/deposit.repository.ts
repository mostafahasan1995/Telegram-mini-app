/**
 * WHY every method takes `tx` FIRST: a deposit read that decides whether to move money must be able
 * to happen inside the same transaction and under the same locks as the write it justifies. Making
 * the transaction the first parameter (rather than an optional trailing one) means a caller cannot
 * accidentally read outside the transaction it is about to write in — the compiler asks for it.
 *
 * WHY it does not extend BaseRepository: nothing here is a generic CRUD shape. Every query is either
 * a keyset page over an append-heavy queue, an aggregate over a rolling window, or a lock-ordered
 * read. Inheriting a generic `_findMany` would add a layer that none of them use.
 *
 * NOTE: this repository never writes `status`. That column belongs to DepositStateMachine and to
 * nothing else — see its header for why.
 */
import { Injectable } from '@nestjs/common';
import { DepositStatus, Prisma, type DepositProof, type DepositRequest } from '@prisma/client';

import type { Tx } from '@core/prisma/tx.type';

import { OPEN_STATUSES } from '../deposit-state.machine';
import {
  buildCursorWhere,
  buildOrderBy,
  buildWhere,
  combineWhere,
  decodeDepositCursor,
  type DepositFilter,
  type DepositSort,
} from '../utils/deposit-filter.util';

/** Rows the admin card and the review endpoints always need together. */
const REVIEW_INCLUDE = {
  player: { select: { id: true, telegramUserId: true, telegramUsername: true, status: true } },
  paymentMethod: {
    select: {
      id: true,
      code: true,
      displayName: true,
      instructions: true,
      requiresReference: true,
      referencePattern: true,
      feeFixedMinor: true,
      feeBps: true,
      minAmountMinor: true,
      maxAmountMinor: true,
      currencyCode: true,
      isActive: true,
      verificationMode: true,
    },
  },
  paymentDestination: {
    select: { id: true, label: true, accountIdentifier: true, accountHolder: true },
  },
  proofs: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.DepositRequestInclude;

export type DepositWithReviewContext = Prisma.DepositRequestGetPayload<{
  include: typeof REVIEW_INCLUDE;
}>;

export interface DepositPage {
  rows: DepositRequest[];
  /** Present because the caller asked for limit+1 rows; the caller trims it. */
  hasMore: boolean;
}

@Injectable()
export class DepositRepository {
  findById(tx: Tx, id: string): Promise<DepositRequest | null> {
    return tx.depositRequest.findUnique({ where: { id } });
  }

  findByIdWithContext(tx: Tx, id: string): Promise<DepositWithReviewContext | null> {
    return tx.depositRequest.findUnique({ where: { id }, include: REVIEW_INCLUDE });
  }

  findByShortId(tx: Tx, shortId: string): Promise<DepositWithReviewContext | null> {
    return tx.depositRequest.findUnique({ where: { shortId }, include: REVIEW_INCLUDE });
  }

  /**
   * Scoped by player on purpose: an endpoint that looks a deposit up by shortId alone and checks
   * ownership afterwards is one refactor away from being an enumeration oracle over other people's
   * payments.
   */
  findByShortIdForPlayer(
    tx: Tx,
    shortId: string,
    playerId: string,
  ): Promise<DepositWithReviewContext | null> {
    return tx.depositRequest.findFirst({ where: { shortId, playerId }, include: REVIEW_INCLUDE });
  }

  findByIdempotencyKey(tx: Tx, key: string): Promise<DepositRequest | null> {
    return tx.depositRequest.findUnique({ where: { idempotencyKey: key } });
  }

  create(tx: Tx, data: Prisma.DepositRequestUncheckedCreateInput): Promise<DepositRequest> {
    return tx.depositRequest.create({ data });
  }

  /** Offset page for a player's own history — small, and they get a total. */
  async listForPlayer(
    tx: Tx,
    playerId: string,
    filter: Omit<DepositFilter, 'playerId'>,
    take: number,
    skip: number,
  ): Promise<{ rows: DepositRequest[]; total: number }> {
    const where = buildWhere({ ...filter, playerId });
    const [rows, total] = [
      await tx.depositRequest.findMany({
        where,
        orderBy: buildOrderBy('newest'),
        take,
        skip,
      }),
      await tx.depositRequest.count({ where }),
    ];
    return { rows, total };
  }

  /**
   * Keyset page for the admin queue. Fetches `limit + 1` so the caller can derive `hasMore` without
   * a COUNT over a table that is being appended to while we read it.
   */
  async pageForAdmin(
    tx: Tx,
    filter: DepositFilter,
    cursor: string | undefined,
    limit: number,
    sort: DepositSort = 'newest',
  ): Promise<DepositWithReviewContext[]> {
    const where = combineWhere(
      buildWhere(filter),
      buildCursorWhere(decodeDepositCursor(cursor ?? null), sort),
    );
    return tx.depositRequest.findMany({
      where,
      orderBy: buildOrderBy(sort),
      take: limit + 1,
      include: REVIEW_INCLUDE,
    });
  }

  countOpenForPlayer(tx: Tx, playerId: string): Promise<number> {
    return tx.depositRequest.count({
      where: { playerId, status: { in: [...OPEN_STATUSES] } },
    });
  }

  /**
   * Money accepted in a rolling window, for the per-player cap.
   *
   * Counts what we ACCEPTED, not what was claimed: a rejected claim never cost the player anything,
   * and counting it would let a mistyped amount lock someone out of their own cap for a day. Rows
   * still in flight count at their claimed amount, because they may yet be approved.
   */
  async sumAcceptedSince(tx: Tx, playerId: string, since: Date): Promise<bigint> {
    const rows = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM(COALESCE(verified_amount_minor, claimed_amount_minor)), 0)::bigint
             AS total
      FROM deposit_requests
      WHERE player_id = ${playerId}::uuid
        AND created_at >= ${since}
        AND status NOT IN (
          'REJECTED'::deposit_status,
          'EXPIRED'::deposit_status,
          'REVERSED'::deposit_status,
          'CREDIT_FAILED'::deposit_status
        )
    `;
    return rows[0]?.total ?? 0n;
  }

  /**
   * Money one admin has approved since `since`.
   *
   * NOT used by the approval path any more — the daily authority budget is enforced by
   * APPROVAL_LIMIT_PORT (the admin module owns `admin_approval_limits`). Kept because it answers a
   * different question the deposit module legitimately owns: "what has this reviewer released?",
   * which reporting and an after-the-fact investigation both need. Deleting it and re-deriving it
   * later from a different set of statuses would make two reports disagree.
   */
  async sumApprovedByAdminSince(tx: Tx, adminUserId: string, since: Date): Promise<bigint> {
    const rows = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM(COALESCE(verified_amount_minor, claimed_amount_minor)), 0)::bigint
             AS total
      FROM deposit_requests
      WHERE decided_at >= ${since}
        AND (decided_by_admin_id = ${adminUserId}::uuid
          OR second_approver_admin_id = ${adminUserId}::uuid)
        AND status IN (
          'APPROVED'::deposit_status,
          'CREDITING'::deposit_status,
          'CREDITED'::deposit_status,
          'CREDIT_FAILED'::deposit_status,
          'NEEDS_RECONCILIATION'::deposit_status
        )
    `;
    return rows[0]?.total ?? 0n;
  }

  lastSubmissionAt(tx: Tx, playerId: string): Promise<{ createdAt: Date } | null> {
    return tx.depositRequest.findFirst({
      where: { playerId, status: { notIn: [DepositStatus.DRAFT] } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
  }

  /** Non-rejected deposits already claiming this rail reference. Drives REFERENCE_REUSED. */
  findByReference(
    tx: Tx,
    paymentMethodId: string,
    externalReference: string,
  ): Promise<DepositRequest[]> {
    return tx.depositRequest.findMany({
      where: {
        paymentMethodId,
        externalReference,
        status: { not: DepositStatus.REJECTED },
      },
      take: 5,
    });
  }

  countProofs(tx: Tx, depositRequestId: string): Promise<number> {
    return tx.depositProof.count({ where: { depositRequestId } });
  }

  listProofs(tx: Tx, depositRequestId: string): Promise<DepositProof[]> {
    return tx.depositProof.findMany({
      where: { depositRequestId },
      orderBy: { createdAt: 'asc' },
    });
  }

  findProof(tx: Tx, proofId: string): Promise<DepositProof | null> {
    return tx.depositProof.findUnique({ where: { id: proofId } });
  }

  createProof(tx: Tx, data: Prisma.DepositProofUncheckedCreateInput): Promise<DepositProof> {
    return tx.depositProof.create({ data });
  }

  updateProof(
    tx: Tx,
    proofId: string,
    data: Prisma.DepositProofUncheckedUpdateInput,
  ): Promise<DepositProof> {
    return tx.depositProof.update({ where: { id: proofId }, data });
  }

  /**
   * Every deposit that has ever carried this exact content hash — the cheapest cross-player fraud
   * signal there is, and the only one that survives a Redis flush.
   */
  findDepositsBySha256(
    tx: Tx,
    sha256: string,
    excludeDepositRequestId: string,
  ): Promise<{ depositRequestId: string; playerId: string; createdAt: Date }[]> {
    return tx.depositProof
      .findMany({
        where: { sha256, depositRequestId: { not: excludeDepositRequestId } },
        select: {
          depositRequestId: true,
          createdAt: true,
          depositRequest: { select: { playerId: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      })
      .then((rows) =>
        rows.map((row) => ({
          depositRequestId: row.depositRequestId,
          playerId: row.depositRequest.playerId,
          createdAt: row.createdAt,
        })),
      );
  }

  /** Where the admin review card lives, so a worker can edit that exact message later. */
  recordAdminCard(
    tx: Tx,
    depositRequestId: string,
    card: { chatId: bigint; messageId: bigint; threadId: bigint | null },
  ): Promise<Prisma.BatchPayload> {
    return tx.depositRequest.updateMany({
      where: { id: depositRequestId },
      data: {
        adminChatId: card.chatId,
        adminMessageId: card.messageId,
        adminThreadId: card.threadId,
      },
    });
  }

  /** The transition rows carrying risk flags, newest first. See enums/risk-flag.enum.ts. */
  findTransitionsWithMetadata(
    tx: Tx,
    depositRequestId: string,
    limit = 10,
  ): Promise<{ metadata: Prisma.JsonValue | null }[]> {
    return tx.depositTransition.findMany({
      where: { depositRequestId, metadata: { not: Prisma.DbNull } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { metadata: true },
    });
  }

  /** Ids only: the expiry cron transitions them one at a time and must not hold a big result set. */
  findExpiredOpenIds(tx: Tx, now: Date, limit: number): Promise<{ id: string }[]> {
    return tx.depositRequest.findMany({
      where: {
        status: { in: [DepositStatus.DRAFT, DepositStatus.AWAITING_PROOF] },
        expiresAt: { lt: now },
      },
      orderBy: { expiresAt: 'asc' },
      take: limit,
      select: { id: true },
    });
  }

  findStaleClaimIds(tx: Tx, staleBefore: Date, limit: number): Promise<{ id: string }[]> {
    return tx.depositRequest.findMany({
      where: { status: DepositStatus.UNDER_REVIEW, reviewStartedAt: { lt: staleBefore } },
      orderBy: { reviewStartedAt: 'asc' },
      take: limit,
      select: { id: true },
    });
  }

  findStuckCreditingIds(
    tx: Tx,
    staleBefore: Date,
    limit: number,
  ): Promise<{ id: string; creditKeyEpoch: number }[]> {
    return tx.depositRequest.findMany({
      where: { status: DepositStatus.CREDITING, updatedAt: { lt: staleBefore } },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: { id: true, creditKeyEpoch: true },
    });
  }
}
