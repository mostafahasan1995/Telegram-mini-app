/**
 * Where a new operator's defaults come from, as pure functions so the rules can be tested without a
 * database.
 *
 * TWO RULES LIVE HERE, and both are about telling a real value from a placeholder:
 *
 *  1. SEEDING. PlatformDefaults are copied from this deployment's env the first time anything reads
 *     them (dashboard docs/API-CONTRACT.md: "Seeded from this deployment's `.env` the first time
 *     anything reads it, so an existing deployment keeps exactly the values it already had without
 *     anybody running a script"). `platformDefaultsFromEnv` is that copy.
 *
 *  2. THE AGENT ID FALLBACK. `ichancyAgentId` is the one default that cannot be derived: Ichancy
 *     `signin()` returns a token pair and nothing else. The contract's order is supplied ->
 *     PlatformDefaults -> tenant zero's -> 400 naming the field. But tenant zero is the platform, and
 *     the migration fills its NOT NULL agent column with the literal `unused`. Falling back to that
 *     would register real players under an agent called "unused", so a placeholder at any step is
 *     treated as absent and the chain moves on.
 */
import type { AppConfigService } from '@core/config/config.service';
import { isTenantSecretSentinel } from '@core/tenant/services/tenant-secret.service';

/** The six values a PlatformDefaults row holds, in the column types Prisma uses. */
export interface PlatformDefaultsValues {
  ichancyBaseUrl: string;
  ichancyAgentId: string | null;
  currencyCode: string;
  dualApprovalThresholdMinor: bigint;
  agentFloatLowWatermarkMinor: bigint;
  depositExpiryMinutes: number;
}

/**
 * True for a value that only occupies an agent-id column: empty, or one of the literals the
 * migration and the seeds write where there is nothing truthful to put (`unused`, `REPLACE-ME`,
 * `SEED-PLACEHOLDER-…`). Those are the same family the tenant secret columns use, written by the
 * same statements, so the same prefix test recognises them.
 */
export function isInertAgentId(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  const trimmed = value.trim();
  return trimmed.length === 0 || isTenantSecretSentinel(trimmed);
}

/** A real agent id, trimmed, or null when the value is a placeholder. */
function realAgentId(value: string | null | undefined): string | null {
  return isInertAgentId(value) ? null : (value ?? '').trim();
}

/** This deployment's env, shaped as a PlatformDefaults row. Reads only validated config. */
export function platformDefaultsFromEnv(
  config: Pick<AppConfigService, 'ichancy' | 'limits'>,
): PlatformDefaultsValues {
  return {
    ichancyBaseUrl: config.ichancy.baseUrl,
    // ICHANCY_AGENT_ID is required by the env schema, so a deployment that never had a house agent
    // carries a placeholder there. Storing it would make the next creation's fallback succeed with
    // a value nobody chose.
    ichancyAgentId: realAgentId(config.ichancy.agentId),
    currencyCode: config.ichancy.currency,
    dualApprovalThresholdMinor: config.limits.dualApprovalThresholdMinor,
    agentFloatLowWatermarkMinor: config.limits.agentFloatLowWatermarkMinor,
    depositExpiryMinutes: config.limits.depositExpiryMinutes,
  };
}

/**
 * The agent id a new operator gets, or null when there is nowhere left to look, which is the
 * caller's cue to refuse with a 400 naming `ichancyAgentId`.
 *
 * Two operators sharing an agent id is allowed; it is how a second operator gets tested.
 */
export function resolveIchancyAgentId(
  supplied: string | null | undefined,
  platformDefault: string | null | undefined,
  tenantZeroAgentId: string | null | undefined,
): string | null {
  return realAgentId(supplied) ?? realAgentId(platformDefault) ?? realAgentId(tenantZeroAgentId);
}
