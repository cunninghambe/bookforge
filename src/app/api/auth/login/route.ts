import { NextResponse } from "next/server";
import {
  COOKIE_NAME,
  createSessionToken,
  passwordMatches,
  sessionCookieOptions,
} from "@/lib/auth";
import { isAuthConfigured } from "@/lib/authConfig";
import {
  createThrottleState,
  decideLogin,
  recordFailure,
  recordSuccess,
  throttleKeyFrom,
} from "@/lib/loginThrottle";

// A23.7 / D191: one counter per process. The deploy pins a single pm2 instance,
// so module memory is the whole story; a restart forgives outstanding failures,
// which is acceptable for a cost-control and detection measure.
const throttle = createThrottleState(Date.now());

export async function POST(req: Request) {
  const secret = process.env.SESSION_SECRET ?? "";
  const expected = process.env.APP_PASSWORD ?? "";

  if (!isAuthConfigured({ APP_PASSWORD: expected, SESSION_SECRET: secret })) {
    return NextResponse.json(
      { error: "server not configured: APP_PASSWORD and SESSION_SECRET required" },
      { status: 500 },
    );
  }

  const nowMs = Date.now();
  const key = throttleKeyFrom(req.headers);

  let password = "";
  try {
    const body = (await req.json()) as { password?: string };
    password = body.password ?? "";
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  // D193: the password is checked BEFORE the throttle is consulted, so a correct
  // password always wins. The throttle gates only the response to a FAILED
  // attempt. Blocking first would let anyone on the internet lock the author out
  // of his own manuscript for a whole window just by failing at the global bound,
  // and the box is demonstrably being probed. Nothing is conceded: an attacker
  // still never learns anything from a rejected guess, each guess costs them one
  // HMAC, and the credential is long and random (D191).
  if (!(await passwordMatches(password, expected))) {
    recordFailure(throttle, key, nowMs);
    // One line per failure, so pm2's log carries the detection signal the
    // review found missing.
    console.warn(`login failed: key=${key}`);
    const decision = decideLogin(throttle, key, nowMs);
    if (!decision.allow) {
      console.warn(
        `login throttled: key=${key} retryAfterSec=${decision.retryAfterSec}`,
      );
      return NextResponse.json(
        { error: "too many attempts" },
        {
          status: 429,
          headers: { "Retry-After": String(decision.retryAfterSec) },
        },
      );
    }
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  recordSuccess(throttle, key, nowMs);

  const nowSeconds = Math.floor(nowMs / 1000);
  // D185: signed with both secrets, so rotating either revokes this session.
  const token = await createSessionToken(
    { sessionSecret: secret, appPassword: expected },
    nowSeconds,
  );
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, token, sessionCookieOptions());
  return res;
}
