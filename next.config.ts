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
  // Emit browser source maps in production builds so uh-oh can symbolicate
  // client stack traces (scripts/uh-oh-upload-sourcemaps.mjs uploads them at
  // deploy time; see DEPLOY.md).
  productionBrowserSourceMaps: true,
};

export default nextConfig;
