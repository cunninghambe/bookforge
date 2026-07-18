import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { isFixtureMode, ttsServiceUrl } from "./config";
import { minimalWav } from "./wav";

// TTS bridge to the on-box Piper server. Real path: POST {text} to
// {TTS_SERVICE_URL}/speak and receive a complete WAV (RIFF) body. Fixture path
// (USE_FIXTURE_LLM=1): serve a tiny checked-in WAV with no network call, so the
// test loop never touches the service. Returns raw WAV bytes; transcode and cache
// happen in the route.

// Loads the checked-in fixture WAV, mirroring how the LLM FixtureClient loads
// tests/fixtures/*. Falls back to a generated minimal WAV if the file is missing,
// so a sync hiccup never breaks the fixture bridge.
function fixtureWav(): Buffer {
  const path = resolve(process.cwd(), "tests", "fixtures", "audio.tiny.wav");
  if (existsSync(path)) {
    try {
      return readFileSync(path);
    } catch {
      return minimalWav();
    }
  }
  return minimalWav();
}

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  if (isFixtureMode()) {
    return fixtureWav();
  }
  const base = ttsServiceUrl();
  if (base === "") {
    throw new Error("TTS_SERVICE_URL is not configured");
  }
  const res = await fetch(`${base}/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`TTS service returned ${res.status}`);
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}
