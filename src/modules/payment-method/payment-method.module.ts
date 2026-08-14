/**
 * WHY no `imports`: everything this module needs — PrismaService, RedisService, AuditService — comes
 * from @Global core modules. The rail drivers are plain providers with no dependencies of their own
 * yet; the first one to need config or HTTP simply gains a constructor.
 *
 * PAYMENT_METHOD_PORT is the cross-module surface (see payment-method.port.ts): the deposit flow
 * cannot import this module, so it injects the string token instead.
 */
import { Module } from '@nestjs/common';

import { AdminPaymentMethodController } from './controllers/admin-payment-method.controller';
import { PaymentMethodController } from './controllers/payment-method.controller';
import { PaymentDestinationRepository } from './repositories/payment-destination.repository';
import { PaymentMethodRepository } from './repositories/payment-method.repository';
import { BankTransferDriver } from './rails/bank-transfer.driver';
import { CashAgentDriver } from './rails/cash-agent.driver';
import { CryptoManualDriver } from './rails/crypto-manual.driver';
import { EwalletDriver } from './rails/ewallet.driver';
import { RailDriverRegistry } from './rails/driver-registry';
import { DestinationPickerService } from './services/destination-picker.service';
import { PaymentDestinationService } from './services/payment-destination.service';
import { PaymentGatewayService } from './services/payment-gateway.service';
import { PaymentMethodService } from './services/payment-method.service';
import { PAYMENT_METHOD_PORT } from './payment-method.port';

@Module({
  controllers: [PaymentMethodController, AdminPaymentMethodController],
  providers: [
    PaymentMethodRepository,
    PaymentDestinationRepository,
    BankTransferDriver,
    EwalletDriver,
    CashAgentDriver,
    CryptoManualDriver,
    RailDriverRegistry,
    PaymentMethodService,
    PaymentDestinationService,
    DestinationPickerService,
    PaymentGatewayService,
    { provide: PAYMENT_METHOD_PORT, useExisting: PaymentGatewayService },
  ],
  exports: [
    PAYMENT_METHOD_PORT,
    PaymentGatewayService,
    PaymentMethodService,
    PaymentDestinationService,
    DestinationPickerService,
    RailDriverRegistry,
  ],
})
export class PaymentMethodModule {}
