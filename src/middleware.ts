import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { mustBlockForMissingAuthConfig } from "@/lib/authConfig";

// Public paths that never require a session.
const PUBLIC_PATHS = ["/login", "/api/auth/login"];

// Next internals and static assets. These pass through even when the server
// is refusing to serve protected content, so the login page's own JS/CSS can
// still load if it were ever reachable.
function isStaticAsset(pathname: string): boolean {
  if (pathname.startsWith("/_next")) return true;
  if (pathname === "/favicon.ico") return true;
  return false;
}

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.includes(pathname) || isStaticAsset(pathname);
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isStaticAsset(pathname)) return NextResponse.next();

  // Production with no APP_PASSWORD/SESSION_SECRET configured: refuse to serve
  // anything rather than run unauthenticated or 500 deep in a route handler.
  // Dev/test keep the existing behavior (the login route itself 500s).
  if (mustBlockForMissingAuthConfig(process.env.NODE_ENV, process.env)) {
    const message = "APP_PASSWORD not configured";
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: message }, { status: 503 });
    }
    return new NextResponse(message, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
  }

  if (isPublic(pathname)) return NextResponse.next();

  const secret = process.env.SESSION_SECRET ?? "";
  const token = req.cookies.get(COOKIE_NAME)?.value;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ok = secret.length > 0 && (await verifySessionToken(token, secret, nowSeconds));

  if (ok) return NextResponse.next();

  // API routes get a 401 JSON. Page routes redirect to the login gate.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Run on everything except Next internals and common static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
