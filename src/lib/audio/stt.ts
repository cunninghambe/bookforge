import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { isFixtureMode, sttServiceUrl } from "./config";
import { detectFfmpeg, transcodeToWav16k } from "./ffmpeg";

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

// Pure: true when the bytes are already a RIFF/WAVE file, which the whisper.cpp
// server reads natively. Anything else (webm/opus from Chrome, mp4 from iOS)
// needs the ffmpeg transcode first. Unit-tested.
export function isWavBytes(audio: Uint8Array): boolean {
  if (audio.byteLength < 12) return false;
  const tag = (o: number) =>
    String.fromCharCode(audio[o], audio[o + 1], audio[o + 2], audio[o + 3]);
  return tag(0) === "RIFF" && tag(8) === "WAVE";
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

  // Browser recordings (webm/opus, mp4) are not decodable by the whisper.cpp
  // server (production-verified: "failed to read audio data"), so anything that
  // is not already WAV is transcoded to 16 kHz mono WAV when ffmpeg is present.
  // Without ffmpeg the original bytes are sent and the service's own error is
  // surfaced below.
  let payload: Uint8Array = audio;
  let sendName = filename;
  let sendMime = mime;
  if (!isWavBytes(audio) && (await detectFfmpeg())) {
    try {
      payload = await transcodeToWav16k(audio);
      sendName = "note.wav";
      sendMime = "audio/wav";
    } catch {
      // Fall through with the original bytes; the service error names the
      // failure if it cannot read them either.
    }
  }

  const form = new FormData();
  const view = new Uint8Array(payload.byteLength);
  view.set(payload);
  form.append("file", new Blob([view], { type: sendMime }), sendName);
  form.append("response_format", "json");
  const res = await fetch(`${base}/inference`, { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`STT service returned ${res.status}`);
  }
  const json = (await res.json()) as unknown;
  // whisper.cpp reports failures as 200s carrying {error}; surface the reason
  // (A2.2 discipline) instead of returning an empty transcript.
  const errText = (json as { error?: unknown } | null)?.error;
  if (typeof errText === "string" && errText.length > 0) {
    throw new Error(`STT service error: ${errText}`);
  }
  return parseTranscript(json);
}
