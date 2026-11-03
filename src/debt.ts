import { dateInYm, isYm, kIntoVnd, nextTopPosition } from "./month-utils";
import { materializeMonth } from "./month";
import { openSettings } from "./setup";

export const INITIAL_DEBT_KEY = "initial_debt";

export type DebtDirection = "add" | "pay";

export interface DebtEntry {
  id: number;
  ym: string;
  direction: DebtDirection;
  name: string;
  amount: number; // full VND
  date: string;
  comment: string;
  position: number;
}

export interface DebtView {
  initial: number;
  remaining: number;
  entries: DebtEntry[];
}

export interface NewDebtEntry {
  direction: DebtDirection;
  name: string;
  amount: number; // full VND
  date: string;
  comment: string;
}

export interface DebtEntryPatch {
  direction?: DebtDirection;
  name?: string;
  amount?: number;
  date?: string;
  comment?: string;
  position?: number;
}

export async function getDebtView(env: Env, ym: string): Promise<DebtView> {
  const [settings, priorRow, entriesResult] = await Promise.all([
    openSettings(env),
    env.DB.prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'add' THEN amount ELSE -amount END), 0) AS net
         FROM debt_entries
        WHERE ym < ? AND deleted = 0`,
    )
      .bind(ym)
      .first<{ net: number }>(),
    env.DB.prepare(
      `SELECT id, ym, direction, name, amount, date, comment, position
         FROM debt_entries
        WHERE ym = ? AND deleted = 0
        ORDER BY position DESC, id DESC`,
    )
      .bind(ym)
      .all<DebtEntry>(),
  ]);

  const baseInitial = readStoredDebt(settings[INITIAL_DEBT_KEY]);
  const priorNet = priorRow?.net ?? 0;
  const initial = baseInitial + priorNet;

  const entries = entriesResult.results ?? [];
  let thisMonthNet = 0;
  for (const entry of entries) {
    if (entry.direction === "add") thisMonthNet += entry.amount;
    else if (entry.direction === "pay") thisMonthNet -= entry.amount;
  }

  const remaining = initial + thisMonthNet;

  return {
    initial,
    remaining,
    entries,
  };
}

export async function createDebtEntry(
  env: Env,
  ym: string,
  input: NewDebtEntry,
): Promise<{ id: number }> {
  await materializeMonth(env, ym);

  const { results: siblings } = await env.DB.prepare(
    "SELECT position FROM debt_entries WHERE ym = ? AND deleted = 0",
  )
    .bind(ym)
    .all<{ position: number }>();

  const { meta } = await env.DB.prepare(
    `INSERT INTO debt_entries (ym, direction, name, amount, date, comment, position)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      ym,
      input.direction,
      input.name,
      input.amount,
      input.date,
      input.comment,
      nextTopPosition(siblings),
    )
    .run();

  return { id: meta.last_row_id };
}

export async function patchDebtEntry(
  env: Env,
  id: number,
  fields: DebtEntryPatch,
): Promise<DebtEntry | null> {
  const { meta } = await env.DB.prepare(
    `UPDATE debt_entries
        SET direction = COALESCE(?, direction),
            name = COALESCE(?, name),
            amount = COALESCE(?, amount),
            date = COALESCE(?, date),
            comment = COALESCE(?, comment),
            position = COALESCE(?, position)
      WHERE id = ? AND deleted = 0`,
  )
    .bind(
      fields.direction ?? null,
      fields.name ?? null,
      fields.amount ?? null,
      fields.date ?? null,
      fields.comment ?? null,
      fields.position ?? null,
      id,
    )
    .run();

  if (meta.changes === 0) return null;

  return env.DB.prepare(
    `SELECT id, ym, direction, name, amount, date, comment, position
       FROM debt_entries
      WHERE id = ?`,
  )
    .bind(id)
    .first<DebtEntry>();
}

export async function deleteDebtEntry(env: Env, id: number): Promise<boolean> {
  const { meta } = await env.DB.prepare(
    "UPDATE debt_entries SET deleted = 1 WHERE id = ? AND deleted = 0",
  )
    .bind(id)
    .run();

  return meta.changes > 0;
}

export async function reorderDebtEntries(
  env: Env,
  ym: string,
  ids: number[],
): Promise<boolean> {
  const { results: live } = await env.DB.prepare(
    "SELECT id FROM debt_entries WHERE ym = ? AND deleted = 0",
  )
    .bind(ym)
    .all<{ id: number }>();

  if (live.length !== ids.length) return false;
  const liveSet = new Set(live.map((r) => r.id));
  if (!ids.every((id) => liveSet.has(id))) return false;

  const statements = ids.map((id, index) =>
    env.DB.prepare("UPDATE debt_entries SET position = ? WHERE id = ?").bind(index + 1, id),
  );

  await env.DB.batch(statements);
  return true;
}

