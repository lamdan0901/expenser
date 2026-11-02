import { SELF } from "cloudflare:test";
import {
  AUTH_COOKIE,
  AUTH_MAX_AGE_SECONDS,
  authCookieHeader,
  isValidPasscode,
  requireAuth,
  signToken,
  verifyToken,
} from "../src/auth";

// The Worker gets its real passcode from the PASSCODE secret; tests inject the
// same value as a Miniflare binding (see vitest.config.ts).
const TEST_SECRET = "test-secret";
const OTHER_SECRET = "other-secret";
const OWNER = "owner";

function apiRequest(cookie?: string): Request {
  return new Request("https://example.com/api/expenses", {
    headers: cookie === undefined ? {} : { Cookie: cookie },
  });
}

describe("token signing", () => {
  it("verifies a signed token back to its id", async () => {
    const token = await signToken(OWNER, TEST_SECRET);

    expect(token).toMatch(/^owner\.\d+\.[A-Za-z0-9_-]+$/);
    await expect(verifyToken(token, TEST_SECRET)).resolves.toBe(OWNER);
  });

  it("rejects tokens whose payload or signature was tampered with", async () => {
    const token = await signToken(OWNER, TEST_SECRET);

    const [id, issuedAt, signature] = token.split(".");
    const tamperedPayload = token.replace(`${OWNER}.${issuedAt}.`, `admin.${issuedAt}.`);
    // Flip the first signature character: its bits are always significant,
    // unlike the last character's trailing padding bits.
    const flipped = signature!.startsWith("A") ? "B" : "A";
    const tamperedSignature = `${id}.${issuedAt}.${flipped}${signature!.slice(1)}`;

    expect(tamperedPayload).not.toBe(token);
    expect(tamperedSignature).not.toBe(token);
    await expect(verifyToken(tamperedPayload, TEST_SECRET)).resolves.toBeNull();
    await expect(verifyToken(tamperedSignature, TEST_SECRET)).resolves.toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signToken(OWNER, OTHER_SECRET);

    await expect(verifyToken(token, TEST_SECRET)).resolves.toBeNull();
  });

  it("rejects expired tokens but accepts fresh ones", async () => {
    const expired = await signToken(OWNER, TEST_SECRET, { issuedAt: Date.now() - 10_000 });
    const fresh = await signToken(OWNER, TEST_SECRET);

    await expect(verifyToken(expired, TEST_SECRET, { maxAgeSeconds: 5 })).resolves.toBeNull();
    await expect(verifyToken(fresh, TEST_SECRET, { maxAgeSeconds: 5 })).resolves.toBe(OWNER);
  });

  it("rejects malformed tokens instead of throwing", async () => {
    for (const token of ["", "not-a-token", "owner.123", `${OWNER}.123.not!base64`]) {
      await expect(verifyToken(token, TEST_SECRET)).resolves.toBeNull();
    }
  });
});

describe("passcode check", () => {
  it("accepts only the configured passcode", async () => {
    await expect(isValidPasscode("hunter2", "hunter2")).resolves.toBe(true);
    await expect(isValidPasscode("hunter3", "hunter2")).resolves.toBe(false);
    await expect(isValidPasscode("", "hunter2")).resolves.toBe(false);
  });
});

describe("auth cookie", () => {
  it("is HttpOnly, SameSite=Lax and lasts one year", () => {
    const header = authCookieHeader("owner.123.signature");

    expect(header).toContain(`${AUTH_COOKIE}=owner.123.signature`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain(`Max-Age=${AUTH_MAX_AGE_SECONDS}`);
    expect(AUTH_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 365);
  });
});

describe("requireAuth middleware", () => {
  it("returns a 401 JSON response when the cookie is missing", async () => {
    const response = await requireAuth(apiRequest(), TEST_SECRET);

    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
    await expect(response!.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("returns a 401 JSON response when the cookie is invalid", async () => {
    const response = await requireAuth(apiRequest(`${AUTH_COOKIE}=garbage`), TEST_SECRET);

    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
    await expect(response!.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("lets a valid signed cookie through", async () => {
    const token = await signToken(OWNER, TEST_SECRET);

    await expect(
      requireAuth(apiRequest(`${AUTH_COOKIE}=${token}`), TEST_SECRET),
    ).resolves.toBeNull();
  });

  it("finds the auth cookie among other cookies", async () => {
    const token = await signToken(OWNER, TEST_SECRET);

    await expect(
      requireAuth(apiRequest(`theme=dark; ${AUTH_COOKIE}=${token}; other=1`), TEST_SECRET),
    ).resolves.toBeNull();
  });
});

describe("worker dispatch order", () => {
  it("returns 401 JSON for a protected API route without a cookie", async () => {
    const response = await SELF.fetch("https://example.com/api/expenses");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("reaches the route dispatch when the signed cookie is valid", async () => {
    const token = await signToken(OWNER, TEST_SECRET);
    const response = await SELF.fetch("https://example.com/api/expenses", {
      headers: { Cookie: `${AUTH_COOKIE}=${token}` },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });

  it("does not gate POST /api/passcode or GET /api/me", async () => {
    // 401 now means "wrong passcode" on this route, so prove reachability with
    // the right one instead of asserting the status is not 401.
    const passcode = await SELF.fetch("https://example.com/api/passcode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode: TEST_SECRET }),
    });
    const me = await SELF.fetch("https://example.com/api/me");

    expect(passcode.status).toBe(204);
    expect(me.status).toBe(200);
  });
});
