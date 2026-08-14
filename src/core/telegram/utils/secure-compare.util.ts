/**
 * WHY hash-then-compare rather than comparing the raw buffers: `timingSafeEqual` THROWS when the
 * two buffers differ in length, so a naive implementation has to check the length first — and that
 * check itself leaks the secret's length through timing. Hashing both sides to a fixed 32 bytes
 * removes the length channel entirely and makes the comparison total.
 *
 * Used for the Telegram webhook secret header and for the unguessable webhook path segment. Both
 * are compared against attacker-supplied input on an unauthenticated endpoint, which is exactly
 * where `===` would be a real (if slow) oracle.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

export function secureCompare(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return timingSafeEqual(digest(a), digest(b));
}
