/**
 * WHY the driver is chosen here and nowhere else: every consumer injects FILE_STORAGE and never
 * learns which implementation it got, so a dev box, a CI run and production differ by one env var
 * rather than by an `if` inside the proof pipeline.
 *
 * FILE_STORAGE_DRIVER is read from process.env directly, exactly like ICHANCY_FAKE in
 * @core/ichancy/ichancy.module: the foundation's zod schema is a closed object that strips unknown
 * keys, and adding a key there is not this module's to do. Default: `local` under NODE_ENV=test (so
 * no test can ever need a bucket), `s3` everywhere else.
 *
 * @Global because the deposit, reconciliation and telegram paths all need storage, and there is
 * exactly one bucket per process.
 */
import { Global, Module, type Provider } from '@nestjs/common';

import { AppConfigService } from '@core/config/config.service';
import { TelegramModule } from '@core/telegram/telegram.module';

import { DEFAULT_LOCAL_STORAGE_DIR, LocalFileStorage } from './local-file-storage.adapter';
import { FILE_STORAGE, type FileStorage, type FileStorageDriver } from './file.types';
import { S3FileStorage } from './s3-file-storage.adapter';
import { TelegramFileService } from './telegram-file.service';

export function resolveFileStorageDriver(env: NodeJS.ProcessEnv = process.env): FileStorageDriver {
  const raw = env['FILE_STORAGE_DRIVER']?.trim().toLowerCase();
  if (raw === 'local') return 'LOCAL';
  if (raw === 's3') return 'S3';
  return env['NODE_ENV'] === 'test' ? 'LOCAL' : 'S3';
}

const storageProvider: Provider = {
  provide: FILE_STORAGE,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): FileStorage =>
    resolveFileStorageDriver() === 'LOCAL'
      ? new LocalFileStorage(
          config.s3.bucket,
          process.env['FILE_STORAGE_LOCAL_DIR'] ?? DEFAULT_LOCAL_STORAGE_DIR,
        )
      : new S3FileStorage(config.s3),
};

@Global()
@Module({
  // TelegramModule provides BotService, which TelegramFileService needs to call getFile.
  imports: [TelegramModule],
  providers: [storageProvider, TelegramFileService],
  exports: [FILE_STORAGE, TelegramFileService],
})
export class FileModule {}
