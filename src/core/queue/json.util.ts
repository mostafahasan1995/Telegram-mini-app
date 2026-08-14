/**
 * WHY: four different tables in this system store a JavaScript value as JSON — a BullMQ job payload,
 * `outbox_messages.payload`, a cached idempotent response, and an audit before/after snapshot. All
 * four hit the same two traps, so the encoding lives in exactly one place and cannot drift:
 *
 *  1. Money is `bigint`, and `JSON.stringify(1n)` throws. @common/helpers/bigint-json patches
 *     BigInt.prototype.toJSON at process start, but nothing here may DEPEND on that global side
 *     effect — a worker that forgot the import would start throwing at the outbox instead of at
 *     boot. The replacer below converts bigint -> decimal string whether or not the patch ran.
 *  2. Prisma's Json input rejects `undefined` and distinguishes SQL NULL (`Prisma.DbNull`) from the
 *     JSON value null (`Prisma.JsonNull`). Getting that wrong turns "there was no before-snapshot"
 *     into "the before-snapshot was literally null", which is a different claim in an audit trail.
 *
 * It sits next to the queue types because those are its first consumer; outbox, idempotency and
 * audit all import it.
 */
import { Prisma } from '@prisma/client';

export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export type JsonEncodingErrorCode = 'JSON_NOT_ENCODABLE' | 'JSON_NOT_AN_OBJECT';

/** Stable code, never a translated message — same rule as MoneyError. */
export class JsonEncodingError extends Error {
  constructor(
    readonly code: JsonEncodingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'JsonEncodingError';
  }
}

/**
 * `toJSON()` runs before a replacer, so when bigint-json is loaded this sees a string already and
 * does nothing; when it is not loaded, this is what keeps money out of the "cannot serialize" path.
 */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Round-trips through JSON so what we store is byte-identical to what an HTTP client would receive:
 * Dates become ISO strings, bigints become decimal strings, `undefined` members disappear.
 * Returns `undefined` only when the whole value is not representable (undefined / a function).
 */
function encode(value: unknown): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(value, bigintReplacer);
  } catch (cause) {
    throw new JsonEncodingError(
      'JSON_NOT_ENCODABLE',
      `Value cannot be encoded as JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (text === undefined) return undefined;
  return JSON.parse(text);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** For NOT NULL Json columns. Throws rather than inventing a value when there is nothing to store. */
export function toJsonValue(value: unknown): Prisma.InputJsonValue {
  const encoded = encode(value);
  if (encoded === undefined || encoded === null) {
    throw new JsonEncodingError(
      'JSON_NOT_ENCODABLE',
      'A required JSON column cannot be written from undefined/null',
    );
  }
  return encoded;
}

/** Same, but refuses anything that is not a JSON object — payloads and snapshots are always objects. */
export function toJsonObject(value: unknown): Prisma.InputJsonObject {
  const encoded = encode(value);
  if (!isJsonObject(encoded)) {
    throw new JsonEncodingError(
      'JSON_NOT_AN_OBJECT',
      `Expected a JSON object, got ${encoded === null ? 'null' : typeof encoded}`,
    );
  }
  return encoded;
}

/**
 * For nullable Json columns. Absent values become SQL NULL (`DbNull`), never JSON null, so
 * `WHERE before IS NULL` means "no snapshot was taken" and nothing else.
 */
export function toNullableJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  const encoded = encode(value);
  if (encoded === undefined || encoded === null) return Prisma.DbNull;
  return encoded;
}

/**
 * Reading direction: Prisma hands back `Prisma.JsonValue`, whose object members are nullable in a
 * way our JsonValue is not. This is the single sanctioned narrowing point.
 */
export function fromDbJson(value: Prisma.JsonValue | null | undefined): JsonValue | null {
  if (value === undefined || value === null) return null;
  return value as JsonValue;
}

/** Same, but for the columns we know we wrote with toJsonObject. */
export function fromDbJsonObject(value: Prisma.JsonValue | null | undefined): JsonObject {
  const narrowed = fromDbJson(value);
  return isJsonObject(narrowed) ? narrowed : {};
}

/**
 * Deterministic serialization: object keys sorted at every depth, so two structurally equal request
 * bodies hash to the same digest regardless of the order the client happened to send them in.
 * Only used for hashing — never for storage.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(encode(value) ?? null));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!isJsonObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortDeep(value[key]);
  }
  return out;
}
