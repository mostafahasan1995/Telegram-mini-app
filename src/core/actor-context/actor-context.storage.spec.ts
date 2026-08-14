import { adminActor, playerActor, SYSTEM_ACTOR } from '@common/types/actor.type';

import {
  createActorContext,
  getActorContext,
  getCorrelationId,
  getCurrentActor,
  normalizeIp,
  runWithActorContext,
  setCurrentActor,
} from './actor-context.storage';

describe('actor context', () => {
  it('is empty outside a run, and SYSTEM is the answer to "who?"', () => {
    expect(getActorContext()).toBeUndefined();
    expect(getCurrentActor()).toBe(SYSTEM_ACTOR);
    expect(getCorrelationId()).toBeUndefined();
  });

  it('exposes the actor and correlation id inside a run', () => {
    const actor = playerActor('11111111-1111-4111-8111-111111111111');

    runWithActorContext({ actor, correlationId: 'corr-1' }, () => {
      expect(getCurrentActor()).toBe(actor);
      expect(getCorrelationId()).toBe('corr-1');
    });
  });

  it('survives awaits inside the callback', async () => {
    await runWithActorContext(
      { actor: adminActor('admin-1'), correlationId: 'corr-2' },
      async () => {
        await Promise.resolve();
        expect(getCorrelationId()).toBe('corr-2');
      },
    );
  });

  it('starts a LAZY thenable inside the context, not after it', async () => {
    // Mirrors PrismaPromise: nothing happens until something calls .then().
    let seenCorrelationId: string | undefined;
    const lazy = {
      then(onFulfilled: (value: string) => unknown) {
        seenCorrelationId = getCorrelationId();
        return Promise.resolve('done').then(onFulfilled);
      },
    };

    // Returned WITHOUT awaiting — the bug this guards against.
    const result = runWithActorContext({ correlationId: 'corr-lazy' }, () => lazy);

    await result;
    expect(seenCorrelationId).toBe('corr-lazy');
  });

  it('lets a guard upgrade the actor mid-request', () => {
    runWithActorContext({ correlationId: 'corr-3' }, () => {
      expect(getCurrentActor().type).toBe('SYSTEM');
      expect(setCurrentActor(playerActor('p1'))).toBe(true);
      expect(getCurrentActor()).toEqual({ type: 'PLAYER', id: 'p1' });
      // The correlation id is NOT replaceable — a trace must not fork mid-request.
      expect(getCorrelationId()).toBe('corr-3');
    });
  });

  it('reports rather than throws when there is nothing to upgrade', () => {
    expect(setCurrentActor(playerActor('p1'))).toBe(false);
  });

  it('nests without merging', () => {
    runWithActorContext({ correlationId: 'outer' }, () => {
      runWithActorContext({ correlationId: 'inner' }, () => {
        expect(getCorrelationId()).toBe('inner');
      });
      expect(getCorrelationId()).toBe('outer');
    });
  });

  it('defaults a context to the SYSTEM actor with no ip', () => {
    expect(createActorContext({ correlationId: 'c' })).toEqual({
      actor: SYSTEM_ACTOR,
      correlationId: 'c',
      ip: null,
      userAgent: null,
    });
  });
});

describe('normalizeIp', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['203.0.113.9, 70.41.3.18', '203.0.113.9'],
    ['2001:db8::1', '2001:db8::1'],
    ['::1', '::1'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeIp(input)).toBe(expected);
  });

  it.each([['unknown'], [''], ['999.1.1.1'], ['127.0.0.1; DROP TABLE audit_logs']])(
    'refuses %s, because audit_logs.ip is an INET column',
    (input) => {
      expect(normalizeIp(input)).toBeNull();
    },
  );

  it('refuses null and undefined', () => {
    expect(normalizeIp(null)).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
  });
});
