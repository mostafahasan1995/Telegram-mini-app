import type { AuditService } from '@core/audit/audit.service';
import type { LockService } from '@core/cache/lock.service';
import type { PrismaService } from '@core/prisma/prisma.service';

import { REFERRAL_BOUND_ACTION, ReferralService } from './referral.service';

const PLAYER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const REFERRER_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const PLAYER_TG = 111111n;
const REFERRER_TG = 222222n;

function harness(options: { existingBinding?: unknown; referrerId?: string | null } = {}) {
  const auditFindFirst = jest.fn().mockResolvedValue(options.existingBinding ?? null);
  const playerFindUnique = jest
    .fn()
    .mockResolvedValue(
      options.referrerId === null ? null : { id: options.referrerId ?? REFERRER_ID },
    );
  const auditWrite = jest.fn().mockResolvedValue('audit-1');

  const prisma = {
    auditLog: { findFirst: auditFindFirst },
    player: { findUnique: playerFindUnique },
    runInTransaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ auditLog: { findFirst: auditFindFirst } }),
    ),
  } as unknown as PrismaService;

  const acquire = jest
    .fn()
    .mockResolvedValue({ key: 'k', token: 't', acquiredAt: Date.now(), ttlMs: 5_000 });
  const release = jest.fn().mockResolvedValue(true);
  const locks = { acquire, release } as unknown as LockService;

  const audit = { write: auditWrite } as unknown as AuditService;

  return {
    service: new ReferralService(prisma, locks, audit),
    auditFindFirst,
    playerFindUnique,
    auditWrite,
    acquire,
    release,
  };
}

