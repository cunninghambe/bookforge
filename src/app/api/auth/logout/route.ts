import { NextResponse } from "next/server";
import { COOKIE_NAME } from "@/lib/auth";

// Clears the session cookie and returns to the login gate. Accepts POST from the
// nav form (redirect) and is also callable via fetch.
export async function POST(req: Request) {
  const url = new URL("/login", req.url);
  const res = NextResponse.redirect(url, { status: 303 });
  res.cookies.set(COOKIE_NAME, "", { path: "/", maxAge: 0 });
  return res;
}
