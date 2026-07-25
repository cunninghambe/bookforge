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
  // A23.10: the image optimizer is NOT a static asset. The app uses no
  // next/image anywhere, so the endpoint carried its own advisories and nothing
  // else; gating it costs nothing and removes an unauthenticated surface. This
  // check must come before the /_next prefix below.
  if (pathname.startsWith("/_next/image")) return false;
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
  // D185: the token is keyed on SESSION_SECRET AND APP_PASSWORD, so rotating
  // either one invalidates every live session.
  const secrets = {
    sessionSecret: secret,
    appPassword: process.env.APP_PASSWORD ?? "",
  };
  const token = req.cookies.get(COOKIE_NAME)?.value;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ok =
    secret.length > 0 && (await verifySessionToken(token, secrets, nowSeconds));

  if (ok) {
    // A23.2 / D184: refuse genuine cross-site traffic. The session cookie is
    // SameSite=Lax on a host under a domain that carries other services, so a
    // sibling subdomain counts as same-site and could otherwise drive writes.
    // Same-origin requests report "same-origin", a typed URL or bookmark
    // reports "none", and a browser that omits the header is not blocked, so
    // only real cross-site traffic is refused. This also closes the audio GET
    // vector, where Lax does send the cookie on a top-level navigation.
    if (req.headers.get("sec-fetch-site") === "cross-site") {
      // D194: refuse cross-site WRITES anywhere, and any cross-site reach into
      // /api/ even by GET (the audio route synthesizes on a plain GET, and no
      // honest cross-site traffic navigates into this API). A cross-site GET of
      // a PAGE is allowed: that is just following a link to the app from a chat
      // client, an email, or another site, and refusing it would break normal
      // use to no benefit, since a page render mutates nothing.
      const method = req.method.toUpperCase();
      const isSafeMethod = method === "GET" || method === "HEAD";
      const isApi = pathname.startsWith("/api/");
      if (!isSafeMethod || isApi) {
        const message = "cross-site request refused";
        if (isApi) {
          return NextResponse.json({ error: message }, { status: 403 });
        }
        return new NextResponse(message, {
          status: 403,
          headers: { "content-type": "text/plain" },
        });
      }
    }
    return NextResponse.next();
  }

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
  // Run on everything except Next internals and common static files. A23.10:
  // _next/image is deliberately NOT excluded any more.
  matcher: ["/((?!_next/static|favicon.ico).*)"],
};
