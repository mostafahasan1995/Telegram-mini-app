/**
 * Admin endpoints for the review queue.
 *
 * WHY the queue is CURSOR paginated: it is append-heavy and is read while it is written. With OFFSET
 * paging, every deposit that arrives between page 1 and page 2 shifts the rest down by one, so a row
 * crosses the page boundary and is never seen. In a review queue an unseen row is an unreviewed
 * payment. A keyset cursor over (createdAt, id) cannot skip.
 *
 * WHY proof access is an endpoint and not a URL in the list response: a proof is a document
 * identifying a real person. The URL is minted on demand with a five-minute TTL, and on a driver
 * that cannot sign one, the bytes stream through here instead — so a deployment on local storage is
 * not silently less private than one on S3.
 */
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { AdminRole, DepositStatus } from '@prisma/client';

import { AdminAuth } from '@common/decorators/auth.decorator';
import { CurrentAdmin } from '@common/decorators/current-principal.decorator';
import { cursorPage, type CursorResult } from '@common/dtos/paginated.dto';
import type { AuthenticatedAdmin } from '@common/decorators/auth.types';
import { NotFoundError } from '@common/exceptions/app.exception';
import { parseDecimalToMinor } from '@common/helpers/money.util';
import { FILE_STORAGE, type FileStorage } from '@core/file';
import { PrismaService } from '@core/prisma/prisma.service';
import { Inject } from '@nestjs/common';

import { PROOF_URL_TTL_SECONDS } from '../deposit.constants';
import { REVIEWABLE_STATUSES } from '../deposit-state.machine';
import { AdminDepositQueueQueryDto } from '../dtos/deposit-query.dto';
import { ApproveDepositDto, RejectDepositDto, RetryCreditDto } from '../dtos/review.dto';
import { toAdminDepositView, type AdminDepositView } from '../dtos/deposit.view';
import { DepositErrorCodes } from '../enums/deposit-error-code.enum';
import { DepositRepository } from '../repositories/deposit.repository';
import { DepositService } from '../services/deposit.service';
import { DepositSweepService, type SweepReport } from '../services/deposit-sweep.service';
import { DepositRetryService } from '../services/deposit-retry.service';
import { DepositReviewService, type ReviewOutcome } from '../services/deposit-review.service';
import { encodeDepositCursor } from '../utils/deposit-filter.util';

/** Anyone who may SEE the queue. Deciding is checked again inside the review service. */
const QUEUE_ROLES: AdminRole[] = [
  AdminRole.SUPER_ADMIN,
  AdminRole.FINANCE_ADMIN,
  AdminRole.REVIEWER,
  AdminRole.SUPPORT,
  AdminRole.VIEWER,
];

const DECIDE_ROLES: AdminRole[] = [
  AdminRole.SUPER_ADMIN,
  AdminRole.FINANCE_ADMIN,
  AdminRole.REVIEWER,
];

