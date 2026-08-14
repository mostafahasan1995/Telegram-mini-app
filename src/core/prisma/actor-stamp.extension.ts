/**
 * WHY: every append-only row in this schema records WHO caused it, and the answer is already known
 * — it lives in the AsyncLocalStorage actor context. Relying on each call site to pass it means the
 * one call site that forgets produces an audit row that says "SYSTEM" for a player action, and
 * nobody notices until an auditor asks.
 *
 * DEVIATION worth knowing: there is no `createdById`/`updatedById` pair anywhere in this schema.
 * The actor is modelled per table with the pair that reads naturally there — `actorType/actorId`,
 * `uploadedByType/uploadedById`, `setByType/setById`, `requestedByType/requestedById` — and there
 * is no `updatedBy` at all, because the tables that carry an actor are exactly the tables that are
 * never updated (ledger, transitions, audit). The map below is therefore the schema's own truth,
 * not a convention this file invents.
 *
 * Three rules keep this from ever corrupting a write:
 *  1. Only INSERT-shaped operations are touched (create, createMany, createManyAndReturn, upsert's
 *     create branch). Updates are never rewritten.
 *  2. A field the caller set explicitly is NEVER overwritten — the extension only fills blanks.
 *  3. An actor id is only written when it is a syntactically valid UUID. Those columns are
 *     `@db.Uuid`; stamping a Telegram id there would abort the whole money transaction.
 *
 * TIMING (verified, and the reason runWithActorContext touches `.then`): this callback runs when
 * the query is AWAITED, not when it is built. A query built inside an actor context but awaited
 * outside it would be stamped with whatever context is active at await time.
 */
import { Prisma } from '@prisma/client';

import { getActorContext, type ActorContextStore } from '@core/actor-context/actor-context.storage';

interface ActorStampFields {
  /** Column holding the ActorType enum. */
  type?: string;
  /** Column holding the actor's uuid (nullable for SYSTEM). */
  id?: string;
  correlationId?: string;
  ip?: string;
  userAgent?: string;
}

/** Keyed by Prisma MODEL name (what the extension receives), not by table name. */
export const ACTOR_STAMPED_MODELS: Readonly<Record<string, ActorStampFields>> = Object.freeze({
  AuditLog: {
    type: 'actorType',
    id: 'actorId',
    correlationId: 'correlationId',
    ip: 'ip',
    userAgent: 'userAgent',
  },
  DepositTransition: { type: 'actorType', id: 'actorId' },
  LedgerTransaction: { type: 'actorType', id: 'actorId' },
  DepositProof: { type: 'uploadedByType', id: 'uploadedById' },
  PlayerLimit: { type: 'setByType', id: 'setById' },
  SelfExclusion: { type: 'requestedByType', id: 'requestedById' },
  IchancyCall: { correlationId: 'correlationId' },
});

const WRITE_OPERATIONS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'upsert',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function stampRecord(
  data: Record<string, unknown>,
  fields: ActorStampFields,
  store: ActorContextStore,
): void {
  // The type/id pair moves together: if the caller named the actor type, the id is theirs to set.
  if (fields.type !== undefined && fields.id !== undefined) {
    if (data[fields.type] === undefined && data[fields.id] === undefined) {
      data[fields.type] = store.actor.type;
      data[fields.id] =
        store.actor.id !== null && UUID.test(store.actor.id) ? store.actor.id : null;
    }
  } else if (fields.type !== undefined && data[fields.type] === undefined) {
    data[fields.type] = store.actor.type;
  }

  if (fields.correlationId !== undefined && data[fields.correlationId] === undefined) {
    data[fields.correlationId] = store.correlationId;
  }
  if (fields.ip !== undefined && data[fields.ip] === undefined && store.ip !== null) {
    data[fields.ip] = store.ip;
  }
  if (
    fields.userAgent !== undefined &&
    data[fields.userAgent] === undefined &&
    store.userAgent !== null
  ) {
    data[fields.userAgent] = store.userAgent;
  }
}

/** Copy-on-write: Prisma's args object belongs to the caller and may be reused across a retry. */
function stampPayload(
  payload: unknown,
  fields: ActorStampFields,
  store: ActorContextStore,
): unknown {
  if (Array.isArray(payload)) {
    return payload.map((row) => stampPayload(row, fields, store));
  }
  if (!isRecord(payload)) return payload;
  const copy = { ...payload };
  stampRecord(copy, fields, store);
  return copy;
}

function stampArgs(
  rawArgs: unknown,
  operation: string,
  fields: ActorStampFields,
  store: ActorContextStore,
): unknown {
  if (!isRecord(rawArgs)) return rawArgs;

  if (operation === 'upsert') {
    if (rawArgs.create === undefined) return rawArgs;
    return { ...rawArgs, create: stampPayload(rawArgs.create, fields, store) };
  }

  if (rawArgs.data === undefined) return rawArgs;
  return { ...rawArgs, data: stampPayload(rawArgs.data, fields, store) };
}

/**
 * Applied in PrismaService. Outside an actor context (a script, a test) the extension is a no-op,
 * so nothing here can make a write fail that would otherwise have succeeded.
 */
export const actorStampExtension = Prisma.defineExtension({
  name: 'actor-stamp',
  query: {
    $allModels: {
      $allOperations({ model, operation, args, query }) {
        if (!WRITE_OPERATIONS.has(operation)) return query(args);

        const fields = ACTOR_STAMPED_MODELS[model];
        if (fields === undefined) return query(args);

        const store = getActorContext();
        if (store === undefined) return query(args);

        return query(stampArgs(args, operation, fields, store) as typeof args);
      },
    },
  },
});
