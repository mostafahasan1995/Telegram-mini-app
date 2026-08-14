/**
 * WHY normalize before hashing, and why the hash is taken of the NORMALIZED bytes:
 *
 * A player who reuses someone else's receipt only has to re-save the JPEG to change every byte of
 * it. A hash of the uploaded file therefore catches only the laziest duplicate. Normalizing first —
 * auto-orient, strip ALL metadata, downscale to a fixed bound, re-encode with fixed parameters —
 * collapses "same picture, different file" into "same bytes", so sha256 becomes a useful signal
 * instead of a formality. It also removes the EXIF GPS tags and device serial numbers we have no
 * business storing about a player.
 *
 * The dHash is the second line: it survives a crop, a re-compression and a watermark, which sha256
 * does not. 64 bits, compared by Hamming distance. It is a SIGNAL, never a verdict — the deposit
 * flow records it as a risk flag for a human and never auto-rejects on it.
 *
 * SIZE BOUND: sharp is given `limitInputPixels` so a 60 000 × 60 000 "decompression bomb" fails
 * during decode instead of allocating 10 GB. The byte cap is enforced upstream (stream.util).
 */
import sharp from 'sharp';

import { FileErrorCodes, FileStorageError } from './file.errors';
import { sha256Hex } from './stream.util';

/** Long edge, in pixels. A receipt is legible well below this; the storage saving is ~10x. */
export const MAX_IMAGE_DIMENSION = 1600;

/** 80 megapixels. Comfortably above any phone camera, far below what can exhaust memory. */
export const MAX_INPUT_PIXELS = 80_000_000;

export const NORMALIZED_MIME_TYPE = 'image/jpeg';
export const NORMALIZED_EXTENSION = 'jpg';

/** JPEG quality for the stored derivative. 82 is visually lossless for text-on-paper receipts. */
const JPEG_QUALITY = 82;

/** dHash grid: 9 columns × 8 rows produces 8 horizontal comparisons per row = 64 bits. */
const DHASH_WIDTH = 9;
const DHASH_HEIGHT = 8;
export const PERCEPTUAL_HASH_BITS = DHASH_WIDTH - 1; // per row
export const PERCEPTUAL_HASH_HEX_LENGTH = 16;

export const ACCEPTED_IMAGE_MIME_TYPES: readonly string[] = Object.freeze([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
]);

export interface NormalizedImage {
  /** EXIF-free, downscaled, re-encoded JPEG bytes. This is what gets stored and hashed. */
  readonly buffer: Buffer;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  /** sha256 of `buffer` — i.e. of the normalized bytes, not of what was uploaded. */
  readonly sha256: string;
  /** 64-bit difference hash as 16 lowercase hex characters. */
  readonly perceptualHash: string;
  /** Format sharp detected before normalization; useful when a proof looks suspicious. */
  readonly sourceFormat: string | null;
  readonly sourceWidth: number | null;
  readonly sourceHeight: number | null;
}

export function isAcceptedImageMimeType(mimeType: string): boolean {
  return ACCEPTED_IMAGE_MIME_TYPES.includes(mimeType.trim().toLowerCase());
}

export function assertAcceptedImageMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  if (!isAcceptedImageMimeType(normalized)) {
    throw new FileStorageError(
      FileErrorCodes.UNSUPPORTED_MEDIA_TYPE,
      `"${mimeType}" is not an accepted proof image type`,
      { mimeType, accepted: ACCEPTED_IMAGE_MIME_TYPES },
    );
  }
  return normalized;
}

/**
 * Decode → auto-orient → downscale → re-encode, then hash both ways.
 *
 * `.rotate()` with no argument applies the EXIF orientation and then drops it; combined with sharp's
 * default of NOT copying metadata forward, the output carries no EXIF, no ICC beyond sRGB, no GPS.
 * `withoutEnlargement` means a small receipt is never upscaled into a bigger, blurrier file.
 */
