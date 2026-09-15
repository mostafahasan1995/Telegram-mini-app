/**
 * The part of a PATCH that actually changes something.
 *
 * WHY THIS EXISTS: the console's edit form sends every editable field on save, whether or not the
 * operator touched it. Writing and auditing all of them would fill an operator's audit log with
 * "changed displayName from X to X", which buries the one real change an auditor is looking for.
 * So only fields whose value differs are written, the audit row's `before` and `after` hold exactly
 * those fields, and a save that changes nothing writes nothing at all.
 *
 * Values are compared with `===`, which is right for every column type the two PATCH routes touch:
 * strings, numbers, enums, null, and bigint primitives (`5n === 5n`).
 */
export interface FieldChanges<T extends object> {
  /** The fields to write, with their new values. */
  data: Partial<T>;
  before: Partial<T>;
  after: Partial<T>;
}

export function changedFields<T extends object>(
  current: T,
  edits: Partial<T>,
): FieldChanges<T> | null {
  const data: Partial<T> = {};
  const before: Partial<T> = {};
  const after: Partial<T> = {};

  for (const key of Object.keys(edits) as (keyof T)[]) {
    const next = edits[key];
    // An absent key is "leave it alone", never "set it to undefined".
    if (next === undefined) continue;
    if (current[key] === next) continue;
    data[key] = next;
    before[key] = current[key];
    after[key] = next;
  }

  return Object.keys(data).length === 0 ? null : { data, before, after };
}
