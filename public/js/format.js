// Pure formatting helpers for the frontend.
//
// This module is deliberately DOM-free and Node-free: the unit tests run it in
// the Cloudflare Workers runtime. Everything here mirrors `src/month-utils.ts`
// where the two overlap, so the browser and the API agree on month bounds and
// on what counts as a valid k-scale amount.

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Formats full dong with comma separators, no decimals, and a trailing `₫`:
 * `500000` → `"500,000 ₫"`. Negative values keep a leading minus.
 */
export function fmtVND(n) {
  const value = Number.isFinite(n) ? Math.round(n) : 0;
  const sign = value < 0 ? "−" : "";
  const digits = String(Math.abs(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  return `${sign}${digits} ₫`;
}

/**
 * Converts an amount typed in whole thousands to dong, or `null` when it is not
 * a positive whole number below 1e9 — exactly the range `kIntoVnd` accepts on
 * the server. `"500"` → `500000`; `"0"`, `"12.5"`, `"abc"`, `""` → `null`.
 */
export function parseK(input) {
  const text = String(input).trim();
  if (!/^\d+$/.test(text)) return null;

  const k = Number(text);
  if (!Number.isSafeInteger(k) || k <= 0 || k >= 1e9) return null;

  return k * 1000;
}

/** Today as a `YYYY-MM-DD` UTC day, matching the server's default entry date. */
export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** `"2026-11-15"` → `"November 15, 2026"`. */
export function prettyDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/** `"2026-11"` → `"November 2026"`. */
export function ymLabel(ym) {
  const [year, month] = ym.split("-").map(Number);
  return `${MONTHS[month - 1]} ${year}`;
}

/**
 * First and last calendar day of `ym` as ISO dates — the frontend mirror of
 * `ymBounds` in `src/month-utils.ts`. UTC keeps timezones from shifting a day;
 * day 0 of the following month is the last day of this one.
 */
export function monthISOBounds(ym) {
  const [year, month] = ym.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return { min: `${ym}-01`, max: `${ym}-${String(lastDay).padStart(2, "0")}` };
}
