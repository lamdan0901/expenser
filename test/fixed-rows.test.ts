import { SELF, env } from "cloudflare:test";
import { AUTH_COOKIE, signToken } from "../src/auth";
import { getMonth, materializeMonth } from "../src/month";
import { currentYm } from "../src/month-utils";
import { listTemplates } from "../src/templates";

// vitest.config.ts injects this as the PASSCODE binding; tests sign their own
// cookie instead of going through the passcode route.
const TEST_PASSCODE = "test-secret";

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", `${AUTH_COOKIE}=${await signToken("owner", TEST_PASSCODE)}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");

  return SELF.fetch(`https://example.com${path}`, { ...init, headers });
}

function createTemplateRoute(body: unknown): Promise<Response> {
  return authedFetch("/api/templates", { method: "POST", body: JSON.stringify(body) });
}

function createFixed(ym: string, body: unknown): Promise<Response> {
  return authedFetch(`/api/fixed/${ym}`, { method: "POST", body: JSON.stringify(body) });
}

function patchFixed(ym: string, id: number, body: unknown): Promise<Response> {
  return authedFetch(`/api/fixed/${ym}/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

function deleteFixed(ym: string, id: number): Promise<Response> {
  return authedFetch(`/api/fixed/${ym}/${id}`, { method: "DELETE" });
}

function reorderFixed(ym: string, body: unknown): Promise<Response> {
  return authedFetch(`/api/fixed/${ym}/reorder`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** The month `delta` steps away from `ym`; the tests never read the wall clock twice. */
function shiftMonth(ym: string, delta: number): string {
  const [year, month] = ym.split("-").map(Number);
  return currentYm(new Date(Date.UTC(year, month - 1 + delta, 1)));
}

const CURRENT = currentYm(new Date());
const PAST = shiftMonth(CURRENT, -1);

interface StoredFixedRow {
  id: number;
  ym: string;
  kind: string;
  template_id: number | null;
  name: string;
  amount: number;
  comment: string;
  position: number;
  deleted: number;
}

async function storedFixedRows(ym: string): Promise<StoredFixedRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, ym, kind, template_id, name, amount, comment, position, deleted
       FROM fixed_rows
      WHERE ym = ?
      ORDER BY kind, position, id`,
  )
    .bind(ym)
    .all<StoredFixedRow>();

  return results;
}

interface StoredTemplate {
  id: number;
  name: string;
  amount: number;
  deleted: number;
}

async function storedTemplates(): Promise<StoredTemplate[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, name, amount, deleted FROM templates ORDER BY id",
  ).all<StoredTemplate>();

  return results;
}

