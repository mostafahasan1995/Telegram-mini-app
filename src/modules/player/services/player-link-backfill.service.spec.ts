/**
 * THE TESTS THAT WOULD HAVE CAUGHT THE 2026-08-20 INCIDENT — and the ones that stop the fix from
 * being worse than the bug.
 *
 * Two failure modes are being defended against at once, and they pull in opposite directions:
 *   - doing nothing, which is what left tg=1743150171 stranded at PENDING_ICHANCY for nineteen
 *     hours with a NULL ichancy_player_id;
 *   - doing too much, which on a system whose registerPlayer is not idempotent and has no
 *     deletePlayer means a SECOND casino account under our agent that can never be removed.
 *
 * So the load-bearing assertions here are as much about what is NOT called as about what is.
 */
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from '@common/exceptions/app.exception';
import { type AppConfigService } from '@core/config/config.service';
import { type IchancyHealthService } from '@core/ichancy';
import { type PrismaService } from '@core/prisma/prisma.service';

import {
  PLAYER_LINK_BACKFILL_CORRELATION,
  PLAYER_LINK_BACKFILL_GRACE_MS,
  PLAYER_LINK_MAX_ATTEMPTS,
  PlayerErrorCodes,
} from '../player.constants';
import { type PlayerLinkService } from './player-link.service';
import {
  backoffMsFor,
  classifyLinkFailure,
  PlayerLinkBackfillService,
} from './player-link-backfill.service';

interface Candidate {
  id: string;
  telegramUserId: bigint;
  ichancyLinkAttempts: number;
}

/** The stranded player from the live incident, minus the parts the selector does not read. */
const STRANDED: Candidate = {
  id: 'player-hasan',
  telegramUserId: 1_743_150_171n,
  ichancyLinkAttempts: 0,
};

interface Harness {
  service: PlayerLinkBackfillService;
  findMany: jest.Mock;
  updateMany: jest.Mock;
  ensureLinked: jest.Mock;
  isDown: jest.Mock;
  /** Every write's `data`, in order, so backoff and parking can be asserted directly. */
  writes: { where: Record<string, unknown>; data: Record<string, unknown> }[];
}

function build(options: { candidates?: Candidate[]; down?: boolean; fake?: boolean } = {}): Harness {
  const writes: Harness['writes'] = [];

  const findMany = jest.fn().mockResolvedValue(options.candidates ?? []);
  const updateMany = jest.fn((args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    writes.push(args);
    return Promise.resolve({ count: 1 });
  });
  const prisma = { player: { findMany, updateMany } } as unknown as PrismaService;

  const ensureLinked = jest.fn().mockResolvedValue({
    playerId: STRANDED.id,
    ichancyPlayerId: '459424640',
    ichancyLogin: 'p1743150171_abcd',
    created: true,
  });
  const links = { ensureLinked } as unknown as PlayerLinkService;

  const isDown = jest.fn().mockResolvedValue(options.down ?? false);
  const health = { isDown } as unknown as IchancyHealthService;

  const config = {
    ichancy: { fake: options.fake ?? false },
  } as unknown as AppConfigService;

  return {
    service: new PlayerLinkBackfillService(prisma, links, health, config),
    findMany,
    updateMany,
    ensureLinked,
    isDown,
    writes,
  };
}

/** noUncheckedIndexedAccess: assert the write exists rather than optional-chaining past a bug. */
function writeAt(
  harness: Harness,
  index: number,
): { where: Record<string, unknown>; data: Record<string, unknown> } {
  const write = harness.writes[index];
  if (write === undefined) throw new Error('expected a bookkeeping write at index ' + String(index));
  return write;
}

const ambiguous = (): ServiceUnavailableError =>
  new ServiceUnavailableError(
    PlayerErrorCodes.ICHANCY_LINK_AMBIGUOUS,
    'We could not confirm your gaming account just now.',
  );

const rejected = (reason: string): BusinessRuleError =>
  new BusinessRuleError(
    PlayerErrorCodes.ICHANCY_LINK_REJECTED,
    'We could not set up your gaming account.',
    { reason },
  );

