// Pure decision logic for whether the app is allowed to serve protected
// content, kept separate from the middleware so it is unit testable without a
// Next.js request/response.

export interface AuthEnv {
  APP_PASSWORD?: string;
  SESSION_SECRET?: string;
  // Index signature so process.env (NodeJS.ProcessEnv) is assignable directly,
  // without a cast at every call site.
  [key: string]: string | undefined;
}

// Both secrets must be present and non-empty for the auth gate to function at
// all (the login route needs APP_PASSWORD to check against and SESSION_SECRET
// to sign the cookie).
export function isAuthConfigured(env: AuthEnv): boolean {
  return Boolean(
    env.APP_PASSWORD &&
      env.APP_PASSWORD.length > 0 &&
      env.SESSION_SECRET &&
      env.SESSION_SECRET.length > 0,
  );
}

// True when the server must refuse to serve rather than run unauthenticated or
// throw a confusing 500 deep in a route handler: production mode with the
// required secrets missing or empty. Dev and test modes are never blocked here;
// an unconfigured dev server keeps its existing behavior (the login route
// 500s when it is actually used).
export function mustBlockForMissingAuthConfig(
  nodeEnv: string | undefined,
  env: AuthEnv,
): boolean {
  return nodeEnv === "production" && !isAuthConfigured(env);
}
