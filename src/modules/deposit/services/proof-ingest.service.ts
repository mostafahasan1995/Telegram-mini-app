/**
 * Normalizes a proof that arrived as a STREAM (the Telegram path) and brings it to the same state
 * the mini-app path reaches inline: normalized bytes in the bucket, a sha256 of THOSE bytes on the
 * row, a perceptual hash in the index, and risk flags on the deposit.
 *
 * WHY this is a separate step at all: `TelegramFileService` never buffers a file — it meters and
 * pipes it straight into storage, because the size is attacker-controlled. Decoding an image
 * requires the whole thing in memory, so that work has to happen afterwards, once the size is known
 * to be inside the cap. It runs on the media queue, where CPU-heavy work belongs.
 *
 * WHY it is idempotent on the storage key: the media queue delivers at least once. A proof whose
 * key already points at a normalized derivative has been through here, so a redelivery re-indexes
 * (cheap, and repairs a lost Redis entry) and returns.
 *
 * WHY a failure downgrades rather than throws: an unreadable image is not a system fault — it is a
 * fact about the upload, and the right response is a PROOF_UNREADABLE risk flag on the admin card,
 * not a job that retries eight times and then sits in a dead-letter set nobody reads.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DepositProof } from '@prisma/client';

import { AuditService } from '@core/audit/audit.service';
import {
  FILE_STORAGE,
  collect,
  isFileStorageError,
  isNormalizedKey,
  normalizeImage,
  normalizedProofKey,
  type FileStorage,
} from '@core/file';
import { MAX_PROOF_BYTES } from '@core/file/telegram-file.service';
import { SYSTEM_ACTOR } from '@common/types/actor.type';
import { OutboxService } from '@core/outbox/outbox.service';
import { PrismaService } from '@core/prisma/prisma.service';
import { isUniqueConstraintError, mapPrismaError } from '@core/prisma/prisma-errors';
import type { Tx } from '@core/prisma/tx.type';

import { DEPOSIT_AGGREGATE, DEPOSIT_TOPICS } from '../deposit.constants';
import { RiskFlags, RISK_FLAG_SEVERITY, type RiskFlag } from '../enums/risk-flag.enum';
import { DepositRepository } from '../repositories/deposit.repository';
import { ProofDuplicateService } from './proof-duplicate.service';

export interface IngestOutcome {
  proofId: string;
  status: 'normalized' | 'already-normalized' | 'unreadable' | 'missing';
  riskFlags: RiskFlag[];
}

@Injectable()
export class ProofIngestService {
  private readonly logger = new Logger(ProofIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deposits: DepositRepository,
    private readonly duplicates: ProofDuplicateService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async ingest(depositProofId: string): Promise<IngestOutcome> {
    const proof = await this.deposits.findProof(this.prisma, depositProofId);
    if (proof === null) {
      this.logger.warn(`proof ${depositProofId} vanished before ingestion`);
      return { proofId: depositProofId, status: 'missing', riskFlags: [] };
    }

    const deposit = await this.prisma.depositRequest.findUniqueOrThrow({
      where: { id: proof.depositRequestId },
      select: { id: true, playerId: true, shortId: true },
    });

    if (isNormalizedKey(proof.storageKey)) {
      // Already normalized. Re-index anyway: it is idempotent and repairs a lost cache entry.
      await this.reindex(proof, deposit.playerId);
      return { proofId: proof.id, status: 'already-normalized', riskFlags: [] };
    }

    let normalized;
    try {
      const stream = await this.storage.getStream(proof.storageKey);
      // Bounded read: the stream was already metered under the same cap on the way in.
      const bytes = await collect(stream, MAX_PROOF_BYTES, `proof ${proof.id}`);
      normalized = await normalizeImage(bytes);
    } catch (cause) {
      return this.markUnreadable(proof, deposit, cause);
    }

    const normalizedKey = normalizedProofKey(deposit.id, normalized.sha256);
    // Third-party call, outside any transaction, exactly like the mini-app path.
    const stored = await this.storage.put({
      key: normalizedKey,
      body: normalized.buffer,
      contentType: normalized.mimeType,
      contentLength: normalized.sizeBytes,
      metadata: { 'deposit-short-id': deposit.shortId },
    });

    const riskFlags = await this.prisma.runInTransaction(async (tx) => {
      const report = await this.duplicates.findDuplicates(tx, {
        proofId: proof.id,
        depositRequestId: deposit.id,
        playerId: deposit.playerId,
        sha256: normalized.sha256,
        perceptualHash: normalized.perceptualHash,
        createdAt: proof.createdAt,
      });

      const flags = new Set<RiskFlag>();
      if (report.exact && report.crossPlayer) flags.add(RiskFlags.DUPLICATE_PROOF_EXACT);
      if (report.similar && report.crossPlayer) flags.add(RiskFlags.DUPLICATE_PROOF_SIMILAR);
      if (report.matches.some((match) => match.samePlayer)) {
        flags.add(RiskFlags.DUPLICATE_PROOF_SAME_PLAYER);
      }
      const ordered = [...flags].sort((a, b) => RISK_FLAG_SEVERITY[b] - RISK_FLAG_SEVERITY[a]);

      await this.updateProofRow(tx, proof, {
        bucket: stored.bucket,
        storageKey: stored.key,
        mimeType: normalized.mimeType,
        sizeBytes: normalized.sizeBytes,
        sha256: normalized.sha256,
        width: normalized.width,
        height: normalized.height,
      });

      // Risk flags live on an append-only transition row (see enums/risk-flag.enum.ts). Ingestion
      // does not change the deposit's STATUS, so this row records the finding without a state move.
      await tx.depositTransition.create({
        data: {
          depositRequestId: deposit.id,
          fromStatus: null,
          toStatus: (
            await tx.depositRequest.findUniqueOrThrow({
              where: { id: deposit.id },
              select: { status: true },
            })
          ).status,
          actorType: 'SYSTEM',
          actorId: null,
          reason: 'Proof normalized and screened',
          metadata: {
            proofId: proof.id,
            riskFlags: ordered,
            perceptualHash: normalized.perceptualHash,
            sha256: normalized.sha256,
          },
        },
        select: { id: true },
      });

      await this.audit.write(tx, {
        action: 'deposit.proof.normalized',
        actor: SYSTEM_ACTOR,
        subjectType: DEPOSIT_AGGREGATE,
        subjectId: deposit.id,
        after: { proofId: proof.id, sha256: normalized.sha256, storageKey: stored.key },
        metadata: { riskFlags: ordered, perceptualHash: normalized.perceptualHash },
      });

      await this.outbox.enqueue(tx, {
        aggregateType: DEPOSIT_AGGREGATE,
        aggregateId: deposit.id,
        topic: DEPOSIT_TOPICS.CARD_UPDATE,
        payload: { depositRequestId: deposit.id, reason: 'proof-normalized', riskFlags: ordered },
        dedupeKey: `${DEPOSIT_TOPICS.CARD_UPDATE}:${proof.id}:normalized`,
      });

      return ordered;
    });

    await this.duplicates.index({
      proofId: proof.id,
      depositRequestId: deposit.id,
      playerId: deposit.playerId,
      sha256: normalized.sha256,
      perceptualHash: normalized.perceptualHash,
      createdAt: proof.createdAt,
    });

    // The raw upload has served its purpose; the normalized derivative is what a reviewer sees and
    // what every hash refers to. Keeping both doubles storage for no evidentiary gain.
    await this.storage.delete(proof.storageKey).catch((cause: unknown) => {
      this.logger.warn(
        `could not remove the raw proof ${proof.storageKey}: ` +
          (cause instanceof Error ? cause.message : String(cause)),
      );
    });

    return { proofId: proof.id, status: 'normalized', riskFlags };
  }

  /**
   * `@@unique([depositRequestId, sha256])` can fire here: the same picture may already be attached
   * to this deposit under its normalized hash (a player who uploaded through the mini-app AND sent
   * it to the bot). That is a duplicate row, not a failure — drop this one and keep the original.
   */
  private async updateProofRow(
    tx: Tx,
    proof: DepositProof,
    patch: {
      bucket: string;
      storageKey: string;
      mimeType: string;
      sizeBytes: number;
      sha256: string;
      width: number;
      height: number;
    },
  ): Promise<void> {
    try {
      await this.deposits.updateProof(tx, proof.id, patch);
    } catch (cause) {
      const mapped = mapPrismaError(cause, { model: 'DepositProof', operation: 'update' });
      if (!isUniqueConstraintError(mapped)) throw mapped;
      this.logger.log(
        `proof ${proof.id} normalizes to a hash already on deposit ${proof.depositRequestId}; keeping one copy`,
      );
      await tx.depositProof.delete({ where: { id: proof.id } });
    }
  }

  private async reindex(proof: DepositProof, playerId: string): Promise<void> {
    const perceptualHash = await this.perceptualHashFromTransitions(proof);
    if (perceptualHash === null) return;
    await this.duplicates.index({
      proofId: proof.id,
      depositRequestId: proof.depositRequestId,
      playerId,
      sha256: proof.sha256,
      perceptualHash,
      createdAt: proof.createdAt,
    });
  }

  /**
   * The durable copy of the perceptual hash. `deposit_proofs` has no column for it, so it is written
   * to the append-only transition metadata — which is precisely what makes the Redis index a
   * rebuildable cache rather than the only record.
   */
  private async perceptualHashFromTransitions(proof: DepositProof): Promise<string | null> {
    const rows = await this.deposits.findTransitionsWithMetadata(
      this.prisma,
      proof.depositRequestId,
      20,
    );
    for (const row of rows) {
      const metadata = row.metadata;
      if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) continue;
      const record = metadata as Record<string, unknown>;
      if (record['proofId'] !== proof.id) continue;
      const hash = record['perceptualHash'];
      if (typeof hash === 'string' && hash.length > 0) return hash;
    }
    return null;
  }

  private async markUnreadable(
    proof: DepositProof,
    deposit: { id: string; playerId: string; shortId: string },
    cause: unknown,
  ): Promise<IngestOutcome> {
    const reason = isFileStorageError(cause)
      ? `${cause.code}: ${cause.message}`
      : cause instanceof Error
        ? cause.message
        : String(cause);

    this.logger.warn(`proof ${proof.id} for ${deposit.shortId} is unreadable: ${reason}`);

    await this.prisma.runInTransaction(async (tx) => {
      const current = await tx.depositRequest.findUniqueOrThrow({
        where: { id: deposit.id },
        select: { status: true },
      });
      await tx.depositTransition.create({
        data: {
          depositRequestId: deposit.id,
          fromStatus: null,
          toStatus: current.status,
          actorType: 'SYSTEM',
          actorId: null,
          reason: 'Proof could not be decoded',
          metadata: {
            proofId: proof.id,
            riskFlags: [RiskFlags.PROOF_UNREADABLE],
            error: reason,
          },
        },
        select: { id: true },
      });
      await this.outbox.enqueue(tx, {
        aggregateType: DEPOSIT_AGGREGATE,
        aggregateId: deposit.id,
        topic: DEPOSIT_TOPICS.CARD_UPDATE,
        payload: { depositRequestId: deposit.id, reason: 'proof-unreadable' },
        dedupeKey: `${DEPOSIT_TOPICS.CARD_UPDATE}:${proof.id}:unreadable`,
      });
    });

    return { proofId: proof.id, status: 'unreadable', riskFlags: [RiskFlags.PROOF_UNREADABLE] };
  }
}
