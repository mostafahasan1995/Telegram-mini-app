import { SecretBoxError, deriveKey, openSecret, sealSecret, secretsEqual } from './secret-box.util';

const KEY = deriveKey('root-secret', 'test:v1');
const OTHER_KEY = deriveKey('root-secret', 'different-label:v1');

describe('secret-box', () => {
  it('round-trips a secret', () => {
    const sealed = sealSecret(KEY, 'hunter2-with-symbols-!@#');
    expect(openSecret(KEY, sealed)).toBe('hunter2-with-symbols-!@#');
  });

  it('produces a different ciphertext each time for the same plaintext', () => {
    // Otherwise the column would reveal which players share a derived secret.
    const a = sealSecret(KEY, 'same');
    const b = sealSecret(KEY, 'same');
    expect(a).not.toBe(b);
    expect(openSecret(KEY, a)).toBe(openSecret(KEY, b));
  });

  it('refuses a ciphertext encrypted under a different key', () => {
    const sealed = sealSecret(KEY, 'secret');
    expect(() => openSecret(OTHER_KEY, sealed)).toThrow(SecretBoxError);
  });

  it('detects tampering rather than returning a different password', () => {
    // This is the entire reason for GCM over CBC. A silently-altered password would be sent to
    // Ichancy and read as an outage instead of as corruption.
    const sealed = sealSecret(KEY, 'secret-value');
    const parts = sealed.split('.');
    const ciphertext = Buffer.from(parts[3] as string, 'base64url');
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
    parts[3] = ciphertext.toString('base64url');

    expect(() => openSecret(KEY, parts.join('.'))).toThrow(SecretBoxError);
  });

  it('rejects a truncated nonce instead of failing deep inside OpenSSL', () => {
    // Buffer.from(junk, 'base64url') does NOT throw — it returns a short buffer. Without the
    // explicit length checks this surfaced as an opaque OpenSSL error.
    const sealed = sealSecret(KEY, 'secret');
    const parts = sealed.split('.');
    parts[1] = Buffer.from([1, 2, 3]).toString('base64url');
    expect(() => openSecret(KEY, parts.join('.'))).toThrow(/nonce/i);
  });

  it('rejects a malformed envelope and an unknown version', () => {
    expect(() => openSecret(KEY, 'not-sealed')).toThrow(SecretBoxError);
    expect(() => openSecret(KEY, 'v2.aaa.bbb.ccc')).toThrow(/version/i);
  });

  it('derives independent keys per label', () => {
    expect(KEY.equals(OTHER_KEY)).toBe(false);
    expect(KEY).toHaveLength(32);
  });

  it('derives the same key for the same (secret, label)', () => {
    expect(deriveKey('root-secret', 'test:v1').equals(KEY)).toBe(true);
  });

  it('compares secrets without leaking length-independent timing', () => {
    expect(secretsEqual('abc', 'abc')).toBe(true);
    expect(secretsEqual('abc', 'abd')).toBe(false);
    expect(secretsEqual('abc', 'abcd')).toBe(false);
  });
});
