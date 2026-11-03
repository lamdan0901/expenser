import { SELF, env } from "cloudflare:test";
import { AUTH_COOKIE, signToken } from "../src/auth";
import { MAX_PASSCODE_FAILURES, openSettings } from "../src/setup";

// vitest.config.ts injects this as the PASSCODE binding.
const TEST_PASSCODE = "test-secret";
const WRONG_PASSCODE = "not-the-passcode";

let ipCounter = 0;

/**
 * Every test gets its own client IP: the passcode limiter's Map lives for the
 * whole test file, so sharing an IP would let one test lock out another.
 */
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function postPasscode(passcode: unknown, ip: string): Promise<Response> {
  return SELF.fetch("https://example.com/api/passcode", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ passcode }),
  });
}

/** Signs a cookie directly instead of going through the passcode route. */
async function signedCookie(): Promise<string> {
  return `${AUTH_COOKIE}=${await signToken("owner", TEST_PASSCODE)}`;
}

function getMe(cookie?: string): Promise<Response> {
  return SELF.fetch("https://example.com/api/me", {
    headers: cookie === undefined ? {} : { Cookie: cookie },
  });
}

function putInitial(value: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie !== undefined) headers.Cookie = cookie;

  return SELF.fetch("https://example.com/api/settings/initial", {
    method: "PUT",
    headers,
    body: JSON.stringify({ value }),
  });
}

function getCollapsed(cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.Cookie = cookie;
  return SELF.fetch("https://example.com/api/settings/collapsed", {
    headers,
  });
}

function putCollapsed(body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie !== undefined) headers.Cookie = cookie;
  return SELF.fetch("https://example.com/api/settings/collapsed", {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

/** `Set-Cookie` value without its attributes, ready to send back as a Cookie. */
function cookiePair(response: Response): string {
  const header = response.headers.get("Set-Cookie");
  expect(header).not.toBeNull();
  return header!.split(";")[0];
}

beforeEach(async () => {
  // Storage is not isolated per test, so each test starts from an empty table.
  await env.DB.prepare("DELETE FROM settings").run();
});

describe("POST /api/passcode", () => {
  it("rejects a wrong passcode with 401 and no cookie", async () => {
    const response = await postPasscode(WRONG_PASSCODE, nextIp());

    expect(response.status).toBe(401);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: "invalid_passcode" });
  });

  it("treats a missing passcode as a failed attempt", async () => {
    const response = await postPasscode(undefined, nextIp());

    expect(response.status).toBe(401);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("accepts the passcode with 204 and a signed cookie", async () => {
    const response = await postPasscode(TEST_PASSCODE, nextIp());

    expect(response.status).toBe(204);
    expect(response.headers.get("Set-Cookie")).toContain(`${AUTH_COOKIE}=`);
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(response.headers.get("Set-Cookie")).toContain("SameSite=Lax");

    // The cookie it just issued unlocks a protected route.
    const me = await getMe(cookiePair(response));
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toEqual({ verified: true, setup_done: false });
  });

  it("locks an IP out after 10 consecutive failures, even with the right passcode", async () => {
    const ip = nextIp();

    for (let attempt = 1; attempt <= MAX_PASSCODE_FAILURES; attempt++) {
      const response = await postPasscode(WRONG_PASSCODE, ip);
      expect(response.status).toBe(401);
    }

    const blocked = await postPasscode(TEST_PASSCODE, ip);
    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toEqual({ error: "too_many_attempts" });
    expect(blocked.headers.get("Retry-After")).toBe("600");
  });

  it("keeps lockouts per IP so one attacker cannot lock out the owner", async () => {
    const attacker = nextIp();

    for (let attempt = 1; attempt <= MAX_PASSCODE_FAILURES; attempt++) {
      await postPasscode(WRONG_PASSCODE, attacker);
    }

    expect((await postPasscode(TEST_PASSCODE, attacker)).status).toBe(429);
    expect((await postPasscode(TEST_PASSCODE, nextIp())).status).toBe(204);
  });

  it("resets the failure counter after a successful verify", async () => {
    const ip = nextIp();

    for (let attempt = 1; attempt <= MAX_PASSCODE_FAILURES - 1; attempt++) {
      expect((await postPasscode(WRONG_PASSCODE, ip)).status).toBe(401);
    }

    expect((await postPasscode(TEST_PASSCODE, ip)).status).toBe(204);

    // A fresh run of ten consecutive failures is still needed to lock out.
    for (let attempt = 1; attempt <= MAX_PASSCODE_FAILURES; attempt++) {
      expect((await postPasscode(WRONG_PASSCODE, ip)).status).toBe(401);
    }
    expect((await postPasscode(WRONG_PASSCODE, ip)).status).toBe(429);
  });
});

describe("GET /api/me", () => {
  it("reports an unverified visitor without a cookie", async () => {
    const response = await getMe();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ verified: false });
  });

  it("reports an unverified visitor with an invalid cookie", async () => {
    const response = await getMe(`${AUTH_COOKIE}=garbage`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ verified: false });
  });

  it("reports setup_done false before the initial balance is set", async () => {
    const response = await getMe(await signedCookie());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ verified: true, setup_done: false });
  });

  it("reports setup_done true after the initial balance is set", async () => {
    const cookie = await signedCookie();
    await putInitial(20_000_000, cookie);

    const response = await getMe(cookie);
    await expect(response.json()).resolves.toEqual({ verified: true, setup_done: true });
  });
});

