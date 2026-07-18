# Deploy

## Local run, from a fresh clone

```
npm install
cp .env.example .env.local
# fill in APP_PASSWORD and SESSION_SECRET in .env.local
npm run dev
```

Open http://localhost:3000, log in with APP_PASSWORD. The SQLite database is
created automatically on first request at `./data/bookforge.db` (or wherever
`DATABASE_PATH` points), migrated and seeded idempotently.

## LLM transport (A7)

The default `LLM_TRANSPORT=claude-code` rides the locally installed and logged-in
Claude Code CLI, so the primary local mode needs no `ANTHROPIC_API_KEY` at all:
install Claude Code, run `claude` once to log in, and `npm run dev` just works.
The CLI is discovered as `claude` on PATH (override with `CLAUDE_CODE_BIN`).

Verify auth end to end with a single tiny real call:

```
npm run llm-smoke
```

It prints the transport, the reply, and token/cache usage, and exits nonzero with
a clear message if the CLI is missing or not logged in. It is not part of
`npm test`.

To use an API key instead, set `LLM_TRANSPORT=api-key` and `ANTHROPIC_API_KEY`.

Limitation: the Claude Code CLI has no output-token cap flag, so `maxTokens` is
not enforced on the claude-code transport (it is honored on the api-key
transport). The per-call timeout is `CLAUDE_CODE_TIMEOUT_MS` (default 600000ms).

Chat session reuse (A10): on this transport the app keeps one CLI session per
character-chat conversation and resumes it each turn, so turns after the first
send only the new message and read the provider cache instead of re-processing
the growing transcript. Sessions live in process memory and on the CLI's own
disk; a server restart is safe (the next turn re-seeds losslessly from the
client-held transcript). Nothing to configure.

`DATABASE_PATH` is optional and defaults to `./data/bookforge.db`. Set it to an
absolute path to store the database elsewhere; the parent directory is created
automatically if missing.

## MCP server (A6)

BookForge exposes an MCP server so an agent (Claude Code, Claude Desktop) can
manage canon, characters, chapters, drafting, and chat programmatically. It is a
local stdio process that runs the same repo layer the web app uses:

```
npm run mcp
```

Register it with an MCP client via a `.mcp.json` (Claude Code reads one from the
project root). Point `cwd` at this project so the server finds `.env.local`, the
database (`DATABASE_PATH`), and the fixture files:

```json
{
  "mcpServers": {
    "bookforge": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/absolute/path/to/bookforge"
    }
  }
}
```

Or invoke tsx directly, without the npm wrapper:

```json
{
  "mcpServers": {
    "bookforge": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "/absolute/path/to/bookforge"
    }
  }
}
```

The server reads the same env as the app (`.env.local` is loaded the way the
llm-smoke script loads it): it honors `DATABASE_PATH`, the model vars, and the
`USE_FIXTURE_LLM` / `LLM_TRANSPORT` selection (so with no configuration it rides
the local Claude Code auth, exactly like `npm run dev`).

Trust model. The MCP server is a local stdio child process operating directly on
the SQLite database file. It deliberately bypasses the web app's password gate:
anyone who can start this process already has read/write access to the database
file itself, so the process sits at the same trust boundary as the DB file (and
the machine it lives on). There is no network listener and no auth layer here by
design. Do not register this server on a machine whose database you would not
hand to whoever controls the MCP client.

The human-only approval gates are NOT exposed as tools. No MCP tool approves
extraction or bible proposals, resolves revision hunks, locks or unlocks a
chapter, or imports a chapter: those decisions protect quality (the
diff-enforcement and approval gates the SPEC forbids softening) and stay in the
web UI. `chapter_update` can edit a chapter's title, pov, synopsis, and beats but
cannot change its locked status. Every chapter number in tool inputs and outputs
is 1-based (chapter 1 is a book's first chapter); the server converts to the
0-based storage at the tool boundary.

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

Optional: crash reporting (uh-oh). `UH_OH_DSN` (server) is a normal runtime `-e`
var like the ones above. `NEXT_PUBLIC_UH_OH_DSN` (browser) is inlined into the
client bundle at build time, so it must be passed to `docker build` instead:
`docker build --build-arg NEXT_PUBLIC_UH_OH_DSN=... -t bookforge .`. Both are
no-ops (crash reporting off) when left unset.

`DATABASE_PATH` defaults to `/data/bookforge.db` inside the image, matching the
mounted volume above.

For servers, recommend the api-key transport: set `LLM_TRANSPORT=api-key` and
`ANTHROPIC_API_KEY` (as shown above). Alternatively, install the Claude Code CLI
in the image and supply `CLAUDE_CODE_OAUTH_TOKEN` (minted with `claude
setup-token` on a logged-in machine) so the default claude-code transport can
authenticate headlessly. The api-key transport is simpler and the recommended
choice for server deploys.

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
  LLM_TRANSPORT=api-key \
  ANTHROPIC_API_KEY=<key> \
  APP_PASSWORD=<password> \
  SESSION_SECRET=$(openssl rand -hex 32)
```

`LLM_TRANSPORT=api-key` is the recommended server setting (see the Docker section
for the CLI-plus-`CLAUDE_CODE_OAUTH_TOKEN` alternative).

Optional: crash reporting (uh-oh). `flyctl secrets set UH_OH_DSN=<dsn>` for the
server side, same as the secrets above. The browser side is a build-time value
(see the Docker section), so on Fly it goes on the deploy command instead of a
secret: `flyctl deploy --build-arg NEXT_PUBLIC_UH_OH_DSN=<dsn>`. Both are no-ops
when left unset.

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
