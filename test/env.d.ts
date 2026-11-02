// Test-only bindings injected by vitest.config.ts. `TEST_MIGRATIONS` carries
// the parsed `migrations/` directory into test/apply-migrations.ts; production
// builds never see it.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  }
}
