// Auth for the single-user expenser app.
//
// The passcode lives in the Worker secret `PASSCODE` and is never stored in D1.
// A successful passcode entry sets the `expenser_auth` cookie, whose value is a
// signed token:
//
//   <id>.<issuedAtMs>.<base64url(HMAC-SHA256(secret, "<id>.<issuedAtMs>"))>
//
// The secret is the HMAC key, so rotating `PASSCODE` invalidates every cookie.

const encoder = new TextEncoder();

export const AUTH_COOKIE = "expenser_auth";

/** One year, in seconds — matches the cookie's `Max-Age`. */
export const AUTH_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export interface SignTokenOptions {
  /** Override the issue time (ms since epoch); tests use it to forge old tokens. */
  issuedAt?: number;
}

export interface VerifyTokenOptions {
  /** Reject tokens older than this. Defaults to `AUTH_MAX_AGE_SECONDS`. */
  maxAgeSeconds?: number;
}

/**
 * Signs `id` into a cookie token. Throws when the secret is empty: without a
 * key there is nothing to sign with, and failing loudly beats issuing a token
 * that any caller could forge.
 */
export async function signToken(
  id: string,
  secret: string,
  options: SignTokenOptions = {},
): Promise<string> {
  if (!id) throw new TypeError("signToken: id is required");
  if (!secret) throw new TypeError("signToken: secret is required");

  const issuedAt = options.issuedAt ?? Date.now();
  const payload = `${id}.${issuedAt}`;
  const signature = await hmacSign(payload, secret);

  return `${payload}.${toBase64Url(signature)}`;
}

/**
 * Verifies a cookie token and returns its id, or `null` when the token is
 * malformed, signed with another secret, or older than `maxAgeSeconds`.
 * Never throws: a bad token is simply not trusted.
 */
export async function verifyToken(
  token: string,
  secret: string,
  options: VerifyTokenOptions = {},
): Promise<string | null> {
  if (!token || !secret) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [id, issuedAtRaw, signatureRaw] = parts;
  if (!id || !issuedAtRaw || !signatureRaw) return null;

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) return null;

  let signature: Uint8Array;
  try {
    signature = fromBase64Url(signatureRaw);
  } catch {
    return null;
  }

  const expected = await hmacSign(`${id}.${issuedAtRaw}`, secret);
  if (!timingSafeEqual(signature, expected)) return null;

  const maxAgeSeconds = options.maxAgeSeconds ?? AUTH_MAX_AGE_SECONDS;
  if (Date.now() - issuedAt > maxAgeSeconds * 1000) return null;

  return id;
}

/**
 * Compares the submitted passcode with the configured one in constant time
 * (via fixed-length digests, so neither value's length leaks).
 */
export async function isValidPasscode(input: string, secret: string): Promise<boolean> {
  if (!input || !secret) return false;

  const [submitted, expected] = await Promise.all([sha256(input), sha256(secret)]);
  return timingSafeEqual(submitted, expected);
}

/** `Set-Cookie` value for a freshly signed token. */
export function authCookieHeader(token: string): string {
  return [
    `${AUTH_COOKIE}=${token}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${AUTH_MAX_AGE_SECONDS}`,
  ].join("; ");
}

/**
 * Middleware guard for `/api/*`: returns a 401 JSON response when the request
 * carries no valid auth cookie, or `null` when the request may proceed.
 */
export async function requireAuth(request: Request, secret: string): Promise<Response | null> {
  const token = readCookie(request.headers.get("Cookie"), AUTH_COOKIE);
  if (token !== null && (await verifyToken(token, secret)) !== null) return null;

  return Response.json({ error: "unauthorized" }, { status: 401 });
}

async function hmacSign(payload: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];

  return difference === 0;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }

  return null;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return bytes;
}
