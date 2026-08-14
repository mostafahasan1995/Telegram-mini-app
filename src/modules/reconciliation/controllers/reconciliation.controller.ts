/**
 * The operator's window onto reconciliation: list breaks, resolve one, read the rail ageing report,
 * and force a float comparison.
 *
 * WHY resolving requires a note and returns the row: closing a money difference is a decision, and
 * the audit row written by ReconciliationBreakService is the evidence it was taken deliberately.
 *
 * WHY the float CORRECTION is a separate endpoint from RESOLVE, with a narrower role: resolving says
 * "I have looked at this and it is not a problem". Correcting POSTS TO THE LEDGER — it changes our
 * books to match an outside number. Those are different acts with different consequences and they
 * must not share a button.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { AdminRole, BreakStatus, type ReconciliationBreak } from '@prisma/client';

import { AdminAuth } from '@common/decorators/auth.decorator';
import { CurrentAdmin } from '@common/decorators/current-principal.decorator';
import type { AuthenticatedAdmin } from '@common/decorators/auth.types';
import { cursorPage, type CursorResult } from '@common/dtos/paginated.dto';
import { ValidationError } from '@common/exceptions/app.exception';
import { AppConfigService } from '@core/config/config.service';
import type { LedgerInvariantReport } from '@core/ledger';
import { PrismaService } from '@core/prisma/prisma.service';

import { CorrectFloatDto, ListBreaksQueryDto, ResolveBreakDto } from '../dtos/break-query.dto';
import { toBreakView, type BreakView } from '../dtos/break.view';
import { ReconciliationErrorCodes } from '../enums/reconciliation-error-code.enum';
import { AgentFloatSyncService, type FloatSyncResult } from '../services/agent-float-sync.service';
import { InvariantCheckCron } from '../services/invariant-check.cron';
import { RailAgeingService, type RailAgeingReport } from '../services/rail-ageing.service';
import { ReconciliationBreakService } from '../services/reconciliation-break.service';
import { decodeBreakCursor, encodeBreakCursor } from '../utils/break-cursor.util';

const VIEW_ROLES: AdminRole[] = [
  AdminRole.SUPER_ADMIN,
  AdminRole.FINANCE_ADMIN,
  AdminRole.REVIEWER,
  AdminRole.VIEWER,
];

const ACT_ROLES: AdminRole[] = [AdminRole.SUPER_ADMIN, AdminRole.FINANCE_ADMIN];

/** Only these three are legal outcomes; OPEN and INVESTIGATING are not "resolutions". */
const TERMINAL_BREAK_STATUSES: readonly BreakStatus[] = Object.freeze([
  BreakStatus.RESOLVED,
  BreakStatus.WRITTEN_OFF,
  BreakStatus.FALSE_POSITIVE,
]);

