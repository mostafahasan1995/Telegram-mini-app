/**
 * Public surface of object storage. Consumers should need only `@core/file`.
 */
export * from './file.types';
export * from './file.errors';
export * from './stream.util';
export * from './storage-key.util';
export * from './image.util';
export * from './local-file-storage.adapter';
export * from './s3-file-storage.adapter';
export * from './telegram-file.service';
export * from './file.module';
