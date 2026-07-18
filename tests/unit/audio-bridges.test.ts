import { describe, it, expect, afterEach } from "vitest";
import { minimalWav, isWav } from "@/lib/audio/wav";
import { chooseAudioFormat } from "@/lib/audio/ffmpeg";
import { synthesizeSpeech } from "@/lib/audio/tts";
import { parseTranscript, transcribeAudio } from "@/lib/audio/stt";
import { ttsEnabled, sttEnabled } from "@/lib/audio/config";

// Snapshot and restore the env vars these tests toggle, so ordering never leaks.
const KEYS = ["USE_FIXTURE_LLM", "TTS_SERVICE_URL", "STT_SERVICE_URL"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("minimalWav / isWav", () => {
  it("produces a well-formed RIFF/WAVE PCM file", () => {
    const wav = minimalWav();
    expect(isWav(wav)).toBe(true);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    // RIFF chunk size is filesize - 8.
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    // data chunk size matches the tail after the 44-byte header.
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
  });

  it("rejects non-WAV bytes", () => {
    expect(isWav(Buffer.from("not audio"))).toBe(false);
    expect(isWav(Buffer.from([1, 2, 3]))).toBe(false);
  });
});

describe("chooseAudioFormat: ffmpeg-absent fallback (detection mocked)", () => {
  it("serves Opus when ffmpeg is present", () => {
    expect(chooseAudioFormat(true)).toEqual({
      format: "opus",
      ext: "opus",
      contentType: "audio/ogg",
    });
  });
  it("falls back to WAV when ffmpeg is absent", () => {
    expect(chooseAudioFormat(false)).toEqual({
      format: "wav",
      ext: "wav",
      contentType: "audio/wav",
    });
  });
});

describe("TTS fixture bridge", () => {
  it("serves a valid WAV with no network call in fixture mode", async () => {
    process.env.USE_FIXTURE_LLM = "1";
    delete process.env.TTS_SERVICE_URL;
    const wav = await synthesizeSpeech("anything");
    expect(isWav(wav)).toBe(true);
    expect(wav.length).toBeGreaterThan(44);
  });
});

describe("STT fixture bridge", () => {
  it("parseTranscript trims the whisper leading space and tolerates junk", () => {
    expect(parseTranscript({ text: "  hello there  " })).toBe("hello there");
    expect(parseTranscript({})).toBe("");
    expect(parseTranscript(null)).toBe("");
    expect(parseTranscript({ text: 5 })).toBe("");
  });

  it("returns the canned transcript with no network call in fixture mode", async () => {
    process.env.USE_FIXTURE_LLM = "1";
    delete process.env.STT_SERVICE_URL;
    const text = await transcribeAudio(new Uint8Array([1, 2, 3]), "note.webm", "audio/webm");
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/^\s/);
  });
});

describe("feature gating by service URL", () => {
  it("is disabled when the URL is unset and enabled when set", () => {
    delete process.env.TTS_SERVICE_URL;
    delete process.env.STT_SERVICE_URL;
    expect(ttsEnabled()).toBe(false);
    expect(sttEnabled()).toBe(false);
    process.env.TTS_SERVICE_URL = "http://127.0.0.1:3108";
    process.env.STT_SERVICE_URL = "http://127.0.0.1:3107";
    expect(ttsEnabled()).toBe(true);
    expect(sttEnabled()).toBe(true);
    // Blank (whitespace) counts as unset.
    process.env.TTS_SERVICE_URL = "   ";
    expect(ttsEnabled()).toBe(false);
  });
});