export async function handleCreateDebtEntry(
  request: Request,
  env: Env,
  ym: string,
): Promise<Response> {
  if (!isYm(ym)) return error("invalid_ym");

  const body = await readJsonObject(request);
  if (body === null) return error("invalid_body");

  const direction = readDirection(body.direction);
  if (direction === null) return error("invalid_direction");

  const name = readName(body.name);
  if (name === null) return error("invalid_name");

  const amount = readAmount(body.amount);
  if (amount === null) return error("invalid_amount");

  const date = readDate(body.date, ym);
  if (date === null) return error("invalid_date");

  const comment = readComment(body.comment);
  if (comment === null) return error("invalid_comment");

  const created = await createDebtEntry(env, ym, {
    direction,
    name,
    amount,
    date,
    comment,
  });

  return Response.json(
    {
      id: created.id,
      ym,
      direction,
      name,
      amount,
      date,
      comment,
    },
    { status: 201 },
  );
}

export async function handlePatchDebtEntry(
  request: Request,
  env: Env,
  id: number,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (body === null) return error("invalid_body");

  const existing = await findDebtEntry(env, id);
  if (existing === null) return error("not_found", 404);

  const fields: DebtEntryPatch = {};

  if ("direction" in body) {
    const direction = readDirection(body.direction);
    if (direction === null) return error("invalid_direction");
    fields.direction = direction;
  }

  if ("name" in body) {
    const name = readName(body.name);
    if (name === null) return error("invalid_name");
    fields.name = name;
  }

  if ("amount" in body) {
    const amount = readVnd(body.amount);
    if (amount === null) return error("invalid_amount");
    fields.amount = amount;
  }

  if ("date" in body) {
    const date = readMonthDate(body.date, existing.ym);
    if (date === null) return error("date_out_of_month");
    fields.date = date;
  }

  if ("comment" in body) {
    const comment = readComment(body.comment);
    if (comment === null) return error("invalid_comment");
    fields.comment = comment;
  }

  if ("position" in body) {
    const position = readPosition(body.position);
    if (position === null) return error("invalid_position");
    fields.position = position;
  }

  const updated = await patchDebtEntry(env, id, fields);
  return updated === null ? error("not_found", 404) : Response.json(updated);
}

export async function handleDeleteDebtEntry(env: Env, id: number): Promise<Response> {
  const deleted = await deleteDebtEntry(env, id);
  return deleted ? new Response(null, { status: 204 }) : error("not_found", 404);
}

export async function handleReorderDebtEntries(
  request: Request,
  env: Env,
  ym: string,
): Promise<Response> {
  if (!isYm(ym)) return error("invalid_ym");

  const body = await readJsonObject(request);
  if (body === null) return error("invalid_body");

  const ids = readIds(body.ids);
  if (ids === null) return error("invalid_ids");

  const reordered = await reorderDebtEntries(env, ym, ids);
  return reordered ? new Response(null, { status: 204 }) : error("invalid_ids");
}

export async function handleInitialDebt(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const value = body?.value;

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return error("invalid_value");
  }

  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(INITIAL_DEBT_KEY, String(value))
    .run();

  return new Response(null, { status: 204 });
}

function readStoredDebt(raw?: string): number {
  if (raw === undefined) return 0;
  const val = Number(raw);
  return Number.isSafeInteger(val) && val >= 0 ? val : 0;
}

function readDirection(value: unknown): DebtDirection | null {
  return value === "add" || value === "pay" ? value : null;
}

function readName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name === "" ? null : name;
}

function readAmount(value: unknown): number | null {
  return typeof value === "number" ? kIntoVnd(value) : null;
}

function readVnd(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function readDate(value: unknown, ym: string): string | null {
  if (value === undefined) {
    const today = new Date().toISOString().slice(0, 10);
    return dateInYm(today, ym) ? today : null;
  }
  return typeof value === "string" && dateInYm(value, ym) ? value : null;
}

function readMonthDate(value: unknown, ym: string): string | null {
  return typeof value === "string" && dateInYm(value, ym) ? value : null;
}

function readComment(value: unknown): string | null {
  if (value === undefined) return "";
  return typeof value === "string" ? value : null;
}

function readPosition(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function readIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || !value.every(isId)) return null;
  return new Set(value).size === value.length ? value : null;
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function findDebtEntry(env: Env, id: number): Promise<DebtEntry | null> {
  return env.DB.prepare(
    `SELECT id, ym, direction, name, amount, date, comment, position
       FROM debt_entries
      WHERE id = ? AND deleted = 0`,
  )
    .bind(id)
    .first<DebtEntry>();
}

function error(code: string, status = 400): Response {
  return Response.json({ error: code }, { status });
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {}
  return null;
}
