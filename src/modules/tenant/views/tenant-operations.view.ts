/**
 * The shapes the operator-operations routes answer, field for field the dashboard's zod schemas
 * (manager-account-dashboard src/types/tenant.ts: tenantWebhookSchema, tenantBotSetupSchema,
 * tenantHealthSchema, tenantProvisioningSchema), and the pure mappers that build them from what
 * Telegram answers.
 *
 * ══ A WEBHOOK URL LEAVES THE SERVER WITH ITS PATH TOKEN MASKED ══════════════════════════════════
 * The URL Telegram delivers to is `<API_BASE_URL>/telegram/webhook/<path token>`, and the path token
 * is half of the webhook's credentials: whoever holds it (and the secret) can post updates as that
 * operator. TenantView reports it only as `hasWebhookPath`, and the same rule holds here. Every
 * `url`, `webhookUrl` and Telegram `last_error_message` is passed through the log redaction, so the
 * host and path are visible and the token reads `[REDACTED]`.
 *
 * Nothing the console decides needs the raw token: whether delivery reaches THIS deployment is
 * `webhookMatches`, computed here on the unmasked values before masking. The console's copy for a
 * bot pointed elsewhere still shows where (the host), which is what an admin acts on.
 *
 * ══ BOOLEAN AND ERROR, NEVER A TRI-STATE ═════════════════════════════════════════════════════════
 * The provisioning report keeps each step as a boolean AND a nullable error, as the contract insists:
 * "did not run" and "ran and failed" send an operator to two different places.
 */
import type { WebhookInfo } from 'grammy/types';

import {
  REDACTED_PATH_SEGMENT,
  redactWebhookPathToken,
} from '@common/helpers/request-url-redaction.util';

import type { TenantView } from './tenant.view';

/** POST and DELETE /webhook. `url` is null when Telegram holds no webhook for the bot. */
export interface TenantWebhookView {
  url: string | null;
  registered: boolean;
  pendingUpdateCount: number;
  lastErrorMessage: string | null;
  lastErrorDate: string | null;
}

/** POST /bot-setup. */
export interface TenantBotSetupView {
  commandsSet: number;
  scopes: string[];
}

export interface TenantBotHealthView {
  ok: boolean;
  username: string | null;
  webhookUrl: string | null;
  webhookMatches: boolean;
  pendingUpdateCount: number;
  lastErrorMessage: string | null;
  lastErrorDate: string | null;
}

export interface TenantIchancyHealthView {
  ok: boolean;
  baseUrl: string;
  username: string;
  agentId: string;
  checkedAt: string;
  error: string | null;
  /** Minor units as a string; null when no sign-in succeeded, so there is no float to report. */
  floatMinor: string | null;
  /** False when no comparison was possible, which is never the same as healthy. */
  belowWatermark: boolean;
  /** Slugs of the OTHER operators on the same baseUrl + username: they share one Ichancy session. */
  sharesAgentWith: string[];
}

export interface TenantHealthView {
  bot: TenantBotHealthView;
  ichancy: TenantIchancyHealthView;
  counts: { players: number; deposits: number };
}

export interface TenantProvisioningView {
  webhookRegistered: boolean;
  /** Masked; null when registration did not succeed. */
  webhookUrl: string | null;
  webhookError: string | null;
  menusPushed: boolean;
  menuScopes: string[];
  menuError: string | null;
  activated: boolean;
  activationError: string | null;
  paymentMethodsCreated: number;
  paymentMethodsError: string | null;
  /** True while any provisioned method still points at a placeholder account. */
  paymentMethodsNeedAccounts: boolean;
  playersImported: number;
  playersImportError: string | null;
}

/** POST /v1/admin/tenants: `{ ...TenantView, provisioning }`, flattened as the contract answers it. */
export type TenantCreatedView = TenantView & { provisioning: TenantProvisioningView };

/** A webhook URL or a Telegram sentence, with any path token masked. */
export const maskWebhookText = (text: string): string => redactWebhookPathToken(text);

/**
 * Replaces the masked segment of a URL that is on this deployment's webhook path but carries a path
 * token other than this operator's (a stale token, a legacy registration).
 */
