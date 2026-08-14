/**
 * The bot half of the deposit flow.
 *
 * ══ WHY ctx.from.id IS RE-RESOLVED TO AN AdminUser ON EVERY CALLBACK ══════════════════════════
 * The admin card lives in a group. Everyone in that group can tap its buttons, and Telegram tells us
 * WHO tapped — but the message itself proves nothing about them. Trusting "this callback came from
 * the admin chat, therefore the tapper is an admin" would make group membership equal approval
 * authority: add someone to the group to show them the queue and you have just given them the power
 * to release money. So every single callback resolves ctx.from.id through AdminIdentityService,
 * which re-reads the row (60s cache) and returns null for anyone inactive or unknown. There is no
 * path here that reads authority from the chat.
 *
 * ══ WHY THE PHOTO FALLBACK EXISTS ═════════════════════════════════════════════════════════════
 * The mini-app is the intended way to submit a proof, but players send photos to the bot anyway —
 * it is the obvious thing to do in a chat. Dropping those silently means a player who has already
 * paid believes they are done. So a photo from a player with exactly one open deposit is attached to
 * it; with several, we ask which one instead of guessing (attaching a receipt to the wrong deposit
 * is worse than asking).
 *
 * ══ WHY THE CARD IS RE-RENDERED AND THE KEYBOARD STRIPPED ═════════════════════════════════════
 * A terminal deposit that keeps its buttons invites taps that can only ever answer "already
 * handled". renderAdminKeyboard returns undefined for terminal states, and editing the message with
 * that markup removes the keyboard — so the card becomes a receipt rather than a trap.
 */
import { Injectable, Logger } from '@nestjs/common';
import { DepositStatus, ProofSource, RejectionCode } from '@prisma/client';
import type { Context } from 'grammy';

import { playerActor } from '@common/types/actor.type';
import type { AuthenticatedAdmin } from '@common/decorators/auth.types';
import { isAppException } from '@common/exceptions/app.exception';
import { AdminIdentityService } from '@core/auth/services/admin-identity.service';
import { rawProofKey } from '@core/file/storage-key.util';
import { TelegramFileService } from '@core/file/telegram-file.service';
import { PrismaService } from '@core/prisma/prisma.service';
import { OnCallback, OnMessage } from '@core/telegram/decorators/handlers.decorator';
import { BotService } from '@core/telegram/services/bot.service';
import { decodeCallbackData } from '@core/telegram/utils/callback-data.util';

import { DEPOSIT_CALLBACK_NS } from '../deposit.constants';
import { DepositService } from '../services/deposit.service';
import { DepositReviewService, type ReviewOutcome } from '../services/deposit-review.service';
import { DepositRepository } from '../repositories/deposit.repository';
import { renderAdminCard, renderAdminKeyboard } from './deposit-card.util';

/** Statuses a photo can still be attached to. Mirrors DepositService.assertAcceptsProof. */
const PROOFABLE: readonly DepositStatus[] = Object.freeze([
  DepositStatus.DRAFT,
  DepositStatus.AWAITING_PROOF,
  DepositStatus.SUBMITTED,
  DepositStatus.UNDER_REVIEW,
]);

