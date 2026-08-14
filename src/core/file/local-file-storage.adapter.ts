/**
 * WHY a local driver at all: a developer must be able to run the whole deposit flow — upload, hash,
 * duplicate check, admin review — without a MinIO container, and a unit test must be able to do it
 * without a network. The layout mirrors S3 exactly (bucket directory, key becomes a relative path),
 * so a key written here is byte-for-byte the key the S3 driver would have written.
 *
 * It deliberately cannot presign. Handing out a `file://` URL would be a lie that only fails in the
 * browser; returning null forces callers down the streaming endpoint that also works in production.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { FileErrorCodes, FileStorageError, type FileErrorCode } from './file.errors';
import { assertStorageKey } from './storage-key.util';
import type { FileStorage, ObjectHead, PutObjectInput, StoredObject } from './file.types';

/** Where the fake bucket lives when FILE_STORAGE_LOCAL_DIR is not set. */
export const DEFAULT_LOCAL_STORAGE_DIR = '.storage';

function isNodeErrorWithCode(value: unknown, code: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    (value as { code?: unknown }).code === code
  );
}

@Injectable()
export class LocalFileStorage implements FileStorage {
  readonly driver = 'LOCAL' as const;
  private readonly logger = new Logger(LocalFileStorage.name);
  private readonly root: string;

  constructor(
    readonly bucket: string,
    baseDirectory: string,
  ) {
    this.root = resolve(baseDirectory, bucket);
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const path = this.pathFor(input.key);
    await mkdir(dirname(path), { recursive: true });

    const source = Buffer.isBuffer(input.body) ? Readable.from(input.body) : input.body;
    try {
      await pipeline(source, createWriteStream(path));
    } catch (cause) {
      // A partially written object is worse than none: the next reader would hash half a file and
      // record it as the proof's content hash.
      await rm(path, { force: true }).catch(() => undefined);
      throw this.wrap(FileErrorCodes.UPLOAD_FAILED, `write ${input.key}`, cause);
    }

    const info = await stat(path);
    return { bucket: this.bucket, key: input.key, sizeBytes: info.size, etag: null };
  }

  async getStream(key: string): Promise<Readable> {
    const path = this.pathFor(key);
    // Probe first: createReadStream defers ENOENT to an 'error' event, which would surface far away
    // from the call that asked for the object.
    await this.statOrThrow(path, key);
    return createReadStream(path);
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const info = await stat(this.pathFor(key));
      return { sizeBytes: info.size, contentType: null };
    } catch (cause) {
      if (isNodeErrorWithCode(cause, 'ENOENT')) return null;
      throw this.wrap(FileErrorCodes.DOWNLOAD_FAILED, `head ${key}`, cause);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await rm(this.pathFor(key), { force: true });
    } catch (cause) {
      throw this.wrap(FileErrorCodes.DELETE_FAILED, `delete ${key}`, cause);
    }
  }

  /** Local disk has no signing authority — see the header. */
  presignGet(): Promise<string | null> {
    return Promise.resolve(null);
  }

  /**
   * Resolve the key under the bucket root and refuse anything that escapes it. `assertStorageKey`
   * already rejects `..`, but a defence that only exists in one layer is a defence that disappears
   * the first time someone adds a second caller.
   */
  private pathFor(key: string): string {
    const path = resolve(join(this.root, assertStorageKey(key)));
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new FileStorageError(
        FileErrorCodes.INVALID_KEY,
        `Object key "${key}" resolves outside the bucket directory`,
        { key },
      );
    }
    return path;
  }

  private async statOrThrow(path: string, key: string): Promise<void> {
    try {
      await stat(path);
    } catch (cause) {
      if (isNodeErrorWithCode(cause, 'ENOENT')) {
        throw new FileStorageError(
          FileErrorCodes.OBJECT_NOT_FOUND,
          `Object ${key} does not exist in bucket ${this.bucket}`,
          { key, bucket: this.bucket },
        );
      }
      throw this.wrap(FileErrorCodes.DOWNLOAD_FAILED, `read ${key}`, cause);
    }
  }

  private wrap(code: FileErrorCode, what: string, cause: unknown): Error {
    const message = cause instanceof Error ? cause.message : String(cause);
    this.logger.error(`Local storage failed to ${what}: ${message}`);
    return new FileStorageError(code, `Local storage failed to ${what}: ${message}`);
  }
}
