import { NextResponse } from "next/server";
import {
  COOKIE_NAME,
  createSessionToken,
  passwordMatches,
  sessionCookieOptions,
} from "@/lib/auth";
import { isAuthConfigured } from "@/lib/authConfig";

export async function POST(req: Request) {
  const secret = process.env.SESSION_SECRET ?? "";
  const expected = process.env.APP_PASSWORD ?? "";

  if (!isAuthConfigured({ APP_PASSWORD: expected, SESSION_SECRET: secret })) {
    return NextResponse.json(
      { error: "server not configured: APP_PASSWORD and SESSION_SECRET required" },
      { status: 500 },
    );
  }

  let password = "";
  try {
    const body = (await req.json()) as { password?: string };
    password = body.password ?? "";
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  if (!passwordMatches(password, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = await createSessionToken(secret, nowSeconds);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, token, sessionCookieOptions());
  return res;
}
