import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

// D1 starts empty in the test runtime; the setup file applies these.
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./test/apply-migrations.ts"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // Tests sign their own cookies; production reads the PASSCODE secret.
        bindings: { PASSCODE: "test-secret", TEST_MIGRATIONS: migrations },
      },
    }),
  ],
});
