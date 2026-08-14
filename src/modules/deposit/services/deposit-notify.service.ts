/**
 * Everything that sends a Telegram message about a deposit.
 *
 * WHY the card is EDITED rather than reposted: an admin group with one card per state change is
 * unreadable within a day, and — worse — an old card still shows old buttons. Editing in place means
 * there is exactly one card per deposit, it always shows the current state, and a terminal state
 * strips the keyboard so a stale tap is impossible rather than merely futile.
 *
 * WHY a send failure never propagates into money logic: BotService already turns "bot was blocked"
 * and "message is not modified" into non-errors. What is left (429, 5xx) IS thrown, because the
 * queue should retry those — but the credit that caused the message has already committed, so a
 * retry re-sends a notification, never re-credits anything.
 *
 * `adminChatId`/`adminMessageId` are recorded on the deposit the first time a card is posted, so
 * every later edit addresses that exact message across process restarts.
 */
import { Injectable, Logger } from '@nestjs/common';
import { DepositStatus, type Prisma } from '@prisma/client';

import { AppConfigService } from '@core/config/config.service';
import { IdempotencyService } from '@core/idempotency/idempotency.service';
import { BALANCE_SNAPSHOT_METADATA_KEY, ichancyAgentFloatCode } from '@core/ledger';
import { PrismaService } from '@core/prisma/prisma.service';
import { BotService } from '@core/telegram/services/bot.service';

import { OPS_CARD_IDEMPOTENCY_SCOPE } from '../deposit.constants';
import { DepositRepository } from '../repositories/deposit.repository';
import { DepositService } from './deposit.service';
import {
  renderAdminCard,
  renderAdminKeyboard,
  renderOpsCard,
  renderPlayerMessage,
  esc,
} from '../telegram/deposit-card.util';

