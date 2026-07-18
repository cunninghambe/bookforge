"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Hold-to-record voice-note button (A14). Holding records via MediaRecorder;
// releasing uploads the audio with the chapter id and the current paragraph index
// to /api/voice-notes, which transcribes it and creates an anchored comment. The
// returned transcript is shown immediately in an editable field with a save (one
// tap, PATCHes the comment) and an undo (reverts edits to the raw transcript),
// because transcription is imperfect. When MediaRecorder is unavailable the button
// is replaced by a plain "recording not supported" message.

type Phase = "idle" | "recording" | "transcribing" | "editing" | "error";

interface CreatedComment {
  id: number;
  quotedText: string;
  comment: string;
}

function recordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

export function VoiceNoteRecorder({
  chapterId,
  getParagraphIndex,
  onSaved,
}: {
  chapterId: number;
  getParagraphIndex: () => number;
  onSaved?: () => void;
}) {
  const [supported, setSupported] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [transcript, setTranscript] = useState("");
  const [edited, setEdited] = useState("");
  const [comment, setComment] = useState<CreatedComment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const activeRef = useRef(false);

  // MediaRecorder support is a client-only fact; decide after mount so SSR and the
  // first client render agree (both assume supported), avoiding a hydration warning.
  useEffect(() => {
    setSupported(recordingSupported());
  }, []);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const upload = useCallback(
    async (blob: Blob) => {
      setPhase("transcribing");
      setError(null);
      try {
        const form = new FormData();
        form.append("audio", blob, "note.webm");
        form.append("chapterId", String(chapterId));
        form.append("paragraphIndex", String(getParagraphIndex()));
        const res = await fetch("/api/voice-notes", { method: "POST", body: form });
        if (!res.ok) {
          setError("Could not transcribe the note.");
          setPhase("error");
          return;
        }
        const data = (await res.json()) as {
          comment: CreatedComment;
          transcript: string;
        };
        setComment(data.comment);
        setTranscript(data.transcript);
        setEdited(data.transcript);
        setPhase("editing");
        onSaved?.();
      } catch {
        setError("Could not transcribe the note.");
        setPhase("error");
      }
    },
    [chapterId, getParagraphIndex, onSaved],
  );

  const startRecording = useCallback(async () => {
    if (activeRef.current || phase === "transcribing") return;
    setSaved(false);
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stopTracks();
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        void upload(blob);
      };
      recorderRef.current = recorder;
      activeRef.current = true;
      recorder.start();
      setPhase("recording");
    } catch {
      setError("Microphone access was denied.");
      setPhase("error");
      stopTracks();
    }
  }, [phase, stopTracks, upload]);

  const stopRecording = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    } else {
      stopTracks();
    }
  }, [stopTracks]);

  useEffect(() => () => stopTracks(), [stopTracks]);

  async function saveNote() {
    if (!comment) return;
    const res = await fetch(`/api/comments/${comment.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment: edited }),
    });
    if (res.ok) {
      setSaved(true);
      setPhase("idle");
      setComment(null);
      onSaved?.();
    } else {
      setError("Could not save the note.");
    }
  }

  if (!supported) {
    return (
      <p
        data-testid="voice-record-unsupported"
        className="text-sm text-muted"
      >
        Recording is not supported in this browser. Type a comment instead.
      </p>
    );
  }

  return (
    <div data-testid="voice-note-recorder" className="text-sm">
      {phase !== "editing" && (
        <button
          type="button"
          data-testid="voice-record-button"
          data-phase={phase}
          onPointerDown={(e) => {
            e.preventDefault();
            void startRecording();
          }}
          onPointerUp={(e) => {
            e.preventDefault();
            stopRecording();
          }}
          onPointerLeave={() => stopRecording()}
          onPointerCancel={() => stopRecording()}
          disabled={phase === "transcribing"}
          className={
            phase === "recording"
              ? "select-none rounded border border-danger-edge bg-danger px-4 py-2 text-danger-ink"
              : "btn-secondary select-none px-4 py-2"
          }
        >
          {phase === "recording"
            ? "Recording... release to save"
            : phase === "transcribing"
              ? "Transcribing..."
              : "Hold to record a voice note"}
        </button>
      )}

      {saved && (
        <p data-testid="voice-note-saved" className="mt-2 text-ok-ink">
          Voice note saved as a comment.
        </p>
      )}

      {error && (
        <p data-testid="voice-note-error" className="mt-2 text-danger-ink">
          {error}
        </p>
      )}

      {phase === "editing" && (
        <div className="mt-2 rounded border border-edge-soft p-3">
          <p className="mb-1 text-xs uppercase tracking-wide text-faint">
            Transcript (edit before saving)
          </p>
          <p className="mb-2 text-xs italic text-muted">
            Anchored to: &ldquo;{comment?.quotedText}&rdquo;
          </p>
          <textarea
            aria-label="Voice note transcript"
            data-testid="voice-note-transcript"
            value={edited}
            onChange={(e) => setEdited(e.target.value)}
            rows={3}
            className="w-full rounded border border-edge bg-surface p-2 text-sm text-ink"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              data-testid="voice-note-save"
              onClick={saveNote}
              disabled={edited.trim().length === 0}
              className="btn-primary px-3 py-1.5"
            >
              Save note
            </button>
            <button
              type="button"
              data-testid="voice-note-undo"
              onClick={() => setEdited(transcript)}
              disabled={edited === transcript}
              className="btn-secondary px-3 py-1.5"
            >
              Undo edits
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