@Injectable()
export class DepositTelegramHandlers {
  private readonly logger = new Logger(DepositTelegramHandlers.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deposits: DepositRepository,
    private readonly depositService: DepositService,
    private readonly review: DepositReviewService,
    private readonly admins: AdminIdentityService,
    private readonly files: TelegramFileService,
    private readonly bot: BotService,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // PHOTO AS PROOF
  // ---------------------------------------------------------------------------------------------

  @OnMessage('message:photo')
  async onPhoto(ctx: Context): Promise<void> {
    const from = ctx.from;
    const photos = ctx.message?.photo;
    if (from === undefined || photos === undefined || photos.length === 0) return;

    // Only in a private chat: a photo posted in the admin group is a screenshot for colleagues, not
    // a payment proof, and attaching it to somebody's deposit would be worse than ignoring it.
    if (ctx.chat?.type !== 'private') return;

    const player = await this.prisma.player.findUnique({
      where: { telegramUserId: BigInt(from.id) },
      select: { id: true },
    });
    if (player === null) {
      await ctx.reply('Open the app first, then send your receipt here.');
      return;
    }

    const open = await this.prisma.depositRequest.findMany({
      where: { playerId: player.id, status: { in: [...PROOFABLE] } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, shortId: true, status: true },
    });

    if (open.length === 0) {
      await ctx.reply('You have no deposit waiting for a receipt. Start one in the app first.');
      return;
    }
    if (open.length > 1) {
      // Guessing here attaches a receipt to the wrong payment. Ask instead.
      const list = open.map((row) => `• ${row.shortId}`).join('\n');
      await ctx.reply(
        `You have more than one deposit open:\n${list}\n\n` +
          `Please upload the receipt from the app so it lands on the right one.`,
      );
      return;
    }

    const target = open[0];
    if (target === undefined) return;

    // Telegram sends the same photo in several sizes, largest last. The largest is the one a
    // reviewer can actually read a reference number off.
    const largest = photos[photos.length - 1];
    if (largest === undefined) return;

    try {
      // Streamed straight into the bucket — never buffered. Normalization happens on the media
      // queue afterwards; see ProofIngestService.
      const stored = await this.files.fetchToStorage(
        largest.file_id,
        rawProofKey(target.id, `${largest.file_unique_id}.jpg`),
      );

      const result = await this.depositService.attachStoredProof({
        depositRequestId: target.id,
        bucket: stored.bucket,
        storageKey: stored.key,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        source: ProofSource.TELEGRAM_PHOTO,
        telegramFileId: stored.telegramFileId,
        uploadedBy: playerActor(player.id),
      });

      if (result.missing.length > 0) {
        // The photo is saved, but the rail wants fields a photo cannot carry (its reference, the
        // account it was sent from). The deposit deliberately stays in AWAITING_PROOF: an
        // incomplete claim must not reach a reviewer looking like a complete one.
        const wanted = result.missing.map((issue) => `• ${issue.message}`).join('\n');
        await ctx.reply(
          `📎 Receipt saved to ${result.shortId}, but we still need:\n${wanted}\n\n` +
            `Please finish this deposit in the app — then a reviewer can check it.`,
        );
        return;
      }

      await ctx.reply(
        `📨 Got it — receipt attached to ${result.shortId}. A reviewer will look at it shortly.`,
      );
    } catch (cause) {
      // A player must always be told whether their receipt arrived; a silent failure looks like it
      // did. Business errors carry a safe message, everything else gets a generic one.
      const message = isAppException(cause)
        ? cause.message
        : 'Something went wrong saving that image. Please try again from the app.';
      this.logger.error(
        `photo proof for player ${player.id} failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      await ctx.reply(`⚠️ ${message}`);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // ADMIN CALLBACKS  (d:c = claim, d:a = approve, d:r = reject)
  // ---------------------------------------------------------------------------------------------

  @OnCallback(DEPOSIT_CALLBACK_NS)
  async onDepositCallback(ctx: Context): Promise<void> {
    const query = ctx.callbackQuery;
    const from = ctx.from;
    if (query === undefined || from === undefined) return;

    const decoded = decodeCallbackData(query.data);
    if (decoded === null || decoded.ns !== DEPOSIT_CALLBACK_NS) {
      await this.bot.answerCallback(query.id, 'That button is no longer valid.');
      return;
    }

    const depositRequestId = decoded.args[0];
    if (depositRequestId === undefined) {
      await this.bot.answerCallback(query.id, 'That button is missing its deposit.');
      return;
    }

    // THE authority check. Never the chat, always the tapper — see the header.
    const admin = await this.admins.resolve(BigInt(from.id));
    if (admin === null) {
      await this.bot.answerCallback(query.id, 'You are not authorised to act on deposits.', true);
      this.logger.warn(
        `non-admin telegram user ${from.id} tapped a deposit button on ${depositRequestId}`,
      );
      return;
    }

    try {
      const outcome = await this.dispatch(decoded.action, depositRequestId, admin);
      await this.bot.answerCallback(query.id, this.describe(outcome, admin));
    } catch (cause) {
      const message = isAppException(cause) ? cause.message : 'That action could not be completed.';
      this.logger.warn(
        `deposit callback ${decoded.action} on ${depositRequestId} by ${admin.displayName} failed: ` +
          (cause instanceof Error ? cause.message : String(cause)),
      );
      await this.bot.answerCallback(query.id, message, true);
    }

    // Redraw the SAME message, whatever happened — including on failure, because a failure usually
    // means someone else moved the deposit and the card is now out of date.
    await this.rerenderCard(ctx, depositRequestId);
  }

  private async dispatch(
    action: string,
    depositRequestId: string,
    admin: AuthenticatedAdmin,
  ): Promise<ReviewOutcome> {
    switch (action) {
      case 'c':
        return this.review.claim({ depositRequestId, admin });
      case 'a':
        // No amount from a button: tapping Approve accepts the player's claim verbatim, which is
        // the only thing a two-character callback payload could honestly mean. Changing the amount
        // is a mini-app/API action where the number can actually be typed and reviewed.
        return this.review.approve({ depositRequestId, admin });
      case 'r':
        // Likewise: the button cannot carry a reason, so it records the one an admin who taps
        // "Reject" on an unreadable receipt almost always means. A specific code goes through the
        // API, where it is chosen deliberately.
        return this.review.reject({
          depositRequestId,
          admin,
          rejectionCode: RejectionCode.PROOF_UNREADABLE,
          rejectionNote: `Rejected from Telegram by ${admin.displayName}`,
        });
      default:
        throw new Error(`Unknown deposit callback action "${action}"`);
    }
  }

  private describe(outcome: ReviewOutcome, admin: AuthenticatedAdmin): string {
    switch (outcome.kind) {
      case 'claimed':
        return `Claimed by ${admin.displayName}.`;
      case 'released':
        return 'Released back to the queue.';
      case 'approved':
        return 'Approved — crediting now.';
      case 'awaiting_second_approval':
        return 'Recorded. A second, different admin must approve this amount.';
      case 'rejected':
        return 'Rejected.';
      case 'alreadyHandled':
        return `Already handled (${outcome.status ?? 'gone'}).`;
      default:
        return 'Done.';
    }
  }

  /**
   * Re-render the exact message the button lives on. `editMessageText` with a markup of `undefined`
   * strips the keyboard, which is what makes a terminal card safe to leave in the group.
   */
  private async rerenderCard(ctx: Context, depositRequestId: string): Promise<void> {
    const message = ctx.callbackQuery?.message;
    if (message === undefined) return;

    const deposit = await this.deposits.findByIdWithContext(this.prisma, depositRequestId);
    if (deposit === null) return;

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
      playerLabel:
        deposit.player.telegramUsername === null
          ? `id ${deposit.player.telegramUserId.toString()}`
          : `@${deposit.player.telegramUsername} (${deposit.player.telegramUserId.toString()})`,
      paymentMethodName: deposit.paymentMethod.displayName,
      destinationLabel: deposit.paymentDestination?.label ?? null,
      reviewerLabel:
        deposit.status === DepositStatus.UNDER_REVIEW ? (reviewer?.displayName ?? null) : null,
      requiresSecondApproval: deposit.status === DepositStatus.PENDING_SECOND_APPROVAL,
    });

    await this.bot.editMessageText(message.chat.id, message.message_id, text, {
      parseMode: 'HTML',
      replyMarkup: renderAdminKeyboard(deposit),
      linkPreview: false,
    });

    // Keep the stored coordinates fresh: an admin may be acting on a card posted before a restart,
    // or on one the notifier has never seen (a manually forwarded message).
    if (deposit.adminMessageId === null) {
      await this.deposits.recordAdminCard(this.prisma, deposit.id, {
        chatId: BigInt(message.chat.id),
        messageId: BigInt(message.message_id),
        threadId: null,
      });
    }
  }
}
