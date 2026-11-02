import { SELF, env } from "cloudflare:test";
import { AUTH_COOKIE, signToken } from "../src/auth";

// vitest.config.ts injects this as the PASSCODE binding; tests sign their own
// cookie instead of going through the passcode route.
const TEST_PASSCODE = "test-secret";
const YM = "2026-11";

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", `${AUTH_COOKIE}=${await signToken("owner", TEST_PASSCODE)}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");

  return SELF.fetch(`https://example.com${path}`, { ...init, headers });
}

function putInitial(value: number): Promise<Response> {
  return authedFetch("/api/settings/initial", { method: "PUT", body: JSON.stringify({ value }) });
}

function createTemplate(body: unknown): Promise<Response> {
  return authedFetch("/api/templates", { method: "POST", body: JSON.stringify(body) });
}

function createEntry(ym: string, body: unknown): Promise<Response> {
  return authedFetch(`/api/month/${ym}/entry`, { method: "POST", body: JSON.stringify(body) });
}

function getSummary(ym: string): Promise<Response> {
  return authedFetch(`/api/summary/${ym}`);
}

function getExport(ym: string): Promise<Response> {
  return authedFetch(`/api/month/${ym}/export`);
}

/**
 * A minimal RFC 4180 parser: quoted fields may hold commas, doubled quotes and
 * line breaks, and records end in CRLF. Tests parse rather than compare raw
 * strings so escaping is checked by round-trip.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * The pinned month from the plan: initial 20,000,000; fixed income 500,000 and
 * fixed expense 670,000 snapshotted from templates; income entry 800,000;
 * expense entry 170,000; and a note carrying an amount that must never count
 * or appear in the export.
 */
async function seedPinnedMonth(): Promise<void> {
  await putInitial(20_000_000);
  await createTemplate({ kind: "fixed_income", name: "Salary", amount: 500 });
  await createTemplate({ kind: "fixed_expense", name: "Rent", amount: 670 });

  // The first entry write materializes the month and snapshots both templates.
  await createEntry(YM, { kind: "income", name: "Freelance", amount: 800, date: "2026-11-02" });
  await createEntry(YM, { kind: "expense", name: "Groceries", amount: 170, date: "2026-11-02" });

  // Stored with a non-null amount so the sum exclusion is really exercised.
  await env.DB.prepare(
    `INSERT INTO entries (ym, kind, name, amount, date, position)
     VALUES (?, 'note', 'Remember', 999000, ?, 3)`,
  )
    .bind(YM, "2026-11-02")
    .run();
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

describe("GET /api/summary/:ym", () => {
  it("returns the pinned totals and ignores notes", async () => {
    await seedPinnedMonth();

    const response = await getSummary(YM);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      initial: 20_000_000,
      income: 1_300_000,
      expense: 840_000,
      ending: 20_460_000,
    });
  });

  it("summarizes an unmaterialized month from its virtual template rows", async () => {
    await createTemplate({ kind: "fixed_income", name: "Salary", amount: 500 });

    const response = await getSummary(YM);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      initial: 0,
      income: 500_000,
      expense: 0,
      ending: 500_000,
    });
  });

  it("requires auth", async () => {
    const response = await SELF.fetch(`https://example.com/api/summary/${YM}`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("rejects a malformed month", async () => {
    for (const ym of ["2026-13", "2026-1", "202611", "hello"]) {
      const response = await getSummary(ym);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_ym" });
    }
  });
});

describe("GET /api/month/:ym/export", () => {
  it("exports fixed rows and entries as CSV with the pinned amounts", async () => {
    await seedPinnedMonth();

    const response = await getExport(YM);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="expenser-2026-11.csv"',
    );

    const rows = parseCsv(await response.text());

    // Header plus the two fixed rows and three entries; nothing extra.
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual(["name", "amount", "date", "kind", "comment"]);
    expect(rows.every((row) => row.length === 5)).toBe(true);

    const byName = new Map(rows.slice(1).map((row) => [row[0], row]));
    expect(byName.get("Salary")).toEqual(["Salary", "500,000 ₫", "", "fixed_income", ""]);
    expect(byName.get("Rent")).toEqual(["Rent", "670,000 ₫", "", "fixed_expense", ""]);
    expect(byName.get("Freelance")).toEqual([
      "Freelance",
      "800,000 ₫",
      "2026-11-02",
      "income",
      "",
    ]);
    expect(byName.get("Groceries")).toEqual([
      "Groceries",
      "170,000 ₫",
      "2026-11-02",
      "expense",
      "",
    ]);

    // The note row stays visible, with no amount and no trace of its stored value.
    expect(byName.get("Remember")).toEqual([
      "Remember",
      "",
      "2026-11-02",
      "note",
      "",
    ]);
    expect(byName.get("Remember")![1]).toBe("");
    expect(rows.flat().join(",")).not.toContain("999,000");
  });

  it("escapes commas, quotes and newlines per RFC 4180", async () => {
    const name = 'Lunch, "special"';
    const comment = 'line one\nline two, "quoted"';
    await createEntry(YM, {
      kind: "expense",
      name,
      amount: 50,
      date: "2026-11-02",
      comment,
    });

    const response = await getExport(YM);
    const rows = parseCsv(await response.text());

    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual([name, "50,000 ₫", "2026-11-02", "expense", comment]);
  });

  it("requires auth", async () => {
    const response = await SELF.fetch(`https://example.com/api/month/${YM}/export`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("rejects a malformed month", async () => {
    for (const ym of ["2026-13", "2026-1", "202611", "hello"]) {
      const response = await getExport(ym);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_ym" });
    }
  });
});
