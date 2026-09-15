/**
 * THE ANTI-ALARM-FATIGUE PROOF.
 *
 * Two opposite failures are being pinned. Silence — which is what actually happened on 2026-08-20,
 * where the integration was blocked for hours and no human was told. And noise: a one-minute cron
 * that posted on every tick would send twelve messages an hour for the whole outage, which teaches
 * operators to skim past alarms and is therefore the same failure wearing a different hat.
 *
 * The property is: one message per STATE CHANGE, per operator, and nothing in between. Every ACTIVE
 * operator hears it in its own admin group through its own bot, and one operator whose chat or bot
 * is broken is retried without re-alerting the others.
 */
import { Logger } from '@nestjs/common';

import { type LockService } from '@core/cache/lock.service';
import { type RedisService } from '@core/cache/redis.service';
import { type AppConfigService } from '@core/config/config.service';
import { type IchancyHealthService, type IchancyHealthSnapshot } from '@core/ichancy';
import { type PrismaService } from '@core/prisma/prisma.service';
import { type BotService } from '@core/telegram/services/bot.service';
import { type OperatorRef, type TenantRegistryService, getEffectiveTenantId } from '@core/tenant';

import { IchancyHealthAlertCron } from './ichancy-health.cron';

const HANDLE = { key: 'lock:cron:ichancy-health-alert', token: 't', acquiredAt: 0, ttlMs: 1_000 };

const OUTAGE_START = new Date('2026-08-20T04:14:00.000Z');
const RECOVERED_AT = new Date('2026-08-20T07:44:00.000Z');

const OPERATOR_A: OperatorRef = { id: '11111111-1111-4111-8111-111111111111', slug: 'alpha' };
const OPERATOR_B: OperatorRef = { id: '22222222-2222-4222-8222-222222222222', slug: 'beta' };

const DOWN: IchancyHealthSnapshot = {
  state: 'DOWN',
  consecutive: 42,
  kind: 'CLOUDFLARE_CHALLENGE',
  since: OUTAGE_START,
  lastEndpoint: 'getAgentAllWallets',
  lastMessage: 'Cloudflare answered with a challenge (HTTP 403) instead of the agent API.',
  recoveredAt: null,
};

const RECOVERED: IchancyHealthSnapshot = {
  ...DOWN,
  state: 'UP',
  consecutive: 0,
  recoveredAt: RECOVERED_AT,
};

const STEADY_UP: IchancyHealthSnapshot = {
  state: 'UP',
  consecutive: 0,
  kind: null,
  since: null,
  lastEndpoint: null,
  lastMessage: null,
  recoveredAt: null,
};

/**
 * SET (with and without NX), GET and DEL. NX is the whole "announce once" mechanism; the value is
 * what tells a completed send from one still in flight.
 */
class FakeRedis {
  readonly keys = new Map<string, string>();

  set(key: string, value: string, _ex: string, _ttl: number, nx?: string): Promise<'OK' | null> {
    if (nx !== undefined && this.keys.has(key)) return Promise.resolve(null);
    this.keys.set(key, value);
    return Promise.resolve('OK');
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.keys.get(key) ?? null);
  }

  del(key: string): Promise<number> {
    return Promise.resolve(this.keys.delete(key) ? 1 : 0);
  }
}

const markerOf = (operator: OperatorRef, snapshot: IchancyHealthSnapshot): string => {
  const anchor = snapshot.state === 'DOWN' ? snapshot.since : snapshot.recoveredAt;
  return `ichancy:health:announced:${operator.id}:${snapshot.state}:${anchor?.toISOString() ?? ''}`;
};

