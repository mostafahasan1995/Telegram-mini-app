/**
 * `provision()`: what creating an operator does after its row commits (dashboard docs/API-CONTRACT.md,
 * "What creation actually does — the provisioning block").
 *
 * FIVE STEPS, EACH A BOOLEAN AND A NULLABLE ERROR:
 *  1. register the webhook with Telegram;
 *  2. push the command menus;
 *  3. write the default payment rails on placeholder destinations;
 *  4. activation: a real Ichancy sign-in with the operator's own credentials (TenantIchancyService).
 *     Accepted, the operator is ACTIVE; refused, it stays SUSPENDED and `activationError` carries the
 *     same sentence POST /:id/activate would have answered;
 *  5. the import of the agent's existing players, which runs ONLY after activation succeeded
 *     (API-CONTRACT.md: "an operator that did not activate reports `0` and says why").
 * Steps 1–3 never stop each other: a webhook Telegram refuses says nothing about whether menus or
 * rails can be written, and an admin reading the report needs every answer. Step 5 depends on 4 by
 * contract.
 *
 * WHY THE RAILS COME BEFORE ACTIVATION: an operator activated here can be shown to a player at once,
 * and it should never be ACTIVE without the rails `paymentMethodsNeedAccounts` warns about.
 *
 * NOTHING HERE THROWS FOR A STEP. The row has already committed, so the request must answer 201 with
 * what did not happen. Each step is audited by the code that performed it, in the operator's own log,
 * and the report itself is recorded as `tenant.provisioned`.
 *
 * THE RAILS ARE WRITTEN IN THE OPERATOR'S TENANT CONTEXT with its id on every row: the request's own
 * context is tenant zero, and the scope extension never injects a tenant into a create.
 */
import { Injectable, Logger } from '@nestjs/common';

import { adminActor } from '@common/types/actor.type';
import { AuditService } from '@core/audit/audit.service';
import { AppConfigService } from '@core/config/config.service';
import {
  OPERATOR_DEFAULT_PAYMENT_METHODS,
  ensurePaymentMethods,
} from '@core/payment-rails/default-payment-methods';
import { PrismaService } from '@core/prisma/prisma.service';
import { runWithTenant } from '@core/tenant/tenant.storage';

import { PLAYERS_NOT_IMPORTED_MESSAGE, TenantAuditActions } from '../tenant-admin.constants';
import type { TenantProvisioningView } from '../views/tenant-operations.view';

import { TenantIchancyService } from './tenant-ichancy.service';
import { TenantTelegramService } from './tenant-telegram.service';

const TENANT_SUBJECT = 'Tenant';

export interface ProvisioningTarget {
  id: string;
  currencyCode: string;
}

interface RailsOutcome {
  created: number;
  error: string | null;
  needAccounts: boolean;
}

@Injectable()
export class TenantProvisioningService {
  private readonly logger = new Logger(TenantProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly telegram: TenantTelegramService,
    private readonly ichancy: TenantIchancyService,
    private readonly config: AppConfigService,
  ) {}

  async provision(actorAdminId: string, tenant: ProvisioningTarget): Promise<TenantProvisioningView> {
    const webhook = await this.telegram.registerWebhookForProvisioning(actorAdminId, tenant.id);
    const menus = await this.telegram.pushMenusForProvisioning(actorAdminId, tenant.id);
    const rails = await this.provisionPaymentMethods(actorAdminId, tenant);
    const activation = await this.ichancy.activateForProvisioning(actorAdminId, tenant.id);
    const players = activation.ok
      ? await this.ichancy.importForProvisioning(actorAdminId, tenant.id)
      : { imported: 0, error: PLAYERS_NOT_IMPORTED_MESSAGE };

    const report: TenantProvisioningView = {
      webhookRegistered: webhook.ok,
      webhookUrl: webhook.url,
      webhookError: webhook.error,
      menusPushed: menus.ok,
      menuScopes: menus.scopes,
      menuError: menus.error,
      activated: activation.ok,
      activationError: activation.error,
      paymentMethodsCreated: rails.created,
      paymentMethodsError: rails.error,
      paymentMethodsNeedAccounts: rails.needAccounts,
      playersImported: players.imported,
      playersImportError: players.error,
      ichancyFake: this.config.ichancy.fake,
    };

    await this.recordReport(actorAdminId, tenant.id, report);
    return report;
  }

  private async provisionPaymentMethods(
    actorAdminId: string,
    tenant: ProvisioningTarget,
  ): Promise<RailsOutcome> {
    try {
      const ensured = await runWithTenant(tenant.id, () =>
        this.prisma.runInTransaction(async (tx) => {
          const rows = await ensurePaymentMethods(
            tx,
            tenant.id,
            tenant.currencyCode,
            OPERATOR_DEFAULT_PAYMENT_METHODS,
          );
          const created = rows.filter((row) => row.created).map((row) => row.code);
          if (created.length > 0) {
            await this.audit.write(tx, {
              action: TenantAuditActions.TENANT_PAYMENT_METHODS_PROVISIONED,
              actor: adminActor(actorAdminId),
              subjectType: TENANT_SUBJECT,
              subjectId: tenant.id,
              after: { paymentMethods: created },
              metadata: { placeholderDestinations: true },
            });
          }
          return rows;
        }),
      );
      return {
        created: ensured.filter((row) => row.created).length,
        error: null,
        needAccounts: ensured.some((row) => row.destinationIsPlaceholder),
      };
    } catch (error: unknown) {
      this.logger.error(
        `Tenant ${tenant.id}: default payment methods were not created: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // The transaction rolled back, so there is no rail, and no placeholder to warn about.
      return {
        created: 0,
        error:
          'Payment methods were not created: an unexpected error occurred on this server. Add ' +
          "them from the operator's payment methods page.",
        needAccounts: false,
      };
    }
  }

  /**
   * The report as evidence: booleans and counts only, never the webhook URL. Best effort, because it
   * summarises steps that were each audited already, and failing a committed creation over its
   * summary would be the wrong trade.
   */
  private async recordReport(
    actorAdminId: string,
    tenantId: string,
    report: TenantProvisioningView,
  ): Promise<void> {
    try {
      await this.prisma.runInTransaction((tx) =>
        runWithTenant(tenantId, () =>
          this.audit.write(tx, {
            action: TenantAuditActions.TENANT_PROVISIONED,
            actor: adminActor(actorAdminId),
            subjectType: TENANT_SUBJECT,
            subjectId: tenantId,
            after: {
              webhookRegistered: report.webhookRegistered,
              menusPushed: report.menusPushed,
              menuScopes: report.menuScopes,
              activated: report.activated,
              paymentMethodsCreated: report.paymentMethodsCreated,
              paymentMethodsNeedAccounts: report.paymentMethodsNeedAccounts,
              playersImported: report.playersImported,
              ichancyFake: report.ichancyFake,
            },
          }),
        ),
      );
    } catch (error: unknown) {
      this.logger.error(
        `Tenant ${tenantId}: the provisioning report was not recorded: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
