/**
 * The route that finally makes `SessionService.issueAdminAccessToken` reachable.
 *
 * WHY IT IS `@Public()`: it mints the credential, so requiring one would be circular — the same
 * reasoning that makes `POST /v1/auth/telegram` public. The proof it carries instead is the
 * one-time code, which only the Telegram bot can hand out and only to an account
 * `AdminIdentityService` already recognises as active staff.
 *
 * WHY 200 AND NOT 201: no resource becomes addressable afterwards. A session here is not a REST
 * resource — it is a token in the response body. `POST /v1/auth/telegram` answers 200 for the same
 * reason, and the two login routes should not disagree about their own shape.
 *
 * WHY INVALID AND EXPIRED ARE THE SAME ANSWER: `redeem()` cannot distinguish "never existed" from
 * "TTL elapsed" — both are a Redis miss — and it must not. Telling a caller that a code was real
 * but late confirms a guess, which turns this route into an oracle for the code space. The
 * BOT_CODE_EXPIRED constant exists for a future path that can prove expiry honestly (a persisted
 * code row); until then every miss is BOT_CODE_INVALID.
 *
 * WHY THE ADMIN IS RE-RESOLVED HERE: the code carries a Telegram id, not authority. Authority comes
 * from `resolveOrThrow`, which reads the database (60s cache) and refuses an inactive account. So
 * an admin deactivated between /login and sign-in is stopped at the door, and the 403 they get is
 * the exact ADMIN_INACTIVE the console already knows how to display.
 */
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { Public } from '@common/decorators/auth.decorator';
import { UnauthorizedError } from '@common/exceptions/app.exception';
import { AdminIdentityService } from '@core/auth/services/admin-identity.service';
import { SessionService } from '@core/auth/services/session.service';

import { BotCodeDto, type AdminSessionView } from '../dtos/admin-auth.dto';
import { AdminErrorCodes } from '../enums/admin-error-code.enum';
import { AdminLoginCodeService } from '../services/admin-login-code.service';

@Controller('v1/admin/auth')
export class AdminAuthController {
  constructor(
    private readonly codes: AdminLoginCodeService,
    private readonly admins: AdminIdentityService,
    private readonly sessions: SessionService,
  ) {}

  /** POST /v1/admin/auth/bot-code — exchange a one-time bot code for an admin access token. */
  @Public()
  @Post('bot-code')
  @HttpCode(HttpStatus.OK)
  async exchangeBotCode(@Body() dto: BotCodeDto): Promise<AdminSessionView> {
    const telegramUserId = await this.codes.redeem(dto.code);
    if (telegramUserId === null) {
      throw new UnauthorizedError(
        AdminErrorCodes.BOT_CODE_INVALID,
        'That code is not valid. Send /console to the bot for a new one.',
      );
    }

    // Throws ForbiddenError(ADMIN_INACTIVE) if they are no longer staff.
    const admin = await this.admins.resolveOrThrow(telegramUserId);
    const { accessToken, accessTokenExpiresAt } = await this.sessions.issueAdminAccessToken(admin);

    return {
      accessToken,
      expiresAt: accessTokenExpiresAt.toISOString(),
      admin: {
        id: admin.adminUserId,
        // String, not number: a 64-bit Telegram id does not survive JSON.parse as a number.
        telegramUserId: admin.telegramUserId.toString(),
        role: admin.role,
        displayName: admin.displayName,
      },
    };
  }
}
