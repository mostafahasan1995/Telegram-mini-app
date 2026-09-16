/**
 * Reads an operator's Ichancy agent from its tenant row. The only place credentials for an Ichancy
 * call come from.
 *
 * WHY THERE IS NO CACHE: the row is one primary-key read, and a cached copy is the thing that would
 * let a worker keep signing in with a password or registering under an agent id a platform admin has
 * just replaced, until the entry expired. Opening the sealed password is a single AES-GCM decrypt
 * under a key derived once. Correctness on the money path is worth one indexed read per call.
 *
 * WHY THE ENV ACCOUNT IS NEVER A FALLBACK: ICHANCY_USERNAME / ICHANCY_PASSWORD / ICHANCY_AGENT_ID
 * describe at most the deployment's first operator, and only the seed reads them. Falling back to them
 * for an operator whose row is incomplete would register that operator's players under another agent
 * and pay its credits from another float. An incomplete row is AGENT_UNCONFIGURED instead.
 *
 * NOTHING HERE LOGS, and no error carries the password or any form of it.
 */
import { createHmac } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { AppConfigService } from '@core/config/config.service';
import { deriveKey } from '@core/crypto/secret-box.util';
import { PrismaService } from '@core/prisma/prisma.service';
import {
  TenantSecretService,
  isTenantSecretError,
  isTenantSecretSentinel,
} from '@core/tenant/services/tenant-secret.service';
import { TENANT_ZERO_ID } from '@core/tenant/tenant.constants';
import { getEffectiveTenantId } from '@core/tenant/tenant.storage';

import {
  IchancyAgentErrorCodes,
  IchancyAgentUnavailableError,
  ichancyAgentKey,
  normaliseIchancyBaseUrl,
  type IchancyAgent,
  type IchancyAgentCandidate,
  type IchancyAgentResolver,
} from './ichancy-agent';

/**
 * HKDF label of the credential digest key. Changing it re-keys every stored session's digest, which
 * makes every worker sign in once: harmless, but not something to do by accident.
 */
export const ICHANCY_CREDENTIAL_DIGEST_INFO = 'ichancy-agent-credential-digest:v1';

/** A username or agent id that only occupies its column: empty, `unused`, `REPLACE-ME`, a seed sentinel. */
function isInert(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || isTenantSecretSentinel(trimmed);
}

@Injectable()
export class TenantIchancyAgentResolver implements IchancyAgentResolver {
  private readonly digestKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: TenantSecretService,
    config: AppConfigService,
  ) {
    this.digestKey = deriveKey(config.jwt.secret.trim(), ICHANCY_CREDENTIAL_DIGEST_INFO);
  }

  async forCurrentTenant(): Promise<IchancyAgent> {
    const tenantId = getEffectiveTenantId();
    if (tenantId === undefined) {
      throw new IchancyAgentUnavailableError(
        IchancyAgentErrorCodes.NO_TENANT_CONTEXT,
        'No operator in the tenant context, so there is no Ichancy agent to call with. Wrap the ' +
          'worker, cron or CLI entry point in runWithTenant() for the operator that owns the work.',
      );
    }
    return this.forTenant(tenantId);
  }

  async forTenant(tenantId: string): Promise<IchancyAgent> {
    if (tenantId === TENANT_ZERO_ID) {
      throw new IchancyAgentUnavailableError(
        IchancyAgentErrorCodes.PLATFORM_HAS_NO_AGENT,
        'Tenant zero is the platform and has no Ichancy agent. Point the request at an operator.',
      );
    }

    const row = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        ichancyBaseUrl: true,
        ichancyUsername: true,
        ichancyPasswordEnc: true,
        ichancyAgentId: true,
        currencyCode: true,
      },
    });
    if (row === null) {
      throw new IchancyAgentUnavailableError(
        IchancyAgentErrorCodes.TENANT_NOT_FOUND,
        `Operator ${tenantId} does not exist, so it has no Ichancy agent.`,
      );
    }

    const missing = [
      ...(isInert(row.ichancyBaseUrl) ? ['base URL'] : []),
      ...(isInert(row.ichancyUsername) ? ['username'] : []),
      ...(isInert(row.ichancyAgentId) ? ['agent id'] : []),
    ];
    if (missing.length > 0) {
      throw new IchancyAgentUnavailableError(
        IchancyAgentErrorCodes.AGENT_UNCONFIGURED,
        `The Ichancy ${missing.join(', ')} of operator ${tenantId} is not set; set it from the dashboard.`,
      );
    }

    let password: string;
    try {
      password = this.secrets.openIchancyPassword(row);
    } catch (error: unknown) {
      if (!isTenantSecretError(error)) throw error;
      // The secret service's message names the operator and the field, never a value.
      throw new IchancyAgentUnavailableError(IchancyAgentErrorCodes.AGENT_UNCONFIGURED, error.message);
    }

    return this.fromCandidate({
      tenantId: row.id,
      baseUrl: row.ichancyBaseUrl,
      username: row.ichancyUsername,
      password,
      agentId: row.ichancyAgentId,
      currency: row.currencyCode,
    });
  }

  fromCandidate(candidate: IchancyAgentCandidate): IchancyAgent {
    const username = candidate.username.trim();
    const agentKey = ichancyAgentKey(candidate.baseUrl, username);
    // A JSON array, so no value can shift into its neighbour's position. The username is the same
    // trimmed string the key was built from: were one of them case-folded and the other not, two
    // operators could share a key with different digests and sign each other out on every call.
    const credentialDigest = createHmac('sha256', this.digestKey)
      .update(JSON.stringify([agentKey, username, candidate.password]), 'utf8')
      .digest('hex');

    return {
      tenantId: candidate.tenantId,
      baseUrl: normaliseIchancyBaseUrl(candidate.baseUrl),
      username,
      password: candidate.password,
      agentId: candidate.agentId.trim(),
      currency: candidate.currency,
      agentKey,
      credentialDigest,
    };
  }
}
