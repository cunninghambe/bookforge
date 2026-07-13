# Deploy

## Local run, from a fresh clone

```
npm install
cp .env.example .env.local
# fill in ANTHROPIC_API_KEY, APP_PASSWORD, SESSION_SECRET in .env.local
npm run dev
```

Open http://localhost:3000, log in with APP_PASSWORD. The SQLite database is
created automatically on first request at `./data/bookforge.db` (or wherever
`DATABASE_PATH` points), migrated and seeded idempotently.

`DATABASE_PATH` is optional and defaults to `./data/bookforge.db`. Set it to an
absolute path to store the database elsewhere; the parent directory is created
automatically if missing.

## Backups

```
npm run backup
```

Copies the database file (plus its `-wal` and `-shm` sidecars, if present, since
the app runs SQLite in WAL mode) to a timestamped file under a `backups/`
directory next to the database. Honors `DATABASE_PATH`. Refuses with a clear
error if the database file does not exist yet. Prints the path it created.

Run it on a schedule (cron, a Fly.io scheduled machine, etc.) or by hand before
anything risky (a sweep, a bulk import, an upgrade).

## Docker

Build and run locally (requires a Docker daemon; not exercised in this repo's
own dev/test loop):

```
docker build -t bookforge .
docker run -p 3000:3000 \
  -e ANTHROPIC_API_KEY=... \
  -e APP_PASSWORD=... \
  -e SESSION_SECRET=... \
  -v bookforge_data:/data \
  bookforge
```

`DATABASE_PATH` defaults to `/data/bookforge.db` inside the image, matching the
mounted volume above.

The image is a multi-stage build: dependencies and the Next.js standalone build
happen in Debian-based build stages (better-sqlite3 needs `python3 make g++` as
a fallback when no prebuilt binary matches the target platform); the runtime
stage copies only the traced standalone output, which already includes the
compiled `better_sqlite3.node` artifact, plus the backup script.

To run a backup inside a running container:

```
docker exec <container> node scripts/backup.mjs
```

## Fly.io

One-time setup:

```
flyctl launch --no-deploy --copy-config --name <your-app-name>
flyctl volumes create bookforge_data --size 1 --region <your-region>
flyctl secrets set \
  ANTHROPIC_API_KEY=<key> \
  APP_PASSWORD=<password> \
  SESSION_SECRET=$(openssl rand -hex 32)
```

Then, and for every subsequent deploy:

```
flyctl deploy
```

`fly.toml` mounts the `bookforge_data` volume at `/data` and sets
`DATABASE_PATH=/data/bookforge.db`, so the database survives restarts and
redeploys. `min_machines_running = 1` with `auto_stop_machines = false` keeps
exactly one machine running: SQLite on a single mounted volume is not safe to
read/write from more than one machine at a time, so this app intentionally does
not scale beyond one instance.

In production (`NODE_ENV=production`, which Fly's Docker runtime sets), the app
refuses to serve anything and returns 503 if `APP_PASSWORD` or `SESSION_SECRET`
is missing, rather than running unauthenticated or failing with a confusing
500 the first time someone logs in. Set both as secrets before deploying.

To back up the production database:

```
flyctl ssh console -C "node scripts/backup.mjs"
```

Backups land under `/data/backups/`, inside the same mounted volume, so they
survive restarts too. Fly does not download them automatically; use
`flyctl sftp get` (or `flyctl ssh sftp shell`) to pull a backup file off the
volume if you want a copy outside Fly.
