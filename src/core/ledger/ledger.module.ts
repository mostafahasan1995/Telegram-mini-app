/**
 * WHY @Global: every module that moves money needs the ledger, and making each of them remember to
 * import LedgerModule is an invitation to instantiate a second copy of it. There is exactly one
 * ledger.
 *
 * Note there is no PrismaService here. Every method takes a Tx (or a LedgerTxRunner) from its caller,
 * so this module owns no connection and cannot open a transaction behind anyone's back.
 */
import { Global, Module } from '@nestjs/common';

import { AccountRegistryService } from './account-registry.service';
import { InvariantsService } from './invariants.service';
import { LedgerRepository } from './ledger.repository';
import { LedgerService } from './ledger.service';

@Global()
@Module({
  providers: [AccountRegistryService, LedgerRepository, LedgerService, InvariantsService],
  exports: [LedgerService, AccountRegistryService, InvariantsService],
})
export class LedgerModule {}
