import { SELF, env } from "cloudflare:test";
import { AUTH_COOKIE, signToken } from "../src/auth";
import { getMonth, materializeMonth } from "../src/month";
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

function createTemplate(body: unknown): Promise<Response> {
  return authedFetch("/api/templates", { method: "POST", body: JSON.stringify(body) });
}

function putInitial(value: number): Promise<Response> {
  return authedFetch("/api/settings/initial", { method: "PUT", body: JSON.stringify({ value }) });
}

function getMonthRoute(ym: string): Promise<Response> {
  return authedFetch(`/api/month/${ym}`);
}

async function countRows(table: "months" | "fixed_rows"): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
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

describe("GET /api/month/:ym", () => {
  it("returns virtual fixed rows from live templates without materializing the month", async () => {
    const created = (await (await createTemplate({
      kind: "fixed_income",
      name: "Salary",
      amount: 500,
    })).json()) as Template;

    const response = await getMonthRoute("2026-11");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ym: "2026-11",
      materialized: false,
      initial: 0,
      fixed: [
        {
          id: -created.id,
          kind: "fixed_income",
          name: "Salary",
          amount: 500_000,
          comment: "",
          position: 1,
        },
      ],
      entries: [],
      summary: { income: 500_000, expense: 0, ending: 500_000 },
    });

    // A read is not a write: neither the month nor its snapshot exists.
    await expect(countRows("months")).resolves.toBe(0);
    await expect(countRows("fixed_rows")).resolves.toBe(0);
  });

  it("requires auth", async () => {
    const response = await SELF.fetch("https://example.com/api/month/2026-11");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("rejects a malformed ym with 400", async () => {
    for (const ym of ["2026-13", "2026-1", "202611", "hello"]) {
      const response = await getMonthRoute(ym);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_ym" });
    }
  });
});

describe("materializeMonth", () => {
  it("copies live templates into fixed_rows once, then becomes a no-op", async () => {
    const salary = (await (await createTemplate({
      kind: "fixed_income",
      name: "Salary",
      amount: 500,
      comment: "monthly",
    })).json()) as Template;
    const rent = (await (await createTemplate({
      kind: "fixed_expense",
      name: "Rent",
      amount: 300,
    })).json()) as Template;

    await materializeMonth(env, "2026-11");

    const { results } = await env.DB.prepare(
      `SELECT ym, kind, template_id, name, amount, comment, position, deleted
         FROM fixed_rows
        WHERE ym = ?
        ORDER BY template_id`,
    )
      .bind("2026-11")
      .all();

    expect(results).toEqual([
      {
        ym: "2026-11",
        kind: "fixed_income",
        template_id: salary.id,
        name: "Salary",
        amount: 500_000,
        comment: "monthly",
        position: 1,
        deleted: 0,
      },
      {
        ym: "2026-11",
        kind: "fixed_expense",
        template_id: rent.id,
        name: "Rent",
        amount: 300_000,
        comment: "",
        position: 1,
        deleted: 0,
      },
    ]);

    // The month records that it materialized.
    await expect(
      env.DB.prepare("SELECT ym, materialized_at FROM months WHERE ym = ?")
        .bind("2026-11")
        .first(),
    ).resolves.toEqual({ ym: "2026-11", materialized_at: expect.any(String) });

    // A second call must not copy the templates again.
    await materializeMonth(env, "2026-11");

    await expect(countRows("fixed_rows")).resolves.toBe(2);
  });

  it("materialized reads use the snapshot, not the live templates", async () => {
    const salary = (await (await createTemplate({
      kind: "fixed_income",
      name: "Salary",
      amount: 500,
    })).json()) as Template;
    await materializeMonth(env, "2026-11");

    // Changing the template afterwards leaves the month's snapshot untouched.
    await authedFetch(`/api/templates/${salary.id}`, {
      method: "PATCH",
      body: JSON.stringify({ amount: 900 }),
    });

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
    expect(view.summary).toEqual({ income: 500_000, expense: 0, ending: 500_000 });
  });
});

describe("month view balance", () => {
  it("includes the initial balance from settings", async () => {
    await putInitial(20_000_000);
    await createTemplate({ kind: "fixed_income", name: "Salary", amount: 500 });

    const view = await getMonth(env, "2026-11");

    expect(view.initial).toBe(20_000_000);
    expect(view.summary).toEqual({ income: 500_000, expense: 0, ending: 20_500_000 });
  });

  it("is all zeros on an empty month, ending at the initial balance", async () => {
    await putInitial(12_345_000);

    const view = await getMonth(env, "2026-11");

    expect(view.entries).toEqual([]);
    expect(view.summary).toEqual({ income: 0, expense: 0, ending: 12_345_000 });
  });

  it("sums fixed rows and entries, never notes", async () => {
    await putInitial(20_000_000);
    await env.DB.prepare("INSERT INTO months (ym, materialized_at) VALUES (?, ?)")
      .bind("2026-11", "2026-11-02T00:00:00.000Z")
      .run();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO fixed_rows (ym, kind, name, amount, position)
         VALUES ('2026-11', 'fixed_income', 'Salary', 500000, 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO fixed_rows (ym, kind, name, amount, position)
         VALUES ('2026-11', 'fixed_expense', 'Rent', 670000, 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO entries (ym, kind, name, amount, date, position)
         VALUES ('2026-11', 'income', 'Freelance', 800000, '2026-11-02', 2)`,
      ),
      env.DB.prepare(
        `INSERT INTO entries (ym, kind, name, amount, date, position)
         VALUES ('2026-11', 'expense', 'Groceries', 170000, '2026-11-02', 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO entries (ym, kind, name, amount, date, position)
         VALUES ('2026-11', 'note', 'Remember', 999, '2026-11-02', 3)`,
      ),
    ]);

    const view = await getMonth(env, "2026-11");

    // 500,000 + 800,000 income; 670,000 + 170,000 expense; the note is ignored.
    expect(view.summary).toEqual({
      income: 1_300_000,
      expense: 840_000,
      ending: 20_460_000,
    });
  });
});
