import { SELF } from "cloudflare:test";
import { AUTH_COOKIE, signToken } from "../src/auth";

// Unknown `/api/*` paths still 404, but only behind auth: they need the signed
// cookie the middleware checks. Test requests verify with the PASSCODE binding
// configured in vitest.config.ts.
it("unknown api route returns JSON 404", async () => {
  const token = await signToken("owner", "test-secret");

  const res = await SELF.fetch("https://example.com/api/nope", {
    headers: { Cookie: `${AUTH_COOKIE}=${token}` },
  });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
});

it("unknown api route requires auth", async () => {
  const res = await SELF.fetch("https://example.com/api/nope");

  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
});
