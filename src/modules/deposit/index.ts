/**
 * Public surface of the deposit module. The root module wires DepositModule (api) or
 * DepositModule.forWorker() (worker) and registers DepositOutboxHandler under OUTBOX_HANDLERS.
 */
export * from './deposit.module';
export * from './deposit.constants';
export * from './deposit-state.machine';
export * from './enums/deposit-error-code.enum';
export * from './enums/risk-flag.enum';
export * from './outbox/deposit-outbox.handler';
export * from './services/deposit.service';
export * from './services/deposit-review.service';
export * from './services/deposit-credit.service';
export * from './services/deposit-retry.service';
export * from './services/deposit-policy.service';
export * from './services/deposit-notify.service';
export * from './services/deposit-expiry.cron';
export * from './services/deposit-sweep.service';
export * from './services/proof-duplicate.service';
export * from './ports';
export * from './services/proof-ingest.service';
export * from './repositories/deposit.repository';
export * from './utils/deposit-filter.util';
export * from './dtos/deposit.view';
