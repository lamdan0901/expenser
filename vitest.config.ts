import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  test: {
    globals: true,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // Tests sign their own cookies; production reads the PASSCODE secret.
        bindings: { PASSCODE: "test-secret" },
      },
    }),
  ],
});
