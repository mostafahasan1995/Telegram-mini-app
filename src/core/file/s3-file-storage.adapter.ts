/**
 * WHY @aws-sdk/lib-storage's `Upload` and not `PutObjectCommand`: PutObject requires a known
 * Content-Length, so a caller with only a stream has to buffer the whole object first — which is
 * exactly what we refuse to do with an attacker-sized Telegram document. `Upload` negotiates
 * single-part vs multipart itself and streams either way, and it aborts the multipart upload on
 * failure so a crash does not leave billable orphaned parts in the bucket.
 *
 * WHY `forcePathStyle`: MinIO (and every self-hosted gateway) serves `endpoint/bucket/key`, not
 * `bucket.endpoint/key`. Virtual-host addressing against MinIO fails as a DNS error, which reads
 * like a network outage rather than a configuration mistake.
 *
 * Objects are PRIVATE. Nothing here ever sets an ACL; readers get a short-lived presigned URL or
 * stream through our own API, so a leaked key is not a leaked receipt.
 */
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';

import type { S3Settings } from '@core/config/config.service';

import { FileErrorCodes, FileStorageError, type FileErrorCode } from './file.errors';
import { assertStorageKey } from './storage-key.util';
import type { FileStorage, ObjectHead, PutObjectInput, StoredObject } from './file.types';

/** 5 MiB is the S3 minimum part size; below it a multipart upload is rejected outright. */
const MULTIPART_PART_SIZE = 5 * 1024 * 1024;
/** Four parts in flight is enough to saturate a normal link without holding 4×N MiB per upload. */
const MULTIPART_QUEUE_SIZE = 4;

function statusOf(cause: unknown): number | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const metadata = (cause as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return metadata?.httpStatusCode;
}

function nameOf(cause: unknown): string | undefined {
  return cause instanceof Error ? cause.name : undefined;
}

/** S3 answers 404/NoSuchKey for GET and a bare 404/NotFound for HEAD. Both mean "not there". */
function isNotFound(cause: unknown): boolean {
  const name = nameOf(cause);
  return statusOf(cause) === 404 || name === 'NoSuchKey' || name === 'NotFound';
}

@Injectable()
export class S3FileStorage implements FileStorage, OnModuleDestroy {
  readonly driver = 'S3' as const;
  readonly bucket: string;

  private readonly logger = new Logger(S3FileStorage.name);
  private readonly client: S3Client;

  constructor(settings: S3Settings) {
    this.bucket = settings.bucket;
    const config: S3ClientConfig = {
      region: settings.region,
      endpoint: settings.endpoint,
      forcePathStyle: settings.forcePathStyle,
      credentials: { accessKeyId: settings.accessKey, secretAccessKey: settings.secretKey },
    };
    this.client = new S3Client(config);
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const key = assertStorageKey(input.key);
    const upload = new Upload({
      client: this.client,
      partSize: MULTIPART_PART_SIZE,
      queueSize: MULTIPART_QUEUE_SIZE,
      // A failed multipart upload must not leave parts behind; they are billed and invisible.
      leavePartsOnError: false,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: input.body,
        ContentType: input.contentType,
        ...(input.contentLength === undefined ? {} : { ContentLength: input.contentLength }),
        ...(input.metadata === undefined ? {} : { Metadata: { ...input.metadata } }),
      },
    });

    let etag: string | null = null;
    try {
      const result = await upload.done();
      etag = typeof result.ETag === 'string' ? result.ETag.replaceAll('"', '') : null;
    } catch (cause) {
      throw this.wrap(FileErrorCodes.UPLOAD_FAILED, `upload ${key}`, cause);
    }

    // The declared length is a claim; HEAD is what the bucket actually holds. The proof row records
    // the real number, so a truncated upload is visible instead of merely wrong.
    const head = await this.head(key);
    return {
      bucket: this.bucket,
      key,
      sizeBytes: head?.sizeBytes ?? input.contentLength ?? 0,
      etag,
    };
  }

  async getStream(key: string): Promise<Readable> {
    const safeKey = assertStorageKey(key);
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: safeKey }),
      );
      const body: unknown = response.Body;
      if (!(body instanceof Readable)) {
        throw new FileStorageError(
          FileErrorCodes.DOWNLOAD_FAILED,
          `S3 returned a non-stream body for ${safeKey}`,
          { key: safeKey },
        );
      }
      return body;
    } catch (cause) {
      if (isNotFound(cause)) {
        throw new FileStorageError(
          FileErrorCodes.OBJECT_NOT_FOUND,
          `Object ${safeKey} does not exist in bucket ${this.bucket}`,
          { key: safeKey, bucket: this.bucket },
        );
      }
      if (cause instanceof FileStorageError) throw cause;
      throw this.wrap(FileErrorCodes.DOWNLOAD_FAILED, `download ${safeKey}`, cause);
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    const safeKey = assertStorageKey(key);
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: safeKey }),
      );
      return {
        sizeBytes: response.ContentLength ?? 0,
        contentType: response.ContentType ?? null,
      };
    } catch (cause) {
      if (isNotFound(cause)) return null;
      throw this.wrap(FileErrorCodes.DOWNLOAD_FAILED, `head ${safeKey}`, cause);
    }
  }

  async delete(key: string): Promise<void> {
    const safeKey = assertStorageKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: safeKey }));
    } catch (cause) {
      // S3 delete is already idempotent; only a real failure gets here.
      throw this.wrap(FileErrorCodes.DELETE_FAILED, `delete ${safeKey}`, cause);
    }
  }

  /**
   * Short-lived, single-object, GET-only URL. The TTL is the caller's — the admin card uses minutes,
   * never hours: the URL is a bearer credential for a document that identifies a real person.
   */
  async presignGet(key: string, expiresInSeconds: number): Promise<string | null> {
    const safeKey = assertStorageKey(key);
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: safeKey }),
        { expiresIn: expiresInSeconds },
      );
    } catch (cause) {
      this.logger.warn(
        `Could not presign ${safeKey}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return null;
    }
  }

  private wrap(code: FileErrorCode, what: string, cause: unknown): Error {
    const message = cause instanceof Error ? cause.message : String(cause);
    this.logger.error(`S3 failed to ${what}: ${message}`);
    return new FileStorageError(code, `Object storage failed to ${what}`, {
      reason: message,
      httpStatus: statusOf(cause) ?? null,
    });
  }
}
