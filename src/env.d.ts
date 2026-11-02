// `PASSCODE` is a Worker secret, so `wrangler types` cannot discover it and the
// generated `Env` interface in worker-configuration.d.ts does not list it.
// This declaration merges the binding in so `env.PASSCODE` type-checks.
interface Env {
  PASSCODE: string;
}

declare namespace Cloudflare {
  interface Env {
    PASSCODE: string;
  }
}
