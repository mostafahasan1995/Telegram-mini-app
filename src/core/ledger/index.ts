/**
 * Public surface of the ledger. Import from `@core/ledger`, never from a file inside it — the
 * repository is intentionally NOT provided by LedgerModule, so LedgerService stays the only way to
 * write money and that fact is enforced by DI rather than by convention.
 */

// The writer
export { LedgerService, type PostWithRetryOptions } from './ledger.service';
export { LedgerModule } from './ledger.module';

// Accounts
export { AccountRegistryService } from './account-registry.service';
export {
  ACCOUNT_KIND_SPECS,
  casinoMirrorCode,
  houseCashCode,
  houseRoundingCode,
  ichancyAgentFloatCode,
  parseAccountCode,
  playerLiabilityCode,
  railClearingCode,
  satisfiesSignPolicy,
  suspenseUnidentifiedCode,
  type AccountKindSpec,
  type AccountScope,
  type ParsedAccountCode,
  type SignPolicy,
} from './account-codes';

// The four canonical postings
export {
  depositApproved,
  ichancyCredited,
  railSettled,
  reversal,
  type DepositApprovedInput,
  type IchancyCreditedInput,
  type RailSettledInput,
  type ReversalInput,
  type ReversibleTransaction,
} from './posting-rules';

// Types
export {
  BALANCE_SNAPSHOT_METADATA_KEY,
  LEDGER_IDEMPOTENCY_SCOPE,
  LEDGER_IDEMPOTENCY_TTL_DAYS,
  type EntryBalanceSnapshot,
  type LedgerAccountRef,
  type LedgerMetadata,
  type LedgerRefType,
  type LedgerTxRunner,
  type PostedEntry,
  type PostedTransaction,
  type Posting,
  type PostingEntry,
} from './ledger.types';

// Errors
export { LedgerError, isLedgerError, type LedgerErrorCode } from './ledger.errors';

// Validation (pure; useful for callers that want to check before opening a transaction)
export {
  assertEntryShape,
  assertValidPosting,
  assertZeroSum,
  netByAccountRef,
  MIN_POSTING_ENTRIES,
} from './posting-validation';

// Retry
export {
  isRetryableTransactionError,
  withSerializationRetry,
  type SerializationRetryOptions,
} from './serialization-retry.util';

// Invariants
export {
  InvariantsService,
  type LedgerInvariant,
  type LedgerInvariantReport,
  type LedgerInvariantViolation,
} from './invariants.service';
