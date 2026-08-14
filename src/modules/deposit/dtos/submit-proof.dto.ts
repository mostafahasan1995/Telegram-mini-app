/**
 * WHY base64 in a JSON body and not multipart: the only client is a Telegram mini-app, which already
 * has the bytes in a `File`/`Blob` and posts JSON everywhere else. Adding multipart would pull in
 * multer, a second body pipeline and a second set of size limits — for one endpoint. The cost is
 * ~33% wire overhead on an image that is capped at a few megabytes anyway.
 *
 * The size cap is enforced on the ENCODED string here (cheap, before any decoding) and again on the
 * decoded bytes in the service. Checking only after decode would mean allocating whatever was sent.
 */
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { ACCEPTED_IMAGE_MIME_TYPES } from '@core/file/image.util';
import { MAX_PROOF_BYTES } from '@core/file/telegram-file.service';

/** base64 inflates by 4/3; +1024 covers the data-url prefix and padding. */
export const MAX_PROOF_BASE64_LENGTH = Math.ceil((MAX_PROOF_BYTES * 4) / 3) + 1024;

const DATA_URL_PREFIX = /^data:[^;,]+;base64,/;

export class SubmitProofDto {
  /**
   * Raw base64 or a `data:image/jpeg;base64,...` URL — the mini-app's FileReader produces the
   * latter and stripping it client-side is the kind of step that gets forgotten.
   */
  @IsString()
  @MinLength(32, { message: 'imageBase64 is too short to be an image' })
  @MaxLength(MAX_PROOF_BASE64_LENGTH, { message: 'imageBase64 exceeds the maximum proof size' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().replace(DATA_URL_PREFIX, '') : value,
  )
  @Matches(/^[A-Za-z0-9+/=\r\n]+$/, { message: 'imageBase64 is not valid base64' })
  imageBase64: string;

  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsIn([...ACCEPTED_IMAGE_MIME_TYPES], { message: 'mimeType is not an accepted proof image type' })
  mimeType: string;

  /** Late-supplied rail reference: a player often only has it once the receipt is in front of them. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  externalReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  senderAccount?: string;
}
