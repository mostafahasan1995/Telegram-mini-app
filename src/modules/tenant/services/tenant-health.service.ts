/**
 * GET /v1/admin/tenants/:id/health: bot, webhook, Ichancy agent and counts in one call, "because they
 * fail together" (dashboard src/types/tenant.ts, tenantHealthSchema).
 *
 *  - bot: getWebhookInfo through the operator's own bot, compared with the URL this deployment
 *    expects (TenantTelegramService.botHealth).
 *  - ichancy: the operator's own agent — a wallet read with its credentials (signing in first only
 *    when no session for exactly those credentials exists), the float against the operator's own
 *    watermark, and `sharesAgentWith`, the slugs of the other operators on the same login. Cached
 *    briefly; see TenantIchancyService.health.
 *  - counts: the same two numbers the tenant list reports.
 */
import { Injectable } from '@nestjs/common';

import { PrismaService } from '@core/prisma/prisma.service';

import { tenantNotFound } from '../utils/tenant-errors';
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
  ) {}

  async health(id: string): Promise<TenantHealthView> {
    const row = await this.prisma.tenant.findUnique({
      where: { id },
      select: {
        id: true,
        botUsername: true,
        webhookPathToken: true,
        ichancyBaseUrl: true,
        ichancyUsername: true,
        ichancyAgentId: true,
        agentFloatLowWatermarkMinor: true,
      },
    });
    if (row === null) throw tenantNotFound();

    const [bot, ichancy, counts] = await Promise.all([
      this.telegram.botHealth(row),
      this.ichancy.health(row),
      this.tenants.countsOf(id),
    ]);

    return { bot, ichancy, counts };
  }
}
