/**
 * WHY the file_size guard comes BEFORE getFile's download and not after:
 *
 * `getFile` is cheap and tells us the size Telegram believes the file has. Downloading first and
 * checking afterwards means we have already paid for the bytes — and for a bot that anyone can
 * message, "send the bot a 2 GB document" would be a free way to fill our bucket and our disk. So
 * the claim is checked first (cheap rejection), and then the actual bytes are metered as they
 * arrive (stream.util's guardAndHash), because the claim is only a claim.
 *
 * WHY nothing is buffered: the body goes fetch → meter → storage as a stream. The sha256 falls out
 * of the meter for free, so the caller gets a content hash without a second pass over the bytes.
 * Image normalization needs the whole picture in memory and therefore happens LATER, in the media
 * queue, where the size is already known to be inside the cap.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { AppConfigService } from '@core/config/config.service';
import { BotService } from '@core/telegram/services/bot.service';

import { FileErrorCodes, FileStorageError } from './file.errors';
import { FILE_STORAGE, type FileStorage, type StoredObject } from './file.types';
import { guardAndHash } from './stream.util';

/** Hard cap for anything we accept as a deposit proof. Telegram photos are far below this. */
export const MAX_PROOF_BYTES = 10 * 1024 * 1024;

/** Telegram's own limit for bot downloads; anything larger cannot be fetched at all. */
const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

const EXTENSION_MIME: Readonly<Record<string, string>> = Object.freeze({
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  gif: 'image/gif',
  pdf: 'application/pdf',
});

export interface FetchedTelegramFile extends StoredObject {
  readonly mimeType: string;
  /** sha256 of the RAW bytes as Telegram served them. The normalized hash is computed later. */
  readonly sha256: string;
  readonly telegramFileId: string;
  readonly telegramFilePath: string;
}

@Injectable()
export class TelegramFileService {
  private readonly logger = new Logger(TelegramFileService.name);

  constructor(
    private readonly bot: BotService,
    private readonly config: AppConfigService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  /** Guessed from the file_path extension; Telegram does not send a content type. */
  mimeTypeFor(filePath: string): string {
    const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
    return EXTENSION_MIME[extension] ?? 'application/octet-stream';
  }

  /**
   * Resolve a Telegram file_id and stream it into object storage under `key`.
   * `maxBytes` defaults to MAX_PROOF_BYTES and is enforced twice: against the declared size and
   * against the bytes that actually arrive.
   */
  async fetchToStorage(
    fileId: string,
    key: string,
    maxBytes: number = MAX_PROOF_BYTES,
  ): Promise<FetchedTelegramFile> {
    const cap = Math.min(maxBytes, TELEGRAM_MAX_DOWNLOAD_BYTES);

    const file = await this.bot.api.getFile(fileId).catch((cause: unknown) => {
      throw new FileStorageError(
        FileErrorCodes.TELEGRAM_FILE_UNAVAILABLE,
        `Telegram refused getFile for ${fileId}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { fileId },
      );
    });

    const declared = file.file_size ?? 0;
    if (declared > cap) {
      throw new FileStorageError(
        FileErrorCodes.OBJECT_TOO_LARGE,
        `Telegram file ${fileId} declares ${declared} bytes, over the ${cap} byte limit`,
        { fileId, declared, cap },
      );
    }

    const filePath = file.file_path;
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new FileStorageError(
        FileErrorCodes.TELEGRAM_FILE_UNAVAILABLE,
        `Telegram returned no file_path for ${fileId}`,
        { fileId },
      );
    }

    const mimeType = this.mimeTypeFor(filePath);
    const url = `https://api.telegram.org/file/bot${this.config.telegram.botToken}/${filePath}`;

    const response = await fetch(url).catch((cause: unknown) => {
      throw new FileStorageError(
        FileErrorCodes.TELEGRAM_FILE_UNAVAILABLE,
        // The URL is NEVER interpolated into an error: it carries the bot token.
        `Telegram file download failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { fileId },
      );
    });

    if (!response.ok || response.body === null) {
      throw new FileStorageError(
        FileErrorCodes.TELEGRAM_FILE_UNAVAILABLE,
        `Telegram file download answered HTTP ${response.status}`,
        { fileId, status: response.status },
      );
    }

    // undici's ReadableStream and node:stream/web's differ only in their type declarations.
    const webStream = response.body as unknown as WebReadableStream<Uint8Array>;
    const guarded = guardAndHash(Readable.fromWeb(webStream), cap, `telegram file ${fileId}`);

    const stored = await this.storage.put({
      key,
      body: guarded.stream,
      contentType: mimeType,
      ...(declared > 0 ? { contentLength: declared } : {}),
      metadata: { 'telegram-file-id': fileId },
    });

    this.logger.log(
      `Stored Telegram file ${fileId} as ${stored.key} (${stored.sizeBytes} bytes, ${mimeType})`,
    );

    return {
      ...stored,
      // Trust the metered count over both the declaration and the driver's echo.
      sizeBytes: guarded.bytesSeen(),
      mimeType,
      sha256: guarded.digest(),
      telegramFileId: fileId,
      telegramFilePath: filePath,
    };
  }
}
