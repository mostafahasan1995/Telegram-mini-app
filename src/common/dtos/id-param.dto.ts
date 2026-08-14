/**
 * WHY validate the id shape at the edge: without it, `GET /deposits/:id` forwards arbitrary text
 * into a Prisma `where: { id }` on a uuid column, and Postgres answers with a 22P02 cast error that
 * surfaces as a 500. A 400 with a stable code is both truthful and cheaper.
 *
 * Version is unpinned: rows created by `gen_random_uuid()` are v4, ids we mint in application code
 * come from the `uuidv7` package. Both must pass.
 */
import { Transform } from 'class-transformer';
import { IsUUID, Matches } from 'class-validator';
import { SHORT_ID_REGEX, normalizeShortId } from '../helpers/short-id.util';

export class IdParamDto {
  @IsUUID(undefined, { message: 'id must be a UUID' })
  id: string;
}

/**
 * For routes keyed by a deposit's human-facing reference rather than its uuid.
 * The value is normalized BEFORE validation (uppercased, O->0, I/L->1, separators stripped) because
 * this reference is retyped by humans from a chat message; rejecting "k7q2-zp9v3m" would be hostile
 * when we can repair it deterministically.
 */
export class ShortIdParamDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeShortId(value) : value,
  )
  @Matches(SHORT_ID_REGEX, { message: 'shortId is not a valid deposit reference' })
  shortId: string;
}
