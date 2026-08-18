/**
 * WHY initData is validated only for SHAPE here and never trimmed or normalized:
 * it is a signed string. Any modification — trimming whitespace, re-encoding, reordering — changes
 * the data-check-string and breaks a signature that was perfectly valid. So the DTO asserts that
 * something string-shaped and plausibly sized arrived, and hands the exact bytes to InitDataService.
 *
 * The length ceiling is a cheap denial-of-service guard: HMAC over a 10 MB body is free for the
 * attacker and not for us.
 */
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Real initData is a few hundred bytes; 8 KB is generous and still bounded. */
const INIT_DATA_MAX_LENGTH = 8_192;

export class TelegramAuthDto {
  @IsString()
  @IsNotEmpty({ message: 'initData is required' })
  @MaxLength(INIT_DATA_MAX_LENGTH, { message: 'initData is implausibly long' })
  initData: string;
}

/**
 * WHY the code is NOT normalized here: LoginCodeService owns normalization (uppercase, strip
 * separators), and a DTO that half-normalized would leave two places deciding what "the same code"
 * means. This only bounds the shape so a huge body never reaches a hash function.
 *
 * The ceiling is loose relative to the 9-character printed form (`ABCD-EFGH`) because people paste
 * with trailing whitespace, invisible characters, and sometimes a whole sentence around it.
 */
export class BotCodeDto {
  @IsString()
  @IsNotEmpty({ message: 'code is required' })
  @MaxLength(64, { message: 'code is implausibly long' })
  code: string;
}

export class RefreshTokenDto {
  @IsString()
  @IsNotEmpty({ message: 'refreshToken is required' })
  // base64url of 32 bytes is 43 characters; the ceiling only bounds abuse.
  @MaxLength(512)
  refreshToken: string;
}

/** The session half of an auth response. Mirrors IssuedSession minus the internal session id. */
export interface AuthTokensView {
  accessToken: string;
  refreshToken: string;
  /** ISO-8601. The client refreshes on this, rather than decoding the JWT. */
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
}