describe('PlayerLinkBackfillService — rescuing a stranded player', () => {
  it('picks the stranded player up and re-links them through the ONE registration path', async () => {
    const harness = build({ candidates: [STRANDED] });

    const result = await harness.service.runOnce();

    expect(result.linked).toBe(1);
    // ensureLinked and nothing else. That single call is what carries the per-player lock, the
    // re-read inside it and the `updateMany({id, ichancyPlayerId: null})` compare-and-set — none of
    // which this class is allowed to re-implement.
    expect(harness.ensureLinked).toHaveBeenCalledTimes(1);
    expect(harness.ensureLinked).toHaveBeenCalledWith(
      STRANDED.id,
      PLAYER_LINK_BACKFILL_CORRELATION,
    );
  });

  it('never writes an Ichancy identity column itself', async () => {
    // If this class ever writes ichancy_player_id / ichancy_login directly it has bypassed the
    // compare-and-set, and two passes could then overwrite each other's account id.
    const harness = build({ candidates: [STRANDED] });

    await harness.service.runOnce();

    for (const write of harness.writes) {
      expect(Object.keys(write.data).join(',')).not.toMatch(
        /ichancyPlayerId|ichancyLogin|ichancyEmail|ichancyPasswordEnc|status/,
      );
    }
  });

  it('selects only PENDING_ICHANCY rows that are due and outside the grace window', async () => {
    const harness = build({ candidates: [] });

    await harness.service.runOnce();

    const where = harness.findMany.mock.calls[0][0].where as Record<string, unknown>;
    // status is LOAD-BEARING: linkIchancyAccount force-sets `status: 'ACTIVE'` with a WHERE of only
    // `{ id, ichancyPlayerId: null }`, so a bare `ichancyPlayerId: null` selector would mint a
    // casino account for a SUSPENDED / SELF_EXCLUDED / CLOSED player and silently reactivate them —
    // irreversibly, because the agent API has no deletePlayer.
    expect(where['status']).toBe('PENDING_ICHANCY');
    expect(where['ichancyPlayerId']).toBeNull();
    expect(where['ichancyLinkAttempts']).toEqual({ lt: PLAYER_LINK_MAX_ATTEMPTS });
    // Not due yet => not selected.
    expect(where['OR']).toEqual([
      { ichancyLinkNextAttemptAt: null },
      { ichancyLinkNextAttemptAt: { lte: expect.any(Date) as unknown as Date } },
    ]);
    // And /start's own attempt is not raced.
    const createdAt = where['createdAt'] as { lte: Date };
    expect(Date.now() - createdAt.lte.getTime()).toBeGreaterThanOrEqual(
      PLAYER_LINK_BACKFILL_GRACE_MS - 1_000,
    );
  });
});

describe('PlayerLinkBackfillService — never double-registering', () => {
  it('does not retry when another holder has the per-player lock', async () => {
    // 409 ICHANCY_LINK_IN_PROGRESS means somebody else is doing this exact work. Charging the
    // player an attempt for our own contention would burn their budget on nothing, and pushing past
    // the lock is how two registerPlayer calls for one login happen.
    const harness = build({ candidates: [STRANDED] });
    harness.ensureLinked.mockRejectedValue(
      new ConflictError(PlayerErrorCodes.ICHANCY_LINK_IN_PROGRESS, 'Being prepared.'),
    );

    const result = await harness.service.runOnce();

    expect(result.deferred).toBe(1);
    expect(harness.writes).toHaveLength(1);
    expect(writeAt(harness, 0).data).not.toHaveProperty('ichancyLinkAttempts');
    expect(writeAt(harness, 0).data['ichancyLinkNextAttemptAt']).toBeInstanceOf(Date);
  });

  it('guards every bookkeeping write on the row still being unlinked', async () => {
    // The row can be linked by /start or by an admin between selection and execution. Guarding on
    // `ichancyPlayerId: null` is what stops this class stamping a "failed, retry later" over a
    // player who has in fact just been given an account.
    const harness = build({ candidates: [STRANDED] });
    harness.ensureLinked.mockRejectedValue(ambiguous());

    await harness.service.runOnce();

    expect(harness.writes).toHaveLength(1);
    expect(writeAt(harness, 0).where['ichancyPlayerId']).toBeNull();
  });

  it('guards the success write on the row having actually become linked', async () => {
    const harness = build({ candidates: [STRANDED] });

    await harness.service.runOnce();

    expect(harness.writes).toHaveLength(1);
    expect(writeAt(harness, 0).where['ichancyPlayerId']).toEqual({ not: null });
  });

  it('issues ZERO requests while the breaker says Ichancy is DOWN', async () => {
    // THE ANTI-HAMMER PROPERTY. Every failed challenge lowers the IP's Cloudflare trust score, which
    // is the mechanism that turned twenty minutes of failure into hours. While DOWN the only
    // traffic left is the pre-existing 5-minute float sync, which is exactly enough to notice
    // recovery and reopen this gate.
    const harness = build({ candidates: [STRANDED], down: true });

    const result = await harness.service.runOnce();

    expect(result.skipped).toBe('ichancy-down');
    expect(harness.findMany).not.toHaveBeenCalled();
    expect(harness.ensureLinked).not.toHaveBeenCalled();
    expect(harness.writes).toHaveLength(0);
  });

  it('is inert against the fake adapter', async () => {
    const harness = build({ candidates: [STRANDED], fake: true });

    expect((await harness.service.runOnce()).skipped).toBe('ichancy-fake');
    expect(harness.ensureLinked).not.toHaveBeenCalled();
  });
});

