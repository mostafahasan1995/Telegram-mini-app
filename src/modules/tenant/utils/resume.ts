/**
 * Whether a SUSPENDED operator may go back to ACTIVE without a fresh Ichancy sign-in.
 *
 * WHY THIS EXISTS AT ALL: the contract makes activation a real sign-in with the operator's own
 * credentials, and that sign-in does not exist in this deployment yet. Refusing every activation
 * would make a suspension one-way, while the console's suspend dialog tells the admin, right before
 * they confirm, that "you can activate the tenant again at any time". So an operator stranded by a
 * suspension is a real outage on the money path, and it could only be undone by editing the database.
 *
 * WHY RESUMING IS NOT FAKING A VERIFICATION: what activation protects against is a wrong agent id
 * registering real players under another operator's agent. An operator that was ACTIVE, was
 * suspended, and still holds exactly the Ichancy details it was serving with raises no new question.
 * Whatever made those details acceptable before the suspension still holds, and nothing a sign-in
 * would check has changed. So a resume is allowed only when BOTH are true:
 *
 *  1. its most recent status decision is a `tenant.suspended` row, which is only ever written for an
 *     ACTIVE -> SUSPENDED move. A new operator (created SUSPENDED) has no such row and still needs the
 *     real sign-in;
 *  2. the Ichancy fingerprint recorded on that row equals the one the row holds now. Any change of
 *     base URL, username, sealed password or agent id since the suspension means the details were
 *     never proven, and the real sign-in is required again.
 *
 * The resume is audited as exactly what it is (`signIn: false`), never as a verification.
 *
 * WHY A DIGEST AND NOT THE VALUES: the audit row is read by every auditor of that operator. The
 * digest proves "unchanged" without putting a username, an agent id or any form of the sealed
 * password into the log. It is a SHA-256 of values that already include ciphertext, so it cannot be
 * turned back into a password.
 */
import { createHash } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import { readAuditContext } from '@core/audit/audit.types';

import { TenantAuditActions } from '../tenant-admin.constants';

/** The columns a sign-in would check. Loaded only to fingerprint them, never returned. */
export const ICHANCY_IDENTITY_SELECT = {
  ichancyBaseUrl: true,
  ichancyUsername: true,
  ichancyPasswordEnc: true,
  ichancyAgentId: true,
} as const satisfies Prisma.TenantSelect;

export type IchancyIdentity = Prisma.TenantGetPayload<{ select: typeof ICHANCY_IDENTITY_SELECT }>;

/** Key inside the audit row's `$meta` that carries the fingerprint. */
export const ICHANCY_FINGERPRINT_KEY = 'ichancyFingerprint';

/** The status decisions, newest first, that can answer "was it serving before?". */
export const STATUS_DECISION_ACTIONS: readonly string[] = [
  TenantAuditActions.TENANT_SUSPENDED,
  TenantAuditActions.TENANT_ACTIVATED,
];

export function ichancyFingerprint(identity: IchancyIdentity): string {
  // A JSON array rather than a joined string, so no value can shift into its neighbour's position.
  const canonical = JSON.stringify([
    identity.ichancyBaseUrl,
    identity.ichancyUsername,
    identity.ichancyPasswordEnc,
    identity.ichancyAgentId,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface StatusDecision {
  action: string;
  after: Prisma.JsonValue;
}

/**
 * True only for an operator whose latest status decision was a suspension recorded with a
 * fingerprint equal to the current one. A missing row, a row without a fingerprint (for example one
 * written before fingerprints existed), or a different fingerprint all answer false. Every doubt
 * resolves to "needs the real sign-in".
 */
export function mayResumeWithoutSignIn(
  latest: StatusDecision | null,
  current: IchancyIdentity,
): boolean {
  if (latest === null || latest.action !== TenantAuditActions.TENANT_SUSPENDED) return false;
  const recorded = readAuditContext(latest.after)?.[ICHANCY_FINGERPRINT_KEY];
  return typeof recorded === 'string' && recorded === ichancyFingerprint(current);
}