@Controller('v1/admin/deposits')
export class DepositAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: DepositRepository,
    private readonly deposits: DepositService,
    private readonly review: DepositReviewService,
    private readonly retry: DepositRetryService,
    private readonly sweeper: DepositSweepService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  /** GET /v1/admin/deposits — the review queue, cursor paginated. */
  @Get()
  @AdminAuth(...QUEUE_ROLES)
  async queue(@Query() query: AdminDepositQueueQueryDto): Promise<CursorResult<AdminDepositView>> {
    const status: DepositStatus[] =
      query.status !== undefined && query.status.length > 0
        ? query.status
        : [...REVIEWABLE_STATUSES];

    const rows = await this.repository.pageForAdmin(
      this.prisma,
      {
        status,
        ...(query.playerId === undefined ? {} : { playerId: query.playerId }),
        ...(query.paymentMethodId === undefined ? {} : { paymentMethodId: query.paymentMethodId }),
        ...(query.shortId === undefined ? {} : { shortId: query.shortId }),
        ...(query.externalReference === undefined
          ? {}
          : { externalReference: query.externalReference }),
        ...(query.createdFrom === undefined ? {} : { createdFrom: new Date(query.createdFrom) }),
        ...(query.createdTo === undefined ? {} : { createdTo: new Date(query.createdTo) }),
        ...(query.minAmount === undefined
          ? {}
          : { minAmountMinor: parseDecimalToMinor(query.minAmount) }),
        ...(query.maxAmount === undefined
          ? {}
          : { maxAmountMinor: parseDecimalToMinor(query.maxAmount) }),
        ...(query.unclaimedOnly === undefined ? {} : { unclaimedOnly: query.unclaimedOnly }),
      },
      query.cursor,
      query.limit,
      query.sort ?? 'newest',
    );

    const riskByDeposit = new Map<string, Awaited<ReturnType<DepositService['riskFlagsFor']>>>();
    for (const row of rows) {
      riskByDeposit.set(row.id, await this.deposits.riskFlagsFor(this.prisma, row.id));
    }

    const views = rows.map((row) =>
      toAdminDepositView(row, {
        proofs: row.proofs,
        player: row.player,
        riskFlags: riskByDeposit.get(row.id) ?? [],
        destination: {
          methodCode: row.paymentMethod.code,
          methodName: row.paymentMethod.displayName,
          instructions: row.paymentMethod.instructions,
          requiresReference: row.paymentMethod.requiresReference,
          label: row.paymentDestination?.label ?? null,
          accountIdentifier: row.paymentDestination?.accountIdentifier ?? null,
          accountHolder: row.paymentDestination?.accountHolder ?? null,
        },
        requiresSecondApproval: row.status === DepositStatus.PENDING_SECOND_APPROVAL,
      }),
    );

    // `pageForAdmin` fetched limit+1 rows; cursorPage trims the probe row and derives hasMore.
    return cursorPage(views, query.limit, (view) =>
      encodeDepositCursor({ createdAt: new Date(view.createdAt), id: view.id }),
    );
  }

  @Get(':id')
  @AdminAuth(...QUEUE_ROLES)
  async detail(@Param('id', ParseUUIDPipe) id: string): Promise<AdminDepositView> {
    const deposit = await this.repository.findByIdWithContext(this.prisma, id);
    if (deposit === null) {
      throw new NotFoundError(DepositErrorCodes.DEPOSIT_NOT_FOUND, 'Deposit not found.');
    }
    return toAdminDepositView(deposit, {
      proofs: deposit.proofs,
      player: deposit.player,
      riskFlags: await this.deposits.riskFlagsFor(this.prisma, deposit.id),
      requiresSecondApproval: deposit.status === DepositStatus.PENDING_SECOND_APPROVAL,
      destination: {
        methodCode: deposit.paymentMethod.code,
        methodName: deposit.paymentMethod.displayName,
        instructions: deposit.paymentMethod.instructions,
        requiresReference: deposit.paymentMethod.requiresReference,
        label: deposit.paymentDestination?.label ?? null,
        accountIdentifier: deposit.paymentDestination?.accountIdentifier ?? null,
        accountHolder: deposit.paymentDestination?.accountHolder ?? null,
      },
    });
  }

  @Post(':id/claim')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(...DECIDE_ROLES)
  async claim(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<ReviewOutcome> {
    return this.review.claim({ depositRequestId: id, admin });
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(...DECIDE_ROLES)
  async release(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<ReviewOutcome> {
    return this.review.release({
      depositRequestId: id,
      admin,
      reason: `Released by ${admin.displayName}`,
    });
  }

  /** POST /v1/admin/deposits/:id/approve — see DepositReviewService for the exact ordering. */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(...DECIDE_ROLES)
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() dto: ApproveDepositDto,
  ): Promise<ReviewOutcome> {
    return this.review.approve({
      depositRequestId: id,
      admin,
      ...(dto.verifiedAmount === undefined
        ? {}
        : { verifiedAmountMinor: dto.verifiedAmount.toMinor() }),
      ...(dto.note === undefined ? {} : { note: dto.note }),
    });
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(...DECIDE_ROLES)
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() dto: RejectDepositDto,
  ): Promise<ReviewOutcome> {
    return this.review.reject({
      depositRequestId: id,
      admin,
      rejectionCode: dto.rejectionCode,
      ...(dto.rejectionNote === undefined ? {} : { rejectionNote: dto.rejectionNote }),
    });
  }

  /**
   * POST /v1/admin/deposits/:id/retry-credit
   * Deliberate operator action after CREDIT_FAILED (typically once the agent float has been topped
   * up). It bumps creditKeyEpoch, which is what makes it a NEW attempt rather than a replay.
   */
  @Post(':id/retry-credit')
  @HttpCode(HttpStatus.ACCEPTED)
  @AdminAuth(AdminRole.SUPER_ADMIN, AdminRole.FINANCE_ADMIN)
  async retryCredit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() dto: RetryCreditDto,
  ): Promise<{ requeued: boolean; creditKeyEpoch: number }> {
    return this.retry.requeueCredit({
      depositRequestId: id,
      admin,
      ...(dto.reason === undefined ? {} : { reason: dto.reason }),
    });
  }

  /** A signed, short-lived URL for one proof — or null when the driver cannot sign. */
  @Get(':id/proofs/:proofId/url')
  @AdminAuth(...QUEUE_ROLES)
  async proofUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('proofId', ParseUUIDPipe) proofId: string,
  ): Promise<{ url: string | null; streamPath: string; expiresInSeconds: number }> {
    const proof = await this.requireProof(id, proofId);
    return {
      url: await this.storage.presignGet(proof.storageKey, PROOF_URL_TTL_SECONDS),
      streamPath: `/v1/admin/deposits/${id}/proofs/${proofId}/content`,
      expiresInSeconds: PROOF_URL_TTL_SECONDS,
    };
  }

  /** The bytes, streamed through the API. Works on every driver, including local disk. */
  @Get(':id/proofs/:proofId/content')
  @AdminAuth(...QUEUE_ROLES)
  @Header('Cache-Control', 'private, no-store')
  async proofContent(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('proofId', ParseUUIDPipe) proofId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const proof = await this.requireProof(id, proofId);
    const stream = await this.storage.getStream(proof.storageKey);
    response.setHeader('Content-Type', proof.mimeType);
    // `inline` and not `attachment`: a reviewer looks at the receipt, they do not file it.
    response.setHeader(
      'Content-Disposition',
      `inline; filename="${proof.sha256.slice(0, 16)}.jpg"`,
    );
    return new StreamableFile(stream);
  }

  /** Run the expiry/claim/stuck sweep now instead of waiting for the next tick. */
  @Post('maintenance/sweep')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(AdminRole.SUPER_ADMIN, AdminRole.FINANCE_ADMIN)
  async sweep(): Promise<SweepReport> {
    return this.sweeper.runOnce();
  }

  /** Scoped by deposit id so a proof id alone cannot be used to enumerate other people's receipts. */
  private async requireProof(depositRequestId: string, proofId: string) {
    const proof = await this.repository.findProof(this.prisma, proofId);
    if (proof === null || proof.depositRequestId !== depositRequestId) {
      throw new NotFoundError(DepositErrorCodes.PROOF_NOT_FOUND, 'Proof not found.');
    }
    return proof;
  }
}
