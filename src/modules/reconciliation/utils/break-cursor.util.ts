/**
 * Keyset cursor over (detectedAt, id) for the break list. Same shape and same reasoning as the
 * deposit queue's cursor: `<epochMillis>~<uuid>`, every character inside the class CursorQueryDto
 * allows, and null for anything malformed because a cursor is client input that may outlive a
 * deploy.
 *
 * It is duplicated rather than imported from the deposit module on purpose —
 * eslint-plugin-boundaries forbids modules/A -> modules/B, and eight lines of codec is a much
 * smaller cost than a shared dependency between two feature modules.
 */
export interface BreakCursor {
  detectedAt: Date;
  id: string;
}

const SEPARATOR = '~';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeBreakCursor(cursor: BreakCursor): string {
  return `${cursor.detectedAt.getTime()}${SEPARATOR}${cursor.id}`;
}

export function decodeBreakCursor(raw: string | null | undefined): BreakCursor | null {
  if (typeof raw !== 'string') return null;
  const [millis, id, ...rest] = raw.split(SEPARATOR);
  if (rest.length > 0 || millis === undefined || id === undefined) return null;
  if (!/^\d{1,15}$/.test(millis) || !UUID_PATTERN.test(id)) return null;
  const detectedAt = new Date(Number(millis));
  return Number.isNaN(detectedAt.getTime()) ? null : { detectedAt, id };
}
