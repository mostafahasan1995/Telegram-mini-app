/**
 * WHY this is a module with an assertion instead of a template literal at each call site:
 * Telegram caps `callback_data` at 64 BYTES, and the API rejects an oversized button with
 * BUTTON_DATA_INVALID at SEND time — not at build time. So the failure surfaces as "the admin
 * review card did not appear", long after the line that caused it, and only for the rows whose
 * payload happened to be long enough. Asserting at encode time turns that into an immediate,
 * attributable error.
 *
 * BYTES, NOT CHARACTERS. `'✅'.length === 1` but it is 3 bytes in UTF-8. A limit checked with
 * `.length` passes locally and fails on the first payload containing a non-ASCII character.
 *
 * The wire format is `ns:action[:arg]*`. `:` is forbidden inside segments rather than escaped:
 * escaping would spend bytes from a 64-byte budget to support a character none of our payloads
 * need (ids, shortIds, enum names, page numbers).
 */
import { ValidationError } from '@common/exceptions/app.exception';
import { CommonErrorCodes } from '@common/exceptions/error-codes';

export const CALLBACK_DATA_MAX_BYTES = 64;
export const CALLBACK_DATA_SEPARATOR = ':';

export interface CallbackData {
  /** Feature namespace, e.g. "dep" for deposits. Used to route the callback to a handler. */
  ns: string;
  /** What to do, e.g. "approve". */
  action: string;
  args: string[];
}

export class CallbackDataTooLongError extends ValidationError {
  constructor(encoded: string, bytes: number) {
    super(
      `Callback data is ${bytes} bytes; Telegram allows ${CALLBACK_DATA_MAX_BYTES}`,
      { encoded, bytes, max: CALLBACK_DATA_MAX_BYTES },
      CommonErrorCodes.CALLBACK_DATA_TOO_LONG,
    );
  }
}

function assertSegment(value: string, label: string, allowEmpty: boolean): void {
  if (!allowEmpty && value.length === 0) {
    throw new ValidationError(
      `Callback data ${label} must not be empty`,
      { label },
      CommonErrorCodes.CALLBACK_DATA_MALFORMED,
    );
  }
  if (value.includes(CALLBACK_DATA_SEPARATOR)) {
    throw new ValidationError(
      `Callback data ${label} must not contain "${CALLBACK_DATA_SEPARATOR}"`,
      { label, value },
      CommonErrorCodes.CALLBACK_DATA_MALFORMED,
    );
  }
}

/**
 * Builds `ns:action[:arg]*`, throwing if the result cannot fit in a Telegram button.
 * Numbers are stringified for convenience; everything else must already be a string.
 */
export function encodeCallbackData(
  ns: string,
  action: string,
  ...args: (string | number)[]
): string {
  assertSegment(ns, 'namespace', false);
  assertSegment(action, 'action', false);

  const segments = args.map((arg) => String(arg));
  for (const segment of segments) assertSegment(segment, 'argument', true);

  const encoded = [ns, action, ...segments].join(CALLBACK_DATA_SEPARATOR);
  const bytes = Buffer.byteLength(encoded, 'utf8');
  if (bytes > CALLBACK_DATA_MAX_BYTES) throw new CallbackDataTooLongError(encoded, bytes);

  return encoded;
}

/**
 * Parses callback data back into its parts.
 *
 * Returns null instead of throwing, because the input is whatever was baked into a button that may
 * be arbitrarily old — a message from before a deploy, or a chat export someone replayed. An
 * unrecognised button must be answered politely, not crash the update handler.
 */
export function decodeCallbackData(raw: string | undefined | null): CallbackData | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (Buffer.byteLength(raw, 'utf8') > CALLBACK_DATA_MAX_BYTES) return null;

  const [ns, action, ...args] = raw.split(CALLBACK_DATA_SEPARATOR);
  if (ns === undefined || ns.length === 0) return null;
  if (action === undefined || action.length === 0) return null;

  return { ns, action, args };
}

/** True when `raw` is callback data in `ns` — the cheap check a router does before decoding. */
export function isCallbackDataFor(raw: string | undefined | null, ns: string): boolean {
  return decodeCallbackData(raw)?.ns === ns;
}

/**
 * How many bytes are left for arguments after `ns:action:`. Lets a caller decide between a uuid
 * (36 bytes) and a shortId (10) BEFORE building a keyboard that cannot be sent.
 */
export function callbackDataBudget(ns: string, action: string): number {
  const prefix = `${ns}${CALLBACK_DATA_SEPARATOR}${action}${CALLBACK_DATA_SEPARATOR}`;
  return CALLBACK_DATA_MAX_BYTES - Buffer.byteLength(prefix, 'utf8');
}
