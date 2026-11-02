import { SELF, env } from "cloudflare:test";
import { AUTH_COOKIE, signToken } from "../src/auth";
import { listTemplates, type Template } from "../src/templates";

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

function patchTemplate(id: number, body: unknown): Promise<Response> {
  return authedFetch(`/api/templates/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

function deleteTemplate(id: number): Promise<Response> {
  return authedFetch(`/api/templates/${id}`, { method: "DELETE" });
}

function listRoute(): Promise<Response> {
  return authedFetch("/api/templates");
}

beforeEach(async () => {
  // Storage is not isolated per test, so each test starts from an empty table.
  await env.DB.prepare("DELETE FROM templates").run();
});

describe("POST /api/templates", () => {
  it("creates a fixed income template, converting k input to VND", async () => {
    const response = await createTemplate({
      kind: "fixed_income",
      name: "Salary",
      amount: 500,
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: expect.any(Number),
      kind: "fixed_income",
      name: "Salary",
      amount: 500_000,
      comment: "",
      position: 1,
    });

    await expect(listTemplates(env)).resolves.toEqual([
      {
        id: expect.any(Number),
        kind: "fixed_income",
        name: "Salary",
        amount: 500_000,
        comment: "",
        position: 1,
      },
    ]);
  });

  it("gives each kind its own 1..n position sequence", async () => {
    await createTemplate({ kind: "fixed_income", name: "Salary", amount: 500 });
    await createTemplate({ kind: "fixed_income", name: "Side gig", amount: 80 });
    await createTemplate({ kind: "fixed_expense", name: "Rent", amount: 300 });

    const rows = await listTemplates(env);
    expect(rows.filter((row) => row.kind === "fixed_income").map((row) => row.position)).toEqual([
      1, 2,
    ]);
    expect(rows.filter((row) => row.kind === "fixed_expense").map((row) => row.position)).toEqual([
      1,
    ]);
  });

  it("rejects amounts that are not positive whole thousands", async () => {
    for (const amount of [0, -1, 1.5, 1e9, "500", null, undefined]) {
      const response = await createTemplate({ kind: "fixed_income", name: "Salary", amount });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_amount" });
    }

    await expect(listTemplates(env)).resolves.toEqual([]);
  });

  it("rejects an unknown kind", async () => {
    for (const kind of ["income", "fixed", "", null, undefined]) {
      const response = await createTemplate({ kind, name: "Salary", amount: 500 });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_kind" });
    }
  });

  it("rejects an empty name", async () => {
    for (const name of ["", "   ", 42, null, undefined]) {
      const response = await createTemplate({ kind: "fixed_income", name, amount: 500 });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_name" });
    }
  });

  it("rejects a non-string comment", async () => {
    const response = await createTemplate({
      kind: "fixed_income",
      name: "Salary",
      amount: 500,
      comment: 42,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_comment" });
  });
});

describe("GET /api/templates", () => {
  it("returns live templates with stored amounts and positions", async () => {
    await createTemplate({ kind: "fixed_income", name: "Salary", amount: 500 });
    await createTemplate({
      kind: "fixed_income",
      name: "Rent share",
      amount: 120,
      comment: "from roommate",
    });

    const response = await listRoute();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      {
        id: expect.any(Number),
        kind: "fixed_income",
        name: "Salary",
        amount: 500_000,
        comment: "",
        position: 1,
      },
      {
        id: expect.any(Number),
        kind: "fixed_income",
        name: "Rent share",
        amount: 120_000,
        comment: "from roommate",
        position: 2,
      },
    ]);
  });
});

describe("PATCH /api/templates/:id", () => {
  it("updates the amount from full VND input and returns the stored row", async () => {
    const created = (await (await createTemplate({
      kind: "fixed_income",
      name: "Salary",
      amount: 500,
    })).json()) as Template;

    const response = await patchTemplate(created.id, { amount: 170_000 });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ...created, amount: 170_000 });
    await expect(listTemplates(env)).resolves.toEqual([{ ...created, amount: 170_000 }]);
  });

  it("updates name and comment without touching the amount", async () => {
    const created = (await (await createTemplate({
      kind: "fixed_expense",
      name: "Rent",
      amount: 300,
    })).json()) as Template;

    const response = await patchTemplate(created.id, { name: "  Rent (new)  ", comment: "lease" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ...created,
      name: "Rent (new)",
      comment: "lease",
    });
  });

  it("rejects an invalid amount", async () => {
    const created = (await (await createTemplate({
      kind: "fixed_income",
      name: "Salary",
      amount: 500,
    })).json()) as Template;

    for (const amount of [0, -1, 1.5, 1e16, "170", null]) {
      const response = await patchTemplate(created.id, { amount });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_amount" });
    }

    await expect(listTemplates(env)).resolves.toEqual([created]);
  });

  it("returns 404 for an unknown template", async () => {
    const response = await patchTemplate(999_999, { amount: 170_000 });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });
});

describe("DELETE /api/templates/:id", () => {
  it("soft deletes: hides the template but keeps the row for history", async () => {
    const created = (await (await createTemplate({
      kind: "fixed_income",
      name: "Salary",
      amount: 500,
    })).json()) as Template;

    const response = await deleteTemplate(created.id);

    expect(response.status).toBe(204);
    await expect(listTemplates(env)).resolves.toEqual([]);
    await expect(
      env.DB.prepare("SELECT deleted FROM templates WHERE id = ?")
        .bind(created.id)
        .first(),
    ).resolves.toEqual({ deleted: 1 });
  });

  it("returns 404 for an unknown or already-deleted template", async () => {
    const created = (await (await createTemplate({
      kind: "fixed_income",
      name: "Salary",
      amount: 500,
    })).json()) as Template;
    await deleteTemplate(created.id);

    for (const id of [created.id, 999_999]) {
      const response = await deleteTemplate(id);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "not_found" });
    }
  });
});

describe("template route auth", () => {
  it("requires auth on every template route", async () => {
    const routes: Array<[string, string]> = [
      ["GET", "/api/templates"],
      ["POST", "/api/templates"],
      ["PATCH", "/api/templates/1"],
      ["DELETE", "/api/templates/1"],
    ];

    for (const [method, path] of routes) {
      const response = await SELF.fetch(`https://example.com${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "GET" ? undefined : "{}",
      });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    }
  });
});
