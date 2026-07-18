import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { isFixtureMode, sttServiceUrl } from "./config";

// STT bridge to the on-box whisper.cpp server. Real path: POST the recorded audio
// as multipart field `file` to {STT_SERVICE_URL}/inference with
// response_format=json and read {text}. Fixture path (USE_FIXTURE_LLM=1): return a
// canned transcript from tests/fixtures/stt.note.json with no network call.

interface SttResponse {
  text?: unknown;
}

// Pure: extract and normalize the transcript from a whisper.cpp JSON response.
// Whisper prefixes a leading space; trim it. Unit-tested.
export function parseTranscript(json: unknown): string {
  const obj = (json ?? {}) as SttResponse;
  return typeof obj.text === "string" ? obj.text.trim() : "";
}

function fixtureTranscript(): string {
  const path = resolve(process.cwd(), "tests", "fixtures", "stt.note.json");
  const raw = readFileSync(path, "utf8");
  return parseTranscript(JSON.parse(raw));
}

export async function transcribeAudio(
  audio: Uint8Array,
  filename: string,
  mime: string,
): Promise<string> {
  if (isFixtureMode()) {
    return fixtureTranscript();
  }
  const base = sttServiceUrl();
  if (base === "") {
    throw new Error("STT_SERVICE_URL is not configured");
  }
  const form = new FormData();
  const view = new Uint8Array(audio.byteLength);
  view.set(audio);
  form.append("file", new Blob([view], { type: mime }), filename);
  form.append("response_format", "json");
  const res = await fetch(`${base}/inference`, { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`STT service returned ${res.status}`);
  }
  const json = (await res.json()) as unknown;
  return parseTranscript(json);
}
