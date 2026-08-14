/**
 * The one surface the deposit flow talks to, published as PAYMENT_METHOD_PORT.
 *
 * WHY a facade rather than exporting the three services: a consumer that wires up
 * PaymentMethodService + DestinationPickerService + RailDriverRegistry itself has to know the
 * ORDER of operations — resolve the method, then pick the destination, then validate against the
 * driver for that rail. Getting that order wrong (validating before a destination exists, or
 * validating against the wrong driver) produces a deposit that looks fine and cannot be paid. One
 * object with four verbs makes the sequence unmistakable.
 */
import { Injectable } from '@nestjs/common';
import type { PaymentDestination, PaymentMethod } from '@prisma/client';

import { PaymentMethodService } from './payment-method.service';
import { PaymentDestinationService } from './payment-destination.service';
import { DestinationPickerService } from './destination-picker.service';
import { RailDriverRegistry } from '../rails/driver-registry';
import type { RailDestinationInfo } from '../rails/rail.interface';
import type {
  PaymentMethodPort,
  ResolvedDestination,
  ResolvedPaymentMethod,
  SubmissionCheck,
  SubmissionCheckInput,
} from '../payment-method.port';

@Injectable()
export class PaymentGatewayService implements PaymentMethodPort {
  constructor(
    private readonly methods: PaymentMethodService,
    private readonly destinations: PaymentDestinationService,
    private readonly picker: DestinationPickerService,
    private readonly drivers: RailDriverRegistry,
  ) {}

  async getActiveByCode(code: string): Promise<ResolvedPaymentMethod> {
    return this.toResolved(await this.methods.getActiveByCode(code));
  }

  async getActiveById(id: string): Promise<ResolvedPaymentMethod> {
    return this.toResolved(await this.methods.getActiveById(id));
  }

  async pickDestination(paymentMethodId: string, playerId: string): Promise<ResolvedDestination> {
    const destination = await this.picker.pickFor(paymentMethodId, playerId);
    return this.toResolvedDestination(destination);
  }

  async checkSubmission(input: SubmissionCheckInput): Promise<SubmissionCheck> {
    // FAIL CLOSED on the stage: only a literal 'CREATE' selects the permissive question, so a value
    // that reached this port from a JSON boundary cannot switch the evidence gate off.
    const stage = input.stage === 'CREATE' ? 'CREATE' : 'SUBMIT';

    // WHICH lookup, and why it depends on the stage: resolving the method here is about which RULES
    // apply, not about whether the rail is open for business. Opening a new intent needs an active
    // method (`getActiveById`, which DepositService.create also calls before this). Proving a
    // deposit that ALREADY EXISTS must not: the player has sent real money, and an admin retiring
    // the rail afterwards would otherwise make the receipt unattachable and strand the payment.
    const method =
      stage === 'CREATE'
        ? await this.methods.getActiveById(input.paymentMethodId)
        : await this.methods.getOrThrow(input.paymentMethodId);
    const driver = this.drivers.get(method.rail);

    const destination =
      input.destinationId === null
        ? null
        : this.toRailDestination(await this.destinations.getOrThrow(input.destinationId));

    const result = driver.validateSubmission({
      method: this.methods.toRailConfig(method),
      destination,
      amountMinor: input.amountMinor,
      externalReference: input.externalReference ?? null,
      senderAccount: input.senderAccount ?? null,
      proofCount: input.proofCount,
      // Resolved above rather than passed through as undefined so the strict default is visible at
      // the boundary a caller actually reads, not only inside the driver.
      stage,
    });

    return result.ok ? { ok: true } : { ok: false, issues: result.issues };
  }

  async renderInstructions(
    paymentMethodId: string,
    destinationId: string | null,
    amountMinor: bigint,
    shortId: string,
  ): Promise<string> {
    const method = await this.methods.getActiveById(paymentMethodId);
    const driver = this.drivers.get(method.rail);

    const destination =
      destinationId === null
        ? null
        : this.toRailDestination(await this.destinations.getOrThrow(destinationId));

    return driver.renderInstructions({
      method: this.methods.toRailConfig(method),
      destination,
      amountMinor,
      shortId,
    });
  }

  private toResolved(method: PaymentMethod): ResolvedPaymentMethod {
    return {
      id: method.id,
      code: method.code,
      displayName: method.displayName,
      rail: method.rail,
      currencyCode: method.currencyCode,
      verificationMode: method.verificationMode,
      minAmountMinor: method.minAmountMinor,
      maxAmountMinor: method.maxAmountMinor,
      feeFixedMinor: method.feeFixedMinor,
      feeBps: method.feeBps,
      requiresReference: method.requiresReference,
      isActive: method.isActive,
    };
  }

  private toResolvedDestination(destination: PaymentDestination): ResolvedDestination {
    return {
      id: destination.id,
      label: destination.label,
      accountIdentifier: destination.accountIdentifier,
      accountHolder: destination.accountHolder,
      notes: destination.notes,
    };
  }

  private toRailDestination(destination: PaymentDestination): RailDestinationInfo {
    return {
      label: destination.label,
      accountIdentifier: destination.accountIdentifier,
      accountHolder: destination.accountHolder,
      notes: destination.notes,
    };
  }
}
