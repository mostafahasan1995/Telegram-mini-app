/**
 * The fake is test infrastructure, so it gets tests of its own: if `ambiguous + applyAnyway` did not
 * really move the balance, every BALANCE_DELTA test built on it would be green for the wrong reason.
 */
import { FakeIchancyAdapter } from './fake-ichancy.adapter';
import { IchancyRejectionCodes, isIchancyOk } from './ichancy.types';

describe('FakeIchancyAdapter', () => {
  let fake: FakeIchancyAdapter;

  beforeEach(() => {
    fake = new FakeIchancyAdapter();
    fake.reset();
  });

  it('creates a player once and resolves the same id afterwards', async () => {
    const first = await fake.ensurePlayer({
      login: 'p1',
      email: 'p1@x.io',
      password: 'secret',
    });
    const second = await fake.ensurePlayer({ login: 'p1', email: 'p1@x.io', password: 'secret' });

    expect(isIchancyOk(first) && first.data.created).toBe(true);
    expect(isIchancyOk(second) && second.data.created).toBe(false);
    expect(isIchancyOk(first) && isIchancyOk(second) && first.data.ichancyPlayerId).toBe(
      isIchancyOk(second) ? second.data.ichancyPlayerId : '',
    );
  });

  it('already-exists mode reports created:false and still yields a usable id', async () => {
    fake.setMode('already-exists');
    const result = await fake.ensurePlayer({ login: 'p2', email: 'p2@x.io', password: 'secret' });
    expect(isIchancyOk(result) && result.data.created).toBe(false);
    expect(isIchancyOk(result) && result.data.ichancyPlayerId.length > 0).toBe(true);
  });

  it('moves money and keeps the agent float in step', async () => {
    const player = fake.seedPlayer({ login: 'p3', balanceMinor: 1_000n });
    fake.setAgentWallet({ balanceMinor: 10_000n });

    const credited = await fake.creditPlayer({
      ichancyPlayerId: player.ichancyPlayerId,
      amountMinor: 2_500n,
      comment: 'DEP-1',
    });

    expect(credited).toEqual({ kind: 'ok', data: { balanceMinor: 3_500n } });
    expect(fake.peekPlayerBalance(player.ichancyPlayerId)).toBe(3_500n);
    expect(fake.peekAgentWallet()).toEqual({ balanceMinor: 7_500n, availableMinor: 7_500n });
  });

  it('AMBIGUOUS + applyAnyway credits the player behind our back (the BALANCE_DELTA case)', async () => {
    const player = fake.seedPlayer({ login: 'p4', balanceMinor: 0n });
    fake.script({ operation: 'creditPlayer', mode: 'ambiguous', applyAnyway: true });

    const before = await fake.getPlayerBalance(player.ichancyPlayerId);
    const result = await fake.creditPlayer({
      ichancyPlayerId: player.ichancyPlayerId,
      amountMinor: 5_000n,
      comment: 'DEP-2',
    });
    const after = await fake.getPlayerBalance(player.ichancyPlayerId);

    expect(result.kind).toBe('ambiguous');
    expect(isIchancyOk(before) && before.data.balanceMinor).toBe(0n);
    expect(isIchancyOk(after) && after.data.balanceMinor).toBe(5_000n);
  });

  it('AMBIGUOUS without applyAnyway leaves the balance untouched', async () => {
    const player = fake.seedPlayer({ login: 'p5', balanceMinor: 100n });
    fake.script({ operation: 'creditPlayer', mode: 'ambiguous' });

    await fake.creditPlayer({
      ichancyPlayerId: player.ichancyPlayerId,
      amountMinor: 5_000n,
      comment: 'DEP-3',
    });

    expect(fake.peekPlayerBalance(player.ichancyPlayerId)).toBe(100n);
  });

  it('agent-float-empty refuses credits with the real Ichancy code', async () => {
    const player = fake.seedPlayer({ login: 'p6' });
    fake.setMode('agent-float-empty');

    const result = await fake.creditPlayer({
      ichancyPlayerId: player.ichancyPlayerId,
      amountMinor: 100n,
      comment: 'DEP-4',
    });

    expect(result).toMatchObject({
      kind: 'rejected',
      code: IchancyRejectionCodes.INSUFFICIENT_AGENT_FLOAT,
    });
    expect(await fake.getAgentWallet()).toEqual({
      kind: 'ok',
      data: { balanceMinor: 0n, availableMinor: 0n },
    });
  });

  it('refuses a debit larger than the player balance', async () => {
    const player = fake.seedPlayer({ login: 'p7', balanceMinor: 500n });

    const result = await fake.debitPlayer({
      ichancyPlayerId: player.ichancyPlayerId,
      amountMinor: 600n,
      comment: 'WD-1',
    });

    expect(result).toMatchObject({
      kind: 'rejected',
      code: IchancyRejectionCodes.INSUFFICIENT_PLAYER_BALANCE,
    });
    expect(fake.peekPlayerBalance(player.ichancyPlayerId)).toBe(500n);
  });

  it('mirrors production by refusing non-positive amounts', async () => {
    const player = fake.seedPlayer({ login: 'p8', balanceMinor: 500n });
    const result = await fake.creditPlayer({
      ichancyPlayerId: player.ichancyPlayerId,
      amountMinor: -1n,
      comment: 'DEP-5',
    });
    expect(result.kind).toBe('rejected');
  });

  it('returns ambiguous (not zero) for an unknown player balance', async () => {
    expect((await fake.getPlayerBalance('nope')).kind).toBe('ambiguous');
  });

  it('consumes scripted behaviours in order and then falls back to the default mode', async () => {
    const player = fake.seedPlayer({ login: 'p9', balanceMinor: 0n });
    fake.script([
      { operation: 'creditPlayer', mode: 'rejected', code: 'X', message: 'Wrong arguments' },
      { operation: 'creditPlayer', mode: 'ambiguous', times: 2 },
    ]);

    const outcomes: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await fake.creditPlayer({
        ichancyPlayerId: player.ichancyPlayerId,
        amountMinor: 10n,
        comment: `DEP-${String(i)}`,
      });
      outcomes.push(result.kind);
    }

    expect(outcomes).toEqual(['rejected', 'ambiguous', 'ambiguous', 'ok']);
    expect(fake.callsFor('creditPlayer')).toHaveLength(4);
  });

  it('slow mode delays without changing the outcome', async () => {
    const player = fake.seedPlayer({ login: 'p10', balanceMinor: 0n });
    fake.setSlowDelayMs(40);
    fake.setMode('slow');

    const startedAt = Date.now();
    const result = await fake.creditPlayer({
      ichancyPlayerId: player.ichancyPlayerId,
      amountMinor: 10n,
      comment: 'DEP-slow',
    });

    expect(result.kind).toBe('ok');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30);
  });
});
