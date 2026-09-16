/**
 * What a failed Telegram call becomes on the platform surface: one of four contract errors, each
 * with a sentence an admin can act on.
 *
 * WHY THIS EXISTS: grammY throws GrammyError (Telegram answered with an error), HttpError (Telegram
 * could not be reached) and the registry throws TenantBotUnavailableError (this operator has no bot
 * that works). None of them is an AppException, so any of them escaping a controller would be a 500
 * with "An unexpected error occurred", for failures that are ordinary and that the admin fixes: a
 * revoked token, a URL Telegram refuses, a Telegram outage.
 *
 * THE MAPPING:
 *  - the bot cannot be used, or Telegram answers 401/404 (the token was revoked) -> 422
 *    TENANT_BOT_UNAVAILABLE: the fix is a new token;
 *  - Telegram unreachable, timing out, 429 or 5xx, or a getMe that failed for those reasons -> 503
 *    TENANT_TELEGRAM_UNREACHABLE: the same request can succeed later;
 *  - any other Telegram error -> 422 TENANT_TELEGRAM_REJECTED with Telegram's own description.
 * Anything else is not Telegram's and is answered with null, so the caller rethrows it unchanged.
 *
 * NO MESSAGE CARRIES A CREDENTIAL. grammY leaves the token out of its messages unless sensitiveLogs
 * is on, which nothing enables. Telegram's descriptions can quote the URL it failed to reach, which
 * holds the operator's path token, so every description is passed through the same redaction the
 * logs use.
 */
import { GrammyError, HttpError } from 'grammy';

import {
  BusinessRuleError,
  ServiceUnavailableError,
  type AppException,
} from '@common/exceptions/app.exception';
import { redactWebhookPathToken } from '@common/helpers/request-url-redaction.util';
import { isTenantBotUnavailableError } from '@core/telegram/tenant-bot.errors';
import { TenantErrorCodes } from '@core/tenant/tenant-error-codes';

/** Telegram's answers for a token it will not accept, as TenantBotRegistry reads them. */
const TOKEN_REJECTION_CODES: ReadonlySet<number> = new Set([401, 404]);

/** Telegram answers these when the problem is load or an outage, not the request. */
const TRANSIENT_STATUS = (code: number): boolean => code === 429 || code >= 500;

/**
 * `action` completes "Telegram could not be reached to …" and "Telegram refused to …", so it is a
 * verb phrase: "register the webhook", "push the command menus".
 */
export function telegramFailure(error: unknown, action: string): AppException | null {
  if (isTenantBotUnavailableError(error)) {
    if (error.retryable) return unreachable(action);
    // The registry's messages name the tenant and the reason, never a token.
    return new BusinessRuleError(
      TenantErrorCodes.TENANT_BOT_UNAVAILABLE,
      `This operator's bot cannot be used to ${action}: ${error.message}`,
    );
  }

  if (error instanceof GrammyError) {
    // By code rather than through isTokenRejection: that guard narrows GrammyError itself, which
    // would leave nothing to read in the branches below.
    if (TOKEN_REJECTION_CODES.has(error.error_code)) {
      return new BusinessRuleError(
        TenantErrorCodes.TENANT_BOT_UNAVAILABLE,
        `Telegram no longer accepts this operator's bot token (${error.error_code}: ` +
          `${error.description}). Replace the token from the dashboard.`,
      );
    }
    if (TRANSIENT_STATUS(error.error_code)) return unreachable(action);
    return new BusinessRuleError(
      TenantErrorCodes.TENANT_TELEGRAM_REJECTED,
      `Telegram refused to ${action}: ${redactWebhookPathToken(error.description)}`,
    );
  }

  if (error instanceof HttpError) return unreachable(action);

  return null;
}

function unreachable(action: string): ServiceUnavailableError {
  return new ServiceUnavailableError(
    TenantErrorCodes.TENANT_TELEGRAM_UNREACHABLE,
    `Telegram could not be reached to ${action}. Nothing was changed there; try again shortly.`,
  );
}
