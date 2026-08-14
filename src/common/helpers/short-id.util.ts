/**
 * WHY: a deposit's shortId is read aloud, retyped by a support agent, and — critically — sent as the
 * `comment` on the Ichancy deposit call, because that comment is the ONLY way a human can later find
 * our transaction in the Ichancy panel (the API has no idempotency key and no lookup-by-reference).
 * So it must survive a human eye and a phone keyboard.
 *
 * Alphabet is Crockford base32: digits plus uppercase letters minus I, L, O and U.
 * U is dropped to avoid accidental profanity; I/L/O are dropped because they are indistinguishable
 * from 1/1/0 in most fonts. Confusable input is repaired by normalizeShortId rather than rejected.
 * 32^10 ≈ 1.1e15 possibilities, and the DB still holds a UNIQUE constraint as the real guarantee.
 */
import { customAlphabet } from 'nanoid';

export const SHORT_ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SHORT_ID_LENGTH = 10;
export const SHORT_ID_REGEX = new RegExp(`^[${SHORT_ID_ALPHABET}]{${SHORT_ID_LENGTH}}$`);

const nanoid = customAlphabet(SHORT_ID_ALPHABET, SHORT_ID_LENGTH);

/** Human-facing reference for a deposit, e.g. "K7Q2ZP9V3M". Always uppercase, never ambiguous. */
export function generateShortId(): string {
  return nanoid();
}

/**
 * Repair what a human typed: strip spaces/dashes, uppercase, and fold the confusable characters
 * back onto the canonical alphabet (O -> 0, I/L -> 1). Does NOT validate; pair with isShortId.
 */
export function normalizeShortId(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export function isShortId(raw: string): boolean {
  return SHORT_ID_REGEX.test(raw);
}

/** normalize + validate in one step; returns null when the input cannot be a shortId. */
export function parseShortId(raw: string): string | null {
  const normalized = normalizeShortId(raw);
  return isShortId(normalized) ? normalized : null;
}
