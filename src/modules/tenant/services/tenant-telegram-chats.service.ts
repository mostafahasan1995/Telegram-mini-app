/**
 * An operator's staff group and feed group, from the platform console: issue the one-time "Add bot to
 * group" link, list the groups its bot was seen in, bind one of them (or a typed id), and remove one.
 *
 * ══ PLATFORM_ADMIN ONLY ══════════════════════════════════════════════════════════════════════════
 * Owner decision 3 (2026-09-15): only the platform may bind or change an operator's staff or feed
 * group. Every route here is on /v1/admin/tenants, which admits nobody else, and names its operator in
 * the path. An operator's own SUPER_ADMIN gets 403 on each.
 *
 * ══ THE LINK ═════════════════════════════════════════════════════════════════════════════════════
 * `https://t.me/<bot>?startgroup=<nonce>&admin=<rights>`: Telegram asks the owner which group to add
 * the bot to (as an administrator with those rights) and then sends `/start@<bot> <nonce>` in it, which
 * the worker's chat projection turns into a verified bind (ChatBindingService.bindFromStartGroup). The
 * nonce is 24 CSPRNG bytes; only its sha256 is stored, it works once, for BIND_LINK_TTL_MINUTES, for
 * one operator and one purpose, and issuing a new link for that purpose revokes the previous one. It
 * appears in this response and nowhere else: not in a log line, not in the audit row.
 *
 * ══ BINDING FROM THE CONSOLE ═════════════════════════════════════════════════════════════════════
 * Verified with Telegram first, outside any transaction, then committed; a refusal is 400
 * TELEGRAM_CHAT_REJECTED with `details.reason` and is audited. Telegram failures that say nothing about
 * the chat become the tenant surface's usual 503/422 (utils/telegram-failure.ts). PATCH /:id with a
 * changed `adminChatId` or `feedChatId` takes exactly this path (TenantAdminService.update).
 */
import { Injectable } from '@nestjs/common';
import { TelegramChatPurpose, TenantStatus } from '@prisma/client';

import { BusinessRuleError, ValidationError } from '@common/exceptions/app.exception';
import { adminActor } from '@common/types/actor.type';
import { AuditService } from '@core/audit/audit.service';
import { PrismaService } from '@core/prisma/prisma.service';
import { chatRejected } from '@core/telegram/chat-binding/chat-binding.errors';
import {
  ChatBindingService,
  type ChatBindVia,
} from '@core/telegram/chat-binding/chat-binding.service';
import { TelegramChatDiscoveryService } from '@core/telegram/services/telegram-chat-discovery.service';
import {
  BIND_ADMIN_RIGHTS,
  BIND_LINK_TTL_MINUTES,
  TELEGRAM_CHAT_AUDIT_SUBJECT,
  TelegramChatAuditActions,
} from '@core/telegram/telegram-chat.constants';
import {
  UNBOUND_CHAT_ID,
  boundChatOf,
  hashBindNonce,
  newBindNonce,
  startGroupUrl,
} from '@core/telegram/utils/chat-membership.util';
import type { ChatVerification, VerifiedChat } from '@core/telegram/utils/chat-verification.util';
import { TenantErrorCodes } from '@core/tenant/tenant-error-codes';
import { TENANT_ZERO_ID } from '@core/tenant/tenant.constants';
import { runWithTenant } from '@core/tenant/tenant.storage';

import { telegramFailure } from '../utils/telegram-failure';
import { tenantNotFound } from '../utils/tenant-errors';
import {
  toDiscoveredChatView,
  type DiscoveredChatView,
  type TelegramBindLinkView,
} from '../views/tenant-chats.view';

