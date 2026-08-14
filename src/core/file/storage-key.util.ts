/**
 * WHY object keys are built here and nowhere else: the key is the only durable link between a row in
 * `deposit_proofs` and the bytes an auditor will want to look at in two years. If two call sites
 * invent slightly different layouts, a bulk re-hash or a lifecycle policy has to understand both.
 *
 * Layout, and the reason for each segment:
 *   deposits/<depositId>/raw/<uuid><ext>          exactly what the player/Telegram sent us
 *   deposits/<depositId>/normalized/<sha256>.jpg  EXIF-stripped, downscaled, content-addressed
 *
 * The normalized key is content-addressed on purpose: re-processing the same proof overwrites the
 * same object instead of accumulating near-duplicates, and the key itself proves which bytes were
 * hashed. The raw key is NOT content-addressed, because we only learn the raw hash while streaming.
 */
import { FileErrorCodes, FileStorageError } from './file.errors';

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
/** No absolute paths, no traversal, no backslashes — the local driver writes these onto a disk. */
const SAFE_KEY = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._\-/]+$/;

export const RAW_PREFIX = 'raw';
export const NORMALIZED_PREFIX = 'normalized';

function assertSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value)) {
    throw new FileStorageError(
      FileErrorCodes.INVALID_KEY,
      `Storage key ${label} "${value}" contains characters that are not safe in an object key`,
      { label, value },
    );
  }
  return value;
}

/** Validates a key that arrived from the database before it is handed to a driver. */
export function assertStorageKey(key: string): string {
  if (key.length === 0 || key.length > 900 || !SAFE_KEY.test(key)) {
    throw new FileStorageError(FileErrorCodes.INVALID_KEY, `"${key}" is not a valid object key`, {
      key,
    });
  }
  return key;
}

export function rawProofKey(depositRequestId: string, fileName: string): string {
  return assertStorageKey(
    `deposits/${assertSegment(depositRequestId, 'depositRequestId')}/${RAW_PREFIX}/${assertSegment(
      fileName,
      'fileName',
    )}`,
  );
}

export function normalizedProofKey(
  depositRequestId: string,
  sha256: string,
  extension = 'jpg',
): string {
  return assertStorageKey(
    `deposits/${assertSegment(depositRequestId, 'depositRequestId')}/${NORMALIZED_PREFIX}/` +
      `${assertSegment(sha256, 'sha256')}.${assertSegment(extension, 'extension')}`,
  );
}

/** True when the key already points at a normalized derivative — the ingest fast path. */
export const isNormalizedKey = (key: string): boolean => key.includes(`/${NORMALIZED_PREFIX}/`);
