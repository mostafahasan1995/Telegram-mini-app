/**
 * WHY the "without the global patch" test: bigint-json installs BigInt.prototype.toJSON as a
 * side effect of importing main.ts. Jest loads it as a setup file, so a spec that only asserts
 * "money serializes" would pass even if this module had no bigint handling of its own — and then
 * break in a worker whose entrypoint forgot the import. The test removes the patch to prove the
 * replacer stands on its own.
 */
import { Prisma } from '@prisma/client';

import {
  JsonEncodingError,
  fromDbJson,
  fromDbJsonObject,
  isJsonObject,
  stableStringify,
  toJsonObject,
  toJsonValue,
  toNullableJson,
} from './json.util';

describe('toJsonObject', () => {
  it('renders money as a decimal string, never a float', () => {
    expect(toJsonObject({ amountMinor: 9007199254740993n })).toEqual({
      amountMinor: '9007199254740993',
    });
  });

  it('handles bigints with no help from BigInt.prototype.toJSON', () => {
    const patch = Object.getOwnPropertyDescriptor(BigInt.prototype, 'toJSON');
    expect(patch).toBeDefined();
    delete (BigInt.prototype as { toJSON?: unknown }).toJSON;
    try {
      expect(toJsonObject({ amountMinor: 1234n })).toEqual({ amountMinor: '1234' });
    } finally {
      if (patch) Object.defineProperty(BigInt.prototype, 'toJSON', patch);
    }
  });

  it('normalizes what the wire would normalize anyway', () => {
    expect(
      toJsonObject({
        at: new Date('2026-08-12T10:00:00.000Z'),
        missing: undefined,
        nested: { keep: 1 },
      }),
    ).toEqual({ at: '2026-08-12T10:00:00.000Z', nested: { keep: 1 } });
  });

  it('refuses anything that is not an object', () => {
    expect(() => toJsonObject(['a'])).toThrow(JsonEncodingError);
    expect(() => toJsonObject('a')).toThrow(JsonEncodingError);
    try {
      toJsonObject(null);
    } catch (error) {
      expect((error as JsonEncodingError).code).toBe('JSON_NOT_AN_OBJECT');
    }
  });

  it('reports a circular payload with a stable code instead of a TypeError', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    try {
      toJsonObject(circular);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(JsonEncodingError);
      expect((error as JsonEncodingError).code).toBe('JSON_NOT_ENCODABLE');
    }
  });
});

describe('toJsonValue', () => {
  it('accepts scalars and arrays for a NOT NULL column', () => {
    expect(toJsonValue(['a', 1, true])).toEqual(['a', 1, true]);
    expect(toJsonValue('x')).toBe('x');
  });

  it('refuses to invent a value for a required column', () => {
    expect(() => toJsonValue(undefined)).toThrow(JsonEncodingError);
    expect(() => toJsonValue(null)).toThrow(JsonEncodingError);
  });
});

describe('toNullableJson', () => {
  it('writes SQL NULL, not JSON null, when there is nothing to record', () => {
    // The difference is readable in the audit trail: DbNull means "no snapshot was taken",
    // JsonNull would mean "the snapshot was the value null".
    expect(toNullableJson(undefined)).toBe(Prisma.DbNull);
    expect(toNullableJson(null)).toBe(Prisma.DbNull);
  });

  it('passes a real snapshot through unchanged', () => {
    expect(toNullableJson({ status: 'APPROVED' })).toEqual({ status: 'APPROVED' });
  });
});

describe('fromDbJson', () => {
  it('collapses both flavours of absent to null', () => {
    expect(fromDbJson(null)).toBeNull();
    expect(fromDbJson(undefined)).toBeNull();
  });

  it('gives a usable object, or an empty one, for payload columns', () => {
    expect(fromDbJsonObject({ a: 1 })).toEqual({ a: 1 });
    expect(fromDbJsonObject(null)).toEqual({});
    expect(fromDbJsonObject('not an object')).toEqual({});
  });
});

describe('isJsonObject', () => {
  it('does not mistake an array or null for an object', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
  });
});

describe('stableStringify', () => {
  it('ignores key order at every depth, so a reordered retry hashes the same', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it('preserves array order, which is meaningful', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('separates different values', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: '1' }));
  });

  it('survives undefined and bigint inputs', () => {
    expect(stableStringify(undefined)).toBe('null');
    expect(stableStringify({ amountMinor: 5n })).toBe('{"amountMinor":"5"}');
  });
});