function build(
  options: {
    isWorker?: boolean;
    fake?: boolean;
    operators?: OperatorRef[];
    /** Operators whose admin_chat_id is 0, i.e. unset. */
    withoutChat?: string[];
  } = {},
): {
  cron: IchancyHealthAlertCron;
  snapshot: jest.Mock;
  notifyAdmins: jest.Mock;
  acknowledgeRecovery: jest.Mock;
  count: jest.Mock;
  redis: FakeRedis;
  withoutChat: Set<string>;
} {
  const snapshot = jest.fn().mockResolvedValue(STEADY_UP);
  const acknowledgeRecovery = jest.fn().mockResolvedValue(undefined);
  const withoutChat = new Set(options.withoutChat ?? []);
  // Like the real BotService: no admin chat means null, without touching Telegram.
  const notifyAdmins = jest.fn((tenantId: string) =>
    Promise.resolve(withoutChat.has(tenantId) ? null : { message_id: 1 }),
  );
  const redis = new FakeRedis();
  const count = jest.fn().mockResolvedValue(0);
  // What BotService.chatsOf answers: 0 in the column comes back as null.
  const chatsOf = jest.fn((tenantId: string) =>
    Promise.resolve({ adminChatId: withoutChat.has(tenantId) ? null : -1001n, feedChatId: null }),
  );

  const cron = new IchancyHealthAlertCron(
    { snapshot, acknowledgeRecovery } as unknown as IchancyHealthService,
    { notifyAdmins, chatsOf } as unknown as BotService,
    {
      acquire: jest.fn().mockResolvedValue(HANDLE),
      release: jest.fn().mockResolvedValue(true),
    } as unknown as LockService,
    redis as unknown as RedisService,
    { player: { count } } as unknown as PrismaService,
    {
      listActiveOperators: jest.fn().mockResolvedValue(options.operators ?? [OPERATOR_A]),
    } as unknown as TenantRegistryService,
    {
      app: { isWorker: options.isWorker ?? true },
      ichancy: { fake: options.fake ?? false },
    } as unknown as AppConfigService,
  );
  return { cron, snapshot, notifyAdmins, acknowledgeRecovery, count, redis, withoutChat };
}

const textOf = (call: unknown[] | undefined): string => (call?.[1] as string | undefined) ?? '';

