/**
 * The field rules both PATCH routes share, taken from the dashboard's own form
 * (manager-account-dashboard src/features/tenants/tenant-form-dialog.tsx: CHAT_ID_RE, DIGITS_RE,
 * CURRENCY_RE, HTTPS_RE) plus the one check a regex cannot make: that the number fits the BIGINT
 * column it is headed for.
 *
 * WHY THE RANGE CHECK MATTERS: `^\d+$` accepts twenty nines. Postgres would refuse that with
 * "value out of range for type bigint", which reaches the client as a 500 with no field named, for a
 * mistake that is plainly the caller's. Refusing it here makes it a 400 naming the field.
 *
 * WHY THE MESSAGES START WITH THE FIELD NAME: the global filter hoists them into `details.fields`, and
 * the console prints them after the error message ("The request payload is invalid. (adminChatId must
 * be ...)"). A sentence that does not say which field is a sentence the operator has to guess about.
 */
import { ValidateBy, type ValidationOptions } from 'class-validator';

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** A Telegram chat id: a whole number, negative for groups and channels. */
export const CHAT_ID_PATTERN = /^-?\d{1,19}$/;
/** Minor units: digits only, no sign, no decimal point. */
export const MINOR_UNITS_PATTERN = /^\d{1,19}$/;
export const HTTPS_URL_PATTERN = /^https:\/\/\S+$/;
/** Ichancy agent ids are numeric. The bound only keeps an absurd value out of the column. */
export const AGENT_ID_PATTERN = /^\d{1,32}$/;
export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
/**
 * What BotFather hands out: a numeric bot id, a colon, and at least 30 URL-safe characters. The
 * dashboard's BOT_TOKEN_RE, so a token the form accepts is never refused here for its shape.
 */
export const BOT_TOKEN_PATTERN = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;
/** A caller-chosen slug: the dashboard's SLUG_RE, 3–32 characters, starting with a letter. */
export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

export const isDefined = (_object: object, value: unknown): boolean => value !== undefined;

export const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Upper-cased before validation, as the create form does: "nsp" is a typing accident, not a code. */
export const upperCaseTrimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

function fitsInt64(digits: string): boolean {
  const value = BigInt(digits);
  return value >= INT64_MIN && value <= INT64_MAX;
}

/** A string holding a Telegram chat id that fits a signed 64-bit column. */
export function IsTelegramChatId(validationOptions?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isTelegramChatId',
      validator: {
        validate: (value: unknown): boolean =>
          typeof value === 'string' && CHAT_ID_PATTERN.test(value) && fitsInt64(value),
        defaultMessage: (args): string =>
          `${args?.property ?? 'value'} must be a Telegram chat id sent as a string: a whole number, ` +
          'negative for a group or channel',
      },
    },
    validationOptions,
  );
}

/** A string of minor units that fits a BIGINT column. */
export function IsMinorUnits(validationOptions?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isMinorUnits',
      validator: {
        validate: (value: unknown): boolean =>
          typeof value === 'string' && MINOR_UNITS_PATTERN.test(value) && fitsInt64(value),
        defaultMessage: (args): string =>
          `${args?.property ?? 'value'} must be minor units sent as a string: digits only, ` +
          'no decimal point (150000 means 1,500.00)',
      },
    },
    validationOptions,
  );
}
