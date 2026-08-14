/**
 * WHY @Global and why there is nothing else in here: every service that changes state writes an
 * audit row, so the alternative is importing this module in all of them. AuditService is stateless
 * and does no IO — it only ever writes through the Tx it is handed — so a single shared instance is
 * all there is to provide.
 */
import { Global, Module } from '@nestjs/common';

import { AuditService } from './audit.service';

@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