/** A live template plus a snapshot in the given month, ready for fixed-row writes. */
async function materializedMonth(
  amount = 500,
  name = "Salary",
): Promise<{ templateId: number; rowId: number }> {
  await createTemplateRoute({ kind: "fixed_income", name, amount });
  await materializeMonth(env, PAST);
  await materializeMonth(env, CURRENT);

  const [template] = await storedTemplates();
  const [row] = await storedFixedRows(PAST);

  return { templateId: template.id, rowId: row.id };
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

describe("PATCH /api/fixed/:ym/:id", () => {
  it("changes only a past month's snapshot, leaving the template and current month alone", async () => {
    const { templateId, rowId } = await materializedMonth();

    const response = await patchFixed(PAST, rowId, { name: "Raise", amount: 900_000 });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: rowId,
      kind: "fixed_income",
      name: "Raise",
      amount: 900_000,
      comment: "",
      position: 1,
    });

    // The past month's own snapshot changed.
    const pastRows = await storedFixedRows(PAST);
    expect(pastRows).toEqual([
      {
        id: rowId,
        ym: PAST,
        kind: "fixed_income",
        template_id: templateId,
        name: "Raise",
        amount: 900_000,
        comment: "",
        position: 1,
        deleted: 0,
      },
    ]);

    // The template and the current month's snapshot still hold the old value.
    await expect(storedTemplates()).resolves.toEqual([
      { id: templateId, name: "Salary", amount: 500_000, deleted: 0 },
    ]);
    expect((await storedFixedRows(CURRENT))[0].amount).toBe(500_000);
  });

  it("updates the template and the current month's snapshot together", async () => {
    const { templateId } = await materializedMonth();
    const [currentRow] = await storedFixedRows(CURRENT);

    const response = await patchFixed(CURRENT, currentRow.id, { amount: 900_000 });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: currentRow.id,
      kind: "fixed_income",
      name: "Salary",
      amount: 900_000,
      comment: "",
      position: 1,
    });

    await expect(storedTemplates()).resolves.toEqual([
      { id: templateId, name: "Salary", amount: 900_000, deleted: 0 },
    ]);
    expect((await storedFixedRows(CURRENT))[0].amount).toBe(900_000);
  });

  it("updates the template for a future month too", async () => {
    const { templateId } = await materializedMonth();
    const future = shiftMonth(CURRENT, 1);
    await createFixed(future, { kind: "fixed_income", name: "Bonus", amount: 100 });

    const [bonusRow] = (await storedFixedRows(future)).filter((row) => row.name === "Bonus");
    await patchFixed(future, bonusRow.id, { amount: 200_000 });

    const bonusTemplate = (await storedTemplates()).find((row) => row.name === "Bonus");
    expect(bonusTemplate).toEqual({
      id: expect.any(Number),
      name: "Bonus",
      amount: 200_000,
      deleted: 0,
    });
    expect(bonusTemplate!.id).not.toBe(templateId);
    expect((await storedFixedRows(future)).find((row) => row.name === "Bonus")!.amount).toBe(
      200_000,
    );
  });

  it("does not touch a past month's row through a mismatched ym", async () => {
    const { rowId } = await materializedMonth();

    const response = await patchFixed(CURRENT, rowId, { amount: 900_000 });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
    expect((await storedFixedRows(PAST))[0].amount).toBe(500_000);
    expect((await storedFixedRows(CURRENT))[0].amount).toBe(500_000);
  });

  it("rejects an unknown row and a kind change", async () => {
    const { rowId } = await materializedMonth();

    const missing = await patchFixed(PAST, 999, { amount: 900_000 });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "not_found" });

    const kindChange = await patchFixed(PAST, rowId, { kind: "fixed_expense" });
    expect(kindChange.status).toBe(400);
    await expect(kindChange.json()).resolves.toEqual({ error: "invalid_kind" });
  });

  it("validates fields and the month", async () => {
    const { rowId } = await materializedMonth();

    const badAmount = await patchFixed(PAST, rowId, { amount: 0 });
    expect(badAmount.status).toBe(400);
    await expect(badAmount.json()).resolves.toEqual({ error: "invalid_amount" });

    const blankName = await patchFixed(PAST, rowId, { name: "   " });
    expect(blankName.status).toBe(400);
    await expect(blankName.json()).resolves.toEqual({ error: "invalid_name" });

    const badComment = await patchFixed(PAST, rowId, { comment: 42 });
    expect(badComment.status).toBe(400);
    await expect(badComment.json()).resolves.toEqual({ error: "invalid_comment" });

    const badYm = await patchFixed("2026-13", rowId, { amount: 900_000 });
    expect(badYm.status).toBe(400);
    await expect(badYm.json()).resolves.toEqual({ error: "invalid_ym" });
  });
});

describe("DELETE /api/fixed/:ym/:id", () => {
  it("soft-deletes a past month's row and keeps the template", async () => {
    const { templateId, rowId } = await materializedMonth();

    const response = await deleteFixed(PAST, rowId);

    expect(response.status).toBe(204);
    expect((await storedFixedRows(PAST))[0].deleted).toBe(1);
    await expect(storedTemplates()).resolves.toEqual([
      { id: templateId, name: "Salary", amount: 500_000, deleted: 0 },
    ]);
    expect((await storedFixedRows(CURRENT))[0].deleted).toBe(0);
  });

  it("soft-deletes a current month's row and its template, keeping past snapshots", async () => {
    const { templateId } = await materializedMonth();
    const [currentRow] = await storedFixedRows(CURRENT);

    const response = await deleteFixed(CURRENT, currentRow.id);

    expect(response.status).toBe(204);
    expect((await storedFixedRows(CURRENT))[0].deleted).toBe(1);
    await expect(storedTemplates()).resolves.toEqual([
      { id: templateId, name: "Salary", amount: 500_000, deleted: 1 },
    ]);
    await expect(listTemplates(env)).resolves.toEqual([]);
    expect((await storedFixedRows(PAST))[0].deleted).toBe(0);
  });

  it("rejects an unknown row and a mismatched month", async () => {
    const { rowId } = await materializedMonth();

    const missing = await deleteFixed(PAST, 999);
    expect(missing.status).toBe(404);

    const wrongMonth = await deleteFixed(CURRENT, rowId);
    expect(wrongMonth.status).toBe(404);
    expect((await storedFixedRows(PAST))[0].deleted).toBe(0);
  });

  it("rejects a malformed month", async () => {
    const response = await deleteFixed("hello", 1);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_ym" });
  });
});

