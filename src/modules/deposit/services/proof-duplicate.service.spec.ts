/**
 * The perceptual duplicate index, per operator.
 *
 * The defect this pins: the index keys carried no tenant, so operator A's proof ingest matched
 * operator B's receipts, put a cross-player duplicate flag on A's deposit on the strength of B's
 * evidence, and wrote B's deposit and player ids into A's transition metadata.
 */
import type { RedisService } from '@core/cache/redis.service';
import type { Tx } from '@core/prisma/tx.type';

import { proofBandKey, proofRecordKey } from '../deposit.constants';
import type { DepositRepository } from '../repositories/deposit.repository';
import { ProofDuplicateService, type ProofFingerprint } from './proof-duplicate.service';

const TENANT_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-222222222222';
/** One perceptual hash for every receipt below: the same wallet-app screen, photographed twice. */
const HASH = 'a1b2c3d4e5f60718';

type PipelineResult = [Error | null, unknown][];

interface FakePipeline {
  set(key: string, value: string, mode: string, ttl: number): FakePipeline;
  zadd(key: string, score: number, member: string): FakePipeline;
  zremrangebyscore(key: string, min: number, max: number): FakePipeline;
  expire(key: string, ttl: number): FakePipeline;
  zrangebyscore(key: string, min: number, max: string): FakePipeline;
  exec(): Promise<PipelineResult>;
}

/** Strings and sorted sets, which is all the index uses. Pipelines run their queue in order. */
class FakeRedis {
  readonly strings = new Map<string, string>();
  readonly sortedSets = new Map<string, Map<string, number>>();

  private set(key: string): Map<string, number> {
    let existing = this.sortedSets.get(key);
    if (existing === undefined) {
      existing = new Map<string, number>();
      this.sortedSets.set(key, existing);
    }
    return existing;
  }

  multi(): FakePipeline {
    const queue: (() => unknown)[] = [];
    const pipeline: FakePipeline = {
      set: (key, value) => {
        queue.push(() => this.strings.set(key, value) && 'OK');
        return pipeline;
      },
      zadd: (key, score, member) => {
        queue.push(() => this.set(key).set(member, score).size);
        return pipeline;
      },
      zremrangebyscore: (key, min, max) => {
        queue.push(() => {
          for (const [member, score] of this.set(key)) {
            if (score >= min && score <= max) this.set(key).delete(member);
          }
          return 0;
        });
        return pipeline;
      },
      expire: () => {
        queue.push(() => 1);
        return pipeline;
      },
      zrangebyscore: (key, min) => {
        queue.push(() =>
          [...this.set(key)].filter(([, score]) => score >= min).map(([member]) => member),
        );
        return pipeline;
      },
      exec: () => Promise.resolve(queue.map((run): [Error | null, unknown] => [null, run()])),
    };
    return pipeline;
  }

  mget(...keys: string[]): Promise<(string | null)[]> {
    return Promise.resolve(keys.map((key) => this.strings.get(key) ?? null));
  }
}

function build(): {
  service: ProofDuplicateService;
  redis: FakeRedis;
  findDepositsBySha256: jest.Mock;
} {
  const redis = new FakeRedis();
  const findDepositsBySha256 = jest.fn().mockResolvedValue([]);
  const service = new ProofDuplicateService(
    redis as unknown as RedisService,
    { findDepositsBySha256 } as unknown as DepositRepository,
  );
  return { service, redis, findDepositsBySha256 };
}

const receipt = (tenantId: string, name: string): ProofFingerprint => ({
  tenantId,
  proofId: `proof-${name}`,
  depositRequestId: `deposit-${name}`,
  playerId: `player-${name}`,
  sha256: `${name.padEnd(64, '0')}`.slice(0, 64),
  perceptualHash: HASH,
  createdAt: new Date(),
});

const tx = {} as Tx;

describe('ProofDuplicateService — one index per operator', () => {
  it("does not match another operator's receipt, however identical", async () => {
    const { service } = build();
    await service.index(receipt(TENANT_B, 'b1'));

    const report = await service.findDuplicates(tx, receipt(TENANT_A, 'a1'));

    expect(report).toEqual({ matches: [], crossPlayer: false, exact: false, similar: false });
  });

  it("still matches the same picture within the operator", async () => {
    const { service } = build();
    const first = receipt(TENANT_B, 'b1');
    await service.index(first);

    const report = await service.findDuplicates(tx, receipt(TENANT_B, 'b2'));

    expect(report.matches).toEqual([
      expect.objectContaining({
        proofId: first.proofId,
        depositRequestId: first.depositRequestId,
        distance: 0,
        kind: 'EXACT',
        samePlayer: false,
      }),
    ]);
    expect(report.crossPlayer).toBe(true);
  });

  it('writes the operator into every key it touches and into the record', async () => {
    const { service, redis } = build();
    const fingerprint = receipt(TENANT_B, 'b1');

    await service.index(fingerprint);

    const keys = [...redis.strings.keys(), ...redis.sortedSets.keys()];
    expect(keys.length).toBeGreaterThan(1);
    expect(keys.every((key) => key.includes(`:${TENANT_B}:`))).toBe(true);
    const stored = redis.strings.get(proofRecordKey(TENANT_B, fingerprint.proofId));
    expect(JSON.parse(stored ?? '{}')).toMatchObject({ tenantId: TENANT_B });
  });

  it("ignores a record naming another operator, even under this operator's keys", async () => {
    const { service, redis } = build();
    // Planted by hand: the keyed lookup alone would return it.
    redis.strings.set(
      proofRecordKey(TENANT_A, 'proof-planted'),
      JSON.stringify({
        tenantId: TENANT_B,
        proofId: 'proof-planted',
        depositRequestId: 'deposit-planted',
        playerId: 'player-planted',
        perceptualHash: HASH,
        at: Date.now(),
      }),
    );
    await redis
      .multi()
      .zadd(proofBandKey(TENANT_A, `0:${HASH.slice(0, 2)}`), Date.now(), 'proof-planted')
      .exec();

    const report = await service.findDuplicates(tx, receipt(TENANT_A, 'a1'));

    expect(report.matches).toEqual([]);
  });

  it('asks the exact tier for this operator only', async () => {
    const { service, findDepositsBySha256 } = build();
    const fingerprint = receipt(TENANT_A, 'a1');

    await service.findDuplicates(tx, fingerprint);

    expect(findDepositsBySha256).toHaveBeenCalledWith(
      tx,
      TENANT_A,
      fingerprint.sha256,
      fingerprint.depositRequestId,
    );
  });
});
