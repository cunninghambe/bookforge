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

## Bare-server deploy (pm2)

The reference production deploy is a bare Linux box running `next start` under
pm2 behind a reverse proxy. From the app checkout on the box, each deploy is:

```
node scripts/backup.mjs
git fetch origin
git reset --hard origin/master
npm install
npx next build
node scripts/uh-oh-upload-sourcemaps.mjs --dir .next --release 0.1.0+0
npm run migrate
pm2 restart bookforge
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3009/login   # expect 200
```

The source map upload step feeds uh-oh symbolication. `next.config.ts` sets
`productionBrowserSourceMaps: true`, so `next build` emits browser `.map`
files under `.next/static` alongside the server maps under `.next/server`,
and the script uploads both. It reads `UH_OH_SERVER_URL`,
`UH_OH_SYMBOL_TOKEN`, and `UH_OH_PROJECT` from the environment (see the
script header). It does not load `.env.local` itself; on the box those vars
live in `.env.local`, so export them first, e.g.:

```
set -a; . ./.env.local; set +a
```

When the vars are unset the script prints one line and exits 0, so a deploy
without uh-oh configured never breaks. The `--release` value must match
`UH_OH_RELEASE` in `src/lib/uh-oh-release.ts` (the package.json version plus
a fixed `+0` build segment, so `0.1.0+0` today); a mismatched release uploads
fine but symbolicates nothing, so bump the flag value whenever the package
version bumps.

Browser source maps are deleted by DEFAULT (A23.9 / D192), so the command
above needs no flag for it. This matters because everything under
`/_next/static/` bypasses the auth middleware (the login page's own assets
must load pre-auth), so any `.js.map` left in `.next/static` is
world-readable, exposing the client-side source. That happened twice on
2026-07-24 with the old opt-in flag, which is why the default was inverted.
The uploaded `static/**/*.js.map` files are removed after ALL uploads succeed
(never on partial failure), and symbolication is unaffected because the uh-oh
server keeps its own copies. The `.js` chunks retain `sourceMappingURL`
comments pointing at now-404 URLs, which is harmless.

`--keep-browser-maps` opts out and keeps them on disk; only pass it when you
have a reason to serve maps publicly. The old `--delete-browser-maps` is still
accepted as a no-op alias, so a deploy script that passes it keeps working and
still deletes.

## Better voices (A19): Kokoro TTS and whisper turbo STT

The listen and voice-note features (A14) talk to two on-box loopback services
behind `TTS_SERVICE_URL` and `STT_SERVICE_URL`. A19 upgrades the models without
touching a service contract: two new services on new ports, then an env flip.
Both live under `/opt/bookforge-voice/` and run under pm2, supervised like the
app. The original Piper (3108) and whisper base.en (3107) services stay running
and untouched, so the flip is reversible by env alone.

Kokoro TTS (`bookforge-kokoro`, 127.0.0.1:3110). A Python venv with `kokoro-onnx`
runs `scripts/kokoro-speak-server.py` (copied from this repo), which serves the
exact Piper contract (`GET /health` -> `{"ok":true,"voiceLoaded":true}`, `POST
/speak` JSON `{"text"}` -> WAV). Default voice `af_heart`, overridable with
`KOKORO_VOICE`; model and voices paths come from `KOKORO_MODEL_PATH` and
`KOKORO_VOICES_PATH` (the `kokoro-v1.0.onnx` model and `voices-v1.0.bin` pack, in
`/opt/bookforge-voice/models/`).

```
python3 -m venv /opt/bookforge-voice/venv
/opt/bookforge-voice/venv/bin/pip install kokoro-onnx onnxruntime numpy
KOKORO_PORT=3110 KOKORO_VOICE=af_heart \
KOKORO_MODEL_PATH=/opt/bookforge-voice/models/kokoro-v1.0.onnx \
KOKORO_VOICES_PATH=/opt/bookforge-voice/models/voices-v1.0.bin \
  pm2 start /opt/bookforge-voice/venv/bin/python \
  --name bookforge-kokoro --interpreter none -- \
  /opt/bookforge-voice/kokoro-speak-server.py
pm2 save
```

Whisper turbo STT (`bookforge-whisper`, 127.0.0.1:3111). Reuses the whisper.cpp
binary already on the box with a larger, quantized model
(`ggml-large-v3-turbo-q5_0.bin` in `/opt/bookforge-voice/models/`). The existing
autogeny whisper instance (3107, base.en) is left byte-for-byte as is.

```
pm2 start /root/autogeny-os/apps/desktop/src-tauri/binaries/whisper-server-x86_64-unknown-linux-gnu \
  --name bookforge-whisper --interpreter none -- \
  --port 3111 --model /opt/bookforge-voice/models/ggml-large-v3-turbo-q5_0.bin
pm2 save
```

Benchmark gate (before any TTS flip). Kokoro is heavier than Piper, so the flip
is gated on a measured realtime factor (synthesis seconds / audio seconds) over
three representative Chapter One paragraphs. Median at or below 1.0: flip.
Between 1.0 and 1.5: hold and report the numbers (author's tradeoff). Above 1.5:
hold and report. The run and its decision live in
`/opt/bookforge-voice/benchmark-report.txt`, with kept WAV samples for a listen.
The STT upgrade needs no gate beyond a functional round-trip and may flip on its
own.

Env flip (only for whichever half passed). In `/root/bookforge/.env.local`:

```
TTS_SERVICE_URL=http://127.0.0.1:3110
STT_SERVICE_URL=http://127.0.0.1:3111
AUDIO_VOICE_ID=kokoro-af_heart
```

Then back up and restart, picking up the new env. Re-source `.env.local` into
the shell before the restart so `--update-env` actually reasserts the edited
values: pm2 captured the original URLs at first start and Next.js does not
overwrite a var already present in the process environment, so a bare
`pm2 restart --update-env` from a fresh shell would keep serving the old ports.

```
cd /root/bookforge
node scripts/backup.mjs
set -a; . ./.env.local; set +a
pm2 restart bookforge --update-env
```

`AUDIO_VOICE_ID` namespaces the content-addressed audio cache, so bumping it to
`kokoro-af_heart` means old Piper audio simply ages out of the cache cap and each
chapter re-synthesizes in the new voice on next listen (no manual purge).

Rollback (env only, nothing else changes). Restore the two URLs (and the voice
id) to the Piper/base.en values, back up, and restart:

```
TTS_SERVICE_URL=http://127.0.0.1:3108
STT_SERVICE_URL=http://127.0.0.1:3107
AUDIO_VOICE_ID=default
```

```
cd /root/bookforge
node scripts/backup.mjs
set -a; . ./.env.local; set +a
pm2 restart bookforge --update-env
```

The Kokoro and whisper-turbo pm2 services can keep running after a rollback (they
are idle once the env points away from them) or be stopped with `pm2 delete
bookforge-kokoro bookforge-whisper && pm2 save`.
