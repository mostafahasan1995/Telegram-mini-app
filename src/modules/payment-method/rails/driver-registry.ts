/**
 * WHY a registry built from injected drivers rather than a static object literal: the drivers are
 * Nest providers, so a future driver that needs a config value or an HTTP client (the first one to
 * gain real auto-verification will) is a constructor change and nothing else.
 *
 * WHY the duplicate-key assertion is in the constructor: two drivers claiming the same PaymentRail
 * is a wiring mistake whose only symptom would be "deposits on that rail sometimes use the other
 * driver's rules", depending on provider order. Failing at boot is the only humane place to find it.
 *
 * WHY INTERNAL has no driver, on purpose: that rail is for corrections and float top-ups that never
 * touched a payment network. There is no player, no receipt and no instruction to render — asking
 * for its driver is a bug, and `get()` says so instead of returning something that pretends.
 */
import { Injectable } from '@nestjs/common';
import type { PaymentRail } from '@prisma/client';

import { BusinessRuleError } from '@common/exceptions/app.exception';

import { PaymentMethodErrorCodes } from '../payment-method.constants';
import { BankTransferDriver } from './bank-transfer.driver';
import { CashAgentDriver } from './cash-agent.driver';
import { CryptoManualDriver } from './crypto-manual.driver';
import { EwalletDriver } from './ewallet.driver';
import type { RailDriver } from './rail.interface';

@Injectable()
export class RailDriverRegistry {
  private readonly drivers: ReadonlyMap<PaymentRail, RailDriver>;

  constructor(
    bankTransfer: BankTransferDriver,
    ewallet: EwalletDriver,
    cashAgent: CashAgentDriver,
    cryptoManual: CryptoManualDriver,
  ) {
    const registered: RailDriver[] = [bankTransfer, ewallet, cashAgent, cryptoManual];
    const map = new Map<PaymentRail, RailDriver>();

    for (const driver of registered) {
      const existing = map.get(driver.key);
      if (existing !== undefined) {
        throw new Error(
          `Two rail drivers claim "${driver.key}": ${existing.constructor.name} and ${driver.constructor.name}`,
        );
      }
      map.set(driver.key, driver);
    }

    this.drivers = map;
  }

  /** Undefined for a rail nobody implements — including INTERNAL, by design. */
  find(rail: PaymentRail): RailDriver | undefined {
    return this.drivers.get(rail);
  }

  /** Throws a 422 rather than letting `undefined.validateSubmission` surface as a 500. */
  get(rail: PaymentRail): RailDriver {
    const driver = this.find(rail);
    if (driver === undefined) {
      throw new BusinessRuleError(
        PaymentMethodErrorCodes.RAIL_NOT_SUPPORTED,
        'This payment method is not available.',
        { rail },
      );
    }
    return driver;
  }

  supportedRails(): PaymentRail[] {
    return [...this.drivers.keys()];
  }
}
