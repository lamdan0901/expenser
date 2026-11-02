// Fixed (recurring) rows on a month sheet, with the spec's past/current rules.
//
// A snapshot row with `template_id` set follows its template; a row with
// `template_id = null` is month-local forever. Writes to the current or a
// future month create/edit/delete the template *and* that month's snapshot,
// because those months are still "live". Writes to a past month touch only its
// own snapshot, so history survives template changes. Creating the first
// fixed row in a month materializes it; a fixed-row write is a write.
//
// Amounts are full VND in the DB and in these functions; create converts the
// UI's k-scale input with `kIntoVnd`, while a patch takes the full-VND value an
// inline edit displayed. Reordering rewrites `position = index + 1` in the
// posted top-down order, matching the section's ascending list.
import { currentYm, isYm, kIntoVnd, nextTopPosition } from "./month-utils";
import { materializeMonth, type FixedItem } from "./month";
import {
  createTemplate,
  patchTemplate,
  softDeleteTemplate,
  type TemplateKind,
  type TemplatePatch,
} from "./templates";

export interface NewFixedRow {
  kind: TemplateKind;
  name: string;
  /** Full VND; the HTTP layer converts the k-scale input before calling this. */
  amount: number;
  comment: string;
}

/** Editable fixed-row fields. `kind` is immutable, so a row keeps its sequence. */
export interface FixedRowPatch {
  name?: string;
  /** Full VND. */
  amount?: number;
  comment?: string;
}

/** A stored snapshot row; `template_id` decides whether it follows a template. */
interface StoredFixedRow extends FixedItem {
  ym: string;
  template_id: number | null;
}

/**
 * Inserts a fixed row into `ym` at the top of its kind's sequence. The write
 * materializes the month first, so its snapshot exists before the new row lands.
 * In the current or a future month the row is backed by a new template; in a
 * past month it stays month-local (`template_id = null`).
 */
