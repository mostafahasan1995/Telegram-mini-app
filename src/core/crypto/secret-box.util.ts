/**
 * WHY this exists: `players.ichancy_password_enc` is documented as "Encrypted at rest; never leaves
 * the backend". A column named `_enc` holding plaintext is worse than an honestly-named plaintext
 * column, because everyone downstream assumes it is safe.
 *
 * AES-256-GCM, not AES-CBC: we need to detect tampering. Without an authentication tag, a flipped
 * ciphertext byte decrypts to a different password and we would send THAT to Ichancy, producing an
 * authentication failure that looks like an upstream outage. GCM turns that into a clean throw.
 *
 * The nonce is random per encryption, so the same password does not produce the same ciphertext
 * twice — otherwise the column would leak which players share a derived secret.
 */
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Version prefix so the format can be rotated without guessing what an old row contains. */
const FORMAT_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
/** 96 bits is the GCM-recommended nonce size; anything else forces a slower internal derivation. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

/**
 * Derives a 256-bit key from a root secret and a label.
 *
 * HKDF rather than a bare sha256 of `secret + label`: the labels are what keep the encryption key,
 * the login-derivation key and the password-derivation key independent. A naive concatenation is
 * vulnerable to length-extension and to label collisions ("ab"+"c" === "a"+"bc"); HKDF's Extract
 * step is defined to produce independent keys per `info`.
 */
export function deriveKey(rootSecret: string, info: string): Buffer {
  // A fixed salt is correct here: the root secret is already high-entropy, and a random salt would
  // have to be stored alongside every derivation for it to be reproducible.
  const salt = Buffer.from('ichancy-cashier/hkdf/v1');
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(rootSecret, 'utf8'), salt, Buffer.from(info, 'utf8'), KEY_BYTES),
  );
}

/** `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function sealSecret(key: Buffer, plaintext: string): string {
  if (key.length !== KEY_BYTES) {
    throw new SecretBoxError(`Encryption key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    FORMAT_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** Throws rather than returning null: a password we cannot decrypt must never degrade to "". */
export function openSecret(key: Buffer, sealed: string): string {
  if (key.length !== KEY_BYTES) {
    throw new SecretBoxError(`Encryption key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }

  const parts = sealed.split('.');
  if (parts.length !== 4) {
    throw new SecretBoxError('Sealed secret is malformed (expected 4 dot-separated segments)');
  }
  const [version, ivRaw, tagRaw, ciphertextRaw] = parts;
  if (version !== FORMAT_VERSION) {
    throw new SecretBoxError(`Unsupported sealed-secret version "${String(version)}"`);
  }
  if (ivRaw === undefined || tagRaw === undefined || ciphertextRaw === undefined) {
    throw new SecretBoxError('Sealed secret is malformed');
  }

  const iv = Buffer.from(ivRaw, 'base64url');
  const tag = Buffer.from(tagRaw, 'base64url');
  const ciphertext = Buffer.from(ciphertextRaw, 'base64url');

  // Buffer.from(..., 'base64url') never throws on junk — it silently returns a SHORT buffer. Both
  // lengths therefore have to be asserted, or createDecipheriv would throw a confusing OpenSSL
  // error for what is really a corrupted row.
  if (iv.length !== IV_BYTES) throw new SecretBoxError('Sealed secret has a malformed nonce');
  if (tag.length !== TAG_BYTES) throw new SecretBoxError('Sealed secret has a malformed auth tag');

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // The tag check failed: the row was tampered with, or the root secret changed.
    throw new SecretBoxError('Sealed secret failed authentication (wrong key or tampered value)');
  }
}

/** Constant-time equality for comparing derived credentials without leaking a prefix match. */
export function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
