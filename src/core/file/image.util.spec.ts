import sharp from 'sharp';

import { FileStorageError } from './file.errors';
import {
  MAX_IMAGE_DIMENSION,
  NORMALIZED_MIME_TYPE,
  hammingDistanceHex,
  hashBands,
  isAcceptedImageMimeType,
  isPerceptualHash,
  normalizeImage,
  perceptualHashOf,
} from './image.util';

/**
 * A deterministic 9x8 block pattern.
 *
 * WHY a coarse checkerboard and not a fine gradient: a dHash averages the picture down to 9x8 and
 * compares horizontal neighbours. A high-frequency pattern makes every one of those comparisons a
 * near-tie, so JPEG noise flips bits at random and the fixture — not the implementation — becomes
 * the thing under test. Large flat blocks make each comparison decisive, which is exactly the
 * property real receipts (dark text on a light page) have.
 */
async function makeImage(
  width: number,
  height: number,
  options: { format?: 'jpeg' | 'png'; variant?: number } = {},
): Promise<Buffer> {
  const variant = options.variant ?? 0;
  const channels = 3;
  const blockX = Math.max(1, Math.floor(width / 9));
  const blockY = Math.max(1, Math.floor(height / 8));
  const raw = Buffer.alloc(width * height * channels);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dark = (Math.floor(x / blockX) + Math.floor(y / blockY) + variant) % 2 === 0;
      const value = dark ? 30 : 220;
      const index = (y * width + x) * channels;
      raw[index] = value;
      raw[index + 1] = value;
      raw[index + 2] = value;
    }
  }

  const pipeline = sharp(raw, { raw: { width, height, channels } });
  return options.format === 'png' ? pipeline.png().toBuffer() : pipeline.jpeg().toBuffer();
}

describe('normalizeImage', () => {
  it('downscales the long edge to MAX_IMAGE_DIMENSION and keeps the aspect ratio', async () => {
    const normalized = await normalizeImage(await makeImage(3200, 1600));
    expect(normalized.width).toBe(MAX_IMAGE_DIMENSION);
    expect(normalized.height).toBe(MAX_IMAGE_DIMENSION / 2);
    expect(normalized.mimeType).toBe(NORMALIZED_MIME_TYPE);
    expect(normalized.sourceWidth).toBe(3200);
  });

  it('never upscales a small receipt', async () => {
    const normalized = await normalizeImage(await makeImage(320, 200));
    expect(normalized.width).toBe(320);
    expect(normalized.height).toBe(200);
  });

  it('strips EXIF — the stored bytes carry no metadata block at all', async () => {
    const withExif = await sharp(await makeImage(600, 400))
      .withMetadata({ exif: { IFD0: { Copyright: 'test', Software: 'jest' } } })
      .jpeg()
      .toBuffer();

    // Sanity: the fixture really does have EXIF before we normalize it.
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const normalized = await normalizeImage(withExif);
    const after = await sharp(normalized.buffer).metadata();
    expect(after.exif).toBeUndefined();
  });

  it('hashes the NORMALIZED bytes, so the same picture in two containers collides', async () => {
    const source = await makeImage(800, 600);
    const asJpeg = await sharp(source).jpeg({ quality: 100 }).toBuffer();
    const asPng = await sharp(source).png().toBuffer();

    // Different files by construction.
    expect(asJpeg.equals(asPng)).toBe(false);

    const a = await normalizeImage(asJpeg);
    const b = await normalizeImage(asPng);

    // A re-encode is lossy, so the sha256 may differ — but the perceptual hash must not, and that
    // is exactly why the second tier exists.
    expect(hammingDistanceHex(a.perceptualHash, b.perceptualHash)).toBeLessThanOrEqual(2);
  });

  it('is deterministic: normalizing the same bytes twice yields the same sha256', async () => {
    const source = await makeImage(900, 700);
    const first = await normalizeImage(source);
    const second = await normalizeImage(source);
    expect(second.sha256).toBe(first.sha256);
    expect(second.perceptualHash).toBe(first.perceptualHash);
  });

  it('rejects bytes that are not an image, as a typed FileStorageError', async () => {
    await expect(normalizeImage(Buffer.from('this is not a picture'))).rejects.toBeInstanceOf(
      FileStorageError,
    );
  });
});

