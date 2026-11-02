// A month sheet, read-only for now.
//
// `months` is a materialization marker: a sheet becomes real on its first
// write (entry or fixed-row edit, wired in later tasks). Reading a month never
// writes. Until it materializes, the fixed sections are a *virtual* preview of
// the live templates, with negative ids so the frontend can tell them apart
// from stored snapshot rows. `materializeMonth` copies those templates into
// `fixed_rows` exactly once; afterwards the snapshot is what the month shows,
// so later template edits cannot rewrite history.
import { isYm } from "./month-utils";
import { INITIAL_BALANCE_KEY, openSettings, type Settings } from "./setup";
import { listTemplates, type Template, type TemplateKind } from "./templates";

/** Entry kinds; notes carry no amount and never count towards sums. */
export type EntryKind = "income" | "expense" | "note";

/** A sheet row as the month view exposes it (full VND). */
export interface Entry {
  id: number;
  kind: EntryKind;
  name: string;
  amount: number | null;
  date: string;
  comment: string;
  position: number;
}

/** A fixed row: a snapshot row, or a template mapped to a virtual row. */
export interface FixedItem {
  kind: TemplateKind;
  /** Snapshot id when materialized; `-template.id` while virtual. */
  id: number;
  name: string;
  amount: number;
  comment: string;
  position: number;
}

export interface MonthView {
  ym: string;
  materialized: boolean;
  initial: number;
  fixed: FixedItem[];
  entries: Entry[];
  summary: { income: number; expense: number; ending: number };
}

interface MonthRow {
  materialized_at: string | null;
}

/**
 * Materializes `ym`: inserts its `months` row if new, then copies the live
 * templates into `fixed_rows` if the month has not materialized yet. The
 * statements run as one D1 batch, so a repeated (or concurrent) call cannot
 * copy the templates twice. Callers are write routes; the read path
 * (`getMonth`) never calls this.
 */
export async function materializeMonth(env: Env, ym: string): Promise<void> {
  const materializedAt = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare("INSERT INTO months (ym) VALUES (?) ON CONFLICT(ym) DO NOTHING").bind(ym),
    // kind and position are carried over verbatim: positions are scoped per
    // kind, and the month keeps the template's price as a snapshot.
    env.DB.prepare(
      `INSERT INTO fixed_rows (ym, kind, template_id, name, amount, comment, position)
       SELECT ?, kind, id, name, amount, comment, position
         FROM templates
        WHERE deleted = 0
          AND (SELECT materialized_at FROM months WHERE ym = ?) IS NULL`,
    ).bind(ym, ym),
    env.DB.prepare(
      "UPDATE months SET materialized_at = ? WHERE ym = ? AND materialized_at IS NULL",
    ).bind(materializedAt, ym),
  ]);
}

/**
 * Reads a month sheet and its balance preview. Pure read: it never creates the
 * `months` row, copies templates, or touches settings.
 */
export async function getMonth(env: Env, ym: string): Promise<MonthView> {
  const [month, settings] = await Promise.all([
    env.DB.prepare("SELECT materialized_at FROM months WHERE ym = ?")
      .bind(ym)
      .first<MonthRow>(),
    openSettings(env),
  ]);

  const materialized = month !== null && month.materialized_at !== null;
  const initial = readInitial(settings);

  const fixed = materialized
    ? await listFixedRows(env, ym)
    : (await listTemplates(env)).map(virtualRow);
  const entries = materialized ? await listEntries(env, ym) : [];

  return {
    ym,
    materialized,
    initial,
    fixed,
    entries,
    summary: summarize(fixed, entries, initial),
  };
}

/** `GET /api/month/:ym` — read-only; a malformed month is a 400. */
export async function handleGetMonth(env: Env, ym: string): Promise<Response> {
  if (!isYm(ym)) return Response.json({ error: "invalid_ym" }, { status: 400 });

  return Response.json(await getMonth(env, ym));
}

async function listFixedRows(env: Env, ym: string): Promise<FixedItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT kind, id, name, amount, comment, position
       FROM fixed_rows
      WHERE ym = ? AND deleted = 0
      ORDER BY kind, position, id`,
  )
    .bind(ym)
    .all<FixedItem>();

  return results;
}

// Newest first, matching the sheet's default order (Task 8 pins the same).
async function listEntries(env: Env, ym: string): Promise<Entry[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, name, amount, date, comment, position
       FROM entries
      WHERE ym = ? AND deleted = 0
      ORDER BY position DESC, id DESC`,
  )
    .bind(ym)
    .all<Entry>();

  return results;
}

/** Maps a live template to its virtual row: negative id, same fields. */
function virtualRow(template: Template): FixedItem {
  return {
    kind: template.kind,
    id: -template.id,
    name: template.name,
    amount: template.amount,
    comment: template.comment,
    position: template.position,
  };
}

/** Income and expense totals; notes and NULL amounts never count. */
function summarize(
  fixed: FixedItem[],
  entries: Entry[],
  initial: number,
): MonthView["summary"] {
  let income = 0;
  let expense = 0;

  for (const row of fixed) {
    if (row.kind === "fixed_income") income += row.amount;
    else expense += row.amount;
  }

  for (const entry of entries) {
    if (entry.amount === null) continue;
    if (entry.kind === "income") income += entry.amount;
    else if (entry.kind === "expense") expense += entry.amount;
  }

  return { income, expense, ending: initial + income - expense };
}

/** Initial balance is absent (0) until setup; stored values are non-negative. */
function readInitial(settings: Settings): number {
  const raw = settings[INITIAL_BALANCE_KEY];
  if (raw === undefined) return 0;

  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
