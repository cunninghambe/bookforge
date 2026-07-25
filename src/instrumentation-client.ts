import { init } from "./lib/uh-oh-client";
import { UH_OH_RELEASE } from "./lib/uh-oh-release";

// Crash reporting (uh-oh, self-hosted), browser side. Runs once, as early as
// possible, before the app starts (Next 15.3+ instrumentation-client.ts). init()
// without a DSN is a silent no-op: no listeners installed, no console noise, no
// behavior change, until NEXT_PUBLIC_UH_OH_DSN is set at build time.

// A23.8: a failed JSON.parse in the browser produces a message containing a
// slice of the response body, and a response body here can be manuscript text.
// The crash client ships messages off-box, so the exception value is truncated
// before it ever leaves. 200 characters is plenty to identify a parse failure
// and far too little to leak prose. The review confirmed the client never reads
// cookies and never captures request or response bodies, so nothing else here
// needs redacting.
const MAX_EXCEPTION_VALUE_CHARS = 200;

init({
  dsn: process.env.NEXT_PUBLIC_UH_OH_DSN,
  release: UH_OH_RELEASE,
  environment: process.env.NODE_ENV,
  beforeSend: (event) => {
    const value = event.exception.value;
    if (typeof value === "string" && value.length > MAX_EXCEPTION_VALUE_CHARS) {
      event.exception.value =
        value.slice(0, MAX_EXCEPTION_VALUE_CHARS) + " [truncated]";
    }
    return event;
  },
});
