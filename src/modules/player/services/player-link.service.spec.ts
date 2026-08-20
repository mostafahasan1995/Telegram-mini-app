/**
 * THE ONE REGISTRATION PATH — the class every other test in this area mocks away.
 *
 * ══ WHY THIS FILE HAD TO BE WRITTEN ═══════════════════════════════════════════════════════════
 * PlayerLinkService had no spec of its own. The backfill's spec stubs `ensureLinked`, the credit
 * service's spec stubs it, the /start handler's spec stubs it — so the single property the whole
 * design rests on was asserted precisely nowhere:
 *
 *     Ichancy's registerPlayer is NOT idempotent, has no key we can dedupe on, and their agent API
 *     has NO deletePlayer. A second call therefore creates a second casino account under our agent
 *     that cannot be removed by us, by them, or by an operator.
 *
 * Everything below exists to pin the four mechanisms that stop that from happening — the per-player
 * lock, the re-read INSIDE it, the compare-and-set persist, and persisting NOTHING when the outcome
 * is unknown — and to prove that each one is reached by the code rather than merely described in a
 * comment above it.
 */
import { LockService } from '@core/cache/lock.service';
import { type AppConfigService } from '@core/config/config.service';
import { type AuditService } from '@core/audit/audit.service';
import { type IchancyPort } from '@core/ichancy';
import { ichancyAmbiguous, ichancyOk, ichancyRejected } from '@core/ichancy/ichancy.types';
import { type PrismaService } from '@core/prisma/prisma.service';

import { PLAYER_LINK_LOCK_TTL_MS, PlayerErrorCodes, playerLinkLockKey } from '../player.constants';
import { type PlayerRepository } from '../repositories/player.repository';
import { PlayerLinkService } from './player-link.service';

const PLAYER_ID = 'player-hasan';
const TELEGRAM_ID = 1_743_150_171n;
const ICHANCY_ID = '459424640';

/** Only the columns this service reads. Cast at the seam so the Prisma model stays out of here. */
function playerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PLAYER_ID,
    telegramUserId: TELEGRAM_ID,
    status: 'PENDING_ICHANCY',
    ichancyPlayerId: null,
    ichancyLogin: null,
    ichancyEmail: null,
    ichancyPasswordEnc: null,
    ...overrides,
  };
}

const HANDLE = {
  key: LockService.key(playerLinkLockKey(PLAYER_ID)),
  token: 'fencing-token',
  acquiredAt: 0,
  ttlMs: PLAYER_LINK_LOCK_TTL_MS,
};

interface Harness {
  readonly service: PlayerLinkService;
  readonly findById: jest.Mock;
  readonly linkIchancyAccount: jest.Mock;
  readonly ensurePlayer: jest.Mock;
  readonly acquire: jest.Mock;
  readonly release: jest.Mock;
  readonly auditWrite: jest.Mock;
}

function build(
  options: {
    /** Successive findById answers, in call order. The LAST one repeats. */
    rows?: Record<string, unknown>[];
    lockHeldByAnotherCaller?: boolean;
    linkWins?: boolean;
  } = {},
): Harness {
  const rows = options.rows ?? [playerRow()];
  let call = 0;
  const findById = jest.fn(() => {
    const row = rows[Math.min(call, rows.length - 1)];
    call += 1;
    return Promise.resolve(row ?? null);
  });

  const linkIchancyAccount = jest.fn().mockResolvedValue(options.linkWins ?? true);
  const players = { findById, linkIchancyAccount } as unknown as PlayerRepository;

  const prisma = {
    runInTransaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn({})),
  } as unknown as PrismaService;

  const acquire = jest
    .fn()
    .mockResolvedValue(options.lockHeldByAnotherCaller === true ? null : HANDLE);
  const release = jest.fn().mockResolvedValue(true);
  const locks = { acquire, release } as unknown as LockService;

  const auditWrite = jest.fn().mockResolvedValue(undefined);
  const audit = { write: auditWrite } as unknown as AuditService;

  const ensurePlayer = jest.fn().mockResolvedValue(ichancyOk({ ichancyPlayerId: ICHANCY_ID, created: true }));
  const ichancy = { ensurePlayer } as unknown as IchancyPort;

  const config = {
    jwt: { secret: 'unit-test-root-secret-not-a-real-one' },
    ichancy: { playerEmailDomain: 'example.com' },
  } as unknown as AppConfigService;

  const service = new PlayerLinkService(prisma, players, locks, audit, config, ichancy);
  return { service, findById, linkIchancyAccount, ensurePlayer, acquire, release, auditWrite };
}

