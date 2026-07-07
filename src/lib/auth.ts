// Session auth for a single shared password. The session cookie is an HMAC-signed
// token. Signing/verifying uses Web Crypto (SubtleCrypto) so the exact same code
// runs in Edge middleware and in Node route handlers.

export const COOKIE_NAME = "bookforge_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

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
  secret: string,
  issuedAtSeconds: number,
): Promise<string> {
  const payload = JSON.stringify({ v: 1, iat: issuedAtSeconds });
  const payloadB64 = toBase64Url(new TextEncoder().encode(payload));
  const sig = await sign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

export async function verifySessionToken(
  token: string | undefined | null,
  secret: string,
  nowSeconds: number,
): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payloadB64, sigB64] = parts;
  const expected = await sign(payloadB64, secret);
  if (!timingSafeEqual(fromBase64Url(sigB64), fromBase64Url(expected))) {
    return false;
  }
  try {
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

// Password check. Uses a length-then-content comparison; constant-time enough for
// a single local shared secret.
export function passwordMatches(input: string, expected: string): boolean {
  if (expected.length === 0) return false;
  const a = new TextEncoder().encode(input);
  const b = new TextEncoder().encode(expected);
  return timingSafeEqual(a, b);
}
