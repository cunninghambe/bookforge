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
  // A23.1 / D183: security headers live here, in one place, applied to every
  // path and versioned with the app, rather than in the middleware or in Caddy
  // (the repo's posture must not depend on infrastructure the repo cannot see).
  // frame-ancestors 'none' is the load-bearing one: no destructive control in
  // this UI has a confirmation step, so a framed click deletes canon or starts
  // a paid run. script-src is deliberately omitted: it needs a per-request
  // nonce and the review found no HTML injection sink anywhere in the app.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
          },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          {
            // microphone stays self: VoiceNoteRecorder calls getUserMedia (A14).
            key: "Permissions-Policy",
            value: "camera=(), geolocation=(), payment=(), microphone=(self)",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
