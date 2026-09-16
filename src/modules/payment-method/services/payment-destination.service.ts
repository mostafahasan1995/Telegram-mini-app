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
import type { PaymentDestination, PaymentMethod } from '@prisma/client';

import { PrismaService } from '@core/prisma/prisma.service';
import { AuditService } from '@core/audit/audit.service';
import { isUniqueConstraintError } from '@core/prisma/prisma-errors';
import { requireEffectiveTenantId } from '@core/tenant';
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
    // Pinned lookup first: without it a foreign method id answered 200 [] where an unknown one
    // answered 404, which confirmed the id exists.
    await this.loadMethodOrThrow(requireEffectiveTenantId(), paymentMethodId);
    const rows = await this.destinations.listForMethod(paymentMethodId, !includeInactive);
    return rows.map(toAdminDestinationView);
  }

  async create(
    actorAdminId: string,
    paymentMethodId: string,
    dto: CreatePaymentDestinationDto,
  ): Promise<AdminPaymentDestinationView> {
    const tenantId = requireEffectiveTenantId();
    const method = await this.loadMethodOrThrow(tenantId, paymentMethodId);
    // Unreachable while the lookup above is pinned; kept so that a future change to it cannot turn
    // back into a write for another operator. Answered as a missing method, never as a distinct
    // error that would confirm the id.
    if (method.tenantId !== tenantId) throw this.methodNotFound();
    const dailyCapMinor = toMinorOrNull(dto.dailyCap, 'dailyCap');

    const created = await this.prisma
      .runInTransaction(async (tx) => {
        const destination = await this.destinations.create(
          {
            // From the CONTEXT, never copied off the method row. Copying it is exactly how one
            // operator's staff put their own wallet into another operator's rotation: the method
            // was fetched by bare id, both sides of the composite foreign key then named the victim,
            // and the database had nothing to object to.
            tenantId,
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
    // EFFECTIVE: a PLATFORM_ADMIN with X-Tenant-Id edits that operator's accounts; anyone else, and a
    // platform admin without the header, reaches only their own operator's.
    const tenantId = requireEffectiveTenantId();

    const updated = await this.prisma.runInTransaction(async (tx) => {
      const current = await this.destinations.findByIdInTenant(tenantId, id, tx);
      if (current === null) {
        throw new NotFoundError(
          PaymentMethodErrorCodes.DESTINATION_NOT_FOUND,
          'That payment destination does not exist.',
        );
      }

      const destination = await this.destinations.updateInTenant(
        tenantId,
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
    const destination = await this.destinations.findByIdInTenant(requireEffectiveTenantId(), id);
    if (destination === null) {
      throw new NotFoundError(
        PaymentMethodErrorCodes.DESTINATION_NOT_FOUND,
        'That payment destination does not exist.',
      );
    }
    return destination;
  }

  /**
   * Existence check, IN THE GIVEN OPERATOR. Another operator's method is a 404 with the same body as
   * an id that never existed (API-CONTRACT.md §5: another operator's id is a 404, not a leak).
   */
  private async loadMethodOrThrow(tenantId: string, paymentMethodId: string): Promise<PaymentMethod> {
    const method = await this.methods.findByIdInTenant(tenantId, paymentMethodId);
    if (method === null) throw this.methodNotFound();
    return method;
  }

  private methodNotFound(): NotFoundError {
    return new NotFoundError(
      PaymentMethodErrorCodes.PAYMENT_METHOD_NOT_FOUND,
      'That payment method does not exist.',
    );
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
