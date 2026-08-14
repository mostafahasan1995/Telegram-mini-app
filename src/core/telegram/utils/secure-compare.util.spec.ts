import { secureCompare } from './secure-compare.util';

describe('secureCompare', () => {
  it('accepts identical strings', () => {
    expect(secureCompare('s3cret-token', 's3cret-token')).toBe(true);
  });

  it('rejects different strings of the same length', () => {
    expect(secureCompare('s3cret-token', 's3cret-tokeX')).toBe(false);
  });

  it('rejects strings of different lengths without throwing', () => {
    // The naive implementation calls timingSafeEqual on unequal buffers, which THROWS. Hashing
    // first is what makes this total.
    expect(() => secureCompare('short', 'a-much-longer-secret')).not.toThrow();
    expect(secureCompare('short', 'a-much-longer-secret')).toBe(false);
  });

  it('rejects a missing header rather than treating it as a match', () => {
    expect(secureCompare(undefined, 'secret')).toBe(false);
    expect(secureCompare(null, 'secret')).toBe(false);
    expect(secureCompare('secret', undefined)).toBe(false);
  });

  it('rejects the empty string against a real secret', () => {
    expect(secureCompare('', 'secret')).toBe(false);
  });

  it('is case- and whitespace-sensitive', () => {
    expect(secureCompare('Secret', 'secret')).toBe(false);
    expect(secureCompare('secret ', 'secret')).toBe(false);
  });

  it('handles non-ASCII secrets', () => {
    expect(secureCompare('sécret-✅', 'sécret-✅')).toBe(true);
    expect(secureCompare('sécret-✅', 'secret-✅')).toBe(false);
  });
});
