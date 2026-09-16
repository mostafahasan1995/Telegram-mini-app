/**
 * The console's sign-in door (API-CONTRACT.md §2a). All of the decisions live in
 * AdminCredentialsService; this file is the HTTP shape.
 *
 * WHY IT IS `@Public()`: it mints the credential, so requiring one would be circular — the same
 * reasoning that makes `POST /v1/auth/telegram` public. The proof it carries instead is a username
 * and a password, checked against a scrypt hash, and the route is rate limited (throttle-routes.ts,
 * `admin-sign-in`: 10 a minute, then blocked 15).
 *
 * WHY 200 AND NOT 201: no resource becomes addressable afterwards. A session here is not a REST
 * resource — it is a token in the response body. `POST /v1/auth/telegram` answers 200 for the same
 * reason, and the two login routes should not disagree about their own shape.
 *
 * `POST /v1/admin/auth/bot-code` used to live here. It was removed with the bot's `/console` command
 * (contract, 2026-09-05): staff are username+password accounts, most have no Telegram account for a
 * code to be tied to, and a bot that hands out console credentials leaves them in a chat log. Its
 * BOT_CODE_INVALID / BOT_CODE_EXPIRED codes are retired on this surface and must not be reused.
 */
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { Public } from '@common/decorators/auth.decorator';

import { AdminCredentialsDto, type AdminSessionView } from '../dtos/admin-auth.dto';
import { AdminCredentialsService } from '../services/admin-credentials.service';

@Controller('v1/admin/auth')
export class AdminAuthController {
  constructor(private readonly credentials: AdminCredentialsService) {}

  /** POST /v1/admin/auth/credentials — a username and a password for an admin access token. */
  @Public()
  @Post('credentials')
  @HttpCode(HttpStatus.OK)
  signIn(@Body() dto: AdminCredentialsDto): Promise<AdminSessionView> {
    return this.credentials.signIn(dto);
  }

  /**
   * POST /v1/admin/auth/ichancy — the operator's Ichancy agent username and password for its
   * SUPER_ADMIN session (§2b). Same body, same response, same throttle rule as /credentials. Kept as
   * its own door because the contract publishes it and the Flutter console posts to it; the web
   * console reaches the same logic through /credentials.
   */
  @Public()
  @Post('ichancy')
  @HttpCode(HttpStatus.OK)
  signInWithAgent(@Body() dto: AdminCredentialsDto): Promise<AdminSessionView> {
    return this.credentials.signInWithAgent(dto);
  }
}
