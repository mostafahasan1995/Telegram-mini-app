/**
 * The console login's shape, in one place (API-CONTRACT.md, staff accounts: "3–64 characters,
 * `[A-Za-z0-9._@+-]`, unique per tenant, lower-cased on write"). The dashboard's staff form checks
 * the same rule before it sends anything.
 *
 * WHY A FILE OF ITS OWN, with no Nest and no Prisma in it: `prisma/seed-platform-admin.ts` must
 * apply exactly the rule the staff directory applies, and a seed script that imported
 * AdminUserService to get it would load a slice of the DI graph (Prisma, audit, cache) just to
 * lower-case a string.
 */

export const ADMIN_USERNAME_MIN_LENGTH = 3;
export const ADMIN_USERNAME_MAX_LENGTH = 64;
/** ASCII only, so `.length` is the character count a person sees. */
export const ADMIN_USERNAME_PATTERN = /^[A-Za-z0-9._@+-]+$/;

/**
 * Usernames are stored lower-cased (API contract: "unique per tenant, lower-cased on write"). One
 * function, used by every writer and by any lookup, so `Alice` and `alice` can never become two
 * accounts in one operator, and a sign-in never misses because of how someone capitalised it.
 */
export function normalizeAdminUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** Checks an ALREADY-NORMALISED username against the contract's length and character rules. */
export function isValidAdminUsername(normalized: string): boolean {
  return (
    normalized.length >= ADMIN_USERNAME_MIN_LENGTH &&
    normalized.length <= ADMIN_USERNAME_MAX_LENGTH &&
    ADMIN_USERNAME_PATTERN.test(normalized)
  );
}