@Controller('v1/admin/reconciliation')
export class ReconciliationController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly breaks: ReconciliationBreakService,
    private readonly floatSync: AgentFloatSyncService,
    private readonly railAgeing: RailAgeingService,
    private readonly invariants: InvariantCheckCron,
    private readonly config: AppConfigService,
  ) {}

  /** GET /v1/admin/reconciliation/breaks */
  @Get('breaks')
  @AdminAuth(...VIEW_ROLES)
  async list(@Query() query: ListBreaksQueryDto): Promise<CursorResult<BreakView>> {
    const cursor = decodeBreakCursor(query.cursor ?? null);

    const rows = await this.prisma.reconciliationBreak.findMany({
      where: {
        ...(query.status !== undefined && query.status.length > 0
          ? { status: { in: query.status } }
          : // Default view is work that still needs doing, not the whole history.
            { status: { in: [BreakStatus.OPEN, BreakStatus.INVESTIGATING] } }),
        ...(query.category !== undefined && query.category.length > 0
          ? { category: { in: query.category } }
          : {}),
        ...(query.minSeverity === undefined ? {} : { severity: { gte: query.minSeverity } }),
        ...(cursor === null
          ? {}
          : {
              OR: [
                { detectedAt: { lt: cursor.detectedAt } },
                { detectedAt: cursor.detectedAt, id: { lt: cursor.id } },
              ],
            }),
      },
      // Newest first, id last so the ordering is total and the cursor cannot loop.
      orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    return cursorPage(rows.map(toBreakView), query.limit, (view) =>
      encodeBreakCursor({ detectedAt: new Date(view.detectedAt), id: view.id }),
    );
  }

  @Get('breaks/:id')
  @AdminAuth(...VIEW_ROLES)
  async detail(@Param('id', ParseUUIDPipe) id: string): Promise<BreakView> {
    const row = await this.prisma.reconciliationBreak.findUniqueOrThrow({ where: { id } });
    return toBreakView(row);
  }

  /** POST /v1/admin/reconciliation/breaks/:id/resolve */
  @Post('breaks/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(...ACT_ROLES)
  async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() dto: ResolveBreakDto,
  ): Promise<BreakView> {
    if (!TERMINAL_BREAK_STATUSES.includes(dto.status)) {
      throw new ValidationError(
        'A break can only be closed as RESOLVED, WRITTEN_OFF or FALSE_POSITIVE.',
        { status: dto.status },
        ReconciliationErrorCodes.CORRECTION_NOT_ALLOWED,
      );
    }
    const updated: ReconciliationBreak = await this.breaks.resolve({
      breakId: id,
      admin,
      status: dto.status as 'RESOLVED' | 'WRITTEN_OFF' | 'FALSE_POSITIVE',
      note: dto.note,
    });
    return toBreakView(updated);
  }

  @Post('breaks/:id/assign')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(...ACT_ROLES)
  async assign(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<BreakView> {
    return toBreakView(await this.breaks.assign(id, admin));
  }

  /** Read both sides of the agent float now instead of waiting for the next tick. */
  @Post('agent-float/sync')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(...ACT_ROLES)
  async syncFloat(): Promise<{
    currencyCode: string;
    ledgerMinor: string;
    ichancyMinor: string | null;
    deltaMinor: string | null;
    breakId: string | null;
    belowWatermark: boolean;
  }> {
    const result: FloatSyncResult = await this.floatSync.sync(this.config.ichancy.currency);
    return {
      currencyCode: result.currencyCode,
      ledgerMinor: result.ledgerMinor.toString(),
      ichancyMinor: result.ichancyMinor?.toString() ?? null,
      deltaMinor: result.deltaMinor?.toString() ?? null,
      breakId: result.breakId,
      belowWatermark: result.belowWatermark,
    };
  }

  /**
   * POST a ledger correction for a float mismatch. SUPER_ADMIN/FINANCE_ADMIN only, and it always
   * writes an AGENT_FLOAT_SYNC transaction carrying the operator's note — see the header.
   */
  @Post('breaks/:id/correct-float')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(AdminRole.SUPER_ADMIN, AdminRole.FINANCE_ADMIN)
  async correctFloat(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() dto: CorrectFloatDto,
  ): Promise<{ ledgerTransactionId: string; deltaMinor: string }> {
    const result = await this.floatSync.applyCorrection({ breakId: id, admin, note: dto.note });
    return {
      ledgerTransactionId: result.ledgerTransactionId,
      deltaMinor: result.deltaMinor.toString(),
    };
  }

  /** GET /v1/admin/reconciliation/rail-ageing */
  @Get('rail-ageing')
  @AdminAuth(...VIEW_ROLES)
  async ageing(): Promise<RailAgeingReport> {
    return this.railAgeing.report();
  }

  /** Run I1/I2/I3 now. Read-only apart from the I3 cache repair, which is always safe. */
  @Post('invariants/run')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(...ACT_ROLES)
  async runInvariants(): Promise<LedgerInvariantReport> {
    return this.invariants.runOnce();
  }
}
