/**
 * The refusals more than one platform service answers, built in one place so the console reads the
 * same code and sentence whichever route produced them.
 */
import { ConflictError, NotFoundError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';
import { isUniqueConstraintError, mapPrismaError } from '@core/prisma/prisma-errors';
import { TenantErrorCodes } from '@core/tenant/tenant-error-codes';

export function tenantNotFound(): NotFoundError {
  return new NotFoundError(TenantErrorCodes.TENANT_NOT_FOUND, 'Tenant not found.');
}

/**
 * A slug the caller CHOSE is taken. The dashboard mock's exact answer: 409 DUPLICATE_RESOURCE with
 * `fields: ['slug']`, the same envelope the global filter gives any unique violation.
 */
export function slugTaken(): ConflictError {
  return new ConflictError(
    CommonErrorCodes.DUPLICATE_RESOURCE,
    'A record with these values already exists.',
    { fields: ['slug'] },
  );
}

/**
 * The pasted token's bot is already another operator's. Telegram keeps one webhook per bot, so
 * attaching it here would move that operator's deliveries to this one (dashboard
 * TENANT-OPERATIONS.md §2: "each operator needs its own bot"). The same envelope as a taken slug,
 * naming the field. Which operator holds it is not said, and the token is never echoed.
 */
export function botAlreadyAttached(): ConflictError {
  return new ConflictError(
    CommonErrorCodes.DUPLICATE_RESOURCE,
    'This bot is already connected to another operator. Each operator needs its own bot: create ' +
      'a new one with @BotFather and paste its token.',
    { fields: ['botToken'] },
  );
}

/**
 * True when a write lost the race for `tenants_bot_id_key`: two requests attaching the same bot
 * both passed the read check, and the index let only one land.
 */
export function isBotIdCollision(error: unknown): boolean {
  const mapped = isUniqueConstraintError(error) ? error : mapPrismaError(error);
  if (!isUniqueConstraintError(mapped)) return false;
  return (
    mapped.fields.some((field) => field === 'bot_id' || field === 'botId') ||
    (mapped.constraint ?? '').includes('bot_id')
  );
}
