/**
 * Payment method configuration and the player-facing read model.
 *
 * WHY `code`, `rail` and `currencyCode` cannot be updated: all three are load-bearing identity.
 * `code` is quoted in seeds and by the mini app; `rail` selects the driver whose rules already
 * validated past submissions; `currencyCode` is denormalized onto every deposit and onto the
 * RAIL_CLEARING ledger account. Changing any of them retroactively changes the meaning of history
 * that has already been posted to an append-only ledger. Retire the method and create a new one.
 *
 * WHY `requiredProofFields` comes from the driver rather than the row: it is behaviour, not
 * configuration. Storing it would let the database disagree with the code that enforces it.
 */
import { Injectable } from '@nestjs/common';
import { Prisma, type PaymentMethod } from '@prisma/client';

import { PrismaService } from '@core/prisma/prisma.service';
import { AuditService } from '@core/audit/audit.service';
import { isForeignKeyConstraintError, isUniqueConstraintError } from '@core/prisma/prisma-errors';
import { formatMinorToDecimal } from '@common/helpers/money.util';
import { adminActor } from '@common/types/actor.type';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '@common/exceptions/app.exception';

import { PaymentMethodErrorCodes } from '../payment-method.constants';
import { PaymentMethodRepository } from '../repositories/payment-method.repository';
import { RailDriverRegistry } from '../rails/driver-registry';
import type { RailMethodConfig } from '../rails/rail.interface';
import type {
  AdminPaymentMethodView,
  CreatePaymentMethodDto,
  ListPaymentMethodsQueryDto,
  PaymentMethodView,
  UpdatePaymentMethodDto,
} from '../dtos/payment-method.dto';
import { toMinorOrThrow } from '../utils/money-input.util';

