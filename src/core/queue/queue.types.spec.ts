/**
 * WHY assert a mapped type at runtime: TASK_QUEUE is typed `{ [N in TaskName]: QueueName }`, so
 * omitting a task is already a compile error. What the compiler cannot catch is a task pointed at a
 * queue string that no worker is registered for — the job would be accepted, stored, and never
 * processed. These checks are cheap and cover exactly that blind spot.
 */
import { ALL_QUEUE_NAMES, QUEUE_NAMES } from './queue.constants';
import { ALL_TASK_NAMES, TASKS, TASK_QUEUE } from './queue.types';

describe('the task map', () => {
  it('routes every task to a queue that is actually registered', () => {
    for (const task of ALL_TASK_NAMES) {
      expect(ALL_QUEUE_NAMES).toContain(TASK_QUEUE[task]);
    }
  });

  it('declares a route for every task name and nothing else', () => {
    expect([...ALL_TASK_NAMES].sort()).toEqual([...Object.values(TASKS)].sort());
  });

  it('has no duplicate task names', () => {
    const names = Object.values(TASKS);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps the outbox queue for the relay alone', () => {
    // Anything else on this queue would compete with the dispatch processor for outbox jobs.
    const onOutbox = ALL_TASK_NAMES.filter((task) => TASK_QUEUE[task] === QUEUE_NAMES.OUTBOX);
    expect(onOutbox).toEqual([TASKS.OUTBOX_DISPATCH]);
  });

  it('names tasks after the queue they run on, so a misrouted task is visible in review', () => {
    for (const task of ALL_TASK_NAMES) {
      expect(task.startsWith(`${TASK_QUEUE[task]}.`)).toBe(true);
    }
  });
});

describe('queue names', () => {
  it('lists every declared queue exactly once', () => {
    const declared = Object.values(QUEUE_NAMES);
    expect([...ALL_QUEUE_NAMES].sort()).toEqual([...declared].sort());
    expect(new Set(ALL_QUEUE_NAMES).size).toBe(ALL_QUEUE_NAMES.length);
  });
});
