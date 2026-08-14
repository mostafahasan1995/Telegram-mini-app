/**
 * Cross-module contract for the deposit approval path — same reasoning as PLAYER_LINK_PORT.
 *
 * The module that approves deposits must ask "may this admin release this amount alone?", and it
 * cannot import this module (eslint-plugin-boundaries forbids modules/A -> modules/B). A plain
 * string token needs no import: the consumer declares its own structurally-identical interface and
 * the binding is made in the root module.
 *
 * PROPER FIX (for whoever owns src/core): move `ApprovalLimitPort` and the token into
 * `src/core/approval/`, next to the other ports. This file is shaped so that becomes a re-export.
 */
import type { AdminRole } from '@prisma/client';
import type { Tx } from '@core/prisma/tx.type';

export const APPROVAL_LIMIT_PORT = 'APPROVAL_LIMIT_PORT';

export type ApprovalDecisionValue = 'ALLOWED' | 'NEEDS_SECOND' | 'DENIED';

export interface ApprovalLimitPort {
  /**
   * `tx` is FIRST and is not optional: the ceiling must be evaluated against the same snapshot as
   * the approval it authorizes, or two concurrent approvals can both pass one budget.
   */
  evaluate(
    tx: Tx,
    admin: { readonly adminUserId: string; readonly role: AdminRole },
    amountMinor: bigint,
    currencyCode: string,
  ): Promise<ApprovalDecisionValue>;
}