describe('PlayerLinkService — the lock around a non-idempotent registration', () => {
  it('takes the per-player lock, with the documented key and TTL, before registering', async () => {
    const h = build();

    await h.service.ensureLinked(PLAYER_ID);

    expect(h.acquire).toHaveBeenCalledTimes(1);
    const [key, ttl] = h.acquire.mock.calls[0] as [string, number];
    // Pinned against the constants rather than a literal: the house rule names this exact lock, and
    // a rename that silently changed the key would let two linkers run at once again.
    expect(key).toBe(LockService.key(playerLinkLockKey(PLAYER_ID)));
    expect(ttl).toBe(PLAYER_LINK_LOCK_TTL_MS);
  });

  it('registers NOTHING when the lock is held by another caller', async () => {
    const h = build({ lockHeldByAnotherCaller: true });

    await expect(h.service.ensureLinked(PLAYER_ID)).rejects.toMatchObject({
      errorCode: PlayerErrorCodes.ICHANCY_LINK_IN_PROGRESS,
    });
    // The whole point. Failing closed here is what makes the backfill's retry safe.
    expect(h.ensurePlayer).not.toHaveBeenCalled();
  });

  it('re-reads INSIDE the lock and does not register a player linked while we queued', async () => {
    // The exact race the backfill creates: /start and the cron both want this row, /start wins, and
    // the cron must notice between acquiring the lock and calling Ichancy. A service that trusted
    // its pre-lock read would register a second, undeletable account here.
    const h = build({
      rows: [playerRow(), playerRow({ ichancyPlayerId: ICHANCY_ID, ichancyLogin: 'p1743150171_ab' })],
    });

    const link = await h.service.ensureLinked(PLAYER_ID);

    expect(h.ensurePlayer).not.toHaveBeenCalled();
    expect(link.ichancyPlayerId).toBe(ICHANCY_ID);
    // Two reads: one before the lock, one after taking it. The second is the load-bearing one.
    expect(h.findById).toHaveBeenCalledTimes(2);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('short-circuits an already-linked player without taking the lock or calling Ichancy', async () => {
    const h = build({
      rows: [playerRow({ ichancyPlayerId: ICHANCY_ID, ichancyLogin: 'p1743150171_ab' })],
    });

    const link = await h.service.ensureLinked(PLAYER_ID);

    expect(link.ichancyPlayerId).toBe(ICHANCY_ID);
    expect(h.acquire).not.toHaveBeenCalled();
    expect(h.ensurePlayer).not.toHaveBeenCalled();
  });

  it('releases the lock even when the registration throws', async () => {
    // A leaked lock would freeze this player for its full 30-second TTL on every attempt, which on
    // a 5-minute cron is a player who is never rescued.
    const h = build();
    h.ensurePlayer.mockRejectedValue(new Error('socket hang up'));

    await expect(h.service.ensureLinked(PLAYER_ID)).rejects.toThrow('socket hang up');
    expect(h.release).toHaveBeenCalledWith(HANDLE);
  });

  it('presents the SAME derived login on every attempt, so a retry converges', async () => {
    // This is why retrying is safe at all: the credentials are derived from the row, not generated,
    // so attempt two asks Ichancy about the same identity and gets "Duplicate login" rather than a
    // second account.
    const first = build();
    await first.service.ensureLinked(PLAYER_ID);
    const second = build();
    await second.service.ensureLinked(PLAYER_ID);

    const loginOf = (h: Harness): string =>
      (h.ensurePlayer.mock.calls[0] as [{ login: string }])[0].login;
    expect(loginOf(second)).toBe(loginOf(first));
    expect(loginOf(first)).toContain(TELEGRAM_ID.toString());
  });
});

describe('PlayerLinkService — what gets persisted, and when', () => {
  it('persists through the compare-and-set, never a bare update', async () => {
    const h = build();

    await h.service.ensureLinked(PLAYER_ID);

    expect(h.linkIchancyAccount).toHaveBeenCalledTimes(1);
    const [id, fields] = h.linkIchancyAccount.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe(PLAYER_ID);
    expect(fields['ichancyPlayerId']).toBe(ICHANCY_ID);

    // The password is stored SEALED. A plaintext column here would be the actual incident, so this
    // asserts against the value we actually sent to Ichancy rather than against a shape.
    const sent = (h.ensurePlayer.mock.calls[0] as [{ password: string }])[0].password;
    const stored = fields['ichancyPasswordEnc'];
    expect(typeof stored).toBe('string');
    expect(stored).not.toContain(sent);
  });

  it('persists NOTHING when the outcome is ambiguous, and says so', async () => {
    // AMBIGUOUS means "we do not know whether it landed". Writing a guess would either strand the
    // real account or claim one that does not exist; the derived login makes the next attempt find
    // it if it was in fact created.
    const h = build();
    h.ensurePlayer.mockResolvedValue(ichancyAmbiguous('CLOUDFLARE_CHALLENGE'));

    await expect(h.service.ensureLinked(PLAYER_ID)).rejects.toMatchObject({
      errorCode: PlayerErrorCodes.ICHANCY_LINK_AMBIGUOUS,
    });
    expect(h.linkIchancyAccount).not.toHaveBeenCalled();
    expect(h.auditWrite).not.toHaveBeenCalled();
  });

  it('surfaces a rejection with the reason the backfill classifies on', async () => {
    // player-link-backfill.service.ts reads `details.reason` to tell a blocked SIGN-IN (retryable)
    // apart from Ichancy refusing this player (terminal). Dropping it would make every rejection
    // look terminal and would park the outage's own victims.
    const h = build();
    h.ensurePlayer.mockResolvedValue(ichancyRejected('ICHANCY_SESSION_MISSING', 'no session'));

    await expect(h.service.ensureLinked(PLAYER_ID)).rejects.toMatchObject({
      errorCode: PlayerErrorCodes.ICHANCY_LINK_REJECTED,
      details: { reason: 'ICHANCY_SESSION_MISSING' },
    });
    expect(h.linkIchancyAccount).not.toHaveBeenCalled();
  });

  it('keeps the STORED id when it loses the compare-and-set', async () => {
    // The lock TTL is 30 s while ensurePlayer makes up to four bounded calls, so the lock can lapse
    // mid-flight. The compare-and-set — not the lock — is the real safety net, and the winner's id
    // is authoritative: overwriting it would point us at an account we do not have credentials for.
    const winner = '999999999';
    const h = build({
      linkWins: false,
      rows: [
        playerRow(),
        playerRow(),
        playerRow({ ichancyPlayerId: winner, ichancyLogin: 'p1743150171_ab' }),
      ],
    });

    const link = await h.service.ensureLinked(PLAYER_ID);

    expect(link.ichancyPlayerId).toBe(winner);
    expect(h.auditWrite).not.toHaveBeenCalled();
  });

  it('refuses to invent a link for a player who does not exist', async () => {
    const h = build({ rows: [] });

    await expect(h.service.ensureLinked(PLAYER_ID)).rejects.toMatchObject({
      errorCode: PlayerErrorCodes.PLAYER_NOT_FOUND,
    });
    expect(h.acquire).not.toHaveBeenCalled();
  });

  it('audits the link as a SYSTEM action, without the password', async () => {
    const h = build();

    await h.service.ensureLinked(PLAYER_ID, 'cron:player-link-backfill');

    const [, entry] = h.auditWrite.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(entry['action']).toBe('player.ichancy.linked');
    expect(entry['correlationId']).toBe('cron:player-link-backfill');
    expect(JSON.stringify(entry)).not.toContain('password');
  });
});
