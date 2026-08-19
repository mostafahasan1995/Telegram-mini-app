/**
 * The staff surface over players — and the ONE place a human can ask for an Ichancy account to be
 * opened on demand.
 *
 * ══ WHY THIS CONTROLLER LIVES IN modules/player AND NOT IN modules/admin ══════════════════════
 * `eslint-plugin-boundaries` makes modules/admin -> modules/player a build failure, and the two
 * things these routes need — PlayerService (the scoped reads) and PlayerLinkService (the
 * registration) — are owned here. The established pattern in this codebase is that the module which
 * owns the data serves its own `/v1/admin/...` routes: see
 * modules/payment-method/controllers/admin-payment-method.controller.ts. The routes are still
 * admin-authenticated; only the code's address differs.
 *
 * ══ WHY REGISTRATION IS EXPOSED AT ALL ════════════════════════════════════════════════════════
 * Until this existed, an Ichancy account could only be created by the player pressing /start or by
 * the credit worker just before the first credit. Neither is available to an operator holding a
 * player who has neither — for example after a Cloudflare outage swallowed the /start attempt. This
 * is the manual retry, and it is deliberately the same idempotent call the automatic paths make:
 * PlayerLinkService.ensureLinked. There is no second implementation of a non-idempotent
 * registration in this system, and there must never be.
 *
 * ══ WHY THERE IS NO POST /v1/admin/players ════════════════════════════════════════════════════
 * A player IS a Telegram account here — `players.telegram_user_id` is the identity, and everything
 * downstream (login codes, deposit notifications, the bot itself) addresses that chat. A player row
 * invented by staff would have no chat to notify and no way to sign in, so creating one is not a
 * gap, it is a thing that must not exist. People arrive by pressing Start.
 */
import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';

import { AdminAuth } from '@common/decorators/auth.decorator';
import { CurrentAdmin } from '@common/decorators/current-principal.decorator';
import type { AuthenticatedAdmin } from '@common/decorators/auth.types';
import { IdParamDto } from '@common/dtos/id-param.dto';
import type { PaginatedResult } from '@common/dtos/paginated.dto';
import { AppConfigService } from '@core/config/config.service';

import { ListPlayersQueryDto, type IchancyAccountView } from '../dtos/player-admin.dto';
import type { AdminPlayerView, PlayerView } from '../dtos/player.view';
import { PLAYER_ICHANCY_MANAGER_ROLES, PLAYER_READER_ROLES } from '../player.constants';
import { PlayerLinkService } from '../services/player-link.service';
import { PlayerService } from '../services/player.service';
import { viewerFromAdmin } from '../services/player-access.service';
import { toPlayerWhere } from '../utils/player-filter.util';

@Controller('v1/admin/players')
export class PlayerAdminController {
  constructor(
    private readonly players: PlayerService,
    private readonly links: PlayerLinkService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * The directory. `linked=false` is the query that matters operationally: it lists exactly the
   * people who can be handed to the POST below.
   */
  @AdminAuth(...PLAYER_READER_ROLES)
  @Get()
  list(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Query() query: ListPlayersQueryDto,
  ): Promise<PaginatedResult<AdminPlayerView>> {
    return this.players.list(
      viewerFromAdmin(admin),
      toPlayerWhere(query),
      query.limit,
      query.offset,
    );
  }

  @AdminAuth(...PLAYER_READER_ROLES)
  @Get(':id')
  get(@CurrentAdmin() admin: AuthenticatedAdmin, @Param() params: IdParamDto): Promise<PlayerView> {
    return this.players.getView(viewerFromAdmin(admin), params.id);
  }

  /**
   * Open (or re-discover) this player's Ichancy account under our agent.
   *
   * 200, not 201: the call is idempotent and usually finds an account that already exists, so
   * "created a resource" would be a lie on most invocations. `created` in the body says which
   * happened.
   *
   * Not @Idempotent(): ensureLinked is idempotent at the DOMAIN level — derived credentials, a
   * distributed lock, "Duplicate login" treated as success, and a compare-and-set persist — so a
   * retried request converges on the same account rather than needing a replayed HTTP response.
   */
  @AdminAuth(...PLAYER_ICHANCY_MANAGER_ROLES)
  @Post(':id/ichancy-account')
  @HttpCode(HttpStatus.OK)
  async createIchancyAccount(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param() params: IdParamDto,
  ): Promise<IchancyAccountView> {
    // Read through the scope FIRST: an id that this viewer may not see must 404 here exactly as it
    // does on GET, instead of being confirmed by a registration attempt.
    await this.players.getView(viewerFromAdmin(admin), params.id);

    const link = await this.links.ensureLinked(params.id, `admin:${admin.adminUserId}`);

    return {
      playerId: link.playerId,
      ichancyPlayerId: link.ichancyPlayerId,
      ichancyLogin: link.ichancyLogin,
      created: link.created,
      agentId: this.config.ichancy.agentId,
    };
  }
}
