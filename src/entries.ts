// Manual sheet entries: the income, expense and note rows a user adds to a
// month. Rows store full VND; the HTTP API accepts the k-scale integer the UI
// collects and converts it with `kIntoVnd`. New rows always go on top of the
// month's single position sequence (positions span all kinds), and the first
// write materializes the month so its fixed rows become a snapshot.
//
// Edits keep a row on its stored month, so a patched date must still fall
// inside it. Deletes are soft so history survives. A reorder rewrites positions
// from the id order (`index + 1`); the list orders by `position DESC`, so the
// last id becomes the top row.
import { dateInYm, isYm, kIntoVnd, nextTopPosition } from "./month-utils";
import { materializeMonth, type Entry, type EntryKind } from "./month";

export interface NewEntry {
  kind: EntryKind;
  name: string;
  /** Full VND; always null for notes. */
  amount: number | null;
  /** ISO `YYYY-MM-DD`; the route defaults an omitted date to today. */
  date: string;
  comment: string;
}

/**
 * Inserts an entry at the top of `ym`'s sheet. Materializes the month first:
 * this is a write path, so its fixed rows must freeze before the entry lands.
 */
export async function createEntry(
  env: Env,
  ym: string,
  input: NewEntry,
): Promise<{ id: number }> {
  await materializeMonth(env, ym);

  const { results: siblings } = await env.DB.prepare(
    "SELECT position FROM entries WHERE ym = ? AND deleted = 0",
  )
    .bind(ym)
    .all<{ position: number }>();

  const { meta } = await env.DB.prepare(
    `INSERT INTO entries (ym, kind, name, amount, date, comment, position)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      ym,
      input.kind,
      input.name,
      input.amount,
      input.date,
      input.comment,
      nextTopPosition(siblings),
    )
    .run();

  return { id: meta.last_row_id };
}

/** Editable entry fields; `amount` is full VND and notes ignore it. */
export interface EntryPatch {
  name?: string;
  amount?: number;
  date?: string;
  comment?: string;
  position?: number;
}

/** A live entry plus its month, which PATCH needs to validate a new date. */
interface StoredEntry extends Entry {
  ym: string;
}

/** Updates the given fields on a live entry; `null` when no row matched. */
export async function patchEntry(
  env: Env,
  id: number,
  fields: EntryPatch,
): Promise<Entry | null> {
  const { meta } = await env.DB.prepare(
    `UPDATE entries
        SET name = COALESCE(?, name),
            amount = COALESCE(?, amount),
            date = COALESCE(?, date),
            comment = COALESCE(?, comment),
            position = COALESCE(?, position)
      WHERE id = ? AND deleted = 0`,
  )
    .bind(
      fields.name ?? null,
      fields.amount ?? null,
      fields.date ?? null,
      fields.comment ?? null,
      fields.position ?? null,
      id,
    )
    .run();

  if (meta.changes === 0) return null;

  const stored = await findEntry(env, id);
  if (stored === null) return null;

  const { ym: _ym, ...entry } = stored;
  return entry;
}

/** Marks a live entry as deleted; `false` when no row matched. */
export async function softDeleteEntry(env: Env, id: number): Promise<boolean> {
  const { meta } = await env.DB.prepare(
    "UPDATE entries SET deleted = 1 WHERE id = ? AND deleted = 0",
  )
    .bind(id)
    .run();

  return meta.changes > 0;
}

/**
 * Rewrites positions to `index + 1` in the given id order. The list orders by
 * `position DESC`, so the last id becomes the top row: the frontend sends the
 * whole section bottom-up after a drag. `false` when `ids` is not exactly the
 * set of live rows for `kind` in `ym`.
 */
export async function reorderEntries(
  env: Env,
  kind: string,
  ym: string,
  ids: number[],
): Promise<boolean> {
  const { results: rows } = await env.DB.prepare(
    "SELECT id FROM entries WHERE ym = ? AND kind = ? AND deleted = 0",
  )
    .bind(ym, kind)
    .all<{ id: number }>();

  const live = new Set(rows.map((row) => row.id));
  const unique = new Set(ids);
  if (unique.size !== ids.length || live.size !== ids.length || !ids.every((id) => live.has(id))) {
    return false;
  }

  await env.DB.batch(
    ids.map((id, index) =>
      env.DB.prepare("UPDATE entries SET position = ? WHERE id = ? AND deleted = 0").bind(
        index + 1,
        id,
      ),
    ),
  );

  return true;
}

/** `POST /api/month/:ym/entry` — body carries the k-scale amount. */
export async function handleCreateEntry(
  request: Request,
  env: Env,
  ym: string,
): Promise<Response> {
  if (!isYm(ym)) return error("invalid_ym");

  const body = await readJsonObject(request);
  if (body === null) return error("invalid_body");

  const { kind } = body;
  if (!isKind(kind)) return error("invalid_kind");

  const name = readName(body.name);
  if (name === null) return error("invalid_name");

  // Notes carry no amount, so anything sent for one is ignored; the other
  // kinds require a positive whole number of thousands.
  const amount = kind === "note" ? null : readAmount(body.amount);
  if (kind !== "note" && amount === null) return error("invalid_amount");

  const date = readDate(body.date, ym);
  if (date === null) return error("date_out_of_month");

  const comment = readComment(body.comment);
  if (comment === null) return error("invalid_comment");

  return Response.json(
    await createEntry(env, ym, { kind, name, amount, date, comment }),
    { status: 201 },
  );
}

/** `PATCH /api/entry/:id` — body carries the k-scale amount when present. */
export async function handlePatchEntry(
  request: Request,
  env: Env,
  id: number,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (body === null) return error("invalid_body");

  // Moving a row between kinds would need a position in the target sequence;
  // that is a delete + create, not an edit.
  if ("kind" in body) return error("invalid_kind");

  const existing = await findEntry(env, id);
  if (existing === null) return error("not_found", 404);

  const fields: EntryPatch = {};

  if ("name" in body) {
    const name = readName(body.name);
    if (name === null) return error("invalid_name");
    fields.name = name;
  }

  // Notes always store a NULL amount, so anything sent for one is ignored.
  if ("amount" in body && existing.kind !== "note") {
    const amount = readAmount(body.amount);
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

  const updated = await patchEntry(env, id, fields);
  return updated === null ? error("not_found", 404) : Response.json(updated);
}

/** `DELETE /api/entry/:id` — soft delete so past months keep their rows. */
export async function handleDeleteEntry(env: Env, id: number): Promise<Response> {
  const deleted = await softDeleteEntry(env, id);

  return deleted ? new Response(null, { status: 204 }) : error("not_found", 404);
}

/** `POST /api/month/:ym/reorder` — body `{kind, ids}`; ids arrive bottom-up. */
export async function handleReorderEntries(
  request: Request,
  env: Env,
  ym: string,
): Promise<Response> {
  if (!isYm(ym)) return error("invalid_ym");

  const body = await readJsonObject(request);
  if (body === null) return error("invalid_body");

  const { kind } = body;
  if (!isKind(kind)) return error("invalid_kind");

  const ids = readIds(body.ids);
  if (ids === null) return error("invalid_ids");

  const reordered = await reorderEntries(env, kind, ym, ids);
  return reordered ? new Response(null, { status: 204 }) : error("invalid_ids");
}

function isKind(value: unknown): value is EntryKind {
  return value === "income" || value === "expense" || value === "note";
}

/** Trims a submitted name; `null` when absent, non-string or blank. */
function readName(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const name = value.trim();
  return name === "" ? null : name;
}

/** Converts a k-scale amount; `null` when missing or outside `kIntoVnd`'s range. */
function readAmount(value: unknown): number | null {
  return typeof value === "number" ? kIntoVnd(value) : null;
}

/**
 * An omitted date means today (UTC, matching `currentYm`), but only when today
 * falls inside `ym`: an entry must always belong to the sheet it is posted to.
 * A supplied date must be a real day inside `ym`; that also rejects impossible
 * days such as `2026-02-31`.
 */
function readDate(value: unknown, ym: string): string | null {
  if (value === undefined) {
    const today = new Date().toISOString().slice(0, 10);
    return dateInYm(today, ym) ? today : null;
  }

  return typeof value === "string" && dateInYm(value, ym) ? value : null;
}

/** `undefined` means "no comment"; only a string is accepted otherwise. */
function readComment(value: unknown): string | null {
  if (value === undefined) return "";
  return typeof value === "string" ? value : null;
}

/** A patched date must be a real day inside the entry's stored month. */
function readMonthDate(value: unknown, ym: string): string | null {
  return typeof value === "string" && dateInYm(value, ym) ? value : null;
}

/** Positions are 1-based integers, matching `nextTopPosition`'s output. */
function readPosition(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** A reorder payload is a list of unique positive integer ids. */
function readIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || !value.every(isId)) return null;

  return new Set(value).size === value.length ? value : null;
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A live entry with its month; hidden from responses (they expose `Entry`). */
async function findEntry(env: Env, id: number): Promise<StoredEntry | null> {
  return env.DB.prepare(
    `SELECT id, ym, kind, name, amount, date, comment, position
       FROM entries
      WHERE id = ? AND deleted = 0`,
  )
    .bind(id)
    .first<StoredEntry>();
}

function error(code: string, status = 400): Response {
  return Response.json({ error: code }, { status });
}

/** Parses a JSON object body; malformed or non-object bodies yield `null`. */
async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // Malformed JSON is a failed request, not a crash.
  }

  return null;
}
