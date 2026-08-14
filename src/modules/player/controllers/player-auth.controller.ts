/**
 * WHY these three routes are @Public: they are what MINT credentials, so requiring one would be
 * circular. Each carries its own proof instead — a Telegram HMAC on /telegram, a refresh token on
 * /refresh. /logout is the exception and is player-authenticated, because revoking a session
 * requires knowing which session.
 *
 * WHY the refresh token is returned in the body and not set as a cookie: the client is a Telegram
 * mini app rendered in an in-app webview, where third-party cookie behaviour differs per platform
 * and is silently dropped on some Android builds. The token is held by the app and sent explicitly.
 */
import { Body, Controller, HttpCode, HttpStatus, Headers, Ip, Post } from '@nestjs/common';

import { CurrentPlayer } from '@common/decorators/current-principal.decorator';
import { Public, PlayerAuth } from '@common/decorators/auth.decorator';

import { RefreshTokenDto, TelegramAuthDto, type AuthTokensView } from '../dtos/auth.dto';
import { PlayerAuthService, type LoginResult } from '../services/player-auth.service';

@Controller('v1/auth')
export class PlayerAuthController {
  constructor(private readonly auth: PlayerAuthService) {}

  /**
   * Exchange Telegram initData for a session.
   * 200, not 201: no resource is addressable afterwards — a session is not a REST resource here.
   */
  @Public()
  @Post('telegram')
  @HttpCode(HttpStatus.OK)
  login(
    @Body() body: TelegramAuthDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<LoginResult> {
    return this.auth.loginWithInitData(body.initData, {
      ip,
      userAgent: userAgent ?? null,
    });
  }

  /** Rotate a refresh token. The presented token is dead afterwards, whatever the outcome. */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(
    @Body() body: RefreshTokenDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AuthTokensView> {
    return this.auth.refresh(body.refreshToken, { ip, userAgent: userAgent ?? null });
  }

  /**
   * Ends THIS device's session. The session id comes from the access token, never from the body —
   * a body-supplied id would let any authenticated player log out any other.
   */
  @PlayerAuth()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@CurrentPlayer('sessionId') sessionId: string): Promise<void> {
    await this.auth.logout(sessionId);
  }
}
