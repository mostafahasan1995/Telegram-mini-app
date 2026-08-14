/**
 * Cross-player duplicate detection over a 180-day window, in two tiers.
 *
 * TIER 1 — exact. sha256 of the NORMALIZED bytes, queried straight out of `deposit_proofs`. Durable,
 * transactional, and immune to a Redis flush. It catches the same file re-uploaded, and (because the
 * bytes are normalized first) also the same picture re-saved with different EXIF or a different
 * JPEG container.
 *
 * TIER 2 — perceptual. 64-bit dHash, Hamming distance <= 6. This is what survives a crop, a
 * re-compression, a screenshot of a screenshot.
 *
 * WHY tier 2 lives in Redis and not in Postgres — and why that is honest rather than a shortcut:
 * `deposit_proofs` has no perceptual-hash column, and the schema is owned by the foundation, so this
 * module cannot add one (the ledger hit the same wall and made the same call; see its README). The
 * hash is therefore ALSO written into the append-only DepositTransition metadata, which means the
 * index is a CACHE and can be rebuilt from Postgres if Redis is lost — nothing is only in Redis.
 *
 * WHY the index is banded (LSH), not a scan: with 8 bands of 8 bits each, two hashes within 6 bits
 * must agree on at least TWO whole bands — 6 differing bits can touch at most 6 of the 8 bands, so
 * at least 2 are untouched. Looking up the 8 band keys therefore finds EVERY true match at this
 * threshold (no false negatives, by the pigeonhole principle) while reading a handful of small sets
 * instead of 180 days of hashes. Raising PROOF_DUPLICATE_MAX_DISTANCE above 7 without adding bands
 * would silently start missing matches — hence the assertion in the constructor.
 *
 * Nothing here rejects anything. It returns evidence; DepositService turns it into risk flags and a
 * human decides. See enums/risk-flag.enum.ts for why.
 */
import { Injectable, Logger } from '@nestjs/common';

import { RedisService } from '@core/cache/redis.service';
import { hammingDistanceHex, hashBands, isPerceptualHash } from '@core/file/image.util';
import type { Tx } from '@core/prisma/tx.type';

import {
  PROOF_DUPLICATE_MAX_DISTANCE,
  PROOF_DUPLICATE_WINDOW_MS,
  PROOF_HASH_BAND_COUNT,
  proofBandKey,
  proofRecordKey,
} from '../deposit.constants';
import { DepositRepository } from '../repositories/deposit.repository';

export interface ProofFingerprint {
  proofId: string;
  depositRequestId: string;
  playerId: string;
  sha256: string;
  perceptualHash: string;
  createdAt: Date;
}

export interface DuplicateMatch {
  proofId: string;
  depositRequestId: string;
  playerId: string;
  /** 0 for an exact sha256 hit; otherwise the Hamming distance between the two dHashes. */
  distance: number;
  kind: 'EXACT' | 'SIMILAR';
  samePlayer: boolean;
  matchedAt: Date;
}

export interface DuplicateReport {
  matches: DuplicateMatch[];
  /** True when at least one match belongs to a DIFFERENT player — the signal that matters. */
  crossPlayer: boolean;
  exact: boolean;
  similar: boolean;
}

/** One indexed proof, as stored in the Redis record hash. All strings: it round-trips through JSON. */
interface IndexedProof {
  proofId: string;
  depositRequestId: string;
  playerId: string;
  perceptualHash: string;
  at: number;
}

@Injectable()
export class ProofDuplicateService {
  private readonly logger = new Logger(ProofDuplicateService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly deposits: DepositRepository,
  ) {
    // Guard the pigeonhole argument in the header: bands must outnumber the tolerated bit errors.
    if (PROOF_DUPLICATE_MAX_DISTANCE >= PROOF_HASH_BAND_COUNT) {
      throw new Error(
        `PROOF_DUPLICATE_MAX_DISTANCE (${PROOF_DUPLICATE_MAX_DISTANCE}) must be smaller than ` +
          `PROOF_HASH_BAND_COUNT (${PROOF_HASH_BAND_COUNT}), or the banded index loses matches`,
      );
    }
  }

  /**
   * Look for prior proofs matching this fingerprint. Read-only: indexing is a separate call so the
   * caller can decide the order (we look BEFORE we index, otherwise every proof matches itself).
   */
  async findDuplicates(tx: Tx, fingerprint: ProofFingerprint): Promise<DuplicateReport> {
    const byId = new Map<string, DuplicateMatch>();

    for (const hit of await this.findExact(tx, fingerprint)) byId.set(hit.proofId, hit);

    for (const hit of await this.findSimilar(fingerprint)) {
      // An exact hit already says everything a similar hit would; never downgrade one.
      if (!byId.has(hit.proofId)) byId.set(hit.proofId, hit);
    }

    const matches = [...byId.values()].sort((a, b) => a.distance - b.distance);
    return {
      matches,
      crossPlayer: matches.some((match) => !match.samePlayer),
      exact: matches.some((match) => match.kind === 'EXACT'),
      similar: matches.some((match) => match.kind === 'SIMILAR'),
    };
  }

