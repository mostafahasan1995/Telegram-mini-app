/**
 * WHY storage failures get their own error type: "the object is missing" and "the upload was
 * refused" have completely different consequences for a deposit — the first means we lost evidence
 * we already told an admin about, the second means the player's submission never happened. Folding
 * both into a generic 500 would hide that difference exactly where it matters.
 *
 * Codes are stable strings, never messages (same rule as the rest of the codebase).
 */
export const FileErrorCodes = {
  OBJECT_NOT_FOUND: 'OBJECT_NOT_FOUND',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  DELETE_FAILED: 'DELETE_FAILED',
  /** The stream carried more bytes than the caller declared it would allow. */
  OBJECT_TOO_LARGE: 'OBJECT_TOO_LARGE',
  INVALID_KEY: 'INVALID_KEY',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  /** sharp could not decode the bytes at all — not an image, or a truncated upload. */
  IMAGE_UNREADABLE: 'IMAGE_UNREADABLE',
  TELEGRAM_FILE_UNAVAILABLE: 'TELEGRAM_FILE_UNAVAILABLE',
} as const;

export type FileErrorCode = (typeof FileErrorCodes)[keyof typeof FileErrorCodes];

export class FileStorageError extends Error {
  constructor(
    readonly code: FileErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'FileStorageError';
    Error.captureStackTrace?.(this, FileStorageError);
  }
}

export const isFileStorageError = (value: unknown): value is FileStorageError =>
  value instanceof FileStorageError;

export const isObjectNotFound = (value: unknown): boolean =>
  isFileStorageError(value) && value.code === FileErrorCodes.OBJECT_NOT_FOUND;
