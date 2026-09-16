/**
 * WHY the global guards are registered HERE and not in AppModule: the guards and the services they
 * depend on ship together. A future AppModule that imports AuthModule cannot accidentally get the
 * services without the protection, which is the failure mode that leaves endpoints open.
 *
 * PROVIDER ORDER IS SIGNIFICANT. Nest executes global guards in registration order, and RolesGuard
 * reads the principal that AuthGuard attaches. Swapping these two lines makes every role check
 * throw WRONG_PRINCIPAL.
 *
 * AppModule must import this module. `PrismaModule` and `CacheModule` are expected to be @Global
 * (CacheModule in this area certainly is), so they are not re-imported here.
 */
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AppConfigService } from '../config/config.service';
import { ttlToSeconds } from './auth.constants';
import { AuthGuard } from './guards/auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { AdminIdentityService } from './services/admin-identity.service';
import { InitDataService } from './services/init-data.service';
import { LoginCodeService } from './services/login-code.service';
import { PasswordHasherService } from './services/password-hasher.service';
import { SessionService } from './services/session.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        secret: config.jwt.secret,
        signOptions: {
          algorithm: 'HS256' as const,
          expiresIn: ttlToSeconds(config.jwt.accessTtl),
        },
        // Pinned on verification too. Accepting whatever `alg` the token asks for is the classic
        // JWT bypass; @nestjs/jwt does not pin it for you.
        verifyOptions: {
          algorithms: ['HS256' as const],
        },
      }),
    }),
  ],
  providers: [
    InitDataService,
    SessionService,
    AdminIdentityService,
    // The player app's bot-minted sign-in code. The staff console's code door was retired; staff
    // sign in with a username and password through PasswordHasherService below.
    LoginCodeService,
    // Console passwords. Stateless, so one instance serves the credentials route and the staff
    // directory alike.
    PasswordHasherService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [
    InitDataService,
    SessionService,
    AdminIdentityService,
    LoginCodeService,
    PasswordHasherService,
  ],
})
export class AuthModule {}