@Injectable()
export class PaymentMethodService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly methods: PaymentMethodRepository,
    private readonly drivers: RailDriverRegistry,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Player-facing reads
  // ---------------------------------------------------------------------------

  /**
   * Active methods for the player's currency.
   * Filtering by currency is not cosmetic: offering an NSP player a method settled in another
   * currency would produce a deposit whose claimed amount cannot be posted to their liability
   * account without an FX rate we do not have.
   */
  async listForPlayer(currencyCode: string): Promise<PaymentMethodView[]> {
    const rows = await this.methods.list({ isActive: true, currencyCode });
    // A method whose rail has no driver is misconfiguration (INTERNAL, or a rail added to the enum
    // before its driver). Showing it would produce a form nobody can fill in.
    return rows
      .filter((row) => this.drivers.find(row.rail) !== undefined)
      .map((row) => this.toPlayerView(row));
  }

  async getActiveByCode(code: string): Promise<PaymentMethod> {
    const method = await this.methods.findByCode(code);
    if (method === null) {
      throw new NotFoundError(
        PaymentMethodErrorCodes.PAYMENT_METHOD_NOT_FOUND,
        'That payment method does not exist.',
      );
    }
    if (!method.isActive) {
      throw new BusinessRuleError(
        PaymentMethodErrorCodes.PAYMENT_METHOD_INACTIVE,
        'That payment method is not available at the moment.',
      );
    }
    return method;
  }

  async getActiveById(id: string): Promise<PaymentMethod> {
    const method = await this.methods.findById(id);
    if (method === null) {
      throw new NotFoundError(
        PaymentMethodErrorCodes.PAYMENT_METHOD_NOT_FOUND,
        'That payment method does not exist.',
      );
    }
    if (!method.isActive) {
      throw new BusinessRuleError(
        PaymentMethodErrorCodes.PAYMENT_METHOD_INACTIVE,
        'That payment method is not available at the moment.',
      );
    }
    return method;
  }

  // ---------------------------------------------------------------------------
  // Admin
  // ---------------------------------------------------------------------------

  async listForAdmin(query: ListPaymentMethodsQueryDto): Promise<AdminPaymentMethodView[]> {
    const where: Prisma.PaymentMethodWhereInput = {
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.rail !== undefined ? { rail: query.rail } : {}),
    };
    const rows = await this.methods.list(where);
    return rows.map((row) => this.toAdminView(row));
  }

  async getForAdmin(id: string): Promise<AdminPaymentMethodView> {
    return this.toAdminView(await this.getOrThrow(id));
  }

  async create(actorAdminId: string, dto: CreatePaymentMethodDto): Promise<AdminPaymentMethodView> {
    const minAmountMinor = toMinorOrThrow(dto.minAmount, 'minAmount');
    const maxAmountMinor = toMinorOrThrow(dto.maxAmount, 'maxAmount');
    const feeFixedMinor =
      dto.feeFixed === undefined ? 0n : toMinorOrThrow(dto.feeFixed, 'feeFixed');

    this.assertCoherent(minAmountMinor, maxAmountMinor, feeFixedMinor);
    // Fail fast on a rail nobody implements, rather than creating a method that can never be used.
    this.drivers.get(dto.rail);

    const created = await this.prisma
      .runInTransaction(async (tx) => {
        const method = await this.methods.create(
          {
            code: dto.code,
            displayName: dto.displayName,
            rail: dto.rail,
            currencyCode: dto.currencyCode,
            verificationMode: dto.verificationMode,
            minAmountMinor,
            maxAmountMinor,
            feeFixedMinor,
            feeBps: dto.feeBps ?? 0,
            requiresReference: dto.requiresReference ?? false,
            referencePattern: dto.referencePattern ?? null,
            instructions: dto.instructions ?? null,
            isActive: dto.isActive ?? true,
            sortOrder: dto.sortOrder ?? 0,
          },
          tx,
        );

        await this.audit.write(tx, {
          action: 'payment_method.created',
          actor: adminActor(actorAdminId),
          subjectType: 'PaymentMethod',
          subjectId: method.id,
          after: this.snapshot(method),
        });

        return method;
      })
      .catch((error: unknown) => {
        throw this.mapWriteError(error);
      });

    return this.toAdminView(created);
  }

  async update(
    actorAdminId: string,
    id: string,
    dto: UpdatePaymentMethodDto,
  ): Promise<AdminPaymentMethodView> {
    const updated = await this.prisma
      .runInTransaction(async (tx) => {
        const current = await this.methods.findById(id, tx);
        if (current === null) {
          throw new NotFoundError(
            PaymentMethodErrorCodes.PAYMENT_METHOD_NOT_FOUND,
            'That payment method does not exist.',
          );
        }

        // Each bound is resolved against the incoming value if present, otherwise the stored one,
        // so a partial update cannot leave min > max.
        const minAmountMinor =
          dto.minAmount === undefined
            ? current.minAmountMinor
            : toMinorOrThrow(dto.minAmount, 'minAmount');
        const maxAmountMinor =
          dto.maxAmount === undefined
            ? current.maxAmountMinor
            : toMinorOrThrow(dto.maxAmount, 'maxAmount');
        const feeFixedMinor =
          dto.feeFixed === undefined
            ? current.feeFixedMinor
            : toMinorOrThrow(dto.feeFixed, 'feeFixed');

        this.assertCoherent(minAmountMinor, maxAmountMinor, feeFixedMinor);

        const method = await this.methods.update(
          id,
          {
            ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
            ...(dto.verificationMode !== undefined
              ? { verificationMode: dto.verificationMode }
              : {}),
            ...(dto.minAmount !== undefined ? { minAmountMinor } : {}),
            ...(dto.maxAmount !== undefined ? { maxAmountMinor } : {}),
            ...(dto.feeFixed !== undefined ? { feeFixedMinor } : {}),
            ...(dto.feeBps !== undefined ? { feeBps: dto.feeBps } : {}),
            ...(dto.requiresReference !== undefined
              ? { requiresReference: dto.requiresReference }
              : {}),
            ...(dto.referencePattern !== undefined
              ? { referencePattern: dto.referencePattern }
              : {}),
            ...(dto.instructions !== undefined ? { instructions: dto.instructions } : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
            ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          },
          tx,
        );

        await this.audit.write(tx, {
          action: 'payment_method.updated',
          actor: adminActor(actorAdminId),
          subjectType: 'PaymentMethod',
          subjectId: id,
          before: this.snapshot(current),
          after: this.snapshot(method),
        });

        return method;
      })
      .catch((error: unknown) => {
        throw this.mapWriteError(error);
      });

    return this.toAdminView(updated);
  }

  /** Retirement, not deletion — see the file header. */
  async deactivate(actorAdminId: string, id: string): Promise<AdminPaymentMethodView> {
    return this.update(actorAdminId, id, { isActive: false });
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  /** The slice a rail driver is allowed to see. */
  toRailConfig(method: PaymentMethod): RailMethodConfig {
    return {
      code: method.code,
      rail: method.rail,
      displayName: method.displayName,
      currencyCode: method.currencyCode,
      verificationMode: method.verificationMode,
      minAmountMinor: method.minAmountMinor,
      maxAmountMinor: method.maxAmountMinor,
      requiresReference: method.requiresReference,
      referencePattern: method.referencePattern,
      instructions: method.instructions,
    };
  }

  toPlayerView(method: PaymentMethod): PaymentMethodView {
    const driver = this.drivers.find(method.rail);
    return {
      id: method.id,
      code: method.code,
      displayName: method.displayName,
      rail: method.rail,
      currencyCode: method.currencyCode,
      verificationMode: method.verificationMode,
      minAmount: formatMinorToDecimal(method.minAmountMinor),
      maxAmount: formatMinorToDecimal(method.maxAmountMinor),
      feeFixed: formatMinorToDecimal(method.feeFixedMinor),
      feeBps: method.feeBps,
      requiresReference: method.requiresReference,
      instructions: method.instructions,
      requiredProofFields: driver?.requiredProofFields ?? [],
    };
  }

  toAdminView(method: PaymentMethod): AdminPaymentMethodView {
    return {
      ...this.toPlayerView(method),
      isActive: method.isActive,
      sortOrder: method.sortOrder,
      referencePattern: method.referencePattern,
      createdAt: method.createdAt.toISOString(),
      updatedAt: method.updatedAt.toISOString(),
    };
  }

  /**
   * The row, whether or not it is still active. Existence only.
   *
   * "Is this rail open for business?" is `getActiveById`'s question and it belongs to anything that
   * OPENS work on a method. It must not be asked of work that already exists: a deposit whose rail
   * was retired after the player paid still has to be provable, reviewable and creditable, and a
   * method row is never deleted (DELETE /v1/admin/payment-methods/:id deactivates).
   */
  async getOrThrow(id: string): Promise<PaymentMethod> {
    const method = await this.methods.findById(id);
    if (method === null) {
      throw new NotFoundError(
        PaymentMethodErrorCodes.PAYMENT_METHOD_NOT_FOUND,
        'That payment method does not exist.',
      );
    }
    return method;
  }

  private assertCoherent(
    minAmountMinor: bigint,
    maxAmountMinor: bigint,
    feeFixedMinor: bigint,
  ): void {
    if (minAmountMinor <= 0n) {
      throw new ValidationError(
        'minAmount must be greater than zero.',
        { field: 'minAmount' },
        PaymentMethodErrorCodes.PAYMENT_METHOD_INVALID,
      );
    }
    if (maxAmountMinor < minAmountMinor) {
      throw new ValidationError(
        'maxAmount cannot be smaller than minAmount.',
        { field: 'maxAmount' },
        PaymentMethodErrorCodes.PAYMENT_METHOD_INVALID,
      );
    }
    if (feeFixedMinor < 0n) {
      throw new ValidationError(
        'feeFixed cannot be negative.',
        { field: 'feeFixed' },
        PaymentMethodErrorCodes.PAYMENT_METHOD_INVALID,
      );
    }
    // A fixed fee at or above the minimum deposit means the smallest allowed deposit credits zero
    // or less — a configuration that can only produce confused players and support tickets.
    if (feeFixedMinor >= minAmountMinor) {
      throw new ValidationError(
        'feeFixed must be smaller than minAmount, otherwise the smallest allowed deposit credits nothing.',
        { field: 'feeFixed' },
        PaymentMethodErrorCodes.PAYMENT_METHOD_INVALID,
      );
    }
  }

  private snapshot(method: PaymentMethod): Record<string, unknown> {
    return {
      code: method.code,
      displayName: method.displayName,
      rail: method.rail,
      currencyCode: method.currencyCode,
      verificationMode: method.verificationMode,
      minAmountMinor: method.minAmountMinor.toString(),
      maxAmountMinor: method.maxAmountMinor.toString(),
      feeFixedMinor: method.feeFixedMinor.toString(),
      feeBps: method.feeBps,
      requiresReference: method.requiresReference,
      referencePattern: method.referencePattern,
      isActive: method.isActive,
      sortOrder: method.sortOrder,
    };
  }

  private mapWriteError(error: unknown): unknown {
    if (isUniqueConstraintError(error)) {
      return new ConflictError(
        PaymentMethodErrorCodes.PAYMENT_METHOD_ALREADY_EXISTS,
        'A payment method with that code already exists.',
      );
    }
    if (isForeignKeyConstraintError(error)) {
      return new ValidationError(
        'That currency does not exist.',
        { field: 'currencyCode' },
        PaymentMethodErrorCodes.PAYMENT_METHOD_INVALID,
      );
    }
    return error;
  }
}
