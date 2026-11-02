// Fixed (recurring) income/expense templates.
//
// Rows hold full VND amounts; create accepts the thousands-scale integer the
// UI collects and converts it with `kIntoVnd`, while a patch takes the full-VND
// value an inline edit displayed. Templates are soft-deleted so months that
// materialized from them keep their history, and positions are independent per
// kind: `fixed_income` and `fixed_expense` each run 1..n.
import { kIntoVnd, nextTopPosition } from "./month-utils";

export type TemplateKind = "fixed_income" | "fixed_expense";

/** A live template row, exactly as stored (amounts are full VND). */
export interface Template {
  id: number;
  kind: TemplateKind;
  name: string;
  amount: number;
  comment: string;
  position: number;
}

export interface NewTemplate {
  kind: TemplateKind;
  name: string;
  /** Full VND; the HTTP layer converts the k-scale input before calling this. */
  amount: number;
  comment: string;
}

/** Editable template fields. `kind` is immutable, so a row keeps its sequence. */
export interface TemplatePatch {
  name?: string;
  /** Full VND. */
  amount?: number;
  comment?: string;
}

const SELECT_TEMPLATE = "SELECT id, kind, name, amount, comment, position FROM templates";

/** Live templates, ordered by kind then by their within-kind position. */
export async function listTemplates(env: Env): Promise<Template[]> {
  const { results } = await env.DB.prepare(
    `${SELECT_TEMPLATE} WHERE deleted = 0 ORDER BY kind, position, id`,
  ).all<Template>();

  return results;
}

/** Inserts a template at the next position in its kind's sequence. */
export async function createTemplate(env: Env, input: NewTemplate): Promise<Template> {
  const { results: siblings } = await env.DB.prepare(
    "SELECT position FROM templates WHERE kind = ? AND deleted = 0",
  )
    .bind(input.kind)
    .all<{ position: number }>();

  const position = nextTopPosition(siblings);

  const { meta } = await env.DB.prepare(
    `INSERT INTO templates (kind, name, amount, comment, position)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(input.kind, input.name, input.amount, input.comment, position)
    .run();

  return { id: meta.last_row_id, ...input, position };
}

/** Updates the given fields on a live template; `null` when no row matched. */
export async function patchTemplate(
  env: Env,
  id: number,
  fields: TemplatePatch,
): Promise<Template | null> {
  const { meta } = await env.DB.prepare(
    `UPDATE templates
        SET name = COALESCE(?, name),
            amount = COALESCE(?, amount),
            comment = COALESCE(?, comment)
      WHERE id = ? AND deleted = 0`,
  )
    .bind(fields.name ?? null, fields.amount ?? null, fields.comment ?? null, id)
    .run();

  if (meta.changes === 0) return null;

  return getTemplate(env, id);
}

/** Marks a live template as deleted; `false` when no row matched. */
export async function softDeleteTemplate(env: Env, id: number): Promise<boolean> {
  const { meta } = await env.DB.prepare(
    "UPDATE templates SET deleted = 1 WHERE id = ? AND deleted = 0",
  )
    .bind(id)
    .run();

  return meta.changes > 0;
}

async function getTemplate(env: Env, id: number): Promise<Template | null> {
  return env.DB.prepare(`${SELECT_TEMPLATE} WHERE id = ? AND deleted = 0`)
    .bind(id)
    .first<Template>();
}

/** `GET /api/templates` — live templates for the fixed sections. */
export async function handleListTemplates(env: Env): Promise<Response> {
  return Response.json(await listTemplates(env));
}

/** `POST /api/templates` — body carries the k-scale amount. */
export async function handleCreateTemplate(request: Request, env: Env): Promise<Response> {
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

  return Response.json(await createTemplate(env, { kind, name, amount, comment }), {
    status: 201,
  });
}

/** `PATCH /api/templates/:id` — body carries the full-VND amount when present. */
export async function handlePatchTemplate(
  request: Request,
  env: Env,
  id: number,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (body === null) return error("invalid_body");

  // Moving a row between kinds would need a position in the target sequence;
  // that is a delete + create, not an edit.
  if ("kind" in body) return error("invalid_kind");

  const fields: TemplatePatch = {};

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

  const updated = await patchTemplate(env, id, fields);
  return updated === null ? error("not_found", 404) : Response.json(updated);
}

/** `DELETE /api/templates/:id` — soft delete so past months keep their rows. */
export async function handleDeleteTemplate(env: Env, id: number): Promise<Response> {
  const deleted = await softDeleteTemplate(env, id);

  return deleted ? new Response(null, { status: 204 }) : error("not_found", 404);
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
