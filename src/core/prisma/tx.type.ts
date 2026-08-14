/**
 * WHY: every service that writes money takes a Tx as its FIRST argument. Naming the type here (and
 * importing it everywhere) means a repository physically cannot be called outside a transaction by
 * accident — there is no "optional tx" overload to fall back on.
 *
 * Nothing that performs IO to a third party may run inside a Tx; the only thing allowed to leave a
 * money transaction is an OutboxMessage row.
 */
import type { Prisma } from '@prisma/client';

export type Tx = Prisma.TransactionClient;
