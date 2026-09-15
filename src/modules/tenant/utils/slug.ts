/**
 * A new operator's slug when the caller did not choose one: `slugify(displayName)`, de-duplicated
 * with `-2`, `-3`, … (dashboard docs/API-CONTRACT.md, "What fills them in").
 *
 * Pure, and written to agree with the dashboard mock character for character
 * (manager-account-dashboard src/mocks/db.ts `slugify` and `uniqueSlug`), so the slug the console
 * previews in demo mode is the slug this server produces.
 *
 * A name with nothing Latin in it (Arabic, say) leaves nothing to slug, so it falls back to a fixed
 * stem, and the de-duplication is what keeps that usable for a second such operator.
 */

/** The stem used when a display name yields no Latin letters or digits at all. */
export const FALLBACK_SLUG = 'tenant';

export function slugify(displayName: string): string {
  const slug = displayName
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? FALLBACK_SLUG : slug;
}

/** `base` when it is free, otherwise the first of `base-2`, `base-3`, … that is. */
export function firstFreeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
