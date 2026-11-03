import { SELF, env } from "cloudflare:test";
import { AUTH_COOKIE, signToken } from "../src/auth";

const TEST_PASSCODE = "test-secret";

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", `${AUTH_COOKIE}=${await signToken("owner", TEST_PASSCODE)}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");

  return SELF.fetch(`https://example.com${path}`, { ...init, headers });
}

function setInitialDebt(value: number): Promise<Response> {
  return authedFetch("/api/settings/initial-debt", {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
}

function createDebt(ym: string, body: unknown): Promise<Response> {
  return authedFetch(`/api/month/${ym}/debt`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function patchDebt(id: number, body: unknown): Promise<Response> {
  return authedFetch(`/api/debt/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

function deleteDebt(id: number): Promise<Response> {
  return authedFetch(`/api/debt/${id}`, {
    method: "DELETE",
  });
}

function reorderDebt(ym: string, ids: number[]): Promise<Response> {
  return authedFetch(`/api/month/${ym}/debt/reorder`, {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

function getMonth(ym: string): Promise<Response> {
  return authedFetch(`/api/month/${ym}`);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM debt_entries"),
    env.DB.prepare("DELETE FROM fixed_rows"),
    env.DB.prepare("DELETE FROM entries"),
    env.DB.prepare("DELETE FROM months"),
    env.DB.prepare("DELETE FROM templates"),
    env.DB.prepare("DELETE FROM settings"),
  ]);
});

describe("Debt API and Rollover", () => {
  it("initializes debt to 0 by default", async () => {
    const res = await getMonth("2026-11");
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.debt).toEqual({
      initial: 0,
      remaining: 0,
      entries: [],
    });
  });

  it("can set a base initial debt", async () => {
    const putRes = await setInitialDebt(20_000_000);
    expect(putRes.status).toBe(204);

    const res = await getMonth("2026-11");
    const json = (await res.json()) as any;
    expect(json.debt.initial).toBe(20_000_000);
    expect(json.debt.remaining).toBe(20_000_000);
  });

  it("creates debt entries and calculates remaining debt", async () => {
    await setInitialDebt(10_000_000);

    // Add more debt: +5,000,000 (amount in k: 5000)
    const addRes = await createDebt("2026-11", {
      direction: "add",
      name: "Emergency laptop",
      amount: 5000,
      date: "2026-11-05",
      comment: "Nam loan",
    });
    expect(addRes.status).toBe(201);
    const addJson = (await addRes.json()) as any;
    expect(addJson.amount).toBe(5_000_000);
    expect(addJson.direction).toBe("add");

    // Pay off debt: -3,000,000 (amount in k: 3000)
    const payRes = await createDebt("2026-11", {
      direction: "pay",
      name: "Bank installment",
      amount: 3000,
      date: "2026-11-10",
      comment: "Transfer",
    });
    expect(payRes.status).toBe(201);

    const monthRes = await getMonth("2026-11");
    const monthJson = (await monthRes.json()) as any;

    expect(monthJson.debt.initial).toBe(10_000_000);
    // Remaining = 10m + 5m - 3m = 12m
    expect(monthJson.debt.remaining).toBe(12_000_000);
    expect(monthJson.debt.entries).toHaveLength(2);
  });

  it("automatically rolls current remaining debt as next month's initial debt", async () => {
    await setInitialDebt(20_000_000);

    // November: add 2m, pay 5m -> remaining = 20m + 2m - 5m = 17m
    await createDebt("2026-11", {
      direction: "add",
      name: "More debt",
      amount: 2000,
      date: "2026-11-01",
    });
    await createDebt("2026-11", {
      direction: "pay",
      name: "Partial repayment",
      amount: 5000,
      date: "2026-11-15",
    });

    const novRes = await getMonth("2026-11");
    const novJson = (await novRes.json()) as any;
    expect(novJson.debt.initial).toBe(20_000_000);
    expect(novJson.debt.remaining).toBe(17_000_000);

    // December: starts with November's remaining debt (17m)
    const decRes = await getMonth("2026-12");
    const decJson = (await decRes.json()) as any;
    expect(decJson.debt.initial).toBe(17_000_000);
    expect(decJson.debt.remaining).toBe(17_000_000);

    // In December, pay another 7m -> remaining becomes 10m
    await createDebt("2026-12", {
      direction: "pay",
      name: "Big repayment",
      amount: 7000,
      date: "2026-12-10",
    });

    const decUpdatedRes = await getMonth("2026-12");
    const decUpdatedJson = (await decUpdatedRes.json()) as any;
    expect(decUpdatedJson.debt.initial).toBe(17_000_000);
    expect(decUpdatedJson.debt.remaining).toBe(10_000_000);

    // January 2027: starts with December's remaining debt (10m)
    const janRes = await getMonth("2027-01");
    const janJson = (await janRes.json()) as any;
    expect(janJson.debt.initial).toBe(10_000_000);
    expect(janJson.debt.remaining).toBe(10_000_000);
  });

  it("patches debt entry fields", async () => {
    const created = (await (
      await createDebt("2026-11", {
        direction: "add",
        name: "Test",
        amount: 1000,
        date: "2026-11-01",
      })
    ).json()) as any;

    // Toggle to pay and update amount
    const patchRes = await patchDebt(created.id, {
      direction: "pay",
      amount: 2_000_000,
      name: "Updated test",
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as any;
    expect(patched.direction).toBe("pay");
    expect(patched.amount).toBe(2_000_000);
    expect(patched.name).toBe("Updated test");
  });

  it("soft deletes a debt entry and updates remaining debt", async () => {
    await setInitialDebt(10_000_000);
    const created = (await (
      await createDebt("2026-11", {
        direction: "add",
        name: "To delete",
        amount: 5000,
        date: "2026-11-01",
      })
    ).json()) as any;

    let res = await getMonth("2026-11");
    expect(((await res.json()) as any).debt.remaining).toBe(15_000_000);

    const delRes = await deleteDebt(created.id);
    expect(delRes.status).toBe(204);

    res = await getMonth("2026-11");
    const json = (await res.json()) as any;
    expect(json.debt.remaining).toBe(10_000_000);
    expect(json.debt.entries).toHaveLength(0);
  });

  it("reorders debt entries", async () => {
    const e1 = (await (
      await createDebt("2026-11", { direction: "add", name: "First", amount: 1000 })
    ).json()) as any;
    const e2 = (await (
      await createDebt("2026-11", { direction: "pay", name: "Second", amount: 1000 })
    ).json()) as any;

    const reorderRes = await reorderDebt("2026-11", [e2.id, e1.id]);
    expect(reorderRes.status).toBe(204);

    const monthRes = await getMonth("2026-11");
    const entries = ((await monthRes.json()) as any).debt.entries;
    // position DESC: the one with higher position is first
    expect(entries[0].id).toBe(e1.id);
  });
});
