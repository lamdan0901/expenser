// Month and currency helpers shared by the API routes (and mirrored by the
// frontend). Everything here is pure: no DB, no ambient clock — `currentYm`
// takes the date to read.

/** True for a zero-padded `YYYY-MM` month, `01`–`12`. */
export function isYm(s: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/**
 * First and last calendar day of `ym`, as ISO date strings. `ym` is assumed to
 * be valid (see `isYm`). Everything is UTC so no timezone can shift a day; the
 * month is 1-based, and day 0 of month `m` is the last day of the month before
 * index `m`, i.e. the last day of the target month.
 */
export function ymBounds(ym: string): { min: string; max: string } {
  const [year, month] = ym.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return { min: `${ym}-01`, max: `${ym}-${String(lastDay).padStart(2, "0")}` };
}

/**
 * True when `date` (`YYYY-MM-DD`) is a real day inside `ym` (`YYYY-MM`).
 * Zero-padded ISO dates compare correctly as strings, so the bounds double as
 * a range check that also rejects impossible days such as `2026-02-31`.
 */
export function dateInYm(date: string, ym: string): boolean {
  if (!isYm(ym) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;

  const { min, max } = ymBounds(ym);
  return date >= min && date <= max;
}

/** The `YYYY-MM` month that `now` falls in, read in UTC. */
export function currentYm(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Converts an amount entered in whole thousands (k) to dong, or `null` when the
 * input is not a positive whole number below 1e9 — the app's range for a single
 * amount. A non-integer k has no meaning on a cash sheet.
 */
export function kIntoVnd(input: number): number | null {
  if (!Number.isInteger(input) || input <= 0 || input >= 1e9) return null;

  return input * 1000;
}

/** Position for a new top row: one above the highest existing position. */
export function nextTopPosition(rows: { position: number }[]): number {
  return rows.reduce((top, row) => Math.max(top, row.position), 0) + 1;
}