describe("PUT /api/settings/initial", () => {
  it("requires auth", async () => {
    const response = await putInitial(20_000_000);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("stores the initial balance and records setup_done", async () => {
    const response = await putInitial(20_000_000, await signedCookie());

    expect(response.status).toBe(204);
    await expect(openSettings(env)).resolves.toEqual({
      initial_balance: "20000000",
      setup_done: "true",
    });
  });

  it("rewrites the balance later and keeps setup_done true", async () => {
    const cookie = await signedCookie();

    expect((await putInitial(20_000_000, cookie)).status).toBe(204);
    expect((await putInitial(35_500_000, cookie)).status).toBe(204);

    await expect(openSettings(env)).resolves.toEqual({
      initial_balance: "35500000",
      setup_done: "true",
    });
    await expect((await getMe(cookie)).json()).resolves.toEqual({
      verified: true,
      setup_done: true,
    });
  });

  it("rejects values that are not non-negative integers", async () => {
    const cookie = await signedCookie();

    for (const value of ["20000000", 12.5, -1, null, Number.MAX_SAFE_INTEGER + 1]) {
      const response = await putInitial(value, cookie);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_value" });
    }

    await expect(openSettings(env)).resolves.toEqual({});
  });

  it("rejects a body with no value", async () => {
    const response = await putInitial(undefined, await signedCookie());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_value" });
  });
});

describe("GET /api/settings/collapsed", () => {
  it("requires auth", async () => {
    const response = await getCollapsed();
    expect(response.status).toBe(401);
  });

  it("returns default collapsed sections when none stored", async () => {
    const cookie = await signedCookie();
    const response = await getCollapsed(cookie);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ collapsed: ["income"] });
  });
});

describe("PUT /api/settings/collapsed", () => {
  it("requires auth", async () => {
    const response = await putCollapsed({ collapsed: [] });
    expect(response.status).toBe(401);
  });

  it("stores collapsed sections array and returns them", async () => {
    const cookie = await signedCookie();
    const response = await putCollapsed({ collapsed: ["expense", "notes", "debt"] }, cookie);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      collapsed: ["expense", "notes", "debt"],
    });

    const getRes = await getCollapsed(cookie);
    await expect(getRes.json()).resolves.toEqual({
      collapsed: ["expense", "notes", "debt"],
    });

    const settings = await openSettings(env);
    expect(JSON.parse(settings.collapsed_sections)).toEqual(["expense", "notes", "debt"]);
  });

  it("allows setting single section collapsed status", async () => {
    const cookie = await signedCookie();
    // Default has "income". Collapsing "debt" adds it.
    let response = await putCollapsed({ section: "debt", collapsed: true }, cookie);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      collapsed: ["income", "debt"],
    });

    // Uncollapsing "income" removes it.
    response = await putCollapsed({ section: "income", collapsed: false }, cookie);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      collapsed: ["debt"],
    });
  });

  it("rejects invalid section names", async () => {
    const cookie = await signedCookie();
    const res1 = await putCollapsed({ collapsed: ["invalid_sec"] }, cookie);
    expect(res1.status).toBe(400);
    await expect(res1.json()).resolves.toEqual({ error: "invalid_section" });

    const res2 = await putCollapsed({ section: "invalid_sec", collapsed: true }, cookie);
    expect(res2.status).toBe(400);
    await expect(res2.json()).resolves.toEqual({ error: "invalid_section" });
  });

  it("rejects invalid payloads", async () => {
    const cookie = await signedCookie();
    const res = await putCollapsed({ foo: "bar" }, cookie);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_payload" });
  });
});
