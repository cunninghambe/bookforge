#!/usr/bin/env python3
"""kokoro-speak-server.py wraps Kokoro-82M (kokoro-onnx) as an HTTP server.

It speaks the exact same contract as the on-box Piper server
(scripts reference: src/lib/audio/tts.ts), so the app upgrades voices with an
env flip and no code change:

  GET  /health  -> {"ok": true, "voiceLoaded": <bool>}   (application/json)
  POST /speak   -> audio/wav   (text in the raw body OR JSON {"text": ...})

The model and voices pack load once at startup (Kokoro warm-loads in a couple of
seconds); each /speak synthesizes with the configured voice and returns a
complete 16-bit PCM WAV body. Synthesis is serialized with a lock so /health
stays responsive and concurrent posts do not race the ONNX session.

Config, all from the environment with defaults matching the SPEC (A19):
  KOKORO_VOICE        voice id                     (default af_heart)
  KOKORO_PORT         listen port                  (default 3110)
  KOKORO_HOST         listen host                  (default 127.0.0.1)
  KOKORO_MODEL_PATH   path to the kokoro onnx model
  KOKORO_VOICES_PATH  path to the voices pack (bin)
  KOKORO_LANG         g2p language                 (default en-us)
  KOKORO_SPEED        synthesis speed              (default 1.0)
"""
import io
import json
import os
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from kokoro_onnx import Kokoro

SELF_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODELS_DIR = os.environ.get(
    "KOKORO_MODELS_DIR", os.path.join(SELF_DIR, "models")
)

VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
PORT = int(os.environ.get("KOKORO_PORT", "3110"))
HOST = os.environ.get("KOKORO_HOST", "127.0.0.1")
MODEL_PATH = os.environ.get(
    "KOKORO_MODEL_PATH", os.path.join(DEFAULT_MODELS_DIR, "kokoro-v1.0.onnx")
)
VOICES_PATH = os.environ.get(
    "KOKORO_VOICES_PATH", os.path.join(DEFAULT_MODELS_DIR, "voices-v1.0.bin")
)
LANG = os.environ.get("KOKORO_LANG", "en-us")
SPEED = float(os.environ.get("KOKORO_SPEED", "1.0"))

MAX_BODY = 64 * 1024

for _label, _path in (("model", MODEL_PATH), ("voices", VOICES_PATH)):
    if not os.path.exists(_path):
        print(f"kokoro {_label} file missing: {_path}", file=sys.stderr)
        sys.exit(1)

_kokoro = Kokoro(MODEL_PATH, VOICES_PATH)
_synth_lock = threading.Lock()


SILENCE_SECONDS = 0.8
FALLBACK_RATE = 24000  # Kokoro's native output rate.


def _pcm_to_wav(pcm, sample_rate):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(int(sample_rate))
        wav.writeframes(pcm.tobytes())
    return buf.getvalue()


def _silence_wav(sample_rate=FALLBACK_RATE, seconds=SILENCE_SECONDS):
    frames = int(sample_rate * seconds)
    return _pcm_to_wav(np.zeros(frames, dtype="<i2"), sample_rate)


def _speakable(text):
    """True when the text contains anything the phonemizer can voice."""
    return any(ch.isalnum() for ch in text)


def synth_wav(text):
    """Synthesize text to a complete 16-bit PCM WAV byte string.

    Text with nothing voiceable (a scene-break separator like a bare "---"
    arrives as its own paragraph) phonemizes to zero segments and makes the
    runtime throw ("need at least one array to concatenate"), so it is
    answered with a short silence instead: a beat of quiet is exactly what a
    scene break should sound like. The same fallback covers a synthesis that
    unexpectedly yields no samples.
    """
    if not _speakable(text):
        return _silence_wav()
    with _synth_lock:
        samples, sample_rate = _kokoro.create(
            text, voice=VOICE, speed=SPEED, lang=LANG
        )
    arr = np.asarray(samples, dtype=np.float32)
    if arr.size == 0:
        return _silence_wav()
    pcm = np.clip(arr, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    return _pcm_to_wav(pcm, sample_rate)


def extract_text(body, content_type):
    if content_type.startswith("application/json"):
        try:
            return json.loads(body).get("text")
        except (ValueError, AttributeError):
            return None
    return body


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path == "/health":
            payload = json.dumps(
                {"ok": True, "voiceLoaded": _kokoro is not None}
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        if self.path != "/speak":
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > MAX_BODY:
            self._text(413, "payload too large")
            return
        raw = self.rfile.read(length) if length > 0 else b""
        content_type = self.headers.get("Content-Type", "") or ""
        text = extract_text(raw.decode("utf-8", "replace"), content_type)
        if not text or not isinstance(text, str):
            self._text(400, "missing text")
            return
        try:
            wav_bytes = synth_wav(text)
        except Exception as err:  # noqa: BLE001 - surface as 500, keep serving
            print(f"kokoro synth error: {err}", file=sys.stderr)
            self._text(500, "synthesis failed")
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav_bytes)))
        self.end_headers()
        self.wfile.write(wav_bytes)

    def _text(self, code, message):
        body = message.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[kokoro-http] listening on http://{HOST}:{PORT} voice={VOICE}")
    server.serve_forever()


if __name__ == "__main__":
    main()
