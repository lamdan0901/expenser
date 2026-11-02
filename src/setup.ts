// Passcode gate, first-run initial-balance setup, and the passcode rate limiter.
//
// The passcode itself is the deploy-time `PASSCODE` Worker secret (see auth.ts).
// Settings live in D1's `settings` table as TEXT key/value pairs; this module is
// the single place that knows the keys.
import {
  authCookieHeader,
  isValidPasscode,
  requireAuth,
  signToken,
} from "./auth";

/** The single user's id; the token id is not used for authorization. */
const OWNER_ID = "owner";

export const SETUP_DONE_KEY = "setup_done";
export const INITIAL_BALANCE_KEY = "initial_balance";

export const MAX_PASSCODE_FAILURES = 10;
export const PASSCODE_LOCKOUT_MS = 10 * 60 * 1000;

/** Raw settings rows, keyed by name. */
export type Settings = Record<string, string>;

/** Reads every settings row. Missing keys are simply absent from the result. */
export async function openSettings(env: Env): Promise<Settings> {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all<{
    key: string;
    value: string;
  }>();

  const settings: Settings = {};
  for (const row of results) settings[row.key] = row.value;
  return settings;
}

/** Whether the one-time initial-balance setup has been completed. */
export function isSetupDone(settings: Settings): boolean {
  return settings[SETUP_DONE_KEY] === "true";
}

/** `POST /api/passcode` — public. */
export async function handlePasscode(request: Request, env: Env): Promise<Response> {
  const ip = clientIp(request);
  const now = Date.now();

  const lockedForMs = lockoutRemainingMs(ip, now);
  if (lockedForMs > 0) {
    return Response.json(
      { error: "too_many_attempts" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(lockedForMs / 1000)) } },
    );
  }

  const passcode = await readPasscode(request);
  if (passcode !== null && (await isValidPasscode(passcode, env.PASSCODE))) {
    attempts.delete(ip);
    const token = await signToken(OWNER_ID, env.PASSCODE);

    return new Response(null, {
      status: 204,
      headers: { "Set-Cookie": authCookieHeader(token) },
    });
  }

  recordFailure(ip, Date.now());
  return Response.json({ error: "invalid_passcode" }, { status: 401 });
}

/** `GET /api/me` — public; reports whether the caller's cookie is trusted. */
export async function handleMe(request: Request, env: Env): Promise<Response> {
  if (await requireAuth(request, env.PASSCODE)) {
    return Response.json({ verified: false });
  }

  const settings = await openSettings(env);
  return Response.json({ verified: true, setup_done: isSetupDone(settings) });
}

/**
 * `PUT /api/settings/initial` — protected by the worker's auth gate.
 *
 * Allowed any time after verifying, so the owner can fix a typo from ⚙. The
 * first call also records `setup_done`; later calls only rewrite the balance.
 */
export async function handleInitialBalance(request: Request, env: Env): Promise<Response> {
  const value = await readInitialBalance(request);
  if (value === null) {
    return Response.json({ error: "invalid_value" }, { status: 400 });
  }

  // One statement so the balance and the setup flag can never disagree.
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?), (?, 'true')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(INITIAL_BALANCE_KEY, String(value), SETUP_DONE_KEY)
    .run();

  return new Response(null, { status: 204 });
}

interface AttemptRecord {
  /** Consecutive failures since the last successful verify. */
  fails: number;
  /** Epoch ms until which this IP is locked out; 0 when not locked out. */
  until: number;
}

// Per-isolate in-memory limiter: a Worker isolate resets its counters on
// eviction and each isolate counts separately, so a determined attacker spread
// across many isolates can exceed the intended limit. Acceptable for this
// single-user app; a Durable Object or D1 counter would be needed for a strict
// global limit.
const attempts = new Map<string, AttemptRecord>();

function clientIp(request: Request): string {
  // Cloudflare sets this on every production request. Local dev and tests have
  // no such header, and all header-less callers share the "unknown" bucket.
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

/** Remaining lockout in ms, or 0 when this IP may attempt a passcode. */
function lockoutRemainingMs(ip: string, now: number): number {
  const record = attempts.get(ip);
  if (record === undefined || record.until === 0) return 0;

  if (record.until > now) return record.until - now;

  // The lockout window has elapsed: start counting from scratch.
  attempts.delete(ip);
  return 0;
}

function recordFailure(ip: string, now: number): void {
  const record = attempts.get(ip) ?? { fails: 0, until: 0 };
  record.fails += 1;

  if (record.fails >= MAX_PASSCODE_FAILURES) {
    record.until = now + PASSCODE_LOCKOUT_MS;
  }

  attempts.set(ip, record);
}

async function readPasscode(request: Request): Promise<string | null> {
  const body = await readJsonObject(request);
  const passcode = body?.passcode;

  return typeof passcode === "string" ? passcode : null;
}

async function readInitialBalance(request: Request): Promise<number | null> {
  const body = await readJsonObject(request);
  const value = body?.value;

  // Full VND integers only: reject strings, fractions, negatives and unsafe ints.
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;

  return value;
}

/** Parses a JSON object body; malformed or non-object bodies yield `null`. */
async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // Malformed JSON is a failed request, not a crash.
  }

  return null;
}
