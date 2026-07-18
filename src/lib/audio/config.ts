// A14 configuration surface. The two service URLs gate the whole feature: when a
// URL is unset (or blank), that half renders nothing and its routes 404, so a
// fresh clone with neither var set shows no trace of listen or voice notes. The
// fixture flag (shared with the LLM fixture player) is orthogonal: it only decides
// whether a bridge short-circuits to a canned response instead of calling the
// loopback service, so the automated test loop never hits the network.

function trimmed(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function ttsServiceUrl(): string {
  return trimmed("TTS_SERVICE_URL").replace(/\/+$/, "");
}

export function sttServiceUrl(): string {
  return trimmed("STT_SERVICE_URL").replace(/\/+$/, "");
}

// Listen (TTS) is available when its service URL is configured. Governs both the
// route 404 gate and UI visibility. Independent of fixture mode by design, so the
// route-404 unit test is deterministic regardless of the test env's fixture flag.
export function ttsEnabled(): boolean {
  return ttsServiceUrl() !== "";
}

// Voice notes (STT) are available when their service URL is configured.
export function sttEnabled(): boolean {
  return sttServiceUrl() !== "";
}

// The shared fixture flag. When set, TTS and STT bridges serve canned responses
// with no network call, exactly like the LLM fixture player.
export function isFixtureMode(): boolean {
  return process.env.USE_FIXTURE_LLM === "1";
}

// Voice identity that namespaces the audio cache key, so re-synthesizing with a
// different Piper voice does not collide with cached audio from the old one.
export function voiceId(): string {
  return trimmed("AUDIO_VOICE_ID") || "default";
}

// Cache size cap in bytes for the on-disk audio cache. Default 2 GB.
export function audioCacheMaxBytes(): number {
  const raw = Number(process.env.AUDIO_CACHE_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 2 * 1024 * 1024 * 1024;
}
