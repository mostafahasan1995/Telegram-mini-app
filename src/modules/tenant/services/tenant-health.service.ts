/**
 * GET /v1/admin/tenants/:id/health: bot, webhook, Ichancy agent, chats and counts in one call,
 * "because they fail together" (dashboard src/types/tenant.ts, tenantHealthSchema).
 *
 *  - bot: getWebhookInfo through the operator's own bot, compared with the URL this deployment
 *    expects (TenantTelegramService.botHealth).
 *  - ichancy: the operator's own agent — a wallet read with its credentials (signing in first only
 *    when no session for exactly those credentials exists), the float against the operator's own
 *    watermark, and `sharesAgentWith`, the slugs of the other operators on the same login. Cached
 *    briefly; see TenantIchancyService.health.
 *  - chats: the bound staff and feed groups with the bot's last sighting in each, read from the chat
 *    directory. No Telegram call: the directory is updated by Telegram's own my_chat_member updates,
 *    and a removal shows here as `isPresent: false` without the binding being cleared.
 *  - counts: the same two numbers the tenant list reports.
 */
import { Injectable } from '@nestjs/common';

import { PrismaService } from '@core/prisma/prisma.service';
import { TelegramChatDiscoveryService } from '@core/telegram/services/telegram-chat-discovery.service';
import { boundChatOf } from '@core/telegram/utils/chat-membership.util';

import { tenantNotFound } from '../utils/tenant-errors';
import { boundChatHealth, type TenantChatsHealthView } from '../views/tenant-chats.view';
import type { TenantHealthView } from '../views/tenant-operations.view';

import { TenantAdminService } from './tenant-admin.service';
import { TenantIchancyService } from './tenant-ichancy.service';
import { TenantTelegramService } from './tenant-telegram.service';

@Injectable()
export class TenantHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TenantTelegramService,
    private readonly tenants: TenantAdminService,
    private readonly ichancy: TenantIchancyService,
    private readonly discovery: TelegramChatDiscoveryService,
  ) {}

  async health(id: string): Promise<TenantHealthView> {
    const row = await this.prisma.tenant.findUnique({
      where: { id },
      select: {
        id: true,
        botUsername: true,
        webhookPathToken: true,
        adminChatId: true,
        feedChatId: true,
        ichancyBaseUrl: true,
        ichancyUsername: true,
        ichancyAgentId: true,
        agentFloatLowWatermarkMinor: true,
      },
    });
    if (row === null) throw tenantNotFound();

    const [bot, ichancy, chats, counts] = await Promise.all([
      this.telegram.botHealth(row),
      this.ichancy.health(row),
      this.chats(row.id, boundChatOf(row.adminChatId), boundChatOf(row.feedChatId)),
      this.tenants.countsOf(id),
    ]);

    return { bot, ichancy, chats, counts };
  }

  private async chats(
    tenantId: string,
    staff: bigint | null,
    feed: bigint | null,
  ): Promise<TenantChatsHealthView> {
    const bound = [staff, feed].filter((chatId): chatId is bigint => chatId !== null);
    const sightings = await this.discovery.findForTenant(tenantId, bound);
    const find = (chatId: bigint | null) =>
      chatId === null ? undefined : sightings.find((sighting) => sighting.chatId === chatId);
    return {
      staff: boundChatHealth(staff, find(staff)),
      feed: boundChatHealth(feed, find(feed)),
    };
  }
}
