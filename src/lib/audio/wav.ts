// Minimal valid WAV (RIFF/PCM) generation and detection. Used by the fixture TTS
// bridge so the automated test loop never touches the real Piper service, and as
// the last-resort body when the real service or transcode misbehaves. Pure node,
// no dependencies, unit-tested against the RIFF header layout.

// A canonical 16-bit mono PCM WAV carrying `samples` frames of silence at
// `sampleRate` Hz. The default is a fraction of a second, which keeps the fixture
// body tiny while remaining a well-formed, decodable file.
export function minimalWav(
  opts: { sampleRate?: number; samples?: number } = {},
): Buffer {
  const sampleRate = opts.sampleRate ?? 8000;
  const numSamples = opts.samples ?? 800;
  const bitsPerSample = 16;
  const numChannels = 1;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;

  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // audioFormat = PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  // The sample region stays zero-filled (silence).
  return buf;
}

// True when the bytes begin with the RIFF/WAVE magic. Used to decide whether a
// service body is already a WAV we can transcode or serve.
export function isWav(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const ascii = (start: number, end: number): string =>
    String.fromCharCode(...Array.from(bytes.subarray(start, end)));
  return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
}
