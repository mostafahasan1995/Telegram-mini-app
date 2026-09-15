/**
 * Which operators a Telegram CLI command acts on: exactly one named by slug, or every ACTIVE one.
 *
 * WHY THE CALLER MUST SAY WHICH, EVERY TIME: there is no deployment-wide bot any more, so a command
 * with no target has no meaning, and guessing one ("the only operator", "all of them") is how a
 * webhook ends up registered for a bot nobody meant to touch. Naming both, or neither, is refused.
 *
 * A single `--tenant` may name an operator in any status: the dashboard's own flow registers a new
 * operator's webhook while it is still SUSPENDED, before activation. `--all-active` is the bulk
 * repair (a new API_BASE_URL, a restored tunnel) and only touches operators that are serving.
 * Tenant zero is the platform and has no bot, so it is never a target.
 */
import { TenantStatus } from '@prisma/client';

import { type PrismaService } from '../../prisma/prisma.service';
import { TENANT_ZERO_ID } from '../../tenant/tenant.constants';

export interface TenantTargetOptions {
  /** A tenant slug, e.g. `default`. */
  tenant?: string;
  allActive?: boolean;
}

/** What the commands need to know about an operator. Sealed values stay sealed. */
export interface TenantTarget {
  id: string;
  slug: string;
  status: TenantStatus;
  webhookPathToken: string | null;
  webhookSecretEnc: string | null;
  adminChatId: bigint;
}

const TARGET_SELECT = {
  id: true,
  slug: true,
  status: true,
  webhookPathToken: true,
  webhookSecretEnc: true,
  adminChatId: true,
} as const;

export const TENANT_TARGET_USAGE =
  'Name exactly one target: --tenant <slug> for one operator, or --all-active for every ACTIVE operator.';

export async function resolveTenantTargets(
  prisma: PrismaService,
  options: TenantTargetOptions,
): Promise<TenantTarget[]> {
  const slug = options.tenant?.trim() ?? '';
  const allActive = options.allActive === true;
  if (slug.length > 0 === allActive) throw new Error(TENANT_TARGET_USAGE);

  if (allActive) {
    return prisma.tenant.findMany({
      where: { status: TenantStatus.ACTIVE, id: { not: TENANT_ZERO_ID } },
      select: TARGET_SELECT,
      orderBy: { slug: 'asc' },
    });
  }

  const row = await prisma.tenant.findUnique({ where: { slug }, select: TARGET_SELECT });
  if (row === null) throw new Error(`There is no operator with slug "${slug}".`);
  if (row.id === TENANT_ZERO_ID) {
    throw new Error(`"${slug}" is tenant zero, the platform. It has no Telegram bot.`);
  }
  return [row];
}
