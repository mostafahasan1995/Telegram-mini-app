/**
 * The platform's view of its operators: list, read, edit, suspend, activate.
 *
 * ══ TENANT ZERO IS LISTED ════════════════════════════════════════════════════════════════════════
 * The dashboard's mock answers `GET /v1/admin/tenants` with every row, tenant zero included, and its
 * operator switcher treats tenant zero's id as "home". So every row is listed here too, the legacy
 * `default` operator included. Tenant zero is protected where it matters: it cannot be suspended,
 * because a suspended operator's staff are refused at sign-in and tenant zero's staff are the
 * platform admins who would have to undo it.
 *
 * ══ AUDIT LANDS IN THE OPERATOR'S OWN LOG ═══════════════════════════════════════════════════════
 * A change to operator X is written with X as the tenant, entered explicitly with runWithTenant. The
 * request's own context is tenant zero (or whatever X-Tenant-Id pointed at), and AuditService's rule
 * is that evidence belongs where that operator's auditor will look for it. The row and its audit
 * commit in one transaction, as every audited change in this codebase does.
 *
 * ══ SUSPEND: WHAT IT STOPS ══════════════════════════════════════════════════════════════════════
 * The console's own suspend dialog defines a suspension: "The bot stops answering and no new deposit
 * can be started. Credits already in flight still land, nothing already recorded is touched, and you
 * can activate the tenant again at any time" (manager-account-dashboard
 * src/features/tenants/messages.ts, tenants.suspend.confirmBody). Each clause is enforced here or
 * deliberately left alone:
 *  - "the bot stops answering": the webhook controller and the update processor drop a non-ACTIVE
 *    operator's inbound updates;
 *  - "no new deposit can be started": DepositService.create refuses with 422 TENANT_NOT_ACTIVE, on
 *    every path that reaches it (the mini app's POST /v1/deposits and the bot's buttons);
 *  - "credits already in flight still land": proof upload, cancel, review and crediting are not
 *    gated, and neither is player sign-in. A player who has already sent money has to be able to
 *    sign in and attach the receipt, or the suspension would strand that money;
 *  - "you can activate the tenant again at any time": see ACTIVATE below.
 *
 * Staff console sessions issued before the suspension stay valid until they expire. The dialog does
 * not promise a staff lockout, and the operator's staff are the people reconciling the credits still
 * in flight. New staff sign-ins are refused (AdminCredentialsService), which is enough to stop
 * anybody new from arriving.
 *
 * After the status commits, three caches are dropped in this process:
 *  - TenantRegistryService: the Redis entry every process reads status through, so the webhook and
 *    the update processor stop serving the operator at once instead of after the 30s TTL;
 *  - TenantBotRegistry: the built Bot and its cached identity, so a reactivated operator is
 *    re-verified with getMe rather than trusted from before it was stopped;
 *  - InitDataService: the derived mini-app key, for the same reason.
 *
 * Outbound sends for a SUSPENDED or CLOSED operator are deliberately NOT gated. "Stops answering" is
 * an inbound property. The outbound sends that remain belong to credits already in flight: the admin
 * card a reviewer is deciding, the receipt telling a player their money landed, the low-float warning
 * about the agent those credits draw on. Dropping them would leave a credit that landed invisible to
 * the player who paid for it and to the staff who have to reconcile it. That is exactly "touching
 * what is already recorded", which the dialog promises a suspension will not do.
 *
 * ══ ACTIVATE: RESUME, OR REFUSE ═════════════════════════════════════════════════════════════════
 * The contract makes activation "a real Ichancy signin with that operator's credentials", and it is
 * the only check standing between a wrong agent id and real players registered under another
 * operator's agent. Per-operator Ichancy sign-in does not exist yet. Refusing everything would make a
 * suspension one-way, which the dialog promises it is not, so /activate answers in one of two ways:
 *  - RESUME: the operator's latest status decision is a suspension, and its Ichancy details are the
 *    ones it was serving with when it was suspended (a fingerprint recorded on that audit row). It
 *    goes back to ACTIVE, audited as `tenant.activated` with `verification:
 *    'resumed-previously-serving'` and `signIn: false`. The reasoning is in utils/resume.ts.
 *  - REFUSE: anything else, for example a new operator that never served or one whose credentials
 *    changed while suspended, gets 503 TENANT_ACTIVATION_UNAVAILABLE and nothing changes.
 * Neither path follows ICHANCY_FAKE. The fake adapter never reads an operator's credentials, so
 * "success" there would be a verification that never happened, recorded as if it had, which is the
 * one outcome the dashboard's own mock refuses to fake ("rather than claiming a verification that
 * never happened").
 */
