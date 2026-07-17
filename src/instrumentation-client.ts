import { init } from "./lib/uh-oh-client";
import { UH_OH_RELEASE } from "./lib/uh-oh-release";

// Crash reporting (uh-oh, self-hosted), browser side. Runs once, as early as
// possible, before the app starts (Next 15.3+ instrumentation-client.ts). init()
// without a DSN is a silent no-op: no listeners installed, no console noise, no
// behavior change, until NEXT_PUBLIC_UH_OH_DSN is set at build time.
init({
  dsn: process.env.NEXT_PUBLIC_UH_OH_DSN,
  release: UH_OH_RELEASE,
  environment: process.env.NODE_ENV,
});