describe("POST /api/fixed/:ym", () => {
  it("creates a month-local row in a past month without a template", async () => {
    const response = await createFixed(PAST, {
      kind: "fixed_expense",
      name: "Repair",
      amount: 120,
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: number };
    expect(created).toEqual({
      id: expect.any(Number),
      kind: "fixed_expense",
      name: "Repair",
      amount: 120_000,
      comment: "",
      position: 1,
    });

    // The first fixed-row write materializes the month.
    expect((await getMonth(env, PAST)).materialized).toBe(true);
    await expect(storedFixedRows(PAST)).resolves.toEqual([
      {
        id: created.id,
        ym: PAST,
        kind: "fixed_expense",
        template_id: null,
        name: "Repair",
        amount: 120_000,
        comment: "",
        position: 1,
        deleted: 0,
      },
    ]);
    await expect(storedTemplates()).resolves.toEqual([]);
  });

  it("creates a template and a linked snapshot in the current month", async () => {
    const response = await createFixed(CURRENT, {
      kind: "fixed_income",
      name: "Freelance",
      amount: 300,
      comment: "weekly",
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: number };

    await expect(listTemplates(env)).resolves.toEqual([
      {
        id: expect.any(Number),
        kind: "fixed_income",
        name: "Freelance",
        amount: 300_000,
        comment: "weekly",
        position: 1,
      },
    ]);

    const [template] = await storedTemplates();
    await expect(storedFixedRows(CURRENT)).resolves.toEqual([
      {
        id: created.id,
        ym: CURRENT,
        kind: "fixed_income",
        template_id: template.id,
        name: "Freelance",
        amount: 300_000,
        comment: "weekly",
        position: 1,
        deleted: 0,
      },
    ]);
    // The month materialized on the first write and reads back the new row.
    expect((await getMonth(env, CURRENT)).fixed).toEqual([
      {
        id: created.id,
        kind: "fixed_income",
        name: "Freelance",
        amount: 300_000,
        comment: "weekly",
        position: 1,
      },
    ]);
  });

  it("keeps a month's existing snapshot when the new row links a template", async () => {
    await createTemplateRoute({ kind: "fixed_expense", name: "Rent", amount: 300 });

    const response = await createFixed(CURRENT, {
      kind: "fixed_income",
      name: "Salary",
      amount: 500,
    });

    expect(response.status).toBe(201);
    const rows = await storedFixedRows(CURRENT);
    expect(rows.map((row) => [row.kind, row.name, row.position])).toEqual([
      ["fixed_expense", "Rent", 1],
      ["fixed_income", "Salary", 1],
    ]);
    expect(rows.every((row) => row.template_id !== null)).toBe(true);
  });

  it("accepts a future month as a template month", async () => {
    const future = shiftMonth(CURRENT, 1);

    const response = await createFixed(future, {
      kind: "fixed_expense",
      name: "Insurance",
      amount: 90,
    });

    expect(response.status).toBe(201);
    const [template] = await storedTemplates();
    const [row] = await storedFixedRows(future);
    expect(row.template_id).toBe(template.id);
    expect(template.amount).toBe(90_000);
  });

  it("validates the body and the month", async () => {
    const cases: [unknown, string][] = [
      [{ kind: "income", name: "Rent", amount: 300 }, "invalid_kind"],
      [{ kind: "fixed_expense", name: "  ", amount: 300 }, "invalid_name"],
      [{ kind: "fixed_expense", name: "Rent", amount: 0 }, "invalid_amount"],
      [{ kind: "fixed_expense", name: "Rent", amount: "300" }, "invalid_amount"],
      [{ kind: "fixed_expense", name: "Rent", amount: 300, comment: 42 }, "invalid_comment"],
    ];

    for (const [body, error] of cases) {
      const response = await createFixed(PAST, body);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error });
    }

    const badYm = await createFixed("202611", {
      kind: "fixed_expense",
      name: "Rent",
      amount: 300,
    });
    expect(badYm.status).toBe(400);
    await expect(badYm.json()).resolves.toEqual({ error: "invalid_ym" });

    await expect(storedFixedRows(PAST)).resolves.toEqual([]);
    await expect(storedTemplates()).resolves.toEqual([]);
  });

  it("requires auth", async () => {
    const response = await SELF.fetch(`https://example.com/api/fixed/${PAST}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "fixed_expense", name: "Rent", amount: 300 }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });
});

describe("POST /api/fixed/:ym/reorder", () => {
  it("writes index+1 positions in display order, so a drag sticks", async () => {
    await createFixed(CURRENT, { kind: "fixed_income", name: "Salary", amount: 500 });
    await createFixed(CURRENT, { kind: "fixed_income", name: "Bonus", amount: 100 });

    const before = (await storedFixedRows(CURRENT)).filter(
      (row) => row.kind === "fixed_income",
    );
    expect(before.map((row) => [row.name, row.position])).toEqual([
      ["Salary", 1],
      ["Bonus", 2],
    ]);

    // The frontend sends the section's ids top-down; positions are ascending,
    // so index+1 keeps the dropped DOM order.
    const response = await reorderFixed(CURRENT, {
      kind: "fixed_income",
      ids: [before[1].id, before[0].id],
    });
    expect(response.status).toBe(204);

    const after = (await storedFixedRows(CURRENT)).filter((row) => row.kind === "fixed_income");
    expect(after.map((row) => [row.name, row.position])).toEqual([
      ["Bonus", 1],
      ["Salary", 2],
    ]);
    await expect(getMonth(env, CURRENT)).resolves.toMatchObject({
      fixed: [
        { kind: "fixed_income", name: "Bonus", position: 1 },
        { kind: "fixed_income", name: "Salary", position: 2 },
      ],
    });
  });

  it("rejects malformed months, kinds and ids without touching positions", async () => {
    await createFixed(CURRENT, { kind: "fixed_income", name: "Salary", amount: 500 });
    await createFixed(CURRENT, { kind: "fixed_income", name: "Bonus", amount: 100 });

    const rows = (await storedFixedRows(CURRENT)).filter((row) => row.kind === "fixed_income");
    const ids = rows.map((row) => row.id);

    const badYm = await reorderFixed("2026-13", { kind: "fixed_income", ids });
    expect(badYm.status).toBe(400);
    await expect(badYm.json()).resolves.toEqual({ error: "invalid_ym" });

    for (const kind of ["income", "fixed_", "", null, undefined]) {
      const response = await reorderFixed(CURRENT, { kind, ids });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_kind" });
    }

    // Not an array, duplicates, a subset, a foreign id and a non-integer id.
    for (const badIds of [undefined, [ids[0], ids[0]], [ids[0]], [...ids, 9999], [ids[0], 1.5]]) {
      const response = await reorderFixed(CURRENT, { kind: "fixed_income", ids: badIds });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_ids" });
    }

    const after = (await storedFixedRows(CURRENT)).filter((row) => row.kind === "fixed_income");
    expect(after.map((row) => [row.name, row.position])).toEqual([
      ["Salary", 1],
      ["Bonus", 2],
    ]);
  });

  it("rejects ids from another kind or another month", async () => {
    await createFixed(CURRENT, { kind: "fixed_income", name: "Salary", amount: 500 });
    await createFixed(CURRENT, { kind: "fixed_expense", name: "Rent", amount: 300 });
    await createFixed(PAST, { kind: "fixed_income", name: "Old salary", amount: 400 });

    const current = await storedFixedRows(CURRENT);
    const income = current.find((row) => row.kind === "fixed_income")!;
    const expense = current.find((row) => row.kind === "fixed_expense")!;
    const old = (await storedFixedRows(PAST)).find((row) => row.kind === "fixed_income")!;

    for (const mixed of [
      [income.id, expense.id],
      [income.id, old.id],
    ]) {
      const response = await reorderFixed(CURRENT, { kind: "fixed_income", ids: mixed });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_ids" });
    }
  });

  it("requires auth", async () => {
    const response = await SELF.fetch(`https://example.com/api/fixed/${CURRENT}/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "fixed_income", ids: [] }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });
});
