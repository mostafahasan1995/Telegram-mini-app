/**
 * WHY a service in front of a repository that already does the work: this is the one public writer.
 * Everything outside core/ledger imports LedgerService and nothing else, so "who can move money?"
 * has a one-line answer, and the two ways to post are named rather than improvised:
 *
 *   post(tx, posting)              — you already own a transaction. The deposit approval writes the
 *                                    deposit row and T1 in ONE transaction; splitting them would let
 *                                    a crash approve a deposit that never hit the ledger.
 *   postWithRetry(runner, posting) — you own nothing. Opens its own transaction (READ COMMITTED, see
 *                                    DEFAULT_POSTING_ISOLATION) and retries deadlocks.
 *
 * The runner is passed in rather than injected so core/ledger never depends on a PrismaService owned
 * by another module — LedgerTxRunner is structural, and a real PrismaClient satisfies it as-is.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { Tx } from '@core/prisma/tx.type';

import { LedgerRepository } from './ledger.repository';
import type { LedgerTxRunner, PostedTransaction, Posting } from './ledger.types';
import { withSerializationRetry, type SerializationRetryOptions } from './serialization-retry.util';

/**
 * READ COMMITTED, deliberately — and measured, not assumed.
 *
 * The repository locks every touched account with SELECT … FOR UPDATE, and under READ COMMITTED a
 * blocked writer re-reads the newest committed row once the lock is granted. That is exactly the
 * lost-update protection SERIALIZABLE would give us, obtained by WAITING instead of ABORTING.
 *
 * SERIALIZABLE was the first choice here and it was wrong. Every player credit debits the one
 * ICHANCY_AGENT_FLOAT account, so concurrent credits are the normal case, not an edge case. Under
 * SERIALIZABLE, 8 concurrent postings against that single hot account produced a storm of 40001s and
 * some exhausted their retries outright — i.e. the "safest" isolation level turned routine
 * contention into failed credits. Under READ COMMITTED the same 8 postings all commit, and the
 * balances still reconcile exactly.
 *
 * withSerializationRetry stays wrapped around it regardless: deadlocks (40P01) remain possible from
 * anywhere in the system, and a retry is the only correct response to one.
 */
const DEFAULT_POSTING_ISOLATION: Prisma.TransactionIsolationLevel = 'ReadCommitted';

export interface PostWithRetryOptions extends SerializationRetryOptions {
  /** Override only with a reason. See DEFAULT_POSTING_ISOLATION above. */
  readonly isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Milliseconds the interactive transaction may run before Prisma cancels it. */
  readonly timeout?: number;
  /** Milliseconds to wait for a connection from the pool. */
  readonly maxWait?: number;
}

@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(private readonly repository: LedgerRepository) {}

  /**
   * Post inside a transaction the caller owns. No retry is possible here by construction: if this
   * throws a serialization error the caller's whole transaction is already dead, so the retry has to
   * live where the transaction was opened.
   */
  async post(tx: Tx, posting: Posting): Promise<PostedTransaction> {
    return this.repository.post(tx, posting);
  }

  /**
   * Post several postings atomically in the caller's transaction — either every one lands or none
   * does. Sequential because they may touch the same accounts, and interleaving statements on one
   * connection is not something an interactive transaction supports anyway.
   */
  async postMany(tx: Tx, postings: readonly Posting[]): Promise<PostedTransaction[]> {
    const results: PostedTransaction[] = [];
    for (const posting of postings) {
      results.push(await this.repository.post(tx, posting));
    }
    return results;
  }

  /**
   * Open a transaction, post, retry on serialization failure. For callers with nothing else to
   * write — the agent-float sync cron, a manual adjustment from the admin bot.
   */
  async postWithRetry(
    runner: LedgerTxRunner,
    posting: Posting,
    options: PostWithRetryOptions = {},
  ): Promise<PostedTransaction> {
    return withSerializationRetry(
      (attempt) => {
        if (attempt > 1) {
          this.logger.warn(`retrying posting ${posting.idempotencyKey} (attempt ${attempt})`);
        }
        return runner.$transaction((tx) => this.repository.post(tx, posting), {
          isolationLevel: options.isolationLevel ?? DEFAULT_POSTING_ISOLATION,
          ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
          ...(options.maxWait === undefined ? {} : { maxWait: options.maxWait }),
        });
      },
      {
        ...options,
        onRetry: (attempt, error) => {
          this.logger.warn(
            `serialization conflict on ${posting.idempotencyKey} attempt ${attempt}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          options.onRetry?.(attempt, error);
        },
      },
    );
  }
}