describe('PlayerLinkBackfillService — backoff and parking', () => {
  it('does not retry a failing player on the next tick', async () => {
    // Without this the cron re-hammers the same row every five minutes forever, adding to exactly
    // the ichancy_calls noise on the one endpoint we most need to be able to read.
    const harness = build({ candidates: [STRANDED] });
    harness.ensureLinked.mockRejectedValue(ambiguous());

    const before = Date.now();
    const result = await harness.service.runOnce();

    expect(result.deferred).toBe(1);
    expect(writeAt(harness, 0).data['ichancyLinkAttempts']).toBe(1);
    const next = writeAt(harness, 0).data['ichancyLinkNextAttemptAt'] as Date;
    // Comfortably beyond the 5-minute tick, so the very next pass cannot pick this row up again.
    expect(next.getTime() - before).toBeGreaterThan(3 * 60_000);
  });

  it('grows the delay and caps it, so a permanent failure stops costing anything', () => {
    expect(backoffMsFor(1, () => 0.5)).toBe(5 * 60_000);
    expect(backoffMsFor(2, () => 0.5)).toBe(10 * 60_000);
    expect(backoffMsFor(3, () => 0.5)).toBe(20 * 60_000);
    expect(backoffMsFor(30, () => 0.5)).toBe(12 * 60 * 60_000);
    // ±20% jitter, so N workers that backed off together do not return together.
    expect(backoffMsFor(1, () => 0)).toBe(4 * 60_000);
    expect(backoffMsFor(1, () => 1)).toBe(6 * 60_000);
  });

  it('parks a player once the attempts run out', async () => {
    const harness = build({
      candidates: [{ ...STRANDED, ichancyLinkAttempts: PLAYER_LINK_MAX_ATTEMPTS - 1 }],
    });
    harness.ensureLinked.mockRejectedValue(ambiguous());

    const result = await harness.service.runOnce();

    expect(result.parked).toBe(1);
    expect(writeAt(harness, 0).data['ichancyLinkAttempts']).toBe(PLAYER_LINK_MAX_ATTEMPTS);
    expect(writeAt(harness, 0).data['ichancyLinkNextAttemptAt']).toBeNull();
  });

  it('parks a genuine rejection immediately, exactly once', async () => {
    // The port's contract for a 422 is "do not retry unchanged", and nothing about waiting changes
    // the request. Counting up to twelve would be twelve pointless registerPlayer calls.
    const harness = build({ candidates: [STRANDED] });
    harness.ensureLinked.mockRejectedValue(rejected('VALIDATION_FAILED'));

    const result = await harness.service.runOnce();

    expect(result.parked).toBe(1);
    expect(harness.writes).toHaveLength(1);
    expect(writeAt(harness, 0).data['ichancyLinkAttempts']).toBe(PLAYER_LINK_MAX_ATTEMPTS);
    expect(writeAt(harness, 0).data['ichancyLinkLastError']).toContain('gaming account');
  });
});

