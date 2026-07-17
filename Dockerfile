# Multi-stage build for the Next.js 15 standalone output (next.config.ts sets
# output: "standalone"). better-sqlite3 is a native module: the deps stage
# installs build tools as a fallback for when prebuild-install has no matching
# prebuilt binary for the target platform, so npm ci can fall back to
# node-gyp rebuild. Debian slim (not alpine) to avoid a musl/glibc prebuild
# mismatch for better-sqlite3 and sharp.

# ---- deps: install dependencies (dev + prod, needed to run `next build`) ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: compile the Next.js standalone build ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Optional. NEXT_PUBLIC_ vars are inlined into the client bundle at build time
# (Next.js cannot read them at runtime), so browser crash reporting needs this
# as a build arg, not a runtime secret: `docker build --build-arg
# NEXT_PUBLIC_UH_OH_DSN=... .` or `flyctl deploy --build-arg
# NEXT_PUBLIC_UH_OH_DSN=...`. Empty default: an unset arg still builds a plain
# image with crash reporting off, matching every other optional env var here.
ARG NEXT_PUBLIC_UH_OH_DSN=
ENV NEXT_PUBLIC_UH_OH_DSN=$NEXT_PUBLIC_UH_OH_DSN
RUN npm run build

# ---- runner: minimal runtime image ----
FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Matches the Fly.io volume mount (see fly.toml). Overridable, but the runtime
# default points at the mounted volume so a plain `docker run` without an
# override still writes somewhere durable-looking rather than the image layer.
ENV DATABASE_PATH=/data/bookforge.db
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs

# The traced standalone output already contains the node_modules subset it
# needs, including the compiled better-sqlite3 .node binary built in the
# builder stage above (serverExternalPackages keeps it out of the JS bundle
# but the file-tracer still copies the native artifact in).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Backup script: plain Node, no build step, copied straight from source so it
# can be run inside the running container (e.g. `fly ssh console -C "npm run backup"`).
COPY --from=builder /app/scripts/backup.mjs ./scripts/backup.mjs
COPY --from=builder /app/scripts/backup-core.mjs ./scripts/backup-core.mjs
COPY --from=builder /app/package.json ./package.json

RUN mkdir -p /data && chown -R nextjs:nodejs /data

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
