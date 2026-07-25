import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db";
import { createChapter, getChapter, updateChapter } from "@/lib/repo/chapters";
import { latestDraft, saveWorkingDraft } from "@/lib/repo/drafts";
import { listProjects } from "@/lib/repo/projects";
import { POST as saveDraftPOST } from "@/app/api/chapters/[id]/save-draft/route";
import { PATCH as chapterPATCH } from "@/app/api/chapters/[id]/route";

// A23 (D187, D190): the two route fixes that touch the manuscript and the lock
// gate, tested through the real handlers rather than through a helper. The
// handlers reach for the process-wide DB singleton, which reads DATABASE_PATH
// lazily on its FIRST getDb() call, so setting it here (before any test runs)
// is enough. The target is a throwaway file under data/, which is gitignored
// and outside the tree sync, and it is removed first so every run starts from a
// fresh, seeded database.
const DB_PATH = resolve(process.cwd(), "data", "test-a23-routes.db");
for (const suffix of ["", "-shm", "-wal"]) {
  rmSync(DB_PATH + suffix, { force: true });
}
process.env.DATABASE_PATH = DB_PATH;

const FINISHED = "The tideglass rang, and Wrenlow did not look up.";

function post(id: number, body: unknown, raw?: string) {
  return saveDraftPOST(
    new Request(`http://t/api/chapters/${id}/save-draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ?? JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(id) }) },
  );
}

let projectId = 0;

beforeAll(() => {
  const db = getDb();
  const project = listProjects(db)[0];
  if (!project) throw new Error("the seeded database has no project");
  projectId = project.id;
});

// A chapter in a writable status, carrying a finished working draft.
function chapterWithDraft(status: "drafting" | "review" | "locked" = "drafting") {
  const db = getDb();
  const chapter = createChapter(db, { projectId, title: "A23 save-draft" });
  saveWorkingDraft(db, chapter.id, FINISHED);
  updateChapter(db, chapter.id, { status });
  return chapter.id;
}

describe("POST save-draft: content must be a string (D187)", () => {
  it("saves a normal string body", async () => {
    const id = chapterWithDraft();
    const res = await post(id, { content: "New words." });
    expect(res.status).toBe(200);
    expect(latestDraft(getDb(), id)?.content).toBe("New words.");
  });

  it("accepts a deliberate empty string", async () => {
    const id = chapterWithDraft();
    const res = await post(id, { content: "" });
    expect(res.status).toBe(200);
    expect(latestDraft(getDb(), id)?.content).toBe("");
  });

  it("400s on an absent content field and leaves the draft untouched", async () => {
    const id = chapterWithDraft();
    const res = await post(id, {});
    expect(res.status).toBe(400);
    // The bug: this used to coerce to "" and overwrite the row IN PLACE, with
    // no new version to recover from.
    expect(latestDraft(getDb(), id)?.content).toBe(FINISHED);
  });

  it("400s on a non-string content and leaves the draft untouched", async () => {
    for (const content of [123, null, true, { a: 1 }, ["x"]]) {
      const id = chapterWithDraft();
      const res = await post(id, { content });
      expect(res.status).toBe(400);
      expect(latestDraft(getDb(), id)?.content).toBe(FINISHED);
    }
  });

  it("400s on an unparseable body", async () => {
    const id = chapterWithDraft();
    const res = await post(id, undefined, "not json");
    expect(res.status).toBe(400);
    expect(latestDraft(getDb(), id)?.content).toBe(FINISHED);
  });

  it("404s for a chapter that does not exist", async () => {
    const res = await post(999_999, { content: "x" });
    expect(res.status).toBe(404);
  });
});

describe("POST save-draft: locked chapters are refused (D187)", () => {
  it("409s on a locked chapter and leaves the draft untouched", async () => {
    const id = chapterWithDraft("locked");
    const res = await post(id, { content: "overwritten" });
    expect(res.status).toBe(409);
    expect(latestDraft(getDb(), id)?.content).toBe(FINISHED);
  });

  it("still writes to a chapter in review", async () => {
    const id = chapterWithDraft("review");
    const res = await post(id, { content: "still editable" });
    expect(res.status).toBe(200);
    expect(latestDraft(getDb(), id)?.content).toBe("still editable");
  });

  it("still nudges a planned chapter into drafting", async () => {
    const db = getDb();
    const chapter = createChapter(db, { projectId, title: "A23 planned" });
    const res = await post(chapter.id, { content: "first words" });
    expect(res.status).toBe(200);
    expect(getChapter(db, chapter.id)?.status).toBe("drafting");
  });
});

// A23.6 / D190: POST /lock refuses while any comment is unresolved. PATCH
// accepted {"status":"locked"} with no such check, so the gate was enforced in
// one route and open in another.
describe("PATCH chapter: locking is not a PATCH (D190)", () => {
  function patch(id: number, body: unknown) {
    return chapterPATCH(
      new Request(`http://t/api/chapters/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: String(id) }) },
    );
  }

  it("400s on a status of locked and leaves the chapter alone", async () => {
    const db = getDb();
    const chapter = createChapter(db, { projectId, title: "A23 patch lock" });
    updateChapter(db, chapter.id, { status: "review" });
    const res = await patch(chapter.id, { status: "locked" });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("/lock");
    expect(getChapter(db, chapter.id)?.status).toBe("review");
  });

  it("still accepts every other status transition", async () => {
    const db = getDb();
    const chapter = createChapter(db, { projectId, title: "A23 patch other" });
    for (const status of ["interrogating", "drafting", "review", "planned"]) {
      const res = await patch(chapter.id, { status });
      expect(res.status).toBe(200);
      expect(getChapter(db, chapter.id)?.status).toBe(status);
    }
  });

  it("still rejects a status that is not a chapter status at all", async () => {
    const db = getDb();
    const chapter = createChapter(db, { projectId, title: "A23 patch bogus" });
    const res = await patch(chapter.id, { status: "published" });
    expect(res.status).toBe(400);
  });

  it("still edits the other fields", async () => {
    const db = getDb();
    const chapter = createChapter(db, { projectId, title: "A23 patch fields" });
    const res = await patch(chapter.id, { title: "Renamed", pov: "Wrenlow" });
    expect(res.status).toBe(200);
    const after = getChapter(db, chapter.id);
    expect(after?.title).toBe("Renamed");
    expect(after?.pov).toBe("Wrenlow");
  });
});