describe('classifyLinkFailure — retryable transport vs a genuine rejection', () => {
  it('calls a Cloudflare 403 retryable transport', () => {
    // A Cloudflare 403 arrives as 503 ICHANCY_LINK_AMBIGUOUS. It is the ONE ambiguous case this
    // system retries, and the house rule still holds: what makes it narrower and safe is that the
    // edge 403 carries Cloudflare's own interstitial as its body, which proves the request never
    // reached Ichancy's application — so nothing can have been created by it.
    expect(classifyLinkFailure(ambiguous())).toBe('TRANSPORT');
  });

  it('does NOT call a genuine rejection retryable', () => {
    expect(classifyLinkFailure(rejected('VALIDATION_FAILED'))).toBe('TERMINAL');
    expect(classifyLinkFailure(rejected('DUPLICATE_EMAIL'))).toBe('TERMINAL');
    expect(
      classifyLinkFailure(new NotFoundError(PlayerErrorCodes.PLAYER_NOT_FOUND, 'gone')),
    ).toBe('TERMINAL');
  });

  it('treats a blocked SIGN-IN as retryable, not as a rejection', () => {
    // THE GOTCHA THAT WOULD HAVE STRANDED THE RESCUE ITSELF. When getAccessToken throws, the
    // adapter returns `rejected` — honestly, because nothing was sent — so a Cloudflare-blocked
    // sign-in surfaces as 422 ICHANCY_LINK_REJECTED, whose documented meaning is "do not retry
    // unchanged". Filing those under TERMINAL would park exactly the population this cron exists
    // to rescue, during exactly the outage it exists for.
    for (const reason of [
      'ICHANCY_SESSION_MISSING',
      'ICHANCY_SESSION_REAUTH_REQUIRED',
      'ICHANCY_SIGNIN_REJECTED',
      'ICHANCY_SIGNIN_AMBIGUOUS',
      'ICHANCY_SESSION_LOCK_TIMEOUT',
    ]) {
      expect(classifyLinkFailure(rejected(reason))).toBe('SESSION');
    }
  });

  it('backs off rather than parking on an unexpected throw', () => {
    // A dead database or a bug tells us nothing about Ichancy, and parking would need a human for
    // a problem that may clear on its own.
    expect(classifyLinkFailure(new Error('connection terminated'))).toBe('TRANSPORT');
  });
});

describe('PlayerLinkBackfillService — pass shape', () => {
  const three: Candidate[] = [
    { ...STRANDED, id: 'p1' },
    { ...STRANDED, id: 'p2' },
    { ...STRANDED, id: 'p3' },
  ];

  it('stops the pass at the first sign the integration is unreachable', async () => {
    // At most ONE failed request per tick while Ichancy is unhealthy: enough for the breaker to
    // trip on the ambient float sync, and not a burst of our own making that drives the IP's trust
    // score down further.
    const harness = build({ candidates: three });
    harness.ensureLinked.mockRejectedValue(ambiguous());

    const result = await harness.service.runOnce();

    expect(harness.ensureLinked).toHaveBeenCalledTimes(1);
    expect(result.scanned).toBe(1);
  });

  it('keeps going past a player-specific rejection', async () => {
    // A player Ichancy will never accept must not abandon everyone queued behind them: shrinking
    // the pending set is the whole point of the pass.
    const harness = build({ candidates: three });
    harness.ensureLinked
      .mockRejectedValueOnce(rejected('VALIDATION_FAILED'))
      .mockResolvedValue({
        playerId: 'p2',
        ichancyPlayerId: '1',
        ichancyLogin: 'x',
        created: true,
      });

    const result = await harness.service.runOnce();

    expect(harness.ensureLinked).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ scanned: 3, linked: 2, parked: 1 });
  });

  it('caps the batch it asks for', async () => {
    const harness = build({ candidates: [] });

    await harness.service.runOnce(4);

    expect(harness.findMany.mock.calls[0][0].take).toBe(4);
  });
});

describe('PLAYER_LINK_MAX_ATTEMPTS — the copy nobody can import', () => {
  it('is still 12, which is the number IchancyHealthAlertCron hard-codes', () => {
    // A TRIPWIRE, not a tautology. `eslint-plugin-boundaries` forbids
    // modules/reconciliation -> modules/player, so IchancyHealthAlertCron cannot import this
    // constant and restates it as its own PARKED_ATTEMPTS = 12 — the threshold its recovery message
    // uses to count the players who need a HUMAN because the backfill has given up on them.
    //
    // Change this constant and that count silently starts describing a different population: the
    // alert would under- or over-report exactly the people an operator has to rescue by hand, and
    // nothing else in the build would notice. If this assertion fails, the fix is to update
    // PARKED_ATTEMPTS in src/modules/reconciliation/services/ichancy-health.cron.ts to match, then
    // update the number here.
    expect(PLAYER_LINK_MAX_ATTEMPTS).toBe(12);
  });
});
