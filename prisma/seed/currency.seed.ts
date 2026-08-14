/**
 * NSP, scale 2 — and `scale` is FROZEN the moment the first money row exists.
 *
 * Every `*Minor` column in this database is an integer in the currency's minor units. Changing
 * scale from 2 to 3 would not migrate anything; it would silently reinterpret every balance,
 * every deposit amount and every ledger entry already written, dividing the entire book by ten.
 * There is no way to detect that after the fact, so this seed REFUSES to change an existing scale
 * rather than upserting over it. That refusal is the point of the file.
 */
import type { PrismaClient } from '@prisma/client';

export const SEED_CURRENCY_CODE = 'NSP';
export const SEED_CURRENCY_SCALE = 2;

export interface SeededCurrency {
  code: string;
  scale: number;
  created: boolean;
}

export async function seedCurrency(prisma: PrismaClient): Promise<SeededCurrency> {
  const existing = await prisma.currency.findUnique({
    where: { code: SEED_CURRENCY_CODE },
    select: { code: true, scale: true },
  });

  if (existing !== null) {
    if (existing.scale !== SEED_CURRENCY_SCALE) {
      throw new Error(
        `Currency ${SEED_CURRENCY_CODE} already exists with scale ${existing.scale}, but this ` +
          `build assumes ${SEED_CURRENCY_SCALE}. Every *_minor column already written is in the ` +
          'stored scale — refusing to change it. Fix the code, not the row.',
      );
    }

    // Cosmetic fields only. `scale` is deliberately absent from this update.
    await prisma.currency.update({
      where: { code: SEED_CURRENCY_CODE },
      data: { name: 'New Syrian Pound', symbol: 'NSP', isActive: true },
    });

    return { code: existing.code, scale: existing.scale, created: false };
  }

  const created = await prisma.currency.create({
    data: {
      code: SEED_CURRENCY_CODE,
      name: 'New Syrian Pound',
      scale: SEED_CURRENCY_SCALE,
      symbol: 'NSP',
      isActive: true,
    },
    select: { code: true, scale: true },
  });

  return { code: created.code, scale: created.scale, created: true };
}
