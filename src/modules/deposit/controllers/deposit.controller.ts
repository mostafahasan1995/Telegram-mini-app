/**
 * Player endpoints. Thin by policy: parse, delegate, map. Every transaction boundary and every
 * business rule lives in a service — a controller that "just checks one thing first" is how a rule
 * ends up enforced on one of the two paths that reach it.
 *
 * `@Idempotent('deposit.create')` is not optional decoration: a mini-app on a flaky mobile network
 * retries POSTs, and without a key the retry opens a second deposit for money that was sent once.
 * The scope string is per-endpoint so a client that reuses one key across actions cannot get the
 * deposit's response back from the proof endpoint.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';

import { PlayerAuth } from '@common/decorators/auth.decorator';
import { CurrentActor, CurrentPlayer } from '@common/decorators/current-principal.decorator';
import { paginate, type PaginatedResult } from '@common/dtos/paginated.dto';
import type { Actor } from '@common/types/actor.type';
import { ValidationError } from '@common/exceptions/app.exception';
import { Idempotent } from '@core/idempotency/idempotent.decorator';

import { DEPOSIT_CREATE_SCOPE, MAX_PROOFS_PER_DEPOSIT } from '../deposit.constants';
import { CreateDepositDto } from '../dtos/create-deposit.dto';
import { ListDepositsQueryDto } from '../dtos/deposit-query.dto';
import { SubmitProofDto } from '../dtos/submit-proof.dto';
import type { DepositView } from '../dtos/deposit.view';
import { DepositErrorCodes } from '../enums/deposit-error-code.enum';
import {
  DepositService,
  type CreatedDeposit,
  type SubmitProofResult,
} from '../services/deposit.service';
import { MAX_PROOF_BYTES } from '@core/file/telegram-file.service';

@Controller('v1/deposits')
@PlayerAuth()
export class DepositController {
  constructor(private readonly deposits: DepositService) {}

  /** POST /v1/deposits — open a deposit and return the destination to pay into. */
  @Post()
  @Idempotent(DEPOSIT_CREATE_SCOPE)
  async create(
    @CurrentActor() actor: Actor,
    @CurrentPlayer('playerId') playerId: string,
    @Body() dto: CreateDepositDto,
    @Req() request: Request,
  ): Promise<CreatedDeposit> {
    return this.deposits.create(actor, {
      playerId,
      paymentMethodId: dto.paymentMethodId,
      ...(dto.paymentDestinationId === undefined
        ? {}
        : { paymentDestinationId: dto.paymentDestinationId }),
      amountMinor: dto.amount.toMinor(),
      ...(dto.externalReference === undefined ? {} : { externalReference: dto.externalReference }),
      ...(dto.senderAccount === undefined ? {} : { senderAccount: dto.senderAccount }),
      source: dto.source ?? 'miniapp',
      ...(request.ip === undefined ? {} : { ipAddress: request.ip }),
      ...(typeof request.headers['user-agent'] === 'string'
        ? { userAgent: request.headers['user-agent'] }
        : {}),
      // The interceptor has already validated and scoped it; persisting it makes the guarantee
      // survive a cache eviction, because deposit_requests.idempotency_key is UNIQUE.
      ...(typeof request.headers['idempotency-key'] === 'string'
        ? { idempotencyKey: `${DEPOSIT_CREATE_SCOPE}:${request.headers['idempotency-key']}` }
        : {}),
    });
  }

  /** GET /v1/deposits — the player's own history. Offset paging: small, and they get a total. */
  @Get()
  async list(
    @CurrentPlayer('playerId') playerId: string,
    @Query() query: ListDepositsQueryDto,
  ): Promise<PaginatedResult<DepositView>> {
    const { items, total } = await this.deposits.listForPlayer(
      playerId,
      query.status,
      query.take,
      query.skip,
    );
    return paginate(items, total, query.limit, query.offset);
  }

  /** GET /v1/deposits/:shortId */
  @Get(':shortId')
  async getOne(
    @CurrentPlayer('playerId') playerId: string,
    @Param('shortId') shortId: string,
  ): Promise<DepositView> {
    return this.deposits.getForPlayer(playerId, shortId.trim().toUpperCase());
  }

  /**
   * POST /v1/deposits/:shortId/proof
   *
   * NOT idempotent by key: attaching a second, different receipt to the same deposit is a legitimate
   * thing to do (a player photographs the transfer AND the confirmation SMS). Re-sending the SAME
   * image is caught by `@@unique([depositRequestId, sha256])` on the normalized hash, which is a
   * stronger guarantee than a client-supplied key.
   */
  @Post(':shortId/proof')
  @HttpCode(HttpStatus.CREATED)
  async submitProof(
    @CurrentActor() actor: Actor,
    @CurrentPlayer('playerId') playerId: string,
    @Param('shortId') shortId: string,
    @Body() dto: SubmitProofDto,
  ): Promise<SubmitProofResult> {
    const image = Buffer.from(dto.imageBase64, 'base64');
    // The DTO caps the ENCODED length; this is the decoded truth. base64 of junk decodes to
    // something, so a near-empty result means the client sent something that is not an image.
    if (image.byteLength === 0 || image.byteLength > MAX_PROOF_BYTES) {
      throw new ValidationError(
        'That image could not be read.',
        { sizeBytes: image.byteLength, maxBytes: MAX_PROOF_BYTES },
        DepositErrorCodes.PROOF_UNREADABLE,
      );
    }

    const result = await this.deposits.submitProof(actor, {
      playerId,
      shortId: shortId.trim().toUpperCase(),
      image,
      mimeType: dto.mimeType,
      ...(dto.externalReference === undefined ? {} : { externalReference: dto.externalReference }),
      ...(dto.senderAccount === undefined ? {} : { senderAccount: dto.senderAccount }),
    });

    // Risk flags are for reviewers. Telling a player which of our checks fired would let them tune
    // their next attempt against it.
    return { ...result, riskFlags: [] };
  }

  /** POST /v1/deposits/:shortId/cancel — only before a proof exists. */
  @Post(':shortId/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentActor() actor: Actor,
    @CurrentPlayer('playerId') playerId: string,
    @Param('shortId') shortId: string,
  ): Promise<DepositView> {
    return this.deposits.cancel(actor, playerId, shortId.trim().toUpperCase());
  }

  /** GET /v1/deposits/limits/proof — what the client should enforce before it uploads. */
  @Get('limits/proof')
  proofLimits(): { maxBytes: number; maxProofsPerDeposit: number } {
    return { maxBytes: MAX_PROOF_BYTES, maxProofsPerDeposit: MAX_PROOFS_PER_DEPOSIT };
  }
}
