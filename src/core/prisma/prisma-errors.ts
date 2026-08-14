/**
 * WHY: a `P2002` leaking into a service (or worse, into an HTTP response) forces every caller to
 * know Prisma's error codes and to guess which column collided. These classes are the translation
 * layer: stable string codes, the offending fields, the SQLSTATE, and the original error kept as
 * `cause`. Error CODES are stable API; error MESSAGES are for humans and may change.
 *
 * VERIFIED AGAINST THE REAL STACK (Prisma 7 + @prisma/adapter-pg + PG17), because the shape is not
 * what the Prisma docs describe. With a driver adapter there is NO `meta.target` and NO
 * `meta.field_name`; the detail lives in
 *     meta.driverAdapterError.cause.constraint = { fields: ['code'] }        // P2002
 *     meta.driverAdapterError.cause.constraint = { index: 'players_..._fkey' } // P2003
 *     meta.driverAdapterError.cause.originalCode = '23505'
 * The legacy locations are still read first so this keeps working if Prisma changes back.
 *
 * One deliberate exception: a serialization failure / deadlock is NOT translated. It has to stay
 * recognisable so `withSerializationRetry` can retry the transaction — wrapping it would turn a
 * retryable race into a permanent failure.
 */
import { isSerializationError } from './retry.util';

export const RepositoryErrorCodes = {
  UNIQUE_CONSTRAINT: 'UNIQUE_CONSTRAINT',
  RECORD_NOT_FOUND: 'RECORD_NOT_FOUND',
  FOREIGN_KEY_CONSTRAINT: 'FOREIGN_KEY_CONSTRAINT',
} as const;

export type RepositoryErrorCode = (typeof RepositoryErrorCodes)[keyof typeof RepositoryErrorCodes];

export interface RepositoryErrorContext {
  /** Prisma model, e.g. "DepositRequest". */
  model?: string;
  /** Repository operation, e.g. "findUnique". */
  operation?: string;
}

interface ConstraintDetails {
  /** Column/field names when the driver reported them. */
  fields?: readonly string[];
  /** Index or constraint name, e.g. "deposit_requests_short_id_key". */
  constraint?: string;
  /** SQLSTATE, e.g. "23505". */
  sqlState?: string;
}

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode;
  readonly model: string | undefined;
  readonly operation: string | undefined;
  /** The database's own constraint/index name — the only reliable key for a targeted catch. */
  readonly constraint: string | undefined;
  readonly sqlState: string | undefined;

  constructor(
    code: RepositoryErrorCode,
    message: string,
    context: RepositoryErrorContext = {},
    details: ConstraintDetails = {},
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
    this.model = context.model;
    this.operation = context.operation;
    this.constraint = details.constraint;
    this.sqlState = details.sqlState;
  }
}

/** P2002 / SQLSTATE 23505 — a unique index refused the write. */
export class UniqueConstraintError extends RepositoryError {
  readonly fields: readonly string[];

  constructor(
    details: ConstraintDetails = {},
    context: RepositoryErrorContext = {},
    cause?: unknown,
  ) {
    const fields = details.fields ?? [];
    super(
      RepositoryErrorCodes.UNIQUE_CONSTRAINT,
      `Unique constraint violated on ${context.model ?? 'record'}${
        fields.length > 0
          ? ` (${fields.join(', ')})`
          : details.constraint !== undefined
            ? ` (${details.constraint})`
            : ''
      }`,
      context,
      details,
      cause,
    );
    this.fields = fields;
  }
}

/** P2025 — an update/delete/connect matched nothing. */
export class RecordNotFoundError extends RepositoryError {
  constructor(context: RepositoryErrorContext = {}, cause?: unknown) {
    super(
      RepositoryErrorCodes.RECORD_NOT_FOUND,
      `${context.model ?? 'Record'} not found`,
      context,
      {},
      cause,
    );
  }
}

/** P2003 / SQLSTATE 23503 — a foreign key pointed at a row that does not exist. */
export class ForeignKeyConstraintError extends RepositoryError {
  /** Field name when the driver gave one, otherwise the constraint name. */
  readonly field: string | undefined;

