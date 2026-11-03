import { SELF, env } from "cloudflare:test";
import { AUTH_COOKIE, signToken } from "../src/auth";
import { getMonth } from "../src/month";

// vitest.config.ts injects this as the PASSCODE binding; tests sign their own
// cookie instead of going through the passcode route.
const TEST_PASSCODE = "test-secret";

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", `${AUTH_COOKIE}=${await signToken("owner", TEST_PASSCODE)}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");

  return SELF.fetch(`https://example.com${path}`, { ...init, headers });
}

function createEntry(ym: string, body: unknown): Promise<Response> {
  return authedFetch(`/api/month/${ym}/entry`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Creates an entry through the API and returns its id. */
async function makeEntry(ym: string, body: unknown): Promise<number> {
  const response = await createEntry(ym, body);
  expect(response.status).toBe(201);

  const created = (await response.json()) as { id: number };
  return created.id;
}

function patchEntry(id: number, body: unknown): Promise<Response> {
  return authedFetch(`/api/entry/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

function deleteEntry(id: number): Promise<Response> {
  return authedFetch(`/api/entry/${id}`, { method: "DELETE" });
}

function reorder(ym: string, body: unknown): Promise<Response> {
  return authedFetch(`/api/month/${ym}/reorder`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  // Storage is not isolated per test, so each test starts from empty tables.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM fixed_rows"),
    env.DB.prepare("DELETE FROM entries"),
    env.DB.prepare("DELETE FROM months"),
    env.DB.prepare("DELETE FROM templates"),
    env.DB.prepare("DELETE FROM settings"),
  ]);
});

describe("PATCH /api/entry/:id", () => {
  it("patches name and amount, treating the amount as full VND", async () => {
    const id = await makeEntry("2026-11", {
      kind: "expense",
      name: "Groceries",
      amount: 500,
      date: "2026-11-02",
    });

    const response = await patchEntry(id, { name: "Market", amount: 170_000 });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id,
      kind: "expense",
      name: "Market",
      amount: 170_000,
      date: "2026-11-02",
      comment: "",
      position: 1,
    });

    await expect(getMonth(env, "2026-11")).resolves.toMatchObject({
      entries: [
        {
          id,
          kind: "expense",
          name: "Market",
          amount: 170_000,
          date: "2026-11-02",
          comment: "",
          position: 1,
        },
      ],
    });
  });

  it("patches date and comment within the month", async () => {
    const id = await makeEntry("2026-11", {
      kind: "expense",
      name: "Groceries",
      amount: 500,
      date: "2026-11-02",
      comment: "Supermarket",
    });

    const response = await patchEntry(id, { date: "2026-11-20", comment: "Farmers market" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id,
      kind: "expense",
      name: "Groceries",
      amount: 500_000,
      date: "2026-11-20",
      comment: "Farmers market",
      position: 1,
    });

    await expect(getMonth(env, "2026-11")).resolves.toMatchObject({
      entries: [
        {
          id,
          date: "2026-11-20",
          comment: "Farmers market",
        },
      ],
    });
  });

  it("can clear a comment by patching an empty string", async () => {
    const id = await makeEntry("2026-11", {
      kind: "expense",
      name: "Coffee",
      amount: 50,
      date: "2026-11-05",
      comment: "With team",
    });

    const response = await patchEntry(id, { comment: "" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id,
      comment: "",
    });

    await expect(getMonth(env, "2026-11")).resolves.toMatchObject({
      entries: [{ id, comment: "" }],
    });
  });

  it("moves a row in the month's entry order by patching its position", async () => {
    const first = await makeEntry("2026-11", {
      kind: "expense",
      name: "First",
      amount: 170,
      date: "2026-11-02",
    });
    const second = await makeEntry("2026-11", {
      kind: "expense",
      name: "Second",
      amount: 170,
      date: "2026-11-03",
    });

    // Newest on top: the list is ordered by position DESC.
    await expect(getMonth(env, "2026-11")).resolves.toMatchObject({
      entries: [{ id: second }, { id: first }],
    });

    const response = await patchEntry(first, { position: 3 });
    expect(response.status).toBe(200);

    const view = await getMonth(env, "2026-11");
    expect(view.entries.map((entry) => entry.id)).toEqual([first, second]);
    expect(view.entries.map((entry) => entry.position)).toEqual([3, 2]);
  });

  it("keeps a note's amount NULL when a patch carries one", async () => {
    const id = await makeEntry("2026-11", {
      kind: "note",
      name: "Remember",
      date: "2026-11-02",
    });

    const response = await patchEntry(id, { name: "Remember this", amount: 999 });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id,
      name: "Remember this",
      amount: null,
    });
    await expect(getMonth(env, "2026-11")).resolves.toMatchObject({
      entries: [{ id, name: "Remember this", amount: null }],
    });
  });

  it("rejects a date outside the entry's month and leaves the row unchanged", async () => {
    const id = await makeEntry("2026-11", {
      kind: "expense",
      name: "Groceries",
      amount: 170,
      date: "2026-11-02",
    });

    for (const date of ["2026-10-31", "2026-12-01", "2026-11-31"]) {
      const response = await patchEntry(id, { date });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "date_out_of_month" });
    }

    await expect(getMonth(env, "2026-11")).resolves.toMatchObject({
      entries: [{ id, date: "2026-11-02" }],
    });
  });

  it("validates patched fields the same way create does", async () => {
    const id = await makeEntry("2026-11", {
      kind: "expense",
      name: "Groceries",
      amount: 170,
      date: "2026-11-02",
    });

    const cases: [unknown, string][] = [
      [{ amount: 12.5 }, "invalid_amount"],
      [{ amount: 0 }, "invalid_amount"],
      [{ amount: "170" }, "invalid_amount"],
      [{ name: "   " }, "invalid_name"],
      [{ comment: 42 }, "invalid_comment"],
      [{ position: 1.5 }, "invalid_position"],
      [{ position: 0 }, "invalid_position"],
      [{ kind: "income" }, "invalid_kind"],
    ];

    for (const [body, code] of cases) {
      const response = await patchEntry(id, body);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: code });
    }

    await expect(getMonth(env, "2026-11")).resolves.toMatchObject({
      entries: [
        {
          id,
          kind: "expense",
          name: "Groceries",
          amount: 170_000,
          date: "2026-11-02",
          comment: "",
          position: 1,
        },
      ],
    });
  });

  it("returns 404 for a missing or already-deleted entry", async () => {
    const missing = await patchEntry(9999, { name: "Nope" });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "not_found" });

    const id = await makeEntry("2026-11", {
      kind: "expense",
      name: "Groceries",
      amount: 170,
      date: "2026-11-02",
    });
    await deleteEntry(id);

    const deleted = await patchEntry(id, { name: "Nope" });
    expect(deleted.status).toBe(404);
    await expect(deleted.json()).resolves.toEqual({ error: "not_found" });
  });
});

describe("DELETE /api/entry/:id", () => {
  it("soft-deletes: the row leaves the month and its amount leaves the summary", async () => {
    const id = await makeEntry("2026-11", {
      kind: "expense",
      name: "Groceries",
      amount: 170,
      date: "2026-11-02",
    });

    await expect(getMonth(env, "2026-11")).resolves.toMatchObject({
      summary: { income: 0, expense: 170_000, ending: -170_000 },
    });

    const response = await deleteEntry(id);
    expect(response.status).toBe(204);

    await expect(getMonth(env, "2026-11")).resolves.toMatchObject({
      entries: [],
      summary: { income: 0, expense: 0, ending: 0 },
    });

    // History is kept: the row is still stored, just flagged deleted.
    const row = await env.DB.prepare("SELECT deleted FROM entries WHERE id = ?")
      .bind(id)
      .first<{ deleted: number }>();
    expect(row).toEqual({ deleted: 1 });

    expect((await deleteEntry(id)).status).toBe(404);
  });
});

describe("POST /api/month/:ym/reorder", () => {
  it("writes index+1 positions, so the last id becomes the top row", async () => {
    const first = await makeEntry("2026-11", {
      kind: "expense",
      name: "First",
      amount: 170,
      date: "2026-11-02",
    });
    const second = await makeEntry("2026-11", {
      kind: "expense",
      name: "Second",
      amount: 170,
      date: "2026-11-03",
    });

    // `second` was created last, so it is currently on top.
    await expect(getMonth(env, "2026-11")).resolves.toMatchObject({
      entries: [{ id: second }, { id: first }],
    });

    // The frontend sends ids bottom-up: the last id is the row dropped on top.
    const response = await reorder("2026-11", {
      kind: "expense",
      ids: [second, first],
    });
    expect(response.status).toBe(204);

    const view = await getMonth(env, "2026-11");
    expect(view.entries.map((entry) => entry.id)).toEqual([first, second]);
    expect(view.entries.map((entry) => entry.position)).toEqual([2, 1]);
  });

  it("rejects malformed months, kinds and ids without touching positions", async () => {
    const first = await makeEntry("2026-11", {
      kind: "expense",
      name: "First",
      amount: 170,
      date: "2026-11-02",
    });
    const second = await makeEntry("2026-11", {
      kind: "expense",
      name: "Second",
      amount: 170,
      date: "2026-11-03",
    });

    const badYm = await reorder("2026-13", { kind: "expense", ids: [first, second] });
    expect(badYm.status).toBe(400);
    await expect(badYm.json()).resolves.toEqual({ error: "invalid_ym" });

    for (const kind of ["fixed_income", "", null, undefined]) {
      const response = await reorder("2026-11", { kind, ids: [first, second] });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_kind" });
    }

    // Not an array, duplicates, a subset, a foreign id and a non-integer id.
    for (const ids of [undefined, [first, first], [first], [first, second, 9999], [first, 1.5]]) {
      const response = await reorder("2026-11", { kind: "expense", ids });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_ids" });
    }

    const view = await getMonth(env, "2026-11");
    expect(view.entries.map((entry) => entry.id)).toEqual([second, first]);
    expect(view.entries.map((entry) => entry.position)).toEqual([2, 1]);
  });

  it("returns 400 when ids do not belong to the named kind", async () => {
    const expense = await makeEntry("2026-11", {
      kind: "expense",
      name: "Groceries",
      amount: 170,
      date: "2026-11-02",
    });
    const note = await makeEntry("2026-11", {
      kind: "note",
      name: "Remember",
      date: "2026-11-03",
    });

    const response = await reorder("2026-11", {
      kind: "expense",
      ids: [expense, note],
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_ids" });
  });
});

describe("entry edit routes auth", () => {
  it("requires auth on patch, delete and reorder", async () => {
    const routes: [string, string, unknown][] = [
      ["/api/entry/1", "PATCH", { name: "Nope" }],
      ["/api/entry/1", "DELETE", undefined],
      ["/api/month/2026-11/reorder", "POST", { kind: "expense", ids: [] }],
    ];

    for (const [path, method, body] of routes) {
      const response = await SELF.fetch(`https://example.com${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    }
  });
});
