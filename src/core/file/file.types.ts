/**
 * WHY a port instead of injecting an S3 client: proof images are evidence in a money dispute, and
 * the code that writes them must be identical in dev (a folder on disk), in CI (the same folder) and
 * in production (MinIO/S3). Anything that differs between those three is a code path that is only
 * ever exercised where it matters least.
 *
 * WHY `put` takes a `Readable`: a Telegram document can be 20 MB. Buffering it to hash it, then
 * buffering it again to upload it, is two copies of an attacker-controlled size in the heap of a
 * process that is also holding money transactions open. Every write path here is a stream.
 *
 * `presignGet` may legitimately answer `null`: the local driver has no signing authority, and a
 * caller must fall back to streaming through our own API rather than pretend it has a URL.
 */
import type { Readable } from 'node:stream';

/** DI token. Inject with `@Inject(FILE_STORAGE) private readonly storage: FileStorage`. */
export const FILE_STORAGE = 'FILE_STORAGE';

export type FileStorageDriver = 'S3' | 'LOCAL';

export interface PutObjectInput {
  /** Full object key, e.g. `deposits/<uuid>/normalized/<sha256>.jpg`. Never starts with a slash. */
  readonly key: string;
  readonly body: Readable | Buffer;
  readonly contentType: string;
  /** Known size in bytes. Lets the S3 driver skip multipart for small objects. */
  readonly contentLength?: number;
  /** User metadata. Keys must be ASCII; values are not a place for anything sensitive. */
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface StoredObject {
  readonly bucket: string;
  readonly key: string;
  readonly sizeBytes: number;
  /** Null when the driver does not produce one (local disk). */
  readonly etag: string | null;
}

export interface ObjectHead {
  readonly sizeBytes: number;
  readonly contentType: string | null;
}

export interface FileStorage {
  readonly driver: FileStorageDriver;
  readonly bucket: string;

  /** Overwrites an existing key. Object keys are content-addressed, so that is a no-op rewrite. */
  put(input: PutObjectInput): Promise<StoredObject>;

  /** Throws FileStorageError('OBJECT_NOT_FOUND') when the key does not exist. */
  getStream(key: string): Promise<Readable>;

  /** Null rather than a throw: "is this object there?" is a question, not an error. */
  head(key: string): Promise<ObjectHead | null>;

  /** Idempotent: deleting a key that is already gone succeeds. */
  delete(key: string): Promise<void>;

  /**
   * A time-limited direct download URL, or null when the driver cannot sign one. Callers MUST
   * handle null by streaming through the API instead — never by exposing the object publicly.
   */
  presignGet(key: string, expiresInSeconds: number): Promise<string | null>;
}
