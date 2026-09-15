/**
 * GET /v1/admin/tenants/:id/health: bot, webhook, Ichancy agent and counts in one call, "because they
 * fail together" (dashboard src/types/tenant.ts, tenantHealthSchema).
 *
 *  - bot: real. getWebhookInfo through the operator's own bot, compared with the URL this deployment
 *    expects (TenantTelegramService.botHealth).
 *  - ichancy: interim. A real check signs in with the operator's own stored credentials, which this
 *    deployment cannot do yet, so the block is a schema-valid "not checked": `ok: false`, the reason,
 *    no float. `sharesAgentWith` needs no sign-in and is real: the slugs of the other operators on the
 *    same base URL and username, which share one Ichancy session whether or not anyone meant them to.
 *  - counts: real, the same two numbers the tenant list reports.
 */
import { Injectable } from '@nestjs/common';

import { PrismaService } from '@core/prisma/prisma.service';

import { ICHANCY_HEALTH_UNAVAILABLE_MESSAGE } from '../tenant-admin.constants';
import { tenantNotFound } from '../utils/tenant-errors';
import { ichancyHealthNotChecked, type TenantHealthView } from '../views/tenant-operations.view';

import { TenantAdminService } from './tenant-admin.service';
import { TenantTelegramService } from './tenant-telegram.service';

@Injectable()
export class TenantHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TenantTelegramService,
    private readonly tenants: TenantAdminService,
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
      },
    });
    if (row === null) throw tenantNotFound();

    const [bot, sharing, counts] = await Promise.all([
      this.telegram.botHealth(row),
      // Matched on base URL + username, NOT agent id: the Ichancy session belongs to the login
      // (TENANT-OPERATIONS.md §6, detail 1). `Tenant` is not tenant-scoped, so this sees every operator.
      this.prisma.tenant.findMany({
        where: {
          id: { not: id },
          ichancyBaseUrl: row.ichancyBaseUrl,
          ichancyUsername: row.ichancyUsername,
        },
        select: { slug: true },
        orderBy: { slug: 'asc' },
      }),
      this.tenants.countsOf(id),
    ]);

    return {
      bot,
      ichancy: ichancyHealthNotChecked({
        baseUrl: row.ichancyBaseUrl,
        username: row.ichancyUsername,
        agentId: row.ichancyAgentId,
        sharesAgentWith: sharing.map((other) => other.slug),
        reason: ICHANCY_HEALTH_UNAVAILABLE_MESSAGE,
        checkedAt: new Date(),
      }),
      counts,
    };
  }
}