describe('perceptualHashOf', () => {
  it('produces 16 lowercase hex characters', async () => {
    const hash = await perceptualHashOf(await makeImage(500, 500));
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(isPerceptualHash(hash)).toBe(true);
  });

  it('survives a re-compression', async () => {
    const source = await makeImage(1000, 800);
    const recompressed = await sharp(source).jpeg({ quality: 40 }).toBuffer();
    expect(
      hammingDistanceHex(await perceptualHashOf(source), await perceptualHashOf(recompressed)),
    ).toBeLessThanOrEqual(6);
  });

  it('separates genuinely different pictures', async () => {
    const a = await perceptualHashOf(await makeImage(600, 600, { variant: 0 }));
    const b = await perceptualHashOf(await makeImage(600, 600, { variant: 1 }));
    expect(hammingDistanceHex(a, b)).toBeGreaterThan(6);
  });
});

describe('hammingDistanceHex', () => {
  it('counts differing bits', () => {
    expect(hammingDistanceHex('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingDistanceHex('0000000000000000', '0000000000000001')).toBe(1);
    expect(hammingDistanceHex('0000000000000000', '000000000000000f')).toBe(4);
    expect(hammingDistanceHex('ffffffffffffffff', '0000000000000000')).toBe(64);
  });

  it('refuses anything that is not a 64-bit hex hash', () => {
    expect(() => hammingDistanceHex('abc', '0000000000000000')).toThrow(FileStorageError);
    expect(() => hammingDistanceHex('0000000000000000', 'ZZZZZZZZZZZZZZZZ')).toThrow(
      FileStorageError,
    );
  });
});

describe('hashBands', () => {
  it('splits into equal, index-prefixed slices', () => {
    const bands = hashBands('0123456789abcdef', 8);
    expect(bands).toEqual(['0:01', '1:23', '2:45', '3:67', '4:89', '5:ab', '6:cd', '7:ef']);
  });

  it('index-prefixes so the same nibbles in different positions are different keys', () => {
    const bands = hashBands('aaaaaaaaaaaaaaaa', 8);
    expect(new Set(bands).size).toBe(8);
  });

  /**
   * This is the property the duplicate index depends on. Any two hashes within 6 bits must share at
   * least two whole bands, so a banded lookup has NO false negatives at that threshold.
   */
  it('guarantees >= 2 shared bands for any pair within 6 bits (pigeonhole)', () => {
    const base = 0n;
    const bandsOf = (value: bigint): string[] => hashBands(value.toString(16).padStart(16, '0'), 8);

    for (let trial = 0; trial < 200; trial += 1) {
      // Flip exactly six bits, chosen to spread across as many bands as possible.
      let mutated = base;
      const positions = new Set<number>();
      while (positions.size < 6) positions.add(Math.floor(Math.random() * 64));
      for (const position of positions) mutated ^= 1n << BigInt(position);

      const a = bandsOf(base);
      const b = bandsOf(mutated);
      const shared = a.filter((band, index) => band === b[index]).length;
      expect(shared).toBeGreaterThanOrEqual(2);
      expect(
        hammingDistanceHex(
          base.toString(16).padStart(16, '0'),
          mutated.toString(16).padStart(16, '0'),
        ),
      ).toBe(6);
    }
  });

  it('refuses a band count that does not divide the hash evenly', () => {
    expect(() => hashBands('0123456789abcdef', 7)).toThrow(FileStorageError);
  });
});

describe('isAcceptedImageMimeType', () => {
  it('accepts the phone-camera formats and rejects documents', () => {
    expect(isAcceptedImageMimeType('image/jpeg')).toBe(true);
    expect(isAcceptedImageMimeType('IMAGE/PNG')).toBe(true);
    expect(isAcceptedImageMimeType('image/heic')).toBe(true);
    expect(isAcceptedImageMimeType('application/pdf')).toBe(false);
    expect(isAcceptedImageMimeType('text/html')).toBe(false);
    expect(isAcceptedImageMimeType('image/svg+xml')).toBe(false);
  });
});
