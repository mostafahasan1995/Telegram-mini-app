import { AppException, ValidationError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import {
  CALLBACK_DATA_MAX_BYTES,
  CallbackDataTooLongError,
  callbackDataBudget,
  decodeCallbackData,
  encodeCallbackData,
  isCallbackDataFor,
} from './callback-data.util';

describe('callback-data.util', () => {
  describe('encode / decode round trip', () => {
    it('round-trips a namespace, action and arguments', () => {
      const encoded = encodeCallbackData('dep', 'approve', 'K7Q2ZP9V3M');
      expect(encoded).toBe('dep:approve:K7Q2ZP9V3M');

      expect(decodeCallbackData(encoded)).toEqual({
        ns: 'dep',
        action: 'approve',
        args: ['K7Q2ZP9V3M'],
      });
    });

    it('supports several arguments and stringifies numbers', () => {
      const encoded = encodeCallbackData('dep', 'page', 'PENDING', 3);
      expect(decodeCallbackData(encoded)).toEqual({
        ns: 'dep',
        action: 'page',
        args: ['PENDING', '3'],
      });
    });

    it('round-trips with no arguments at all', () => {
      expect(decodeCallbackData(encodeCallbackData('menu', 'close'))).toEqual({
        ns: 'menu',
        action: 'close',
        args: [],
      });
    });

    it('preserves empty arguments positionally', () => {
      // A missing middle argument must not silently shift the ones after it.
      const encoded = encodeCallbackData('dep', 'filter', '', 'NEW');
      expect(decodeCallbackData(encoded)?.args).toEqual(['', 'NEW']);
    });
  });

  describe('the 64-byte limit', () => {
    it('accepts data at exactly 64 bytes', () => {
      const arg = 'A'.repeat(CALLBACK_DATA_MAX_BYTES - 'ns:act:'.length);
      const encoded = encodeCallbackData('ns', 'act', arg);
      expect(Buffer.byteLength(encoded, 'utf8')).toBe(CALLBACK_DATA_MAX_BYTES);
    });

    it('rejects data at 65 bytes', () => {
      const arg = 'A'.repeat(CALLBACK_DATA_MAX_BYTES - 'ns:act:'.length + 1);
      expect(() => encodeCallbackData('ns', 'act', arg)).toThrow(CallbackDataTooLongError);
    });

    it('counts BYTES not characters, so multi-byte arguments are measured correctly', () => {
      // 30 emoji = 30 chars but 120 bytes. A `.length` check would wave this straight through and
      // Telegram would reject the button at send time.
      const emoji = '✅'.repeat(30);
      expect(emoji.length).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
      expect(Buffer.byteLength(emoji, 'utf8')).toBeGreaterThan(CALLBACK_DATA_MAX_BYTES);
      expect(() => encodeCallbackData('ns', 'act', emoji)).toThrow(CallbackDataTooLongError);
    });

    it('reports the offending size in a client-safe error', () => {
      try {
        encodeCallbackData('ns', 'act', 'B'.repeat(100));
        throw new Error('expected encodeCallbackData to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(AppException);
        expect((error as AppException).errorCode).toBe(CommonErrorCodes.CALLBACK_DATA_TOO_LONG);
      }
    });

    it('decodes null for oversized data rather than trusting it', () => {
      expect(decodeCallbackData(`ns:act:${'C'.repeat(100)}`)).toBeNull();
    });
  });

  describe('separator handling', () => {
    it('refuses a separator inside the namespace', () => {
      expect(() => encodeCallbackData('de:p', 'approve')).toThrow(ValidationError);
    });

    it('refuses a separator inside the action', () => {
      expect(() => encodeCallbackData('dep', 'app:rove')).toThrow(ValidationError);
    });

    it('refuses a separator inside an argument, which would forge extra arguments', () => {
      expect(() => encodeCallbackData('dep', 'approve', 'a:b')).toThrow(ValidationError);
    });

    it('refuses an empty namespace or action', () => {
      expect(() => encodeCallbackData('', 'approve')).toThrow(ValidationError);
      expect(() => encodeCallbackData('dep', '')).toThrow(ValidationError);
    });
  });

  describe('decoding untrusted input', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['empty string', ''],
      ['no action', 'dep'],
      ['empty action', 'dep:'],
      ['empty namespace', ':approve'],
    ])('returns null for %s instead of throwing', (_label, input) => {
      expect(decodeCallbackData(input)).toBeNull();
    });

    it('never throws on arbitrary junk from an old button', () => {
      expect(() => decodeCallbackData('🙂🙃 not our format at all')).not.toThrow();
    });
  });

  describe('helpers', () => {
    it('isCallbackDataFor matches only its own namespace', () => {
      const encoded = encodeCallbackData('dep', 'approve', 'X');
      expect(isCallbackDataFor(encoded, 'dep')).toBe(true);
      expect(isCallbackDataFor(encoded, 'wd')).toBe(false);
      expect(isCallbackDataFor('garbage', 'dep')).toBe(false);
    });

    it('callbackDataBudget reports the bytes left for arguments', () => {
      // 'dep:approve:' is 12 bytes, so 52 remain — enough for a shortId, not for two uuids.
      expect(callbackDataBudget('dep', 'approve')).toBe(CALLBACK_DATA_MAX_BYTES - 12);

      const budget = callbackDataBudget('dep', 'approve');
      expect(() => encodeCallbackData('dep', 'approve', 'D'.repeat(budget))).not.toThrow();
      expect(() => encodeCallbackData('dep', 'approve', 'D'.repeat(budget + 1))).toThrow();
    });
  });
});
