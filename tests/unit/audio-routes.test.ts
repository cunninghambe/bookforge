import { describe, it, expect, afterEach } from "vitest";
import { GET as manifestGET } from "@/app/api/chapters/[id]/audio-manifest/route";
import { GET as audioGET } from "@/app/api/chapters/[id]/audio/[paragraphIndex]/route";
import { POST as voiceNotesPOST } from "@/app/api/voice-notes/route";

// The service URLs gate every new route: unset means 404, so a fresh clone shows no
// trace of the feature. The 404 check runs before any DB access, so this stays a
// pure route-level assertion. Snapshot/restore the env so ordering never leaks.
const KEYS = ["TTS_SERVICE_URL", "STT_SERVICE_URL"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("A14 routes 404 when their service URL is unset", () => {
  it("GET audio-manifest 404s without TTS_SERVICE_URL", async () => {
    delete process.env.TTS_SERVICE_URL;
    const res = await manifestGET(new Request("http://t/api/chapters/1/audio-manifest"), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET audio 404s without TTS_SERVICE_URL", async () => {
    delete process.env.TTS_SERVICE_URL;
    const res = await audioGET(new Request("http://t/api/chapters/1/audio/0"), {
      params: Promise.resolve({ id: "1", paragraphIndex: "0" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST voice-notes 404s without STT_SERVICE_URL", async () => {
    delete process.env.STT_SERVICE_URL;
    const res = await voiceNotesPOST(
      new Request("http://t/api/voice-notes", { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });
});
