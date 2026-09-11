/**
 * X-Tenant-Id: how a platform admin reads one operator's data without becoming that operator.
 *
 * Runs AFTER the guards (which is what an interceptor does) because it needs the principal
 * AuthGuard attached. It never changes HOME — identity was already resolved in the home tenant by
 * the time this runs, which is the property that keeps the header from being an authentication
 * bypass. It moves only EFFECTIVE: whose rows the request reads.
 *
 * ══ THE THREE RULES, and why each is the way it is ══════════════════════════════════════════
 *
 *  1. HONOURED ONLY FOR A PLATFORM_ADMIN WHOSE HOME IS TENANT ZERO.
 *     The role alone is not enough. A PLATFORM_ADMIN row inside an operator is a tenant login
 *     holding platform authority, and it has existed before. prisma/sql/006 stops one being
 *     written; this stops it being worth anything if it is.
 *
 *  2. IGNORED — NEVER REFUSED — FROM EVERYBODY ELSE.
 *     A SUPER_ADMIN who sends the header gets exactly what they would have got without it. A 403
 *     would turn the header into an oracle: send one, read the error, learn which operator ids are
 *     real. Silence leaks nothing.
 *
 *  3. AN UNKNOWN ID IS A 400, NOT A FALLBACK.
 *     Quietly serving the home tenant instead would show a platform admin one operator's deposits
 *     under another operator's name, with nothing anywhere to reveal the mismatch.
 *
 * The 400 carries VALIDATION_FAILED rather than a tenancy-specific code on purpose: it is the
 * answer the console was built and measured against on 2026-08-25, and TenantNotice keys off it.
 */
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import type { Request } from 'express';
import { Observable, from, switchMap } from 'rxjs';

import { REQUEST_ADMIN_KEY, type RequestPrincipals } from '@common/decorators/auth.types';
import { ValidationError } from '@common/exceptions/app.exception';

import { TenantRegistryService } from './services/tenant-registry.service';
import { TENANT_HEADER } from './tenant.constants';
import { getTenantContext, setEffectiveTenant } from './tenant.storage';

type PrincipalRequest = Request & RequestPrincipals;

@Injectable()
export class TenantOverrideInterceptor implements NestInterceptor {
  constructor(private readonly tenants: TenantRegistryService) {}

  intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<PrincipalRequest>();

    const raw = request.headers[TENANT_HEADER];
    const requested = Array.isArray(raw) ? raw[0] : raw;
    if (typeof requested !== 'string' || requested.length === 0) return next.handle();

    // Rule 1. Both halves are required: the role AND the home tenant.
    const admin = request[REQUEST_ADMIN_KEY];
    const store = getTenantContext();
    if (
      admin === undefined ||
      admin.role !== AdminRole.PLATFORM_ADMIN ||
      store === undefined ||
      !store.isPlatformHome
    ) {
      // Rule 2: ignored, not refused.
      return next.handle();
    }

    // Pointing at your own tenant is a no-op, and skipping the lookup keeps the common case free.
    if (requested === store.homeTenantId) return next.handle();

    return from(this.tenants.find(requested)).pipe(
      switchMap((tenant) => {
        // Rule 3.
        if (tenant === null) {
          throw new ValidationError(`No tenant with id ${requested}.`, {
            header: TENANT_HEADER,
          });
        }

        // A SUSPENDED or CLOSED operator is still readable: suspending one is exactly when a
        // platform admin most needs to look at it. Status gates serving, not inspection.
        setEffectiveTenant(tenant.id);
        return next.handle();
      }),
    );
  }
}