import { Injectable } from '@nestjs/common';
import { TenantStatus, type Prisma } from '@prisma/client';

import {
  BusinessRuleError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '@common/exceptions/app.exception';
import { adminActor } from '@common/types/actor.type';
import { AuditService } from '@core/audit/audit.service';
import { InitDataService } from '@core/auth/services/init-data.service';
import { PrismaService } from '@core/prisma/prisma.service';
import { acrossTenants } from '@core/prisma/tenant-scope.extension';
import { TenantBotRegistry } from '@core/telegram/services/tenant-bot-registry.service';
import { TenantRegistryService } from '@core/tenant/services/tenant-registry.service';
import { TenantErrorCodes } from '@core/tenant/tenant-error-codes';
import { TENANT_ZERO_ID } from '@core/tenant/tenant.constants';
import { runWithTenant } from '@core/tenant/tenant.storage';

import type { UpdateTenantDto } from '../dtos/update-tenant.dto';
import {
  ACTIVATION_UNAVAILABLE_MESSAGE,
  RESUME_VERIFICATION,
  TenantAuditActions,
} from '../tenant-admin.constants';
import { changedFields } from '../utils/changed-fields';
import { immutableFieldsIn, tenantEditsFromDto, type TenantEditableFields } from '../utils/edits';
import {
  ICHANCY_FINGERPRINT_KEY,
  ICHANCY_IDENTITY_SELECT,
  STATUS_DECISION_ACTIONS,
  ichancyFingerprint,
  mayResumeWithoutSignIn,
} from '../utils/resume';
import {
  TENANT_VIEW_SELECT,
  toTenantView,
  type TenantCounts,
  type TenantView,
  type TenantViewRow,
} from '../views/tenant.view';

/** The audit subject of every row this service writes, and what activate searches the log for. */
const TENANT_SUBJECT = 'Tenant';

@Injectable()
export class TenantAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly registry: TenantRegistryService,
    private readonly bots: TenantBotRegistry,
    private readonly initData: InitDataService,
  ) {}

  async list(): Promise<TenantView[]> {
    const [rows, players, deposits] = await Promise.all([
      this.prisma.tenant.findMany({
        select: TENANT_VIEW_SELECT,
        orderBy: [{ createdAt: 'asc' }, { slug: 'asc' }],
      }),
      // Deliberately across operators: this screen counts every operator's rows, and without the
      // marker the scope extension would count only the caller's own tenant (zero, which has none).
      this.prisma.player.groupBy({
        by: ['tenantId'],
        where: acrossTenants<Prisma.PlayerWhereInput>({}),
        _count: { _all: true },
      }),
      this.prisma.depositRequest.groupBy({
        by: ['tenantId'],
        where: acrossTenants<Prisma.DepositRequestWhereInput>({}),
        _count: { _all: true },
      }),
    ]);

    const playersBy = new Map(players.map((group) => [group.tenantId, group._count._all]));
    const depositsBy = new Map(deposits.map((group) => [group.tenantId, group._count._all]));

    return rows.map((row) =>
      toTenantView(row, {
        players: playersBy.get(row.id) ?? 0,
        deposits: depositsBy.get(row.id) ?? 0,
      }),
    );
  }

  async get(id: string): Promise<TenantView> {
    const row = await this.prisma.tenant.findUnique({ where: { id }, select: TENANT_VIEW_SELECT });
    if (row === null) throw tenantNotFound();
    return toTenantView(row, await this.countsOf(id));
  }

  async update(actorAdminId: string, id: string, dto: UpdateTenantDto): Promise<TenantView> {
    const frozen = immutableFieldsIn(dto);
    if (frozen.length > 0) {
      throw new ValidationError(
        'slug and currencyCode are fixed when an operator is created and cannot be changed.',
        { fields: frozen.map((field) => `${field} cannot be changed after creation`) },
        TenantErrorCodes.TENANT_FIELD_IMMUTABLE,
      );
    }

    const edits = tenantEditsFromDto(dto);

    const { row, changed } = await this.prisma.runInTransaction(async (tx) => {
      const current = await tx.tenant.findUnique({ where: { id }, select: TENANT_VIEW_SELECT });
      if (current === null) throw tenantNotFound();

      const changes = changedFields<TenantEditableFields>(current, edits);
      if (changes === null) return { row: current, changed: false };

      const updated = await tx.tenant.update({
        where: { id },
        data: changes.data,
        select: TENANT_VIEW_SELECT,
      });

      await runWithTenant(id, () =>
        this.audit.write(tx, {
          action: TenantAuditActions.TENANT_UPDATED,
          actor: adminActor(actorAdminId),
          subjectType: TENANT_SUBJECT,
          subjectId: id,
          before: changes.before,
          after: changes.after,
        }),
      );
      return { row: updated, changed: true };
    });

    // The registry caches the display name. Chats are read fresh per notification (BotService
    // .chatsOf), so nothing else holds a copy of what a PATCH can change.
    if (changed) await this.registry.invalidate(id);

    return toTenantView(row, await this.countsOf(id));
  }

  async suspend(actorAdminId: string, id: string): Promise<TenantView> {
    if (id === TENANT_ZERO_ID) {
      throw new BusinessRuleError(
        TenantErrorCodes.TENANT_PLATFORM_LOCKED,
        'Tenant zero is the platform itself, not an operator. Suspending it would lock every ' +
          'platform admin out of sign-in, so it cannot be suspended.',
      );
    }

    const row = await this.prisma.runInTransaction(async (tx) => {
      const current = await tx.tenant.findUnique({ where: { id }, select: TENANT_VIEW_SELECT });
      if (current === null) throw tenantNotFound();
      if (current.status === TenantStatus.CLOSED) throw tenantClosed();
      // Already suspended: answer the row, write nothing. Repeating a suspend is not a new decision.
      if (current.status === TenantStatus.SUSPENDED) return current;

      // Conditional, so two concurrent suspends record ONE decision between them.
      const claimed = await tx.tenant.updateMany({
        where: { id, status: TenantStatus.ACTIVE },
        data: { status: TenantStatus.SUSPENDED },
      });
      const updated = await tx.tenant.findUniqueOrThrow({
        where: { id },
        select: TENANT_VIEW_SELECT,
      });

      if (claimed.count === 1) {
        // Read after the claim, inside the same transaction: the conditional update holds the row
        // lock until commit, so no concurrent credential change can land between this read and the
        // suspension it describes. The fingerprint is exactly what the operator was serving with.
        const identity = await tx.tenant.findUniqueOrThrow({
          where: { id },
          select: ICHANCY_IDENTITY_SELECT,
        });
        await runWithTenant(id, () =>
          this.audit.write(tx, {
            action: TenantAuditActions.TENANT_SUSPENDED,
            actor: adminActor(actorAdminId),
            subjectType: TENANT_SUBJECT,
            subjectId: id,
            before: { status: TenantStatus.ACTIVE },
            after: { status: TenantStatus.SUSPENDED },
            metadata: { [ICHANCY_FINGERPRINT_KEY]: ichancyFingerprint(identity) },
          }),
        );
      }
      return updated;
    });

    // Also on a repeated suspend: it costs three deletes, and it is how a cache that missed an
    // eviction (a process that died between commit and here) gets cleared.
    await this.evictOperator(id);

    return toTenantView(row, await this.countsOf(id));
  }

  /**
   * See the file header: resumes an operator suspended while serving with unchanged Ichancy details,
   * refuses every other SUSPENDED operator until per-operator Ichancy sign-in exists.
   */
  async activate(actorAdminId: string, id: string): Promise<TenantView> {
    const { row, resumed } = await this.prisma.runInTransaction(async (tx) => {
      const current = await tx.tenant.findUnique({ where: { id }, select: TENANT_VIEW_SELECT });
      if (current === null) throw tenantNotFound();
      if (current.status === TenantStatus.CLOSED) throw tenantClosed();
      // Already serving: answer the row, write nothing. Repeating an activate is not a new decision.
      if (current.status === TenantStatus.ACTIVE) return { row: current, resumed: false };

      const identity = await tx.tenant.findUniqueOrThrow({
        where: { id },
        select: ICHANCY_IDENTITY_SELECT,
      });
      // An explicit tenantId, which the scope extension never overrides: the evidence is in the
      // operator's own log, wherever the request's context points.
      const latest = await tx.auditLog.findFirst({
        where: {
          tenantId: id,
          entityType: TENANT_SUBJECT,
          entityId: id,
          action: { in: [...STATUS_DECISION_ACTIONS] },
        },
        // uuidv7 ids are time-ordered, so they settle two rows written in the same microsecond.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { action: true, after: true },
      });
      if (!mayResumeWithoutSignIn(latest, identity)) throw activationUnavailable();

      // Conditional on the status AND on the very credentials just fingerprinted. A concurrent
      // activate, or a credential change that commits after the reads above, makes this match no
      // row instead of resuming an operator whose details were never proven.
      const claimed = await tx.tenant.updateMany({
        where: { id, status: TenantStatus.SUSPENDED, ...identity },
        data: { status: TenantStatus.ACTIVE },
      });
      const updated = await tx.tenant.findUniqueOrThrow({
        where: { id },
        select: TENANT_VIEW_SELECT,
      });
      if (claimed.count === 0) {
        if (updated.status === TenantStatus.ACTIVE) return { row: updated, resumed: false };
        if (updated.status === TenantStatus.CLOSED) throw tenantClosed();
        throw activationUnavailable();
      }

      await runWithTenant(id, () =>
        this.audit.write(tx, {
          action: TenantAuditActions.TENANT_ACTIVATED,
          actor: adminActor(actorAdminId),
          subjectType: TENANT_SUBJECT,
          subjectId: id,
          before: { status: TenantStatus.SUSPENDED },
          after: { status: TenantStatus.ACTIVE },
          metadata: { verification: RESUME_VERIFICATION, signIn: false },
        }),
      );
      return { row: updated, resumed: true };
    });

    // The same three as a suspension: every process has to see ACTIVE now, and the bot and the
    // mini-app key are rebuilt from the row rather than trusted from before the suspension.
    if (resumed) await this.evictOperator(id);

    return this.viewWithCounts(row);
  }

  private async viewWithCounts(row: TenantViewRow): Promise<TenantView> {
    return toTenantView(row, await this.countsOf(row.id));
  }

  /** An explicit tenantId, which the scope extension never overrides. */
  private async countsOf(id: string): Promise<TenantCounts> {
    const [players, deposits] = await Promise.all([
      this.prisma.player.count({ where: { tenantId: id } }),
      this.prisma.depositRequest.count({ where: { tenantId: id } }),
    ]);
    return { players, deposits };
  }

  private async evictOperator(id: string): Promise<void> {
    await this.registry.invalidate(id);
    await this.bots.invalidate(id);
    this.initData.invalidate(id);
  }
}

function activationUnavailable(): ServiceUnavailableError {
  return new ServiceUnavailableError(
    TenantErrorCodes.TENANT_ACTIVATION_UNAVAILABLE,
    ACTIVATION_UNAVAILABLE_MESSAGE,
  );
}

function tenantNotFound(): NotFoundError {
  return new NotFoundError(TenantErrorCodes.TENANT_NOT_FOUND, 'Tenant not found.');
}

function tenantClosed(): BusinessRuleError {
  return new BusinessRuleError(
    TenantErrorCodes.TENANT_CLOSED,
    'This operator is closed. A closed operator keeps its records but cannot be suspended or activated.',
  );
}