export async function createFixedRow(
  env: Env,
  ym: string,
  input: NewFixedRow,
): Promise<FixedItem> {
  await materializeMonth(env, ym);

  const template = followsTemplate(ym)
    ? await createTemplate(env, {
        kind: input.kind,
        name: input.name,
        amount: input.amount,
        comment: input.comment,
      })
    : null;

  const { results: siblings } = await env.DB.prepare(
    "SELECT position FROM fixed_rows WHERE ym = ? AND kind = ? AND deleted = 0",
  )
    .bind(ym, input.kind)
    .all<{ position: number }>();

  const position = template?.position ?? nextTopPosition(siblings);

  const { meta } = await env.DB.prepare(
    `INSERT INTO fixed_rows (ym, kind, template_id, name, amount, comment, position)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(ym, input.kind, template?.id ?? null, input.name, input.amount, input.comment, position)
    .run();

  return {
    id: meta.last_row_id,
    kind: input.kind,
    name: input.name,
    amount: input.amount,
    comment: input.comment,
    position,
  };
}

/**
 * Updates a row's snapshot. In the current or a future month a row that is
 * linked to a template also updates that template, so the price carries into
 * new months. A past month's row changes alone; its template is untouched.
 * `null` when `id` is not a live row of `ym`.
 */
export async function patchFixedRow(
  env: Env,
  ym: string,
  id: number,
  fields: FixedRowPatch,
): Promise<FixedItem | null> {
  const row = await findFixedRow(env, ym, id);
  if (row === null) return null;

  if (row.template_id !== null && followsTemplate(ym)) {
    await patchTemplate(env, row.template_id, fields);
  }

  const { meta } = await env.DB.prepare(
    `UPDATE fixed_rows
        SET name = COALESCE(?, name),
            amount = COALESCE(?, amount),
            comment = COALESCE(?, comment)
      WHERE id = ? AND ym = ? AND deleted = 0`,
  )
    .bind(fields.name ?? null, fields.amount ?? null, fields.comment ?? null, id, ym)
    .run();

  if (meta.changes === 0) return null;

  const updated = await findFixedRow(env, ym, id);
  if (updated === null) return null;

  const { ym: _ym, template_id: _templateId, ...item } = updated;
  return item;
}

/**
 * Soft-deletes a row. In the current or a future month a linked template is
 * soft-deleted too, so the item stops recurring; past months keep their
 * snapshots. `false` when `id` is not a live row of `ym`.
 */
export async function deleteFixedRow(env: Env, ym: string, id: number): Promise<boolean> {
  const row = await findFixedRow(env, ym, id);
  if (row === null) return false;

  if (row.template_id !== null && followsTemplate(ym)) {
    await softDeleteTemplate(env, row.template_id);
  }

  const { meta } = await env.DB.prepare(
    "UPDATE fixed_rows SET deleted = 1 WHERE id = ? AND ym = ? AND deleted = 0",
  )
    .bind(id, ym)
    .run();

  return meta.changes > 0;
}

/**
 * Rewrites positions to `index + 1` in the given id order for the live rows of
 * one kind in `ym`. The section orders by `position` ascending, so the frontend
 * posts the whole section top-down. `false` when `ids` is not exactly the set of
 * live rows for `kind` in `ym`.
 */
export async function reorderFixedRows(
  env: Env,
  kind: TemplateKind,
  ym: string,
  ids: number[],
): Promise<boolean> {
  const { results: rows } = await env.DB.prepare(
    "SELECT id FROM fixed_rows WHERE ym = ? AND kind = ? AND deleted = 0",
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
      env.DB.prepare("UPDATE fixed_rows SET position = ? WHERE id = ? AND deleted = 0").bind(
        index + 1,
        id,
      ),
    ),
  );

  return true;
}

/** `POST /api/fixed/:ym` — body carries the k-scale amount. */
export async function handleCreateFixedRow(
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

  const amount = readAmount(body.amount);
  if (amount === null) return error("invalid_amount");

  const comment = readComment(body.comment);
  if (comment === null) return error("invalid_comment");

  return Response.json(await createFixedRow(env, ym, { kind, name, amount, comment }), {
    status: 201,
  });
}

/** `PATCH /api/fixed/:ym/:id` — body carries the full-VND amount when present. */
export async function handlePatchFixedRow(
  request: Request,
  env: Env,
  ym: string,
  id: number,
): Promise<Response> {
  if (!isYm(ym)) return error("invalid_ym");

  const body = await readJsonObject(request);
  if (body === null) return error("invalid_body");

  // Moving a row between kinds would need a position in the target sequence;
  // that is a delete + create, not an edit.
  if ("kind" in body) return error("invalid_kind");

  const fields: FixedRowPatch = {};

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

  if ("comment" in body) {
    const comment = readComment(body.comment);
    if (comment === null) return error("invalid_comment");
    fields.comment = comment;
  }

  const updated = await patchFixedRow(env, ym, id, fields);
  return updated === null ? error("not_found", 404) : Response.json(updated);
}

/** `DELETE /api/fixed/:ym/:id` — mirrors the patch rules for templates. */
export async function handleDeleteFixedRow(
  env: Env,
  ym: string,
  id: number,
): Promise<Response> {
  if (!isYm(ym)) return error("invalid_ym");

  const deleted = await deleteFixedRow(env, ym, id);

  return deleted ? new Response(null, { status: 204 }) : error("not_found", 404);
}

/** `POST /api/fixed/:ym/reorder` — body `{kind, ids}`; ids arrive top-down. */
export async function handleReorderFixedRows(
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

  const reordered = await reorderFixedRows(env, kind, ym, ids);
  return reordered ? new Response(null, { status: 204 }) : error("invalid_ids");
}

/** The current month and later are still live; only earlier months are history. */
function followsTemplate(ym: string): boolean {
  return ym >= currentYm(new Date());
}

async function findFixedRow(env: Env, ym: string, id: number): Promise<StoredFixedRow | null> {
  return env.DB.prepare(
    `SELECT id, ym, kind, template_id, name, amount, comment, position
       FROM fixed_rows
      WHERE id = ? AND ym = ? AND deleted = 0`,
  )
    .bind(id, ym)
    .first<StoredFixedRow>();
}

function isKind(value: unknown): value is TemplateKind {
  return value === "fixed_income" || value === "fixed_expense";
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

/** A full-VND edit (`500000` → 500,000 ₫): a positive safe integer, no ×1000. */
function readVnd(value: unknown): number | null {
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

/** `undefined` means "no comment"; only a string is accepted otherwise. */
function readComment(value: unknown): string | null {
  if (value === undefined) return "";
  return typeof value === "string" ? value : null;
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