export const OTHER_PATH_TOKEN_SEGMENT = '[REDACTED:NOT-THIS-OPERATOR]';

/**
 * The URL health reports as where Telegram delivers. Masked like every other, with one refinement:
 * masked, a stale path token on THIS host reads exactly like the expected URL, and the console's
 * "delivering elsewhere" copy would then show an address that looks right. Saying the token differs
 * reveals nothing about either token.
 */
function maskedDeliveryUrl(url: string, expectedUrl: string | null): string {
  const masked = maskWebhookText(url);
  if (expectedUrl === null || url === expectedUrl) return masked;
  if (masked !== maskWebhookText(expectedUrl)) return masked;
  return masked.replace(REDACTED_PATH_SEGMENT, OTHER_PATH_TOKEN_SEGMENT);
}

/** Telegram's unix seconds, as the ISO string every date on this API is. */
function isoFromUnixSeconds(seconds: number | undefined): string | null {
  return seconds === undefined || seconds <= 0 ? null : new Date(seconds * 1_000).toISOString();
}

/** Telegram reports "no webhook" as an empty string, which the contract spells null. */
function urlOf(info: WebhookInfo): string | null {
  return info.url === undefined || info.url === '' ? null : info.url;
}

export function toWebhookView(info: WebhookInfo): TenantWebhookView {
  const url = urlOf(info);
  return {
    url: url === null ? null : maskWebhookText(url),
    registered: url !== null,
    pendingUpdateCount: info.pending_update_count,
    lastErrorMessage:
      info.last_error_message === undefined ? null : maskWebhookText(info.last_error_message),
    lastErrorDate: isoFromUnixSeconds(info.last_error_date),
  };
}

/**
 * The bot half of GET /health, from a getWebhookInfo that answered.
 *
 * `ok` is the dashboard's decided rule (TENANT-OPERATIONS.md §6, detail 2): the username is known AND
 * the webhook Telegram holds is exactly the URL this deployment expects AND there is no last delivery
 * error. `expectedUrl` is null for an operator with no path token, which can match nothing.
 */
export function botHealthFromWebhookInfo(
  username: string | null,
  info: WebhookInfo,
  expectedUrl: string | null,
): TenantBotHealthView {
  const url = urlOf(info);
  const webhookMatches = expectedUrl !== null && url === expectedUrl;
  const lastErrorMessage =
    info.last_error_message === undefined || info.last_error_message === ''
      ? null
      : maskWebhookText(info.last_error_message);
  return {
    ok: username !== null && webhookMatches && lastErrorMessage === null,
    username,
    webhookUrl: url === null ? null : maskedDeliveryUrl(url, expectedUrl),
    webhookMatches,
    pendingUpdateCount: info.pending_update_count,
    lastErrorMessage,
    lastErrorDate: isoFromUnixSeconds(info.last_error_date),
  };
}

/**
 * The bot half of GET /health when Telegram could not be asked at all (no working token, Telegram
 * unreachable). Nothing is known about delivery, so nothing claims it, and the reason goes where the
 * console shows "the last thing Telegram could not do".
 */
export function botHealthUnavailable(username: string | null, reason: string): TenantBotHealthView {
  return {
    ok: false,
    username,
    webhookUrl: null,
    webhookMatches: false,
    pendingUpdateCount: 0,
    lastErrorMessage: maskWebhookText(reason),
    lastErrorDate: null,
  };
}

/**
 * The Ichancy half of GET /health until per-operator Ichancy sign-in exists: a schema-valid "not
 * checked", never a success. `floatMinor` is null and `belowWatermark` false, which the contract
 * defines as "no comparison was possible". `sharesAgentWith` needs no sign-in and is real.
 */
export function ichancyHealthNotChecked(input: {
  baseUrl: string;
  username: string;
  agentId: string;
  sharesAgentWith: string[];
  reason: string;
  checkedAt: Date;
}): TenantIchancyHealthView {
  return {
    ok: false,
    baseUrl: input.baseUrl,
    username: input.username,
    agentId: input.agentId,
    checkedAt: input.checkedAt.toISOString(),
    error: input.reason,
    floatMinor: null,
    belowWatermark: false,
    sharesAgentWith: input.sharesAgentWith,
  };
}