  /**
   * Add this proof to the perceptual index. Every key gets the same 180-day TTL, so the window
   * expires on its own without a sweeper — and a band set that stops being written simply vanishes.
   */
  async index(fingerprint: ProofFingerprint): Promise<void> {
    if (!isPerceptualHash(fingerprint.perceptualHash)) return;

    const record: IndexedProof = {
      proofId: fingerprint.proofId,
      depositRequestId: fingerprint.depositRequestId,
      playerId: fingerprint.playerId,
      perceptualHash: fingerprint.perceptualHash,
      at: fingerprint.createdAt.getTime(),
    };

    const ttlSeconds = Math.ceil(PROOF_DUPLICATE_WINDOW_MS / 1000);
    const pipeline = this.redis.multi();
    pipeline.set(proofRecordKey(record.proofId), JSON.stringify(record), 'EX', ttlSeconds);

    for (const band of hashBands(fingerprint.perceptualHash, PROOF_HASH_BAND_COUNT)) {
      const key = proofBandKey(band);
      // A sorted set scored by timestamp lets one ZREMRANGEBYSCORE drop everything past the window
      // without touching the members that are still inside it.
      pipeline.zadd(key, record.at, record.proofId);
      pipeline.zremrangebyscore(key, 0, record.at - PROOF_DUPLICATE_WINDOW_MS);
      pipeline.expire(key, ttlSeconds);
    }

    try {
      await pipeline.exec();
    } catch (cause) {
      // The index is a cache. Losing a write costs us a future signal, never a deposit.
      this.logger.warn(
        `Could not index proof ${fingerprint.proofId}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }

  /** Tier 1: identical normalized bytes. Postgres, transactional, no cache involved. */
  private async findExact(tx: Tx, fingerprint: ProofFingerprint): Promise<DuplicateMatch[]> {
    const cutoff = new Date(fingerprint.createdAt.getTime() - PROOF_DUPLICATE_WINDOW_MS);
    const rows = await this.deposits.findDepositsBySha256(
      tx,
      fingerprint.sha256,
      fingerprint.depositRequestId,
    );

    return rows
      .filter((row) => row.createdAt >= cutoff)
      .map((row) => ({
        // The exact query groups by deposit, so the proof id is not carried; the deposit is the
        // unit an admin acts on anyway.
        proofId: `deposit:${row.depositRequestId}`,
        depositRequestId: row.depositRequestId,
        playerId: row.playerId,
        distance: 0,
        kind: 'EXACT' as const,
        samePlayer: row.playerId === fingerprint.playerId,
        matchedAt: row.createdAt,
      }));
  }

  /** Tier 2: the banded perceptual index. Degrades to "no matches" if Redis is unavailable. */
  private async findSimilar(fingerprint: ProofFingerprint): Promise<DuplicateMatch[]> {
    if (!isPerceptualHash(fingerprint.perceptualHash)) return [];

    const since = fingerprint.createdAt.getTime() - PROOF_DUPLICATE_WINDOW_MS;
    const candidateIds = new Set<string>();

    try {
      const bandKeys = hashBands(fingerprint.perceptualHash, PROOF_HASH_BAND_COUNT).map(
        proofBandKey,
      );
      const pipeline = this.redis.multi();
      for (const key of bandKeys) pipeline.zrangebyscore(key, since, '+inf');
      const results = await pipeline.exec();

      for (const entry of results ?? []) {
        const [error, value] = entry;
        if (error !== null || !Array.isArray(value)) continue;
        for (const member of value) {
          if (typeof member === 'string' && member !== fingerprint.proofId) {
            candidateIds.add(member);
          }
        }
      }
    } catch (cause) {
      this.logger.warn(
        `Perceptual index lookup failed; falling back to exact matching only: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return [];
    }

    if (candidateIds.size === 0) return [];

    const records = await this.loadRecords([...candidateIds]);
    const matches: DuplicateMatch[] = [];

    for (const record of records) {
      if (record.depositRequestId === fingerprint.depositRequestId) continue;
      if (record.at < since) continue;

      const distance = hammingDistanceHex(fingerprint.perceptualHash, record.perceptualHash);
      if (distance > PROOF_DUPLICATE_MAX_DISTANCE) continue;

      matches.push({
        proofId: record.proofId,
        depositRequestId: record.depositRequestId,
        playerId: record.playerId,
        distance,
        kind: distance === 0 ? 'EXACT' : 'SIMILAR',
        samePlayer: record.playerId === fingerprint.playerId,
        matchedAt: new Date(record.at),
      });
    }

    return matches;
  }

  private async loadRecords(proofIds: readonly string[]): Promise<IndexedProof[]> {
    if (proofIds.length === 0) return [];
    const raw = await this.redis.mget(...proofIds.map(proofRecordKey));
    const records: IndexedProof[] = [];

    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(entry);
      } catch {
        // A record written by an older shape is a miss, never a crash on the proof path.
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const candidate = parsed as Partial<IndexedProof>;
      if (
        typeof candidate.proofId !== 'string' ||
        typeof candidate.depositRequestId !== 'string' ||
        typeof candidate.playerId !== 'string' ||
        typeof candidate.perceptualHash !== 'string' ||
        typeof candidate.at !== 'number' ||
        !isPerceptualHash(candidate.perceptualHash)
      ) {
        continue;
      }
      records.push({
        proofId: candidate.proofId,
        depositRequestId: candidate.depositRequestId,
        playerId: candidate.playerId,
        perceptualHash: candidate.perceptualHash,
        at: candidate.at,
      });
    }

    return records;
  }
}
