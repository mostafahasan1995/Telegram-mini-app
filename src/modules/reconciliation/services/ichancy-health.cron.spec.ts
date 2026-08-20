/**
 * THE ANTI-ALARM-FATIGUE PROOF.
 *
 * Two opposite failures are being pinned. Silence — which is what actually happened on 2026-08-20,
 * where the integration was blocked for hours and no human was told. And noise: a one-minute cron
 * that posted on every tick would send twelve messages an hour for the whole outage, which teaches
 * operators to skim past alarms and is therefore the same failure wearing a different hat.
 *
 * The property is: one message per STATE CHANGE, and nothing in between.
 */
import { type LockService } from '@core/cache/lock.service';
import { type RedisService } from '@core/cache/redis.service';
import { type AppConfigService } from '@core/config/config.service';
import { type IchancyHealthService, type IchancyHealthSnapshot } from '@core/ichancy';
import { type PrismaService } from '@core/prisma/prisma.service';
import { type BotService } from '@core/telegram/services/bot.service';

import { IchancyHealthAlertCron } from './ichancy-health.cron';

const HANDLE = { key: 'lock:cron:ichancy-health-alert', token: 't', acquiredAt: 0, ttlMs: 1_000 };

const OUTAGE_START = new Date('2026-08-20T04:14:00.000Z');
const RECOVERED_AT = new Date('2026-08-20T07:44:00.000Z');

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

/** Only SET ... NX and DEL are used, and NX is the whole "announce once" mechanism. */
class FakeRedis {
  readonly keys = new Set<string>();

  set(key: string, _value: string, _ex: string, _ttl: number, _nx: string): Promise<'OK' | null> {
    if (this.keys.has(key)) return Promise.resolve(null);
    this.keys.add(key);
    return Promise.resolve('OK');
  }

  del(key: string): Promise<number> {
    return Promise.resolve(this.keys.delete(key) ? 1 : 0);
  }
}

function build(options: { isWorker?: boolean; fake?: boolean } = {}): {
  cron: IchancyHealthAlertCron;
  snapshot: jest.Mock;
  notifyAdmins: jest.Mock;
  redis: FakeRedis;
} {
  const snapshot = jest.fn().mockResolvedValue(STEADY_UP);
  const notifyAdmins = jest.fn().mockResolvedValue({ message_id: 1 });
  const redis = new FakeRedis();
  const count = jest.fn().mockResolvedValue(0);

  const cron = new IchancyHealthAlertCron(
    { snapshot } as unknown as IchancyHealthService,
    { notifyAdmins } as unknown as BotService,
    {
      acquire: jest.fn().mockResolvedValue(HANDLE),
      release: jest.fn().mockResolvedValue(true),
    } as unknown as LockService,
    redis as unknown as RedisService,
    { player: { count } } as unknown as PrismaService,
    {
      app: { isWorker: options.isWorker ?? true },
      ichancy: { fake: options.fake ?? false },
    } as unknown as AppConfigService,
  );
  return { cron, snapshot, notifyAdmins, redis };
}

describe('IchancyHealthAlertCron', () => {
  it('posts EXACTLY ONCE across ten consecutive DOWN ticks', async () => {
    const { cron, snapshot, notifyAdmins } = build();
    snapshot.mockResolvedValue(DOWN);

    for (let tick = 0; tick < 10; tick += 1) await cron.tick();

    expect(notifyAdmins).toHaveBeenCalledTimes(1);
  });

  it('posts exactly one more when the integration comes back', async () => {
    const { cron, snapshot, notifyAdmins } = build();
    snapshot.mockResolvedValue(DOWN);
    await cron.tick();
    await cron.tick();

    snapshot.mockResolvedValue(RECOVERED);
    await cron.tick();
    await cron.tick();
    await cron.tick();

    expect(notifyAdmins).toHaveBeenCalledTimes(2);
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

    const text = notifyAdmins.mock.calls[0][0] as string;
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
    expect(notifyAdmins.mock.calls[0][0] as string).toContain('3 ساعة و30 دقيقة');
  });

  it('retries next tick when the admin chat is unreachable', async () => {
    // notifyAdmins returns null rather than throwing for an unreachable chat. Keeping the marker
    // would mean we had "alerted" into a void and would never try again — the alarm would be lost
    // in exactly the situation it exists for.
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
});