  constructor(
    details: ConstraintDetails = {},
    context: RepositoryErrorContext = {},
    cause?: unknown,
  ) {
    const field = details.fields?.[0] ?? details.constraint;
    super(
      RepositoryErrorCodes.FOREIGN_KEY_CONSTRAINT,
      `Foreign key constraint violated on ${context.model ?? 'record'}${
        field !== undefined ? ` (${field})` : ''
      }`,
      context,
      details,
      cause,
    );
    this.field = field;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

function asStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === 'string');
  return strings.length > 0 ? strings : undefined;
}

interface KnownRequestErrorShape {
  code: string;
  meta: Record<string, unknown> | undefined;
}

/**
 * Duck-typed rather than `instanceof PrismaClientKnownRequestError`: with driver adapters the error
 * can be created by a different copy of the runtime, and instanceof across module instances is a
 * classic source of "impossible" production bugs.
 */
function asKnownRequestError(error: unknown): KnownRequestErrorShape | null {
  if (!isRecord(error)) return null;
  const code = error.code;
  if (typeof code !== 'string' || !/^P\d{4}$/.test(code)) return null;
  return { code, meta: isRecord(error.meta) ? error.meta : undefined };
}

/** Pulls the constraint detail out of whichever place this Prisma version decided to put it. */
export function extractConstraintDetails(
  meta: Record<string, unknown> | undefined,
): ConstraintDetails {
  if (meta === undefined) return {};

  // Legacy (query-engine) locations.
  const legacyFields =
    asStringArray(meta.target) ??
    (asString(meta.target) !== undefined ? [asString(meta.target) as string] : undefined) ??
    (asString(meta.field_name) !== undefined ? [asString(meta.field_name) as string] : undefined);

  const adapterCause = isRecord(meta.driverAdapterError)
    ? isRecord(meta.driverAdapterError.cause)
      ? meta.driverAdapterError.cause
      : undefined
    : undefined;
  const constraintNode =
    adapterCause !== undefined && isRecord(adapterCause.constraint)
      ? adapterCause.constraint
      : undefined;

  const fields = asStringArray(constraintNode?.fields) ?? legacyFields;
  const constraint =
    asString(constraintNode?.index) ??
    asString(constraintNode?.constraint) ??
    asString(meta.constraint);
  const sqlState = asString(adapterCause?.originalCode);

  return {
    ...(fields !== undefined ? { fields } : {}),
    ...(constraint !== undefined ? { constraint } : {}),
    ...(sqlState !== undefined ? { sqlState } : {}),
  };
}

/**
 * Translates a Prisma error into ours. Anything we do not recognise is returned UNCHANGED, so an
 * unexpected failure keeps its stack and its Prisma code instead of being flattened into a generic
 * "database error".
 */
export function mapPrismaError(error: unknown, context: RepositoryErrorContext = {}): unknown {
  // Must stay retryable — see the header.
  if (isSerializationError(error)) return error;

  const known = asKnownRequestError(error);
  if (known === null) return error;

  const details = extractConstraintDetails(known.meta);
  const resolved: RepositoryErrorContext = {
    model: context.model ?? asString(known.meta?.modelName),
    operation: context.operation,
  };

  switch (known.code) {
    case 'P2002':
      return new UniqueConstraintError(details, resolved, error);
    case 'P2025':
      return new RecordNotFoundError(resolved, error);
    case 'P2003':
      return new ForeignKeyConstraintError(details, resolved, error);
    default:
      return error;
  }
}

export const isUniqueConstraintError = (error: unknown): error is UniqueConstraintError =>
  error instanceof UniqueConstraintError;

export const isRecordNotFoundError = (error: unknown): error is RecordNotFoundError =>
  error instanceof RecordNotFoundError;

export const isForeignKeyConstraintError = (error: unknown): error is ForeignKeyConstraintError =>
  error instanceof ForeignKeyConstraintError;