@Injectable()
export class DepositNotifyService {
  private readonly logger = new Logger(DepositNotifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deposits: DepositRepository,
    private readonly depositService: DepositService,
    private readonly bot: BotService,
    private readonly config: AppConfigService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Post the review card if it does not exist yet, otherwise refresh it. Idempotent by design: the
   * outbox delivers at least once and a redelivery must not produce a second card.
   */
  async postOrUpdateAdminCard(depositRequestId: string, reason: string): Promise<void> {
    const deposit = await this.deposits.findByIdWithContext(this.prisma, depositRequestId);
    if (deposit === null) {
      this.logger.warn(`admin card requested for unknown deposit ${depositRequestId}`);
      return;
    }

    const riskFlags = await this.depositService.riskFlagsFor(this.prisma, deposit.id);
    const reviewer =
      deposit.decidedByAdminId === null
        ? null
        : await this.prisma.adminUser.findUnique({
            where: { id: deposit.decidedByAdminId },
            select: { displayName: true },
          });

    const text = renderAdminCard({
      deposit,
      proofs: deposit.proofs,
      riskFlags,
      playerLabel: this.playerLabel(deposit.player),
      paymentMethodName: deposit.paymentMethod.displayName,
      destinationLabel: deposit.paymentDestination?.label ?? null,
      reviewerLabel:
        deposit.status === DepositStatus.UNDER_REVIEW ? (reviewer?.displayName ?? null) : null,
      requiresSecondApproval: deposit.status === DepositStatus.PENDING_SECOND_APPROVAL,
    });
    const keyboard = renderAdminKeyboard(deposit);

    if (deposit.adminChatId !== null && deposit.adminMessageId !== null) {
      const edited = await this.bot.editMessageText(
        deposit.adminChatId,
        Number(deposit.adminMessageId),
        text,
        { parseMode: 'HTML', replyMarkup: keyboard, linkPreview: false },
      );
      if (edited) return;
      // The card was deleted in the group. Fall through and post a fresh one rather than lose the
      // only place an admin can act on this deposit.
      this.logger.warn(`card for ${deposit.shortId} was gone; posting a new one (${reason})`);
    }

    const message = await this.bot.notifyAdmins(text, {
      parseMode: 'HTML',
      replyMarkup: keyboard,
      linkPreview: false,
    });
    if (message === null) {
      this.logger.error(
        `admin chat ${this.config.telegram.adminChatId.toString()} is unreachable; ` +
          `deposit ${deposit.shortId} has no review card`,
      );
      return;
    }

    await this.deposits.recordAdminCard(this.prisma, deposit.id, {
      chatId: BigInt(message.chat.id),
      messageId: BigInt(message.message_id),
      threadId: message.message_thread_id === undefined ? null : BigInt(message.message_thread_id),
    });
  }

  /**
   * The dedicated ops card for a CREDITED deposit — a NEW admin-group message (never an edit), in
   * addition to the review-card redraw, carrying the agent-float before/after.
   *
   * FLOAT BEFORE/AFTER — the truthful source: the balance snapshot the ledger stored on the T2
   * transaction (kind DEPOSIT_CREDIT) for the ICHANCY_AGENT_FLOAT entry. Those are the balances AT
   * POSTING TIME, taken under the account's row lock, so they are correct even when several credits
   * raced — recomputing from the account's current balance here would attribute later movements to
   * this deposit. A missing snapshot renders as — rather than failing the card.
   *
   * IDEMPOTENCY: the outbox delivers at-least-once and a fresh sendMessage has no "message is not
   * modified" safety net, so the send is guarded by an insert-first idempotency record
   * (scope deposit.ops_card, key = deposit id): a redelivery replays COMPLETED and skips; a failed
   * send releases the record and rethrows so the redelivery may try again.
   */
  async postCreditedOpsCard(depositRequestId: string): Promise<void> {
    const deposit = await this.prisma.depositRequest.findUnique({
      where: { id: depositRequestId },
      select: {
        id: true,
        shortId: true,
        currencyCode: true,
        claimedAmountMinor: true,
        creditedAmountMinor: true,
        creditedAt: true,
        ledgerCreditTxId: true,
        player: { select: { telegramUserId: true, ichancyLogin: true, ichancyPlayerId: true } },
        paymentMethod: { select: { displayName: true } },
      },
    });
    if (deposit === null) {
      this.logger.warn(`ops card requested for unknown deposit ${depositRequestId}`);
      return;
    }
    // The outbox row commits in the same transaction that writes ledgerCreditTxId, so this can only
    // be null on a malformed replay. No T2, no money statement to publish.
    if (deposit.ledgerCreditTxId === null) {
      this.logger.warn(`ops card requested for ${deposit.shortId} but it has no T2; skipping`);
      return;
    }

    const t2 = await this.prisma.ledgerTransaction.findUnique({
      where: { id: deposit.ledgerCreditTxId },
      select: { metadata: true, postedAt: true },
    });
    const snapshot = agentFloatSnapshot(
      t2?.metadata ?? null,
      ichancyAgentFloatCode(deposit.currencyCode),
    );
    if (snapshot === null) {
      // Old rows (or a hand-posted correction) may carry no snapshot. The card still goes out.
      this.logger.warn(`no agent-float snapshot on T2 of ${deposit.shortId}; card shows — for it`);
    }

    const text = renderOpsCard({
      shortId: deposit.shortId,
      telegramUserId: deposit.player.telegramUserId,
      ichancyLogin: deposit.player.ichancyLogin,
      ichancyPlayerId: deposit.player.ichancyPlayerId,
      amountMinor: deposit.creditedAmountMinor ?? deposit.claimedAmountMinor,
      floatBeforeMinor: snapshot?.beforeMinor ?? null,
      floatAfterMinor: snapshot?.afterMinor ?? null,
      paymentMethodName: deposit.paymentMethod.displayName,
      creditedAt: deposit.creditedAt ?? t2?.postedAt ?? new Date(),
    });

    const begun = await this.idempotency.begin({
      scope: OPS_CARD_IDEMPOTENCY_SCOPE,
      key: deposit.id,
      requestHash: this.idempotency.hashRequest({ depositRequestId: deposit.id }),
    });
    if (begun.kind === 'replay') {
      this.logger.debug(`ops card for ${deposit.shortId} was already posted; redelivery ignored`);
      return;
    }
    if (begun.kind === 'mismatch') {
      // Impossible with a hash derived from the key itself; refuse to guess if it ever happens.
      this.logger.error(`ops card idempotency mismatch for ${deposit.shortId}; not posting`);
      return;
    }
    if (begun.kind === 'in_flight') {
      // A concurrent delivery of the same row is posting right now. Throw so the queue retries
      // AFTER it resolves to COMPLETED (skip) or released (proceed) — returning here would ack the
      // row while the other worker could still fail.
      throw new Error(
        `ops card for ${deposit.shortId} is being posted elsewhere (since ${begun.since.toISOString()})`,
      );
    }

    try {
      const message = await this.bot.notifyAdmins(text, { parseMode: 'HTML', linkPreview: false });
      if (message === null) {
        // Permanently unreachable admin chat — same terminal outcome as the review card path.
        await this.idempotency.release(begun.lease, 'admin chat unreachable');
        this.logger.error(
          `admin chat ${this.config.telegram.adminChatId.toString()} is unreachable; ` +
            `deposit ${deposit.shortId} has no ops card`,
        );
        return;
      }
      await this.idempotency.complete(begun.lease, {
        response: { messageId: message.message_id, chatId: message.chat.id },
        resultRef: deposit.id,
      });
    } catch (cause) {
      // 429/5xx: give the key back so the queue retry may actually send, then let it retry.
      await this.idempotency.release(begun.lease, 'ops card send failed');
      throw cause;
    }
  }

  /** Direct message to the player's private chat. Their Telegram id IS the chat id. */
  async notifyPlayer(
    playerId: string,
    template: string,
    params: Readonly<Record<string, string>>,
  ): Promise<void> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      select: { telegramUserId: true },
    });
    if (player === null) {
      this.logger.warn(`cannot notify unknown player ${playerId}`);
      return;
    }
    await this.bot.sendMessage(player.telegramUserId, renderPlayerMessage(template, params), {
      parseMode: 'HTML',
      linkPreview: false,
    });
  }

  /** Operator alert. Deliberately loud and deliberately separate from the review cards. */
  async alertAdmins(payload: {
    shortId?: string;
    severity: string;
    code: string;
    message: string;
    hint?: string;
  }): Promise<void> {
    const lines = [
      `🚨 <b>${esc(payload.severity.toUpperCase())}</b> — <code>${esc(payload.code)}</code>`,
      payload.shortId === undefined ? null : `Deposit <b>${esc(payload.shortId)}</b>`,
      esc(payload.message),
      payload.hint === undefined ? null : `<i>${esc(payload.hint)}</i>`,
    ].filter((line): line is string => line !== null);

    await this.bot.notifyAdmins(lines.join('\n'), { parseMode: 'HTML', linkPreview: false });
  }

  private playerLabel(player: { telegramUserId: bigint; telegramUsername: string | null }): string {
    return player.telegramUsername === null
      ? `id ${player.telegramUserId.toString()}`
      : `@${player.telegramUsername} (${player.telegramUserId.toString()})`;
  }
}

/**
 * Pull the ICHANCY_AGENT_FLOAT before/after out of the balance snapshots the ledger repository
 * writes into ledger_transactions.metadata (see BALANCE_SNAPSHOT_METADATA_KEY — the entries table
 * itself carries no balance columns, by design). Defensive on purpose: this reads immutable JSON
 * written by another module, and a malformed shape must cost the card two dashes, not the message.
 */
function agentFloatSnapshot(
  metadata: Prisma.JsonValue | null,
  floatAccountCode: string,
): { beforeMinor: bigint; afterMinor: bigint } | null {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, Prisma.JsonValue>)[BALANCE_SNAPSHOT_METADATA_KEY];
  if (!Array.isArray(raw)) return null;

  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, Prisma.JsonValue>;
    if (record['accountCode'] !== floatAccountCode) continue;
    const previous = record['previousBalanceMinor'];
    const current = record['currentBalanceMinor'];
    if (typeof previous !== 'string' || typeof current !== 'string') return null;
    try {
      return { beforeMinor: BigInt(previous), afterMinor: BigInt(current) };
    } catch {
      return null;
    }
  }
  return null;
}
