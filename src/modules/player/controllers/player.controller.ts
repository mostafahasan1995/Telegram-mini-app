/**
 * WHY /me takes no id: an endpoint that accepts `GET /v1/players/:id` and then checks ownership is
 * one forgotten check away from an enumeration hole. `/me` cannot address anybody else — the id
 * comes from the access token and there is no parameter to tamper with.
 */
import { Controller, Get } from '@nestjs/common';

import { PlayerAuth } from '@common/decorators/auth.decorator';
import { CurrentPlayer } from '@common/decorators/current-principal.decorator';

import type { PlayerView } from '../dtos/player.view';
import { PlayerService } from '../services/player.service';
import type { PlayerEligibility } from '../services/player.service';

interface MeResponse {
  player: PlayerView;
  /** So the mini app can grey out the deposit button with the right message, in one round trip. */
  eligibility: {
    eligible: boolean;
    reason: string | null;
    excludedUntil: string | null;
  };
}

@Controller('v1')
export class PlayerController {
  constructor(private readonly players: PlayerService) {}

  @PlayerAuth()
  @Get('me')
  async me(@CurrentPlayer('playerId') playerId: string): Promise<MeResponse> {
    const [player, eligibility] = await Promise.all([
      this.players.getOwnView(playerId),
      this.players.checkEligibility(playerId),
    ]);

    // Deliberately not awaited into the response: a failed "last seen" write must never turn a
    // successful profile read into an error.
    void this.players.touchLastSeen(playerId).catch(() => undefined);

    return { player, eligibility: this.toEligibilityView(eligibility) };
  }

  private toEligibilityView(eligibility: PlayerEligibility): MeResponse['eligibility'] {
    return {
      eligible: eligibility.eligible,
      reason: eligibility.reason,
      excludedUntil: eligibility.excludedUntil?.toISOString() ?? null,
    };
  }
}
