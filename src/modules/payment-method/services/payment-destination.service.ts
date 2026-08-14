/**
 * WHY deactivating a destination does NOT clear the players stuck to it: someone may have already
 * been shown that account and be standing at a counter paying into it right now. The picker
 * re-validates stickiness against the live candidate list on every read, so a retired destination
 * stops being HANDED OUT immediately while a payment already in flight still reconciles against the
 * row it names. Clearing the sticky keys instead would tell that player to pay somewhere else
 * mid-transaction.
 *
 * WHY `accountIdentifier` is immutable: it is half of the UNIQUE (payment_method_id,
 * account_identifier) key and it is what deposits already point at. Editing it would silently
 * re-target historical payments. Retire the row and add a new one.
 */
import { Injectable } from '@nestjs/common';
import type { PaymentDestination } from '@prisma/client';

import { PrismaService } from '@core/prisma/prisma.service';
import { AuditService } from '@core/audit/audit.service';
import { isUniqueConstraintError } from '@core/prisma/prisma-errors';
import { formatMinorToDecimal } from '@common/helpers/money.util';
import { adminActor } from '@common/types/actor.type';
import { ConflictError, NotFoundError } from '@common/exceptions/app.exception';

import { PaymentMethodErrorCodes } from '../payment-method.constants';
import { PaymentDestinationRepository } from '../repositories/payment-destination.repository';
import { PaymentMethodRepository } from '../repositories/payment-method.repository';
import type {
  AdminPaymentDestinationView,
  CreatePaymentDestinationDto,
  PaymentDestinationView,
  UpdatePaymentDestinationDto,
} from '../dtos/payment-destination.dto';
import { toMinorOrNull } from '../utils/money-input.util';

export function toDestinationView(destination: PaymentDestination): PaymentDestinationView {
  return {
    id: destination.id,
    label: destination.label,
    accountIdentifier: destination.accountIdentifier,
    accountHolder: destination.accountHolder,
    notes: destination.notes,
  };
}

export function toAdminDestinationView(
  destination: PaymentDestination,
): AdminPaymentDestinationView {
  return {
    ...toDestinationView(destination),
    paymentMethodId: destination.paymentMethodId,
    isActive: destination.isActive,
    priority: destination.priority,
    dailyCap:
      destination.dailyCapMinor === null ? null : formatMinorToDecimal(destination.dailyCapMinor),
    createdAt: destination.createdAt.toISOString(),
    updatedAt: destination.updatedAt.toISOString(),
  };
}

@Injectable()
export class PaymentDestinationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly destinations: PaymentDestinationRepository,
    private readonly methods: PaymentMethodRepository,
    private readonly audit: AuditService,
  ) {}

  async listForMethod(
    paymentMethodId: string,
    includeInactive: boolean,
  ): Promise<AdminPaymentDestinationView[]> {
    await this.assertMethodExists(paymentMethodId);
    const rows = await this.destinations.listForMethod(paymentMethodId, !includeInactive);
    return rows.map(toAdminDestinationView);
  }

  async create(
    actorAdminId: string,
    paymentMethodId: string,
    dto: CreatePaymentDestinationDto,
  ): Promise<AdminPaymentDestinationView> {
    await this.assertMethodExists(paymentMethodId);
    const dailyCapMinor = toMinorOrNull(dto.dailyCap, 'dailyCap');

    const created = await this.prisma
      .runInTransaction(async (tx) => {
        const destination = await this.destinations.create(
          {
            paymentMethodId,
            label: dto.label,
            accountIdentifier: dto.accountIdentifier,
            accountHolder: dto.accountHolder ?? null,
            isActive: dto.isActive ?? true,
            priority: dto.priority ?? 0,
            dailyCapMinor,
            notes: dto.notes ?? null,
          },
          tx,
        );

        await this.audit.write(tx, {
          action: 'payment_destination.created',
          actor: adminActor(actorAdminId),
          subjectType: 'PaymentDestination',
          subjectId: destination.id,
          after: this.snapshot(destination),
        });

        return destination;
      })
      .catch((error: unknown) => {
        if (isUniqueConstraintError(error)) {
          throw new ConflictError(
            PaymentMethodErrorCodes.DESTINATION_ALREADY_EXISTS,
            'That account is already configured for this payment method.',
          );
        }
        throw error;
      });

    return toAdminDestinationView(created);
  }

  async update(
    actorAdminId: string,
    id: string,
    dto: UpdatePaymentDestinationDto,
  ): Promise<AdminPaymentDestinationView> {
    const dailyCapMinor = toMinorOrNull(dto.dailyCap, 'dailyCap');

    const updated = await this.prisma.runInTransaction(async (tx) => {
      const current = await this.destinations.findById(id, tx);
      if (current === null) {
        throw new NotFoundError(
          PaymentMethodErrorCodes.DESTINATION_NOT_FOUND,
          'That payment destination does not exist.',
        );
      }

      const destination = await this.destinations.update(
        id,
        {
          ...(dto.label !== undefined ? { label: dto.label } : {}),
          ...(dto.accountHolder !== undefined ? { accountHolder: dto.accountHolder } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
          ...(dto.dailyCap !== undefined ? { dailyCapMinor } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        },
        tx,
      );

      await this.audit.write(tx, {
        action: 'payment_destination.updated',
        actor: adminActor(actorAdminId),
        subjectType: 'PaymentDestination',
        subjectId: id,
        before: this.snapshot(current),
        after: this.snapshot(destination),
      });

      return destination;
    });

    return toAdminDestinationView(updated);
  }

  async deactivate(actorAdminId: string, id: string): Promise<AdminPaymentDestinationView> {
    return this.update(actorAdminId, id, { isActive: false });
  }

  async getOrThrow(id: string): Promise<PaymentDestination> {
    const destination = await this.destinations.findById(id);
    if (destination === null) {
      throw new NotFoundError(
        PaymentMethodErrorCodes.DESTINATION_NOT_FOUND,
        'That payment destination does not exist.',
      );
    }
    return destination;
  }

  private async assertMethodExists(paymentMethodId: string): Promise<void> {
    const method = await this.methods.findById(paymentMethodId);
    if (method === null) {
      throw new NotFoundError(
        PaymentMethodErrorCodes.PAYMENT_METHOD_NOT_FOUND,
        'That payment method does not exist.',
      );
    }
  }

  private snapshot(destination: PaymentDestination): Record<string, unknown> {
    return {
      label: destination.label,
      accountIdentifier: destination.accountIdentifier,
      accountHolder: destination.accountHolder,
      isActive: destination.isActive,
      priority: destination.priority,
      dailyCapMinor: destination.dailyCapMinor?.toString() ?? null,
      notes: destination.notes,
    };
  }
}
