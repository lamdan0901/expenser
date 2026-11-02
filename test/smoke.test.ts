import { SELF } from "cloudflare:test";
it("unknown api route returns JSON 404", async () => {
  const res = await SELF.fetch("https://example.com/api/nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
});
