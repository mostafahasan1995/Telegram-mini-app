/**
 * WHY the code is NOT normalized here: `AdminLoginCodeService.redeem` owns normalization (uppercase,
 * strip separators), and a DTO that half-normalized would leave two places deciding what "the same
 * code" means. The DTO only bounds the shape so an 8 MB body never reaches a hash function.
 *
 * The ceiling is deliberately loose relative to the 9-character printed form (`ABCD-EFGH`): people
 * paste with trailing whitespace, invisible characters and occasionally a whole sentence around it.
 * Normalization discards all of that; the limit exists only to bound abuse.
 */
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

const CODE_MAX_LENGTH = 64;

export class BotCodeDto {
  @IsString()
  @IsNotEmpty({ message: 'code is required' })
  @MaxLength(CODE_MAX_LENGTH, { message: 'code is implausibly long' })
  code: string;
}

/**
 * The admin half of the sign-in response.
 *
 * `telegramUserId` is a decimal STRING, never a number: Telegram ids are 64-bit and
 * `JSON.parse` in a client would round anything above 2^53. The Flutter console parses this field
 * with `BigInt.parse`, so changing it to a number is a breaking change even though the JSON still
 * "looks right".
 */
export interface AdminIdentityView {
  id: string;
  telegramUserId: string;
  role: string;
  displayName: string;
}

/**
 * Mirrors what `SessionService.issueAdminAccessToken` can actually promise. There is NO refresh
 * token here and that is not an omission: admin tokens are minted stateless with no session row, so
 * there would be nothing to rotate. The client is expected to prompt for a new bot code on expiry.
 */
export interface AdminSessionView {
  accessToken: string;
  /** ISO-8601. The client counts down on this rather than decoding the JWT. */
  expiresAt: string;
  admin: AdminIdentityView;
}
