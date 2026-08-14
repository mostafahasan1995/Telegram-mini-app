/**
 * Operator-facing money rendering for the Arabic admin messages.
 *
 * The Syrian market quotes every amount twice — "جديدة" (new NSP) and "قديمة" (old lira) — where
 * old lira = new NSP × 100. Our minor units ARE the old-lira number: NSP has scale 2, so
 * minor = NSP × 100 = old lira. dualNsp() therefore renders the SAME bigint both ways and never
 * performs a conversion that could round: formatMinorToDecimal() for the new amount, the raw
 * bigint digits for the old one.
 *
 * WHY this is not in money.util.ts: that file owns parsing and arithmetic — the write path. This
 * one owns presentation (thousands separators, market labels) and is only ever read by humans.
 */
import { DEFAULT_MONEY_SCALE, formatMinorToDecimal } from './money.util';

/**
 * "2563315.00" -> "2,563,315.00". Pure string surgery over the exact decimal — the value never
 * passes through Number, so amounts beyond 2^53 group just as correctly as small ones.
 */
export function groupThousands(decimal: string): string {
  const negative = decimal.startsWith('-');
  const unsigned = negative ? decimal.slice(1) : decimal;
  const dot = unsigned.indexOf('.');
  const whole = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fraction = dot === -1 ? '' : unsigned.slice(dot);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction}`;
}

/** Minor units as a grouped NSP decimal, e.g. 256331500n -> "2,563,315.00". */
export function formatNspGrouped(minor: bigint, scale: number = DEFAULT_MONEY_SCALE): string {
  return groupThousands(formatMinorToDecimal(minor, scale));
}

/**
 * THE dual-amount rendering used by every operator-facing message:
 *   100000n -> "1,000.00 جديدة | 100,000 قديمة"
 * The old-lira figure is the minor-unit integer itself (see the header), grouped for reading.
 */
export function dualNsp(minor: bigint): string {
  return `${formatNspGrouped(minor)} جديدة | ${groupThousands(minor.toString())} قديمة`;
}
