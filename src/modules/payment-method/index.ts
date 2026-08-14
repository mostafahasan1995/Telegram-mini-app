/**
 * Import surface for the root module. Feature modules must not import from here — cross-module
 * needs go through PAYMENT_METHOD_PORT.
 */
export * from './payment-method.module';
export * from './payment-method.constants';
export * from './payment-method.port';
export * from './rails/rail.interface';
export * from './rails/driver-registry';
export * from './rails/manual-rail.driver';
export * from './rails/bank-transfer.driver';
export * from './rails/ewallet.driver';
export * from './rails/cash-agent.driver';
export * from './rails/crypto-manual.driver';
export * from './dtos/payment-method.dto';
export * from './dtos/payment-destination.dto';
export * from './services/payment-method.service';
export * from './services/payment-destination.service';
export * from './services/destination-picker.service';
export * from './services/payment-gateway.service';
export * from './repositories/payment-method.repository';
export * from './repositories/payment-destination.repository';
