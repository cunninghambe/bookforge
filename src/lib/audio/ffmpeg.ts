import { spawn } from "node:child_process";

// ffmpeg detection and WAV-to-compressed transcode. Raw WAV is heavy over mobile
// data, so when ffmpeg is present the WAV from Piper is transcoded to Opus (Ogg)
// before caching; without ffmpeg the WAV is served as is. Detection runs once,
// is logged once, and is never an error: a host with no ffmpeg simply serves WAV.

export interface AudioFormat {
  format: "opus" | "wav";
  ext: string;
  contentType: string;
}

// Pure: the serving format given whether ffmpeg is available. Opus in an Ogg
// container when we can transcode, otherwise WAV. Unit-tested with detection
// mocked so the fallback is asserted without a real ffmpeg.
export function chooseAudioFormat(ffmpegPresent: boolean): AudioFormat {
  if (ffmpegPresent) {
    return { format: "opus", ext: "opus", contentType: "audio/ogg" };
  }
  return { format: "wav", ext: "wav", contentType: "audio/wav" };
}

let detection: Promise<boolean> | null = null;

// Detects ffmpeg by running `ffmpeg -version`, memoized for the process. Logs the
// outcome exactly once. Resolves false on any spawn or non-zero exit.
export function detectFfmpeg(): Promise<boolean> {
  if (detection) return detection;
  detection = new Promise<boolean>((resolvePromise) => {
    // spawn does not throw for a missing binary; it emits an 'error' (ENOENT).
    const child = spawn("ffmpeg", ["-version"], { windowsHide: true });
    let settled = false;
    const settle = (present: boolean) => {
      if (settled) return;
      settled = true;
      console.log(
        present
          ? "[audio] ffmpeg detected; transcoding synthesized audio to Opus."
          : "[audio] ffmpeg not found; serving WAV without transcode.",
      );
      resolvePromise(present);
    };
    child.on("error", () => settle(false));
    child.on("close", (code) => settle(code === 0));
  });
  return detection;
}

// Test hook: reset the memoized detection so a test can re-run it.
export function __resetFfmpegDetection(): void {
  detection = null;
}

// Transcodes a WAV buffer to Opus (Ogg) via ffmpeg over pipes. Rejects on spawn
// failure or a non-zero exit; callers fall back to serving the original WAV so a
// transcode hiccup is never surfaced as an error.
export function transcodeWavToOpus(wav: Uint8Array): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-c:a",
        "libopus",
        "-b:a",
        "24k",
        "-f",
        "ogg",
        "pipe:1",
      ],
      { windowsHide: true },
    );
    const out: Buffer[] = [];
    let err = "";
    child.stdout?.on("data", (d) => out.push(d as Buffer));
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && out.length > 0) {
        resolvePromise(Buffer.concat(out));
      } else {
        reject(new Error(`ffmpeg transcode failed (code ${code}): ${err.trim()}`));
      }
    });
    child.stdin?.on("error", () => {
      // The child may exit before stdin drains; the close handler reports it.
    });
    child.stdin?.write(wav);
    child.stdin?.end();
  });
}
