/**
 * The single PlatformDefaults row: what every NEW operator inherits. Read through this service and
 * nothing else, by the GET route and by tenant creation alike, so both see the same values.
 *
 * ══ SEEDED FROM THE ENV ON FIRST READ, EXACTLY ONCE ══════════════════════════════════════════════
 * The contract: "Seeded from this deployment's `.env` the first time anything reads it, so an
 * existing deployment keeps exactly the values it already had without anybody running a script."
 * The multi-tenant migration pre-inserts the row with literals (agent id NULL, thresholds 0), so the
 * row existing says nothing. `seeded_from_env_at` does: NULL until the first read copies the env over
 * the literals and stamps it.
 *
 * Exactly once, under concurrency: the copy is `UPDATE … WHERE seeded_from_env_at IS NULL`. Two
 * first reads racing both run it. The second blocks on the row lock, re-checks the WHERE against the
 * committed row, and updates nothing, so only one of them writes the audit row. A database the
 * migration never ran on has no row, and `INSERT … ON CONFLICT DO NOTHING` gives the same guarantee.
 *
 * Why not compare against the literals instead of a column: a platform admin may deliberately set a
 * value that equals one (a zero threshold), and the next read would silently overwrite that choice
 * with the env.
 *
 * ══ AUDIT ════════════════════════════════════════════════════════════════════════════════════════
 * Both the seeding and every edit land in TENANT ZERO's log, entered explicitly with runAsPlatform:
 * the row belongs to the platform, not to whichever operator a platform admin's X-Tenant-Id pointed
 * the request at. The seeding is attributed to SYSTEM, because a GET caused it but no person chose
 * those values. The env did.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { PlatformDefaults } from '@prisma/client';

import { ValidationError } from '@common/exceptions/app.exception';
import { SYSTEM_ACTOR, adminActor } from '@common/types/actor.type';
import { AuditService } from '@core/audit/audit.service';
import { AppConfigService } from '@core/config/config.service';
import { PrismaService } from '@core/prisma/prisma.service';
import type { Tx } from '@core/prisma/tx.type';
import { runAsPlatform } from '@core/tenant/tenant.storage';

import type { UpdatePlatformDefaultsDto } from '../dtos/update-platform-defaults.dto';
import { PLATFORM_DEFAULTS_ID, TenantAuditActions } from '../tenant-admin.constants';
import { changedFields } from '../utils/changed-fields';
import { platformDefaultsEditsFromDto } from '../utils/edits';
import { platformDefaultsFromEnv, type PlatformDefaultsValues } from '../utils/platform-defaults.resolve';
import { toPlatformDefaultsView, type PlatformDefaultsView } from '../views/platform-defaults.view';

@Injectable()
export class PlatformDefaultsService {
  private readonly logger = new Logger(PlatformDefaultsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  /** The row, seeded from the env first if nothing has seeded it yet. */
  async read(): Promise<PlatformDefaults> {
    const row = await this.prisma.platformDefaults.findUnique({
      where: { id: PLATFORM_DEFAULTS_ID },
    });
    if (row !== null && row.seededFromEnvAt !== null) return row;
    return this.seedFromEnv();
  }

  async view(): Promise<PlatformDefaultsView> {
    return toPlatformDefaultsView(await this.read());
  }

  /**
   * A PATCH: absent keys leave stored values alone, and a save that changes nothing writes nothing.
   * Not retroactive. No operator's row is touched, which is what `appliesToNewOperatorsOnly` says.
   */
  async update(actorAdminId: string, dto: UpdatePlatformDefaultsDto): Promise<PlatformDefaultsView> {
    const edits = platformDefaultsEditsFromDto(dto);

    // Seed before editing. Otherwise an edit made before anybody had read the row would be
    // overwritten by the env on the next read, and the admin's change would vanish.
    await this.read();

    const row = await this.prisma.runInTransaction(async (tx) => {
      if (edits.currencyCode !== undefined) {
        await this.assertCurrencyUsable(tx, edits.currencyCode);
      }

      const current = await tx.platformDefaults.findUniqueOrThrow({
        where: { id: PLATFORM_DEFAULTS_ID },
      });
      const changes = changedFields<PlatformDefaultsValues>(current, edits);
      if (changes === null) return current;

      const updated = await tx.platformDefaults.update({
        where: { id: PLATFORM_DEFAULTS_ID },
        data: changes.data,
      });

      await runAsPlatform(() =>
        this.audit.write(tx, {
          action: TenantAuditActions.PLATFORM_DEFAULTS_UPDATED,
          actor: adminActor(actorAdminId),
          subjectType: 'PlatformDefaults',
          subjectId: String(PLATFORM_DEFAULTS_ID),
          before: changes.before,
          after: changes.after,
        }),
      );
      return updated;
    });

    return toPlatformDefaultsView(row);
  }

  private async seedFromEnv(): Promise<PlatformDefaults> {
    const values = platformDefaultsFromEnv(this.config);

    const { row, seeded } = await this.prisma.runInTransaction(async (tx) => {
      const before = await tx.platformDefaults.findUnique({ where: { id: PLATFORM_DEFAULTS_ID } });
      const seededFromEnvAt = new Date();

      const claimed = await tx.platformDefaults.updateMany({
        where: { id: PLATFORM_DEFAULTS_ID, seededFromEnvAt: null },
        data: { ...values, seededFromEnvAt },
      });
      let didSeed = claimed.count === 1;

      if (!didSeed && before === null) {
        const created = await tx.platformDefaults.createMany({
          data: [{ id: PLATFORM_DEFAULTS_ID, ...values, seededFromEnvAt }],
          skipDuplicates: true,
        });
        didSeed = created.count === 1;
      }

      if (didSeed) {
        await runAsPlatform(() =>
          this.audit.write(tx, {
            action: TenantAuditActions.PLATFORM_DEFAULTS_SEEDED,
            actor: SYSTEM_ACTOR,
            subjectType: 'PlatformDefaults',
            subjectId: String(PLATFORM_DEFAULTS_ID),
            before: before === null ? null : snapshot(before),
            after: snapshot(values),
            metadata: { source: 'env', trigger: 'first read' },
          }),
        );
      }

      const current = await tx.platformDefaults.findUniqueOrThrow({
        where: { id: PLATFORM_DEFAULTS_ID },
      });
      return { row: current, seeded: didSeed };
    });

    if (seeded) {
      this.logger.log("PlatformDefaults seeded from this deployment's env on first read");
    }
    return row;
  }

  /**
   * An unknown code and an inactive one are refused with different sentences: the first is a typo,
   * the second is a currency somebody retired on purpose, and they are fixed in different places.
   *
   * Public because tenant creation applies the same rule to the currency a new operator gets: it is
   * a foreign key on `tenants`, so an unchecked code would otherwise fail as a 500 at insert.
   */
  async assertCurrencyUsable(db: Pick<Tx, 'currency'>, code: string): Promise<void> {
    const currency = await db.currency.findUnique({ where: { code }, select: { isActive: true } });
    if (currency === null) {
      throw new ValidationError(undefined, {
        fields: [`currencyCode: there is no currency ${code}`],
      });
    }
    if (!currency.isActive) {
      throw new ValidationError(undefined, {
        fields: [`currencyCode: ${code} exists but is not active, so no new operator may use it`],
      });
    }
  }
}

/** The six values, for an audit snapshot. Never the bookkeeping columns. */
function snapshot(values: PlatformDefaultsValues): Record<string, unknown> {
  return {
    ichancyBaseUrl: values.ichancyBaseUrl,
    ichancyAgentId: values.ichancyAgentId,
    currencyCode: values.currencyCode,
    dualApprovalThresholdMinor: values.dualApprovalThresholdMinor.toString(),
    agentFloatLowWatermarkMinor: values.agentFloatLowWatermarkMinor.toString(),
    depositExpiryMinutes: values.depositExpiryMinutes,
  };
}
