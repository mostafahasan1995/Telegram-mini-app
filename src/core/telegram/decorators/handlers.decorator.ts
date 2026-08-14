/**
 * WHY decorators plus a discovery scan instead of a big `bot.command(...)` block in a module:
 * handlers live next to the feature they serve (deposit review, player onboarding), but grammY
 * needs them all attached to one Bot. Registering them by hand in a central file means every new
 * feature edits a shared file, and a handler that is written but never registered fails silently.
 *
 * These are plain metadata markers; TelegramHandlerRegistrar turns them into grammY listeners at
 * startup — and only in the worker role, since the api role never dispatches updates.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import { type FilterQuery } from 'grammy';

export const TELEGRAM_COMMAND_METADATA = 'telegram:command';
export const TELEGRAM_CALLBACK_METADATA = 'telegram:callback';
export const TELEGRAM_MESSAGE_METADATA = 'telegram:message';

/**
 * `@OnCommand('start')` — handles /start (and /start@thisbot in groups).
 * Pass several names to alias a command: `@OnCommand('deposits', 'queue')`.
 * Names are given WITHOUT the leading slash, exactly as grammY expects.
 */
export const OnCommand = (...commands: string[]): CustomDecorator<string> =>
  SetMetadata<string, string[]>(TELEGRAM_COMMAND_METADATA, commands);

/**
 * `@OnCallback('dep')` — handles every callback button whose data starts with `dep:`.
 * Matching is by NAMESPACE, not by full data, because the action and its arguments vary per button
 * (see @core/telegram/utils/callback-data.util).
 */
export const OnCallback = (namespace: string): CustomDecorator<string> =>
  SetMetadata<string, string>(TELEGRAM_CALLBACK_METADATA, namespace);

/**
 * `@OnMessage('message:photo')` — a grammY filter query, so the full filter language is available
 * ('message:text', 'message:document', ':photo', …). Defaults to every message.
 */
export const OnMessage = (...filters: FilterQuery[]): CustomDecorator<string> =>
  SetMetadata<string, FilterQuery[]>(
    TELEGRAM_MESSAGE_METADATA,
    filters.length > 0 ? filters : ['message'],
  );
