// Session auth for a single shared password. The session cookie is an HMAC-signed
// token. Signing/verifying uses Web Crypto (SubtleCrypto) so the exact same code
// runs in Edge middleware and in Node route handlers.

export const COOKIE_NAME = "bookforge_session";
// A23.3 / D185: 7 days, down from 30. Sessions are now revocable by rotating
// either secret, and a shorter window bounds the damage from a stolen cookie.
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

// D185: the signing key is a function of BOTH secrets. Rotating APP_PASSWORD
// after a suspected compromise used to revoke nothing (the token was keyed on
// SESSION_SECRET alone), so password rotation is now the revocation lever a
// single-user app actually reaches for. Both secrets travel together in one
// object so no call site can sign with half of the key by accident.
export interface SessionSecrets {
  sessionSecret: string;
  appPassword: string;
}

// The two secrets are joined with a version tag and newline separators so the
// derived key changes if either one does.
function signingKey(secrets: SessionSecrets): string {
  return `bookforge.session.v2\n${secrets.sessionSecret}\n${secrets.appPassword}`;
}

// Both halves of a token are base64url, so anything outside this alphabet is a
// malformed cookie, not a forged one (D186).
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(data: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return toBase64Url(new Uint8Array(sig));
}

// Constant-time compare over the decoded signature bytes.
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Token format: base64url(payloadJson).base64url(hmac). Payload carries issued-at
// so we can enforce a max age.
export async function createSessionToken(
  secrets: SessionSecrets,
  issuedAtSeconds: number,
): Promise<string> {
  const payload = JSON.stringify({ v: 1, iat: issuedAtSeconds });
  const payloadB64 = toBase64Url(new TextEncoder().encode(payload));
  const sig = await sign(payloadB64, signingKey(secrets));
  return `${payloadB64}.${sig}`;
}

export async function verifySessionToken(
  token: string | undefined | null,
  secrets: SessionSecrets,
  nowSeconds: number,
): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payloadB64, sigB64] = parts;
  // D186: shape-check BOTH halves BEFORE decoding. fromBase64Url used to run
  // outside the try below, so a cookie like "x.!" threw atob's
  // InvalidCharacterError straight through the middleware and turned every
  // gated path into a 500. It never granted access, but it fails closed and
  // quietly now: a malformed cookie is a 401 like any other bad token.
  if (!BASE64URL_RE.test(payloadB64) || !BASE64URL_RE.test(sigB64)) return false;
  // Belt and braces: the whole decode path is inside the try, so no future
  // decoding change can reintroduce a throwing gate.
  try {
    const expected = await sign(payloadB64, signingKey(secrets));
    if (!timingSafeEqual(fromBase64Url(sigB64), fromBase64Url(expected))) {
      return false;
    }
    const payload = JSON.parse(
      new TextDecoder().decode(fromBase64Url(payloadB64)),
    ) as { v: number; iat: number };
    if (payload.v !== 1) return false;
    if (nowSeconds - payload.iat > MAX_AGE_SECONDS) return false;
    return true;
  } catch {
    return false;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  };
}

// A per-process random key for the password comparison below. The two digests
// are only ever compared to each other, so the key never needs to be stable
// across processes or stored anywhere.
let compareKey: string | null = null;
function passwordCompareKey(): string {
  if (compareKey === null) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    compareKey = toBase64Url(bytes);
  }
  return compareKey;
}

// Password check. A23.3: the old version compared raw bytes and returned early
// on a length mismatch, which leaks the password's length under repeated timing
// samples. It compares HMAC digests of the two inputs instead: both are 32
// bytes regardless of input length, so the compare is over a fixed width and
// the early return is gone. Async because Web Crypto is (its one caller, the
// login route, is already async).
export async function passwordMatches(
  input: string,
  expected: string,
): Promise<boolean> {
  // Not a timing leak: this is about server misconfiguration, not the
  // attacker's input.
  if (expected.length === 0) return false;
  const key = passwordCompareKey();
  const [a, b] = await Promise.all([sign(input, key), sign(expected, key)]);
  return timingSafeEqual(fromBase64Url(a), fromBase64Url(b));
}