describe('IchancyHealthAlertCron', () => {
  it('posts EXACTLY ONCE across ten consecutive DOWN ticks', async () => {
    const { cron, snapshot, notifyAdmins } = build();
    snapshot.mockResolvedValue(DOWN);

    for (let tick = 0; tick < 10; tick += 1) await cron.tick();

    expect(notifyAdmins).toHaveBeenCalledTimes(1);
    expect(notifyAdmins.mock.calls[0]?.[0]).toBe(OPERATOR_A.id);
  });

  it('posts exactly one more when the integration comes back', async () => {
    const { cron, snapshot, notifyAdmins, acknowledgeRecovery } = build();
    snapshot.mockResolvedValue(DOWN);
    await cron.tick();
    await cron.tick();

    snapshot.mockResolvedValue(RECOVERED);
    await cron.tick();
    await cron.tick();
    await cron.tick();

    expect(notifyAdmins).toHaveBeenCalledTimes(2);
    expect(acknowledgeRecovery).toHaveBeenCalledWith(RECOVERED_AT);
  });

  it('says nothing at all in the steady state', async () => {
    const { cron, notifyAdmins, redis } = build();

    for (let tick = 0; tick < 5; tick += 1) await cron.tick();

    expect(notifyAdmins).not.toHaveBeenCalled();
    expect(redis.keys.size).toBe(0);
  });

  it('names the kind, the endpoint and what to do', async () => {
    const { cron, snapshot, notifyAdmins } = build();
    snapshot.mockResolvedValue(DOWN);

    await cron.tick();

    const text = textOf((notifyAdmins.mock.calls as unknown[][])[0]);
    expect(text).toContain('CLOUDFLARE_CHALLENGE');
    expect(text).toContain('getAgentAllWallets');
    expect(text).toContain('ICHANCY_TRANSPORT=browser');
    // The consequence an operator actually needs, stated before the checklist.
    expect(text).toContain('تسجيل اللاعبين الجدد');
  });

  it('reports the outage duration on recovery', async () => {
    const { cron, snapshot, notifyAdmins } = build();
    snapshot.mockResolvedValue(RECOVERED);

    await cron.tick();

    // 04:14 -> 07:44 is three and a half hours.
    expect(textOf((notifyAdmins.mock.calls as unknown[][])[0])).toContain('3 ساعة و30 دقيقة');
  });

  it('retries next tick when the admin chat is unreachable', async () => {
    // notifyAdmins returns null rather than throwing for an unreachable chat. Keeping the marker
    // would mean we had "alerted" into a void and would never try again — the alarm would be lost
    // in exactly the situation it exists for. (An UNSET chat is a different case; see below.)
    const { cron, snapshot, notifyAdmins, redis } = build();
    snapshot.mockResolvedValue(DOWN);
    notifyAdmins.mockResolvedValueOnce(null);

    await cron.tick();
    expect(redis.keys.size).toBe(0);

    await cron.tick();
    expect(notifyAdmins).toHaveBeenCalledTimes(2);
  });

  it('is silent in the api role and in fake mode', async () => {
    const api = build({ isWorker: false });
    api.snapshot.mockResolvedValue(DOWN);
    await api.cron.tick();
    expect(api.notifyAdmins).not.toHaveBeenCalled();

    // Otherwise every dev boot alarms, which is how operators learn to ignore alarms.
    const fake = build({ fake: true });
    fake.snapshot.mockResolvedValue(DOWN);
    await fake.cron.tick();
    expect(fake.notifyAdmins).not.toHaveBeenCalled();
  });

  it('never posts to the customer-facing feed', async () => {
    // "the casino integration is down" reads to a customer as "my money is gone".
    const { cron, snapshot } = build();
    snapshot.mockResolvedValue(DOWN);

    await cron.tick();

    // The class holds no notifyFeed reference at all; asserting on the injected surface is what
    // makes adding one a deliberate act rather than an accident.
    expect(Object.keys(cron)).not.toContain('feed');
  });

  describe('every ACTIVE operator', () => {
    it('tells each operator once, through its own bot', async () => {
      const { cron, snapshot, notifyAdmins } = build({ operators: [OPERATOR_A, OPERATOR_B] });
      snapshot.mockResolvedValue(DOWN);

      for (let tick = 0; tick < 5; tick += 1) await cron.tick();

      expect((notifyAdmins.mock.calls as unknown[][]).map((call) => call[0])).toEqual([
        OPERATOR_A.id,
        OPERATOR_B.id,
      ]);
    });

    it('retries only the operator that was not reached', async () => {
      const { cron, snapshot, notifyAdmins } = build({ operators: [OPERATOR_A, OPERATOR_B] });
      snapshot.mockResolvedValue(DOWN);
      notifyAdmins.mockImplementation((tenantId: string) =>
        Promise.resolve(
          tenantId === OPERATOR_B.id && notifyAdmins.mock.calls.length <= 2 ? null : {},
        ),
      );

      await cron.tick();
      await cron.tick();
      await cron.tick();

      expect((notifyAdmins.mock.calls as unknown[][]).map((call) => call[0])).toEqual([
        OPERATOR_A.id,
        OPERATOR_B.id,
        OPERATOR_B.id,
      ]);
    });

    it('does not let one operator’s broken bot cost another its alarm', async () => {
      const { cron, snapshot, notifyAdmins } = build({ operators: [OPERATOR_A, OPERATOR_B] });
      snapshot.mockResolvedValue(DOWN);
      notifyAdmins.mockImplementation((tenantId: string) =>
        tenantId === OPERATOR_A.id
          ? Promise.reject(new Error('bot token revoked'))
          : Promise.resolve({}),
      );

      await cron.tick();

      expect(notifyAdmins).toHaveBeenCalledWith(
        OPERATOR_B.id,
        expect.any(String),
        expect.any(Object),
      );
    });

    it('retires the recovery only once no operator is still owed it', async () => {
      const { cron, snapshot, notifyAdmins, acknowledgeRecovery } = build({
        operators: [OPERATOR_A, OPERATOR_B],
      });
      snapshot.mockResolvedValue(RECOVERED);
      notifyAdmins.mockImplementation((tenantId: string) =>
        Promise.resolve(
          tenantId === OPERATOR_B.id && notifyAdmins.mock.calls.length <= 2 ? null : {},
        ),
      );

      await cron.tick();
      expect(acknowledgeRecovery).not.toHaveBeenCalled();

      await cron.tick();
      expect(acknowledgeRecovery).toHaveBeenCalledTimes(1);
    });

    it('counts pending players inside each operator’s own context', async () => {
      const { cron, snapshot, count } = build({ operators: [OPERATOR_A, OPERATOR_B] });
      snapshot.mockResolvedValue(RECOVERED);
      const seen: Array<string | undefined> = [];
      count.mockImplementation(() => {
        seen.push(getEffectiveTenantId());
        return Promise.resolve(0);
      });

      await cron.tick();

      // Two counts per recovery message; each operator's pair runs in that operator's context.
      expect(seen).toEqual([OPERATOR_A.id, OPERATOR_A.id, OPERATOR_B.id, OPERATOR_B.id]);
    });

    it('claims and sends nothing when no operator is ACTIVE', async () => {
      const { cron, snapshot, notifyAdmins, redis, acknowledgeRecovery } = build({ operators: [] });
      snapshot.mockResolvedValue(RECOVERED);

      await cron.tick();

      expect(notifyAdmins).not.toHaveBeenCalled();
      expect(redis.keys.size).toBe(0);
      expect(acknowledgeRecovery).not.toHaveBeenCalled();
    });
  });

  describe('an operator with no admin chat (admin_chat_id = 0)', () => {
    // The seed creates the bootstrap operator exactly like this, and it may stay that way for good.
    // It used to count as a failed send: claimed, released and logged at ERROR every minute, and a
    // recovery that was never retired, so everybody else heard it again every day.
    let warn: jest.SpyInstance;
    let error: jest.SpyInstance;

    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    const warningsAbout = (operator: OperatorRef): number =>
      (warn.mock.calls as unknown[][]).filter((call) => String(call[0]).includes(operator.id))
        .length;

    it('does not hold up the recovery, and the other operators are still told once', async () => {
      const { cron, snapshot, notifyAdmins, acknowledgeRecovery, redis } = build({
        operators: [OPERATOR_A, OPERATOR_B],
        withoutChat: [OPERATOR_A.id],
      });
      snapshot.mockResolvedValue(RECOVERED);

      for (let tick = 0; tick < 3; tick += 1) await cron.tick();

      expect((notifyAdmins.mock.calls as unknown[][]).map((call) => call[0])).toEqual([
        OPERATOR_B.id,
      ]);
      expect(acknowledgeRecovery).toHaveBeenCalledWith(RECOVERED_AT);
      expect(redis.keys.has(markerOf(OPERATOR_A, RECOVERED))).toBe(false);
    });

    it('is not claimed, and not logged at ERROR, on every tick — one warning per transition', async () => {
      const { cron, snapshot, notifyAdmins, redis } = build({
        operators: [OPERATOR_A],
        withoutChat: [OPERATOR_A.id],
      });
      snapshot.mockResolvedValue(DOWN);

      for (let tick = 0; tick < 10; tick += 1) await cron.tick();

      expect(notifyAdmins).not.toHaveBeenCalled();
      expect(redis.keys.size).toBe(0);
      expect(error).not.toHaveBeenCalled();
      expect(warningsAbout(OPERATOR_A)).toBe(1);

      // The next transition is news again.
      snapshot.mockResolvedValue(RECOVERED);
      await cron.tick();
      await cron.tick();
      expect(warningsAbout(OPERATOR_A)).toBe(2);
    });

    it('tells the operator once a chat is set while the transition is still current', async () => {
      const { cron, snapshot, notifyAdmins, withoutChat } = build({
        operators: [OPERATOR_A],
        withoutChat: [OPERATOR_A.id],
      });
      snapshot.mockResolvedValue(DOWN);
      await cron.tick();

      withoutChat.delete(OPERATOR_A.id);
      await cron.tick();
      await cron.tick();

      expect(notifyAdmins).toHaveBeenCalledTimes(1);
    });
  });

  describe('a claim is not a delivery', () => {
    it('writes the marker as sent only once Telegram has accepted the message', async () => {
      const { cron, snapshot, notifyAdmins, redis } = build();
      snapshot.mockResolvedValue(DOWN);
      const duringSend: Array<string | undefined> = [];
      notifyAdmins.mockImplementation(() => {
        duringSend.push(redis.keys.get(markerOf(OPERATOR_A, DOWN)));
        return Promise.resolve({ message_id: 1 });
      });

      await cron.tick();

      expect(duringSend).toEqual(['in-flight']);
      expect(redis.keys.get(markerOf(OPERATOR_A, DOWN))).toBe('sent');
    });

    it('does not retire the recovery while another replica is still sending it', async () => {
      const { cron, snapshot, notifyAdmins, acknowledgeRecovery, redis } = build();
      snapshot.mockResolvedValue(RECOVERED);
      // Another replica claimed this operator and has not finished (or has failed) its send.
      redis.keys.set(markerOf(OPERATOR_A, RECOVERED), 'in-flight');

      await cron.tick();
      expect(notifyAdmins).not.toHaveBeenCalled();
      expect(acknowledgeRecovery).not.toHaveBeenCalled();

      // Its send completed.
      redis.keys.set(markerOf(OPERATOR_A, RECOVERED), 'sent');
      await cron.tick();
      expect(notifyAdmins).not.toHaveBeenCalled();
      expect(acknowledgeRecovery).toHaveBeenCalledWith(RECOVERED_AT);
    });

    it('tells the operator itself when the other replica’s send failed and released the claim', async () => {
      const { cron, snapshot, notifyAdmins, acknowledgeRecovery, redis } = build();
      snapshot.mockResolvedValue(RECOVERED);
      redis.keys.set(markerOf(OPERATOR_A, RECOVERED), 'in-flight');
      await cron.tick();

      redis.keys.delete(markerOf(OPERATOR_A, RECOVERED));
      await cron.tick();

      expect(notifyAdmins).toHaveBeenCalledTimes(1);
      expect(acknowledgeRecovery).toHaveBeenCalledTimes(1);
    });
  });
});