@Injectable()
export class TenantTelegramChatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly bindings: ChatBindingService,
    private readonly discovery: TelegramChatDiscoveryService,
  ) {}

  async issueBindLink(
    actorAdminId: string,
    tenantId: string,
    purpose: TelegramChatPurpose,
  ): Promise<TelegramBindLinkView> {
    const operator = await this.bindableOperator(tenantId);
    if (operator.botUsername === null) {
      throw new BusinessRuleError(
        TenantErrorCodes.TENANT_BOT_UNAVAILABLE,
        "This operator's bot has no known @username yet, so no link can be built. Replace its bot " +
          'token from the dashboard so Telegram confirms the bot, then try again.',
      );
    }

    const nonce = newBindNonce();
    const expiresAt = new Date(Date.now() + BIND_LINK_TTL_MINUTES * 60_000);

    await runWithTenant(tenantId, () =>
      this.prisma.runInTransaction(async (tx) => {
        const revoked = await tx.telegramChatBindLink.updateMany({
          where: { tenantId, purpose, usedAt: null, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        const link = await tx.telegramChatBindLink.create({
          data: {
            tenantId,
            purpose,
            nonceHash: hashBindNonce(nonce),
            issuedByAdminId: actorAdminId,
            expiresAt,
          },
          select: { id: true },
        });
        await this.audit.write(tx, {
          action: TelegramChatAuditActions.BIND_LINK_ISSUED,
          actor: adminActor(actorAdminId),
          subjectType: TELEGRAM_CHAT_AUDIT_SUBJECT,
          subjectId: tenantId,
          after: { purpose, linkId: link.id, expiresAt: expiresAt.toISOString() },
          metadata: { previousLinksRevoked: revoked.count },
        });
      }),
    );

    return {
      purpose,
      url: startGroupUrl(operator.botUsername, nonce),
      botUsername: operator.botUsername,
      expiresAt: expiresAt.toISOString(),
      adminRights: [...BIND_ADMIN_RIGHTS],
    };
  }

  async listChats(tenantId: string): Promise<DiscoveredChatView[]> {
    const operator = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { adminChatId: true, feedChatId: true },
    });
    if (operator === null) throw tenantNotFound();
    const bound = { staff: boundChatOf(operator.adminChatId), feed: boundChatOf(operator.feedChatId) };
    const rows = await this.discovery.listForTenant(tenantId);
    return rows.map((row) => toDiscoveredChatView(row, bound));
  }

  /** PUT /:id/telegram/chats/:purpose. */
  async bind(
    actorAdminId: string,
    tenantId: string,
    purpose: TelegramChatPurpose,
    chatId: bigint,
  ): Promise<void> {
    if (chatId === UNBOUND_CHAT_ID) {
      throw new ValidationError(undefined, {
        fields: ['chatId must be a real Telegram chat id: 0 is no chat'],
      });
    }
    const chat = await this.verifyForBinding(actorAdminId, tenantId, purpose, chatId, 'chatId', 'console');
    await this.commitVerified(actorAdminId, tenantId, purpose, chat, 'console');
  }

  /**
   * Telegram's verdict on binding `chatId`, or the refusal to throw. Run before, and outside, any
   * transaction. A refusal is audited in the operator's log before it is thrown.
   */
  async verifyForBinding(
    actorAdminId: string,
    tenantId: string,
    purpose: TelegramChatPurpose,
    chatId: bigint,
    field: string,
    via: ChatBindVia,
  ): Promise<VerifiedChat> {
    await this.bindableOperator(tenantId);

    let verification: ChatVerification;
    try {
      verification = await this.bindings.verify(tenantId, chatId);
    } catch (error: unknown) {
      throw telegramFailure(error, 'check the chat with Telegram') ?? error;
    }
    if (verification.ok) return verification.chat;

    await this.bindings.recordRefusal({
      tenantId,
      purpose,
      reason: verification.reason,
      chatId: verification.chatId,
      actor: adminActor(actorAdminId),
      via,
      linkId: null,
      telegramUserId: null,
      detail: verification.detail,
    });
    throw chatRejected({
      reason: verification.reason,
      purpose,
      field,
      chatId: verification.chatId,
      detail: verification.detail,
    });
  }

  /** Commits a chat `verifyForBinding` just returned. Throws the contract error for each refusal. */
  async commitVerified(
    actorAdminId: string,
    tenantId: string,
    purpose: TelegramChatPurpose,
    chat: VerifiedChat,
    via: ChatBindVia,
  ): Promise<void> {
    const outcome = await this.bindings.commit({
      tenantId,
      purpose,
      chat,
      actor: adminActor(actorAdminId),
      via,
      linkId: null,
      telegramUserId: null,
    });
    switch (outcome.kind) {
      case 'bound':
        return;
      case 'not-found':
        throw tenantNotFound();
      case 'platform':
        throw platformLocked();
      case 'closed':
        throw tenantClosed();
      case 'link-unusable':
        // No link was passed; reaching this is a programming error, not a request error.
        throw new Error('A console bind reported an unusable link');
    }
  }

  /** DELETE /:id/telegram/chats/:purpose. */
  async unbind(actorAdminId: string, tenantId: string, purpose: TelegramChatPurpose): Promise<void> {
    const outcome = await this.bindings.unbind(tenantId, purpose, actorAdminId);
    switch (outcome.kind) {
      case 'unbound':
        return;
      case 'not-found':
        throw tenantNotFound();
      case 'platform':
        throw platformLocked();
      case 'closed':
        throw tenantClosed();
      case 'serving':
        throw new BusinessRuleError(
          TenantErrorCodes.TENANT_STAFF_GROUP_REQUIRED,
          'This operator is active, and an active operator must always have a staff group. Bind ' +
            'another group instead, or suspend the operator before removing this one.',
        );
    }
  }

  /** The operator a bind can target: it exists, is not tenant zero, and is not CLOSED. */
  private async bindableOperator(
    tenantId: string,
  ): Promise<{ status: TenantStatus; botUsername: string | null }> {
    const operator = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true, botUsername: true },
    });
    if (operator === null) throw tenantNotFound();
    if (tenantId === TENANT_ZERO_ID) throw platformLocked();
    if (operator.status === TenantStatus.CLOSED) throw tenantClosed();
    return operator;
  }
}

function platformLocked(): BusinessRuleError {
  return new BusinessRuleError(
    TenantErrorCodes.TENANT_PLATFORM_LOCKED,
    'Tenant zero is the platform itself, not an operator, and has no staff or feed group.',
  );
}

function tenantClosed(): BusinessRuleError {
  return new BusinessRuleError(
    TenantErrorCodes.TENANT_CLOSED,
    'This operator is closed. A closed operator keeps its records but no group can be bound to it.',
  );
}
