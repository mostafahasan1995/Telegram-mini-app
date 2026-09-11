/**
 * WHY @Global: a tenant context that a module has to remember to import is a module whose queries
 * silently read the wrong operator's rows. Same argument as ActorContextModule.
 *
 * WHY TenantContextMiddleware IS A PLAIN PROVIDER AND NOT WIRED THROUGH MiddlewareConsumer:
 * it must run before Nest's router, and `configureApiApp()` in main.ts is the one place in this
 * codebase where pre-router middleware is installed (`requestContextMiddleware`, the body parsers,
 * helmet). Registering it here as a provider and `app.use()`-ing it there keeps all of that
 * ordering readable in one file instead of split across a module's configure() hook.
 *
 * WHY JwtModule IS REGISTERED AGAIN HERE rather than imported from AuthModule: AuthModule's
 * AdminIdentityService resolves identity inside the tenant this module establishes, so importing
 * AuthModule from here would be a cycle. JwtModule holds no state — it is the same secret and the
 * same pinned algorithm, constructed twice.
 *
 * TenantOverrideInterceptor is APP_INTERCEPTOR because Nest runs interceptors AFTER guards, which
 * is exactly when the X-Tenant-Id decision can be made: it needs the principal AuthGuard attached.
 */
import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';

import { AppConfigService } from '../config/config.service';

import { TenantRegistryService } from './services/tenant-registry.service';
import { TenantContextMiddleware } from './tenant-context.middleware';
import { TenantOverrideInterceptor } from './tenant-override.interceptor';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        secret: config.jwt.secret,
        // Pinned here as well as at every call site. Accepting whatever `alg` a token asks for is
        // the classic JWT bypass, and this module verifies tokens before any guard has run.
        verifyOptions: { algorithms: ['HS256' as const] },
      }),
    }),
  ],
  providers: [
    TenantRegistryService,
    TenantContextMiddleware,
    { provide: APP_INTERCEPTOR, useClass: TenantOverrideInterceptor },
  ],
  exports: [TenantRegistryService, TenantContextMiddleware],
})
export class TenantModule {}
