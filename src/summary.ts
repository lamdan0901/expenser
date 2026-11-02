// Read-only month outputs that are not the sheet itself: the balance summary
// and the CSV download. Both build on `getMonth`, so the month's virtual/snapshot
// rules and the note-exclusion math stay in one place.
import { isYm } from "./month-utils";
import { getMonth, type Entry } from "./month";

/**
 * `GET /api/summary/:ym` — the four balance numbers. `getMonth` already ignores
 * notes; this only reshapes them next to the initial balance.
 */
export async function handleGetSummary(env: Env, ym: string): Promise<Response> {
  if (!isYm(ym)) return Response.json({ error: "invalid_ym" }, { status: 400 });

  const view = await getMonth(env, ym);

  return Response.json({
    initial: view.initial,
    income: view.summary.income,
    expense: view.summary.expense,
    ending: view.summary.ending,
  });
}

const CSV_HEADER = ["name", "amount", "date", "kind", "comment"];

/**
 * `GET /api/month/:ym/export` — the whole sheet as a browser download. Fixed
 * rows carry no day, so their `date` is empty; notes keep their row but have no
 * amount, matching the sheet.
 */
export async function handleExportMonth(env: Env, ym: string): Promise<Response> {
  if (!isYm(ym)) return Response.json({ error: "invalid_ym" }, { status: 400 });

  const view = await getMonth(env, ym);
  const rows = [
    CSV_HEADER,
    ...view.fixed.map((row) => [row.name, formatVnd(row.amount), "", row.kind, row.comment]),
    ...view.entries.map(entryRow),
  ];

  return new Response(rows.map(toCsvLine).join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="expenser-${ym}.csv"`,
    },
  });
}

/** A note never shows an amount, even if a stored row somehow has one. */
function entryRow(entry: Entry): string[] {
  const amount =
    entry.kind === "note" || entry.amount === null ? "" : formatVnd(entry.amount);

  return [entry.name, amount, entry.date, entry.kind, entry.comment];
}

/** `500000` → `500,000 ₫` — VND, comma thousands, no decimals. */
function formatVnd(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  const digits = String(Math.trunc(Math.abs(amount))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  return `${sign}${digits} ₫`;
}

/** RFC 4180: quote a field that holds a comma, a quote or a line break. */
function escapeCsv(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

function toCsvLine(fields: string[]): string {
  return fields.map(escapeCsv).join(",");
}
