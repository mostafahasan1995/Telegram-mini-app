/**
 * `provision()`: what creating an operator does after its row commits (dashboard docs/API-CONTRACT.md,
 * "What creation actually does — the provisioning block").
 *
 * FIVE STEPS, EACH INDEPENDENT, EACH A BOOLEAN AND A NULLABLE ERROR:
 *  1. register the webhook with Telegram;
 *  2. push the command menus;
 *  3. write the default payment rails on placeholder destinations;
 *  4. activation: NOT ATTEMPTED until per-operator Ichancy sign-in exists. `activated: false` with a
 *     sentence that says it was not attempted, never one that implies a sign-in failed. The operator
 *     stays SUSPENDED, which is where the contract says a new operator lands;
 *  5. the import of existing players, which runs only after activation succeeded, so `0` and a
 *     sentence saying why (the dashboard mock's own wording).
 * One step failing never stops the next: a webhook Telegram refuses says nothing about whether menus
 * or rails can be written, and an admin reading the report needs every answer.
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
import {
  OPERATOR_DEFAULT_PAYMENT_METHODS,
  ensurePaymentMethods,
} from '@core/payment-rails/default-payment-methods';
import { PrismaService } from '@core/prisma/prisma.service';
import { runWithTenant } from '@core/tenant/tenant.storage';

import {
  ACTIVATION_NOT_ATTEMPTED_MESSAGE,
  PLAYERS_NOT_IMPORTED_MESSAGE,
  TenantAuditActions,
} from '../tenant-admin.constants';
import type { TenantProvisioningView } from '../views/tenant-operations.view';

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
  ) {}

  async provision(actorAdminId: string, tenant: ProvisioningTarget): Promise<TenantProvisioningView> {
    const webhook = await this.telegram.registerWebhookForProvisioning(actorAdminId, tenant.id);
    const menus = await this.telegram.pushMenusForProvisioning(actorAdminId, tenant.id);
    const rails = await this.provisionPaymentMethods(actorAdminId, tenant);

    const report: TenantProvisioningView = {
      webhookRegistered: webhook.ok,
      webhookUrl: webhook.url,
      webhookError: webhook.error,
      menusPushed: menus.ok,
      menuScopes: menus.scopes,
      menuError: menus.error,
      activated: false,
      activationError: ACTIVATION_NOT_ATTEMPTED_MESSAGE,
      paymentMethodsCreated: rails.created,
      paymentMethodsError: rails.error,
      paymentMethodsNeedAccounts: rails.needAccounts,
      playersImported: 0,
      playersImportError: PLAYERS_NOT_IMPORTED_MESSAGE,
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