function boundRow(overrides: Record<string, unknown> = {}) {
  return {
    after: {
      referrerPlayerId: REFERRER_ID,
      referrerTelegramUserId: REFERRER_TG.toString(),
      source: 'telegram:/start',
      payload: `ref_${REFERRER_TG}`,
      ...overrides,
    },
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('ReferralService.parseStartPayload', () => {
  const { service } = harness();

  it('accepts the documented deep-link forms', () => {
    expect(service.parseStartPayload('ref_222222')).toBe(222222n);
    expect(service.parseStartPayload('ref-222222')).toBe(222222n);
    expect(service.parseStartPayload('222222')).toBe(222222n);
    expect(service.parseStartPayload('  ref_222222  ')).toBe(222222n);
  });

  it('ignores payloads that are not referrals, rather than rejecting them', () => {
    // Somebody else's deep link (a campaign tag, a deposit link) must pass through silently.
    for (const payload of ['campaign_summer', 'dep_K7Q2ZP9V3M', '', '   ', 'ref_', 'ref_abc']) {
      expect(service.parseStartPayload(payload)).toBeNull();
    }
  });

  it('ignores null, undefined and non-strings', () => {
    expect(service.parseStartPayload(null)).toBeNull();
    expect(service.parseStartPayload(undefined)).toBeNull();
  });

  it('rejects a zero or over-long id', () => {
    expect(service.parseStartPayload('ref_0')).toBeNull();
    expect(service.parseStartPayload(`ref_${'9'.repeat(25)}`)).toBeNull();
  });

  it('preserves a 64-bit Telegram id exactly', () => {
    // The whole reason ids are bigint: 7123456789012345 does not survive a JS number.
    expect(service.parseStartPayload('ref_7123456789012345')).toBe(7123456789012345n);
  });
});

describe('ReferralService.bindFromStartPayload', () => {
  it('binds a referrer once and records it', async () => {
    const { service, auditWrite } = harness();

    const result = await service.bindFromStartPayload(
      PLAYER_ID,
      PLAYER_TG,
      `ref_${REFERRER_TG}`,
      'telegram:/start',
    );

    expect(result.outcome).toBe('BOUND');
    expect(result.binding?.referrerPlayerId).toBe(REFERRER_ID);
    expect(auditWrite).toHaveBeenCalledTimes(1);

    const written = auditWrite.mock.calls[0]?.[1] as {
      action: string;
      subjectId: string;
      after: Record<string, unknown>;
    };
    expect(written.action).toBe(REFERRAL_BOUND_ACTION);
    expect(written.subjectId).toBe(PLAYER_ID);
    expect(written.after.referrerPlayerId).toBe(REFERRER_ID);
    // The telegram id must be a string in the row: it is 64-bit and passes through JSON.
    expect(typeof written.after.referrerTelegramUserId).toBe('string');
  });

  it('refuses a self-referral without touching the database', async () => {
    const { service, playerFindUnique, auditWrite } = harness();

    const result = await service.bindFromStartPayload(
      PLAYER_ID,
      PLAYER_TG,
      `ref_${PLAYER_TG}`,
      'telegram:/start',
    );

    expect(result.outcome).toBe('IGNORED_SELF');
    expect(playerFindUnique).not.toHaveBeenCalled();
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it('ignores a payload naming a referrer we do not know', async () => {
    const { service, auditWrite } = harness({ referrerId: null });

    const result = await service.bindFromStartPayload(
      PLAYER_ID,
      PLAYER_TG,
      `ref_${REFERRER_TG}`,
      'telegram:/start',
    );

    expect(result.outcome).toBe('IGNORED_UNKNOWN_REFERRER');
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it('BINDS ONCE — a second payload never overwrites the first', async () => {
    const { service, auditWrite } = harness({ existingBinding: boundRow() });

    const result = await service.bindFromStartPayload(
      PLAYER_ID,
      PLAYER_TG,
      'ref_999999',
      'telegram:/start',
    );

    expect(result.outcome).toBe('ALREADY_BOUND');
    expect(result.binding?.referrerPlayerId).toBe(REFERRER_ID);
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it('re-checks INSIDE the lock, so a concurrent binder cannot produce a second row', async () => {
    // The pre-lock read says "unbound"; by the time the lock is held, the other request has
    // committed. Without the second read both callers would write a binding.
    const { service, auditFindFirst, auditWrite } = harness();
    auditFindFirst.mockResolvedValueOnce(null).mockResolvedValue(boundRow());

    const result = await service.bindFromStartPayload(
      PLAYER_ID,
      PLAYER_TG,
      `ref_${REFERRER_TG}`,
      'telegram:/start',
    );

    expect(result.outcome).toBe('ALREADY_BOUND');
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it('steps aside when another call holds the lock', async () => {
    const { service, acquire, auditWrite } = harness();
    acquire.mockResolvedValue(null);

    const result = await service.bindFromStartPayload(
      PLAYER_ID,
      PLAYER_TG,
      `ref_${REFERRER_TG}`,
      'telegram:/start',
    );

    expect(result.outcome).toBe('CONTENDED');
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it('always releases the lock, including on the already-bound path', async () => {
    const { service, auditFindFirst, release } = harness();
    auditFindFirst.mockResolvedValueOnce(null).mockResolvedValue(boundRow());

    await service.bindFromStartPayload(PLAYER_ID, PLAYER_TG, `ref_${REFERRER_TG}`, 'x');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when there is no payload', async () => {
    const { service, auditFindFirst, acquire } = harness();

    const result = await service.bindFromStartPayload(PLAYER_ID, PLAYER_TG, null, 'x');

    expect(result.outcome).toBe('IGNORED_NO_PAYLOAD');
    expect(auditFindFirst).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });
});

describe('ReferralService.findBinding', () => {
  it('reads the binding back out of the audit row', async () => {
    const { service } = harness({ existingBinding: boundRow() });
    const binding = await service.findBinding(PLAYER_ID);

    expect(binding).toEqual({
      referrerPlayerId: REFERRER_ID,
      referrerTelegramUserId: REFERRER_TG.toString(),
      source: 'telegram:/start',
      payload: `ref_${REFERRER_TG}`,
      boundAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('reads the FIRST row, so the earliest binding wins', async () => {
    const { service, auditFindFirst } = harness({ existingBinding: boundRow() });
    await service.findBinding(PLAYER_ID);

    const args = auditFindFirst.mock.calls[0]?.[0] as { orderBy: { createdAt: string } };
    expect(args.orderBy.createdAt).toBe('asc');
  });

  it('treats an unreadable historical row as BOUND, never as unbound', async () => {
    // Reading a malformed row as "no referrer" would permit a second binding — the one thing this
    // component exists to prevent.
    const { service } = harness({ existingBinding: boundRow({ referrerPlayerId: 42 }) });
    await expect(service.findBinding(PLAYER_ID)).resolves.not.toBeNull();
  });

  it('returns null when the player has no binding', async () => {
    const { service } = harness();
    await expect(service.findBinding(PLAYER_ID)).resolves.toBeNull();
  });
});
