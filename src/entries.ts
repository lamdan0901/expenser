// Manual sheet entries: the income, expense and note rows a user adds to a
// month. Rows store full VND; the HTTP API accepts the k-scale integer the UI
// collects and converts it with `kIntoVnd`. New rows always go on top of the
// month's single position sequence (positions span all kinds), and the first
// write materializes the month so its fixed rows become a snapshot.
import { dateInYm, isYm, kIntoVnd, nextTopPosition } from "./month-utils";
import { materializeMonth, type EntryKind } from "./month";

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
 * An omitted date means today (UTC, matching `currentYm`). A supplied date
 * must be a real day inside `ym`; that also rejects impossible days such as
 * `2026-02-31`.
 */
function readDate(value: unknown, ym: string): string | null {
  if (value === undefined) return new Date().toISOString().slice(0, 10);

  return typeof value === "string" && dateInYm(value, ym) ? value : null;
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
