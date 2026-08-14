/**
 * WHY these throw instead of returning undefined: a handler that writes `@CurrentPlayer() p` has
 * already been written on the assumption that `p` exists. Returning undefined would push a
 * `Cannot read properties of undefined` into the service layer, far from the actual mistake (a
 * missing @PlayerAuth(), or @CurrentPlayer() used on an admin route). Failing here names the cause.
 */
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { CommonErrorCodes } from '../exceptions/error-codes';
import { UnauthorizedError } from '../exceptions/app.exception';
import { type Actor } from '../types/actor.type';
import {
  REQUEST_ADMIN_KEY,
  REQUEST_PLAYER_KEY,
  type AuthenticatedAdmin,
  type AuthenticatedPlayer,
  type RequestPrincipals,
} from './auth.types';

function principals(context: ExecutionContext): RequestPrincipals {
  return context.switchToHttp().getRequest<RequestPrincipals>();
}

/**
 * `@CurrentPlayer() player: AuthenticatedPlayer`
 * `@CurrentPlayer('playerId') id: string`
 */
export const CurrentPlayer = createParamDecorator(
  (field: keyof AuthenticatedPlayer | undefined, context: ExecutionContext): unknown => {
    const player = principals(context)[REQUEST_PLAYER_KEY];
    if (!player) {
      throw new UnauthorizedError(
        CommonErrorCodes.WRONG_PRINCIPAL,
        'This endpoint requires a player session.',
      );
    }
    return field === undefined ? player : player[field];
  },
);

/**
 * `@CurrentAdmin() admin: AuthenticatedAdmin`
 * `@CurrentAdmin('adminUserId') id: string`
 */
export const CurrentAdmin = createParamDecorator(
  (field: keyof AuthenticatedAdmin | undefined, context: ExecutionContext): unknown => {
    const admin = principals(context)[REQUEST_ADMIN_KEY];
    if (!admin) {
      throw new UnauthorizedError(
        CommonErrorCodes.WRONG_PRINCIPAL,
        'This endpoint requires an administrator session.',
      );
    }
    return field === undefined ? admin : admin[field];
  },
);

/**
 * `@CurrentActor() actor: Actor` — whichever principal is present, in the shape every money-writing
 * service and audit row demands. Saves each controller from re-deriving it (and from getting the
 * `type` wrong, which would mis-attribute a ledger movement).
 */
export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Actor => {
    const request = principals(context);
    const player = request[REQUEST_PLAYER_KEY];
    if (player) return { type: 'PLAYER', id: player.playerId };
    const admin = request[REQUEST_ADMIN_KEY];
    if (admin) return { type: 'ADMIN', id: admin.adminUserId };
    throw new UnauthorizedError(
      CommonErrorCodes.UNAUTHENTICATED,
      'This endpoint requires an authenticated caller.',
    );
  },
);
