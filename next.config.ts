import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Standalone output for the Docker image: a self-contained server bundle plus
  // a traced node_modules subset, so the runtime image does not need a full
  // `npm install`.
  output: "standalone",
  // better-sqlite3 is a native module. Keep it external to the server bundle so
  // Next does not try to bundle the .node binary.
  serverExternalPackages: ["better-sqlite3"],
  // Pin the workspace root: a stray parent lockfile in the home directory would
  // otherwise be inferred as the root and break file tracing.
  outputFileTracingRoot: here,
  // Crash-reporting source maps (uh-oh). Browser maps land under
  // .next/static/**/*.js.map, which Next serves publicly at /_next/static; the
  // Dockerfile's builder stage uploads them to uh-oh then unconditionally
  // deletes every .js.map under .next/static before the runtime image is
  // assembled, so a production deploy never serves one regardless of whether
  // uh-oh is configured at build time (see DECISIONS and DEPLOY.md).
  productionBrowserSourceMaps: true,
  experimental: {
    // Server bundle maps (.next/server/**/*.js.map). Never served publicly
    // (no route exposes .next/server); uploaded the same way as the browser
    // maps for symbolicated server stack traces.
    serverSourceMaps: true,
  },
};

export default nextConfig;
