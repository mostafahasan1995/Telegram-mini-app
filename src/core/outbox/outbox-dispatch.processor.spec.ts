/**
 * WHY the "no handler" test is the first one: an outbox exists to make a lost side effect
 * impossible. A dispatcher that shrugs at an unknown topic and acknowledges the job would undo the
 * entire mechanism — the row would read SENT and nothing would ever have happened.
 */
import type { Job } from 'bullmq';

import { ActorContextService } from '@core/actor-context/actor-context.service';
import { getActorContext } from '@core/actor-context/actor-context.storage';
import type { OutboxDispatchTask } from '@core/queue/queue.types';

import { NoOutboxHandlerError, OutboxDispatchProcessor } from './outbox-dispatch.processor';
import type { OutboxMessageView, OutboxTopicHandler } from './outbox.types';

function job(
  overrides: Partial<OutboxDispatchTask> = {},
): Job<OutboxDispatchTask, unknown, string> {
  const data: OutboxDispatchTask = {
    outboxId: '018f0000-0000-7000-8000-000000000001',
    topic: 'deposit.credit.requested',
    aggregateType: 'DepositRequest',
    aggregateId: 'dep-1',
    payload: { shortId: 'K7Q2ZP9V3M' },
    attempt: 1,
    ...overrides,
  };
  return { id: `outbox-${data.outboxId}`, data, attemptsMade: 1 } as Job<
    OutboxDispatchTask,
    unknown,
    string
  >;
}

function recorder(topic: string): OutboxTopicHandler & { seen: OutboxMessageView[] } {
  const seen: OutboxMessageView[] = [];
  return {
    topic,
    seen,
    handle(message: OutboxMessageView): Promise<void> {
      seen.push(message);
      return Promise.resolve();
    },
  };
}

const build = (handlers: OutboxTopicHandler[]): OutboxDispatchProcessor =>
  new OutboxDispatchProcessor(new ActorContextService(), handlers);

describe('OutboxDispatchProcessor — routing', () => {
  it('delivers the committed message to the handler that claims the topic', async () => {
    const handler = recorder('deposit.credit.requested');
    await build([handler]).process(job());

    expect(handler.seen).toHaveLength(1);
    expect(handler.seen[0]).toEqual({
      outboxId: '018f0000-0000-7000-8000-000000000001',
      topic: 'deposit.credit.requested',
      aggregateType: 'DepositRequest',
      aggregateId: 'dep-1',
      payload: { shortId: 'K7Q2ZP9V3M' },
      attempt: 1,
    });
  });

  it('fails the job when nothing is subscribed, instead of dropping the side effect', async () => {
    await expect(build([recorder('something.else')]).process(job())).rejects.toBeInstanceOf(
      NoOutboxHandlerError,
    );
  });

  it('fails the same way when the handler table is empty', async () => {
    // The table itself can no longer be missing — OutboxModule.forWorker() binds it and the inject
    // is not optional — but an empty table must still fail the job rather than drop the effect.
    await expect(build([]).process(job())).rejects.toBeInstanceOf(NoOutboxHandlerError);
  });

  it('fans out to every handler that claims the topic', async () => {
    const first = recorder('deposit.credit.requested');
    const second = recorder('deposit.credit.requested');
    await build([first, second]).process(job());

    expect(first.seen).toHaveLength(1);
    expect(second.seen).toHaveLength(1);
  });

  it('lets a prefix subscription catch topics nobody claimed by name', async () => {
    const wildcard = recorder('telegram.*');
    await build([wildcard]).process(job({ topic: 'telegram.notify.player' }));
    expect(wildcard.seen).toHaveLength(1);
  });

  it('does not double-deliver to a catch-all once a specific handler exists', async () => {
    const wildcard = recorder('deposit.*');
    const exact = recorder('deposit.credit.requested');
    await build([wildcard, exact]).process(job());

    expect(exact.seen).toHaveLength(1);
    expect(wildcard.seen).toHaveLength(0);
  });

  it('propagates a handler failure so BullMQ retries the message', async () => {
    const failing: OutboxTopicHandler = {
      topic: 'deposit.credit.requested',
      handle: () => Promise.reject(new Error('telegram 502')),
    };
    await expect(build([failing]).process(job())).rejects.toThrow('telegram 502');
  });
});

describe('OutboxDispatchProcessor — actor context', () => {
  it('runs handlers as SYSTEM so their audit rows are attributable', async () => {
    let observed: { actor: { type: string }; correlationId: string } | undefined;
    const handler: OutboxTopicHandler = {
      topic: 'deposit.credit.requested',
      handle: () => {
        const store = getActorContext();
        if (store) observed = { actor: store.actor, correlationId: store.correlationId };
        return Promise.resolve();
      },
    };

    await build([handler]).process(job());
    expect(observed?.actor.type).toBe('SYSTEM');
  });

  it('keeps the producer correlation id so an effect can be traced to its request', async () => {
    let correlationId: string | undefined;
    const handler: OutboxTopicHandler = {
      topic: 'deposit.credit.requested',
      handle: () => {
        correlationId = getActorContext()?.correlationId;
        return Promise.resolve();
      },
    };

    await build([handler]).process(
      job({ payload: { shortId: 'K7Q2ZP9V3M', correlationId: 'corr-from-request' } }),
    );
    expect(correlationId).toBe('corr-from-request');
  });

  it('falls back to the outbox row id, which is stable across every retry', async () => {
    let correlationId: string | undefined;
    const handler: OutboxTopicHandler = {
      topic: 'deposit.credit.requested',
      handle: () => {
        correlationId = getActorContext()?.correlationId;
        return Promise.resolve();
      },
    };

    await build([handler]).process(job());
    expect(correlationId).toBe('018f0000-0000-7000-8000-000000000001');
  });
});
