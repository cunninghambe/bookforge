import { init, captureException } from "./lib/uh-oh-client";
import { UH_OH_RELEASE } from "./lib/uh-oh-release";

// Crash reporting (uh-oh, self-hosted; see js-core-report and DECISIONS). init()
// without a DSN is a silent no-op, so this ships safely before any server DSN
// exists: no console noise, no behavior change. Only the nodejs runtime is
// initialized (the edge runtime never calls init, so onRequestError below stays a
// safe no-op there too).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    init({
      dsn: process.env.UH_OH_DSN,
      release: UH_OH_RELEASE,
      environment: process.env.NODE_ENV,
    });
  }
}

// Next 15+ server-error hook: fires for uncaught errors in Server Components,
// Route Handlers, and other server rendering paths. Route handlers in this app
// that catch their own errors and return a JSON error response never reach this
// hook by design; it only sees what would otherwise be an unhandled 500.
export async function onRequestError(err: unknown): Promise<void> {
  captureException(err);
}
