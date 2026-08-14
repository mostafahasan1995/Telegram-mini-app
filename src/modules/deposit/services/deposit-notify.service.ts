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
import { DepositStatus } from '@prisma/client';

import { AppConfigService } from '@core/config/config.service';
import { PrismaService } from '@core/prisma/prisma.service';
import { BotService } from '@core/telegram/services/bot.service';

import { DepositRepository } from '../repositories/deposit.repository';
import { DepositService } from './deposit.service';
import {
  renderAdminCard,
  renderAdminKeyboard,
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