export async function normalizeImage(input: Buffer): Promise<NormalizedImage> {
  const pipeline = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });

  let sourceFormat: string | null = null;
  let sourceWidth: number | null = null;
  let sourceHeight: number | null = null;
  try {
    const metadata = await pipeline.metadata();
    sourceFormat = metadata.format ?? null;
    sourceWidth = metadata.width ?? null;
    sourceHeight = metadata.height ?? null;
  } catch (cause) {
    throw new FileStorageError(
      FileErrorCodes.IMAGE_UNREADABLE,
      `Proof image could not be decoded: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  let output: { data: Buffer; info: sharp.OutputInfo };
  try {
    output = await pipeline
      .clone()
      .rotate()
      .resize({
        width: MAX_IMAGE_DIMENSION,
        height: MAX_IMAGE_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: '4:4:4' })
      .toBuffer({ resolveWithObject: true });
  } catch (cause) {
    throw new FileStorageError(
      FileErrorCodes.IMAGE_UNREADABLE,
      `Proof image could not be normalized: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }

  const perceptualHash = await perceptualHashOf(output.data);

  return {
    buffer: output.data,
    mimeType: NORMALIZED_MIME_TYPE,
    width: output.info.width,
    height: output.info.height,
    sizeBytes: output.data.byteLength,
    sha256: sha256Hex(output.data),
    perceptualHash,
    sourceFormat,
    sourceWidth,
    sourceHeight,
  };
}

/**
 * 64-bit difference hash: greyscale, squash to 9×8 ignoring aspect ratio, then emit one bit per
 * horizontally adjacent pixel pair ("is the left pixel brighter?").
 *
 * Ignoring aspect ratio is deliberate — it is what makes the hash survive a crop of the borders, and
 * a receipt photographed twice at slightly different angles still lands within a few bits.
 */
export async function perceptualHashOf(image: Buffer): Promise<string> {
  let raw: Buffer;
  try {
    raw = await sharp(image, { limitInputPixels: MAX_INPUT_PIXELS })
      .greyscale()
      .resize(DHASH_WIDTH, DHASH_HEIGHT, { fit: 'fill' })
      .raw()
      .toBuffer();
  } catch (cause) {
    throw new FileStorageError(
      FileErrorCodes.IMAGE_UNREADABLE,
      `Perceptual hash failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  let bits = 0n;
  for (let row = 0; row < DHASH_HEIGHT; row += 1) {
    for (let column = 0; column < DHASH_WIDTH - 1; column += 1) {
      const left = raw[row * DHASH_WIDTH + column] ?? 0;
      const right = raw[row * DHASH_WIDTH + column + 1] ?? 0;
      bits = (bits << 1n) | (left > right ? 1n : 0n);
    }
  }

  return bits.toString(16).padStart(PERCEPTUAL_HASH_HEX_LENGTH, '0');
}

const HEX64 = /^[0-9a-f]{16}$/;

export const isPerceptualHash = (value: string): boolean => HEX64.test(value);

/**
 * Number of differing bits between two 64-bit hex hashes. 0 = pixel-identical after normalization,
 * ≤ 6 is the threshold the deposit flow treats as "probably the same picture".
 */
export function hammingDistanceHex(a: string, b: string): number {
  if (!HEX64.test(a) || !HEX64.test(b)) {
    throw new FileStorageError(
      FileErrorCodes.IMAGE_UNREADABLE,
      'Perceptual hashes must be 16 lowercase hex characters',
      { a, b },
    );
  }
  let xor = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let distance = 0;
  while (xor !== 0n) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return distance;
}

/**
 * Split a hash into `bandCount` equal slices. Used to build an exact-recall index for a Hamming
 * threshold: with 8 bands, any two hashes within 6 bits MUST agree on at least two whole bands
 * (6 differing bits can touch at most 6 of the 8 bands), so looking up the bands finds every true
 * near-duplicate without scanning the corpus. See ProofDuplicateService.
 */
export function hashBands(hash: string, bandCount = 8): string[] {
  if (!HEX64.test(hash)) {
    throw new FileStorageError(
      FileErrorCodes.IMAGE_UNREADABLE,
      'Perceptual hashes must be 16 lowercase hex characters',
      { hash },
    );
  }
  const width = PERCEPTUAL_HASH_HEX_LENGTH / bandCount;
  if (!Number.isInteger(width)) {
    throw new FileStorageError(
      FileErrorCodes.IMAGE_UNREADABLE,
      `${bandCount} bands do not divide a ${PERCEPTUAL_HASH_HEX_LENGTH}-character hash evenly`,
      { bandCount },
    );
  }
  const bands: string[] = [];
  for (let index = 0; index < bandCount; index += 1) {
    bands.push(`${index}:${hash.slice(index * width, (index + 1) * width)}`);
  }
  return bands;
}
