/**
 * WHY THIS MODULE EXISTS AT ALL — read before deleting it, the api process does not boot without it.
 *
 * The deposit flow needs three things that live in other feature modules:
 *   PLAYER_LINK_PORT     modules/player        (create the Ichancy mirror before the first credit)
 *   APPROVAL_LIMIT_PORT  modules/admin         (may THIS admin approve THIS amount today?)
 *   PAYMENT_METHOD_PORT  modules/payment-method(destination rotation, rail rules, instructions)
 *
 * `modules/A -> modules/B` is a build failure here (eslint-plugin-boundaries), and correctly so: a
 * direct import would let one feature reach past another's transaction boundary. So the owners
 * publish plain string tokens and the composition ROOT binds them — this file is that root.
 *
 * A plain `providers: [...]` list in AppModule is NOT enough. Nest resolves a token from the
 * CONSUMING module and its imports, never from the root's provider list, so DepositModule would
 * still fail with "Nest can't resolve PLAYER_LINK_PORT". Re-exporting the three owner modules from a
 * @Global module republishes what they export (the three tokens) to every module in the graph
 * without anyone importing anything. That is the whole trick, and it is the mechanism the deposit
 * agent's DI spec models with stubs.
 *
 * Because the binding is `useExisting`, the port and the service are the SAME instance — there is
 * exactly one implementation of a non-idempotent registration call in the process.
 */
import { Global, Module } from '@nestjs/common';

import { AdminModule } from '@modules/admin/admin.module';
import { PaymentMethodModule } from '@modules/payment-method/payment-method.module';
import { PlayerModule } from '@modules/player/player.module';

@Global()
@Module({
  imports: [PlayerModule, AdminModule, PaymentMethodModule],
  exports: [PlayerModule, AdminModule, PaymentMethodModule],
})
export class FeaturePortsModule {}
