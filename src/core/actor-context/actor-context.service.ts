/**
 * WHY a service on top of plain functions: workers, cron jobs and the outbox relay have no HTTP
 * request to inherit a context from, and they are the places where "actor = SYSTEM, correlationId =
 * this job" matters most. Injecting a service (instead of importing module-level functions) keeps
 * those call sites testable and makes the dependency visible in the constructor.
 */
import { Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';

import { SYSTEM_ACTOR, type Actor } from '@common/types/actor.type';

import {
  createActorContext,
  getActorContext,
  getCorrelationId,
  getCurrentActor,
  runWithActorContext,
  setCurrentActor,
  type ActorContextInit,
  type ActorContextStore,
} from './actor-context.storage';

@Injectable()
export class ActorContextService {
  /** uuidv7 so correlation ids sort by time in a log aggregator. */
  newCorrelationId(): string {
    return uuidv7();
  }

  get(): ActorContextStore | undefined {
    return getActorContext();
  }

  get actor(): Actor {
    return getCurrentActor();
  }

  get correlationId(): string | undefined {
    return getCorrelationId();
  }

  /** Returns false when called outside any context — callers decide whether that is a bug. */
  setActor(actor: Actor): boolean {
    return setCurrentActor(actor);
  }

  run<T>(init: ActorContextInit, fn: () => T): T {
    return runWithActorContext(init, fn);
  }

  /** The default for anything the machine started on its own (cron, queue, relay). */
  runAsSystem<T>(fn: () => T, correlationId?: string): T {
    return runWithActorContext(
      { actor: SYSTEM_ACTOR, correlationId: correlationId ?? this.newCorrelationId() },
      fn,
    );
  }

  create(init: ActorContextInit): ActorContextStore {
    return createActorContext(init);
  }
}
