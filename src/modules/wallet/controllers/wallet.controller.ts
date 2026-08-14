/**
 * GET /v1/wallet — the mini-app's home screen.
 *
 * Scoped to the authenticated player and nothing else: there is no `:playerId` parameter anywhere on
 * this controller, so there is no version of this endpoint that could be made to read somebody
 * else's balance by changing a path segment.
 */
import { Controller, Get } from '@nestjs/common';

import { PlayerAuth } from '@common/decorators/auth.decorator';
import { CurrentPlayer } from '@common/decorators/current-principal.decorator';

import type { WalletView } from '../dtos/wallet.view';
import { WalletService } from '../services/wallet.service';

@Controller('v1/wallet')
@PlayerAuth()
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  async get(@CurrentPlayer('playerId') playerId: string): Promise<WalletView> {
    return this.wallet.getWallet(playerId);
  }
}
