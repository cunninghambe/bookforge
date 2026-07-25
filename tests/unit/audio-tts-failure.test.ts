import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { getDb } from "@/lib/db";
import { createChapter } from "@/lib/repo/chapters";
import { saveWorkingDraft } from "@/lib/repo/drafts";
import { listProjects } from "@/lib/repo/projects";
import { GET as audioGET } from "@/app/api/chapters/[id]/audio/[paragraphIndex]/route";

// D195: the audio route used to call the TTS bridge with no error handling, so a
// speech service that was down, restarting, or erroring threw straight out of the
// handler and the player got an opaque failure part way through a chapter. It now
// answers 502, which the player already knows how to offer Retry for (D165).
//
// Same DB discipline as tests/unit/a23-routes.test.ts: the handler reaches for the
// process-wide singleton, which reads DATABASE_PATH lazily on the first getDb(),
// so pointing it at a throwaway file here (before any test runs) is enough. The
// file is under data/, which is gitignored and outside the tree sync.
const DB_PATH = resolve(process.cwd(), "data", "test-audio-tts.db");
for (const suffix of ["", "-shm", "-wal"]) {
  rmSync(DB_PATH + suffix, { force: true });
}
process.env.DATABASE_PATH = DB_PATH;

// Unique per run so the content-addressed audio cache can never serve a hit and
// hide the synthesis path we are testing.
const PARAGRAPH = `The tideglass rang and no one answered ${Date.now()}.`;

const KEYS = ["TTS_SERVICE_URL", "USE_FIXTURE_LLM"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

let chapterId = 0;

beforeAll(() => {
  const db = getDb();
  const project = listProjects(db)[0];
  if (!project) throw new Error("the seeded database has no project");
  const chapter = createChapter(db, { projectId: project.id, title: "TTS failure" });
  saveWorkingDraft(db, chapter.id, PARAGRAPH);
  chapterId = chapter.id;
});

function get(index: number) {
  return audioGET(
    new Request(`http://t/api/chapters/${chapterId}/audio/${index}`),
    { params: Promise.resolve({ id: String(chapterId), paragraphIndex: String(index) }) },
  );
}

describe("GET audio: a failing TTS service is a 502, not a crash (D195)", () => {
  it("answers 502 when the speech service is unreachable", async () => {
    // Port 1 is reserved and never listening, so fetch rejects rather than
    // returning a response: the same shape as the service being down.
    delete process.env.USE_FIXTURE_LLM;
    process.env.TTS_SERVICE_URL = "http://127.0.0.1:1";

    const res = await get(0);
    expect(res.status).toBe(502);
  });

  it("does not leak the underlying service error to the client", async () => {
    delete process.env.USE_FIXTURE_LLM;
    process.env.TTS_SERVICE_URL = "http://127.0.0.1:1";

    const res = await get(0);
    const body = (await res.json()) as { error: string };
    // A stable, client-facing message. The detail goes to the server log: it
    // comes from another service and the browser has no use for it.
    expect(body.error).toBe("the speech service is unavailable");
    expect(body.error).not.toContain("127.0.0.1");
    expect(body.error).not.toContain("ECONNREFUSED");
  });

  it("still 404s for an out-of-range paragraph rather than reaching the service", async () => {
    delete process.env.USE_FIXTURE_LLM;
    process.env.TTS_SERVICE_URL = "http://127.0.0.1:1";

    const res = await get(999);
    expect(res.status).toBe(404);
  });
});
