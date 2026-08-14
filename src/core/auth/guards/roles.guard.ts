/**
 * WHY roles are checked in a second guard rather than inside AuthGuard: AuthGuard answers "who is
 * this", which every protected route needs. This answers "is that enough for THIS route", which
 * only role-restricted routes need. Keeping them apart is what makes `@AdminAuth()` with no
 * arguments legible as "any active admin" instead of an accidental wildcard.
 *
 * SUPER_ADMIN is NOT implicitly allowed everywhere. A decorator that says
 * `@AdminAuth(AdminRole.FINANCE_ADMIN)` means exactly that; if SUPER_ADMIN should also pass, it is
 * listed. Implicit super-user grants are how a role model quietly stops describing reality.
 *
 * Registration order matters: this guard must be provided AFTER AuthGuard in the module's provider
 * list, because it reads the principal AuthGuard attached.
 */
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import { AUTH_REQUIREMENT_KEY, IS_PUBLIC_KEY } from '@common/decorators/auth.decorator';
import {
  REQUEST_ADMIN_KEY,
  type AuthRequirement,
  type RequestPrincipals,
} from '@common/decorators/auth.types';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true) return true;

    const requirement = this.reflector.getAllAndOverride<AuthRequirement | undefined>(
      AUTH_REQUIREMENT_KEY,
      targets,
    );

    // Only admin routes carry a role list; everything else was already settled by AuthGuard.
    if (requirement === undefined || requirement.kind !== 'ADMIN') return true;
    if (requirement.roles.length === 0) return true;

    const request = context.switchToHttp().getRequest<RequestPrincipals>();
    const admin = request[REQUEST_ADMIN_KEY];

    // Unreachable through AuthGuard, but a guard that assumes another guard ran is a guard that
    // fails open the day someone reorders the providers.
    if (!admin) {
      throw new ForbiddenError(
        CommonErrorCodes.WRONG_PRINCIPAL,
        'This endpoint is for administrator accounts.',
      );
    }

    if (!requirement.roles.includes(admin.role)) {
      throw new ForbiddenError(
        CommonErrorCodes.INSUFFICIENT_ROLE,
        'Your role does not permit this action.',
        { required: [...requirement.roles] },
      );
    }

    return true;
  }
}
