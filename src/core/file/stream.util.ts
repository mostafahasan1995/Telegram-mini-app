/**
 * WHY a byte-counting guard on every inbound stream: `file_size` in a Telegram getFile response and
 * `Content-Length` on an HTTP response are both CLAIMS made by the other side. Checking the claim and
 * then piping the body unbounded means a lying (or simply wrong) peer can write an arbitrary number
 * of bytes into our bucket and our heap. The transform below enforces the limit on the bytes that
 * actually arrive, which is the only number that exists.
 *
 * `collect` is the deliberate exception: some work (decoding an image) genuinely needs the whole
 * thing in memory. It is bounded by the same limit and is the ONLY place in this folder that buffers.
 */
import { Transform, type Readable } from 'node:stream';
import { createHash, type Hash } from 'node:crypto';

import { FileErrorCodes, FileStorageError } from './file.errors';

export interface GuardedStream {
  readonly stream: Readable;
  /** Bytes seen so far. Only final once the stream has ended. */
  bytesSeen(): number;
  /** Lowercase hex sha256 of everything that passed through. Only final once the stream has ended. */
  digest(): string;
}

/**
 * Wraps `source` so that it fails with OBJECT_TOO_LARGE the moment it exceeds `maxBytes`, and
 * hashes the bytes on the way past — so a stream-to-storage upload gets its content hash for free
 * instead of needing a second read.
 */
export function guardAndHash(source: Readable, maxBytes: number, label: string): GuardedStream {
  let seen = 0;
  const hash: Hash = createHash('sha256');
  let finalDigest: string | null = null;

  const meter = new Transform({
    transform(chunk: Buffer | string, encoding, callback): void {
      // A non-objectMode stream can still emit strings when a producer wrote one; Node reports the
      // encoding as 'buffer' for real Buffers, which is not a BufferEncoding, hence the narrowing.
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      seen += buffer.byteLength;
      if (seen > maxBytes) {
        callback(
          new FileStorageError(
            FileErrorCodes.OBJECT_TOO_LARGE,
            `${label} exceeded the ${maxBytes} byte limit after ${seen} bytes`,
            { maxBytes, seen, label },
          ),
        );
        return;
      }
      hash.update(buffer);
      callback(null, buffer);
    },
    flush(callback): void {
      finalDigest = hash.digest('hex');
      callback();
    },
  });

  // Without this, an error on the source (a socket reset mid-download) is never observed by the
  // consumer of `meter` and the upload hangs until its own timeout instead of failing fast.
  source.on('error', (error: Error) => meter.destroy(error));
  source.pipe(meter);

  return {
    stream: meter,
    bytesSeen: () => seen,
    digest: () => finalDigest ?? hash.copy().digest('hex'),
  };
}

/**
 * Read a whole stream into one Buffer, refusing to go past `maxBytes`. Use only where the bytes are
 * genuinely needed as a unit (image decoding); everything else must stay streaming.
 */
export async function collect(source: Readable, maxBytes: number, label: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let seen = 0;

  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    seen += buffer.byteLength;
    if (seen > maxBytes) {
      source.destroy();
      throw new FileStorageError(
        FileErrorCodes.OBJECT_TOO_LARGE,
        `${label} exceeded the ${maxBytes} byte limit after ${seen} bytes`,
        { maxBytes, seen, label },
      );
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

export const sha256Hex = (buffer: Buffer): string =>
  createHash('sha256').update(buffer).digest('hex');
