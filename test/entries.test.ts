import { SELF, env } from "cloudflare:test";
import { AUTH_COOKIE, signToken } from "../src/auth";
import { getMonth } from "../src/month";
import type { Template } from "../src/templates";

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

function createTemplate(body: unknown): Promise<Response> {
  return authedFetch("/api/templates", { method: "POST", body: JSON.stringify(body) });
}

/** Today in UTC, the same clock the server defaults an omitted date to. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

interface StoredEntry {
  ym: string;
  kind: string;
  name: string;
  amount: number | null;
  date: string;
  comment: string;
  position: number;
}

async function storedEntries(ym: string): Promise<StoredEntry[]> {
  const { results } = await env.DB.prepare(
    `SELECT ym, kind, name, amount, date, comment, position
       FROM entries
      WHERE ym = ?
      ORDER BY position DESC, id DESC`,
  )
    .bind(ym)
    .all<StoredEntry>();

  return results;
}

async function countEntries(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM entries").first<{
    count: number;
  }>();

  return row!.count;
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

describe("POST /api/month/:ym/entry", () => {
  it("creates an expense at the top of the sheet, converting k input to VND", async () => {
    const today = todayIso();
    const ym = today.slice(0, 7);

    const response = await createEntry(ym, {
      kind: "expense",
      name: "Groceries",
      amount: 500,
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: number };
    expect(created).toEqual({ id: expect.any(Number) });

    // The date defaults to today; compute it the same way the server does so
    // the test does not break near midnight UTC.
    await expect(storedEntries(ym)).resolves.toEqual([
      {
        ym,
        kind: "expense",
        name: "Groceries",
        amount: 500_000,
        date: today,
        comment: "",
        position: 1,
      },
    ]);

    // The month materialized as the first write, and the read path exposes it.
    const view = await getMonth(env, ym);
    expect(view.materialized).toBe(true);
    expect(view.entries).toEqual([
      {
        id: created.id,
        kind: "expense",
        name: "Groceries",
        amount: 500_000,
        date: today,
        comment: "",
        position: 1,
      },
    ]);
  });

  it("stacks new entries above earlier ones and snapshots fixed rows once", async () => {
    const salary = (await (await createTemplate({
      kind: "fixed_income",
      name: "Salary",
      amount: 500,
    })).json()) as Template;

    await createEntry("2026-11", {
      kind: "expense",
      name: "Groceries",
      amount: 170,
      date: "2026-11-02",
    });
    await createEntry("2026-11", {
      kind: "income",
      name: "Freelance",
      amount: 800,
      date: "2026-11-03",
    });

    // Positions run across kinds, one sequence per month.
    const rows = await storedEntries("2026-11");
    expect(rows.map((row) => row.position)).toEqual([2, 1]);
    expect(rows.map((row) => row.kind)).toEqual(["income", "expense"]);

    const view = await getMonth(env, "2026-11");
    expect(view.materialized).toBe(true);
    expect(view.fixed).toEqual([
      {
        id: expect.any(Number),
        kind: "fixed_income",
        name: "Salary",
        amount: 500_000,
        comment: "",
        position: 1,
      },
    ]);

    // The month holds a snapshot: editing the template later cannot rewrite it.
    await authedFetch(`/api/templates/${salary.id}`, {
      method: "PATCH",
      body: JSON.stringify({ amount: 900 }),
    });

    expect((await getMonth(env, "2026-11")).fixed[0].amount).toBe(500_000);
  });

  it("rejects a date outside the month, including impossible days", async () => {
    for (const [ym, date] of [
      ["2026-11", "2026-10-28"],
      ["2026-11", "2026-12-01"],
      ["2026-02", "2026-02-31"],
    ]) {
      const response = await createEntry(ym, {
        kind: "expense",
        name: "Groceries",
        amount: 170,
        date,
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "date_out_of_month" });
    }

    await expect(countEntries()).resolves.toBe(0);
  });

  it("rejects an omitted date when today is not inside the target month", async () => {
    // A fixed far-future month keeps this independent of when the suite runs.
    const response = await createEntry("2099-12", {
      kind: "expense",
      name: "Groceries",
      amount: 170,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "date_out_of_month" });
    await expect(countEntries()).resolves.toBe(0);
  });

  it("rejects amounts that are not positive whole thousands", async () => {
    for (const amount of [12.5, 0, -1, 1e9, "500", null, undefined]) {
      const response = await createEntry("2026-11", {
        kind: "expense",
        name: "Groceries",
        amount,
        date: "2026-11-02",
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_amount" });
    }

    await expect(countEntries()).resolves.toBe(0);
  });

  it("creates a note with a NULL amount, ignoring any amount sent", async () => {
    const withoutAmount = await createEntry("2026-11", {
      kind: "note",
      name: "Remember",
      date: "2026-11-02",
    });
    const withAmount = await createEntry("2026-11", {
      kind: "note",
      name: "Also remember",
      amount: 999,
      date: "2026-11-03",
    });

    expect(withoutAmount.status).toBe(201);
    expect(withAmount.status).toBe(201);

    const rows = await storedEntries("2026-11");
    expect(rows.map((row) => row.amount)).toEqual([null, null]);
  });

  it("creates income from k input", async () => {
    const response = await createEntry("2026-11", {
      kind: "income",
      name: "Freelance",
      amount: 800,
      date: "2026-11-02",
    });

    expect(response.status).toBe(201);
    await expect(storedEntries("2026-11")).resolves.toEqual([
      {
        ym: "2026-11",
        kind: "income",
        name: "Freelance",
        amount: 800_000,
        date: "2026-11-02",
        comment: "",
        position: 1,
      },
    ]);
  });

  it("rejects an unknown kind", async () => {
    for (const kind of ["fixed_income", "fixed", "", null, undefined]) {
      const response = await createEntry("2026-11", {
        kind,
        name: "Groceries",
        amount: 170,
        date: "2026-11-02",
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_kind" });
    }

    await expect(countEntries()).resolves.toBe(0);
  });

  it("rejects a malformed ym in the path", async () => {
    for (const ym of ["2026-13", "2026-1", "202611", "hello"]) {
      const response = await createEntry(ym, {
        kind: "expense",
        name: "Groceries",
        amount: 170,
        date: "2026-11-02",
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_ym" });
    }
  });

  it("rejects an empty name and a non-string comment", async () => {
    const blankName = await createEntry("2026-11", {
      kind: "expense",
      name: "   ",
      amount: 170,
      date: "2026-11-02",
    });
    expect(blankName.status).toBe(400);
    await expect(blankName.json()).resolves.toEqual({ error: "invalid_name" });

    const badComment = await createEntry("2026-11", {
      kind: "expense",
      name: "Groceries",
      amount: 170,
      date: "2026-11-02",
      comment: 42,
    });
    expect(badComment.status).toBe(400);
    await expect(badComment.json()).resolves.toEqual({ error: "invalid_comment" });
  });

  it("requires auth", async () => {
    const response = await SELF.fetch("https://example.com/api/month/2026-11/entry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "expense", name: "Groceries", amount: 170 }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });
});
