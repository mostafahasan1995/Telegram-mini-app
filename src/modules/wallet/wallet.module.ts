/**
 * Read-only module: it owns no transaction boundary and writes nothing. That is deliberate — the
 * wallet view reads from the ledger, from Ichancy and from the deposit table, and a module that can
 * read all three is a module that must never be able to write any of them.
 */
import { Module } from '@nestjs/common';

import { IchancyModule } from '@core/ichancy/ichancy.module';

import { WalletController } from './controllers/wallet.controller';
import { WalletService } from './services/wallet.service';

@Module({
  imports: [IchancyModule],
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
