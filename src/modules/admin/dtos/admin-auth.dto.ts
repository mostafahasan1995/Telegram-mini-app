/**
 * The console sign-in body (API-CONTRACT.md §2a).
 *
 * WHY THE DTO ONLY BOUNDS SHAPE: normalisation (trim, lower-case) belongs to the service, beside the
 * lookup it serves, so there is one definition of "the same login". And the password's 8–72 rule is
 * NOT restated here: a 400 naming the password's length would answer a different sentence than the
 * one 401 every other refusal gets. `PasswordHasherService.verify` refuses an out-of-bounds password
 * as a plain mismatch, so a short one is simply wrong. The ceilings exist to keep an 8 MB body away
 * from a hash function; 256 is the console's own `maxLength` on both inputs.
 *
 * No validation message here echoes a value, so a password typed into the wrong field never comes
 * back in `details.fields`.
 */
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

const LOGIN_MAX_LENGTH = 256;
const SLUG_MAX_LENGTH = 128;

export class AdminCredentialsDto {
  /** A plain name or an email: both are ordinary values of `admin_users.username`. */
  @IsString()
  @IsNotEmpty({ message: 'username is required' })
  @MaxLength(LOGIN_MAX_LENGTH, { message: 'username is implausibly long' })
  username: string;

  @IsString()
  @IsNotEmpty({ message: 'password is required' })
  @MaxLength(LOGIN_MAX_LENGTH, { message: 'password is implausibly long' })
  password: string;

  /**
   * Absent on the first attempt. Sent only after a 409 ADMIN_OPERATOR_AMBIGUOUS, with the slug the
   * person picked from `details.operators`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(SLUG_MAX_LENGTH, { message: 'operatorSlug is implausibly long' })
  operatorSlug?: string;
}

/**
 * The admin half of the sign-in response.
 *
 * `telegramUserId` is a decimal STRING, never a number: Telegram ids are 64-bit and
 * `JSON.parse` in a client would round anything above 2^53. The Flutter console parses this field
 * with `BigInt.parse`, so changing it to a number is a breaking change even though the JSON still
 * "looks right".
 *
 * It is NULL for a console-only admin (username + password, no Telegram account) — the dashboard's
 * `adminIdentitySchema` declares it `z.string().nullable()`. It is informational; the session is
 * bound to `id`, never to this.
 */
export interface AdminIdentityView {
  id: string;
  telegramUserId: string | null;
  role: string;
  displayName: string;
}

/**
 * Mirrors what `SessionService.issueAdminAccessToken` can actually promise. There is NO refresh
 * token here and that is not an omission: admin tokens are minted stateless with no session row, so
 * there would be nothing to rotate. The console watches `expiresAt` and signs in again.
 */
export interface AdminSessionView {
  accessToken: string;
  /** ISO-8601. The client counts down on this rather than decoding the JWT. */
  expiresAt: string;
  admin: AdminIdentityView;
  /**
   * The HOME operator the session opened — the `tid` signed into the token, and the tenant every
   * request on it resolves identity in. Tenant zero (`platform`) for platform staff.
   */
  tenantId: string;
  tenantSlug: string;
}
