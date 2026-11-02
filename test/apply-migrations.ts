import { applyD1Migrations, env } from "cloudflare:test";

// Each test file gets fresh storage, so migrations run once per file (the
// helper is idempotent: applied migrations are tracked in `d1_migrations`).
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
