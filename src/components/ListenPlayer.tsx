"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { VoiceNoteRecorder } from "./VoiceNoteRecorder";

// Phone-first sequential audio player for a chapter's latest draft (A14). Plays one
// paragraph at a time, auto-advancing on end, with play/pause, previous/next, and a
// client-side speed control (playbackRate is free). It prefetches the next
// paragraph while the current one plays so on-miss synthesis latency hides, and it
// persists the position per chapter in localStorage so leaving and returning
// resumes. A hold-to-record voice-note button sits alongside when STT is configured.

const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;

function posKey(chapterId: number): string {
  return `bookforge_listen_pos_${chapterId}`;
}

export function ListenPlayer({
  chapterId,
  projectId,
  heading,
  initialParagraphCount,
  initialFormat,
  voiceNotesEnabled,
}: {
  chapterId: number;
  projectId: number;
  heading: string;
  initialParagraphCount: number;
  initialFormat: string;
  voiceNotesEnabled: boolean;
}) {
  const [count, setCount] = useState(initialParagraphCount);
  const [format, setFormat] = useState(initialFormat);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [ready, setReady] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const indexRef = useRef(0);
  indexRef.current = index;

  const src = `/api/chapters/${chapterId}/audio/${index}`;

  // Resume the saved position (clamped to the current paragraph range) once on
  // mount, then refresh count and format from the manifest.
  useEffect(() => {
    let restored = 0;
    try {
      const raw = window.localStorage.getItem(posKey(chapterId));
      const parsed = raw === null ? 0 : Number(raw);
      if (Number.isInteger(parsed) && parsed >= 0) restored = parsed;
    } catch {
      restored = 0;
    }
    setIndex(Math.min(restored, Math.max(0, initialParagraphCount - 1)));
    setReady(true);

    void fetch(`/api/chapters/${chapterId}/audio-manifest`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m: { paragraphCount?: number; format?: string } | null) => {
        if (!m) return;
        if (typeof m.paragraphCount === "number") setCount(m.paragraphCount);
        if (typeof m.format === "string") setFormat(m.format);
      })
      .catch(() => undefined);
  }, [chapterId, initialParagraphCount]);

  // Persist position and prefetch the next paragraph to hide synthesis latency.
  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(posKey(chapterId), String(index));
    } catch {
      // Storage may be unavailable (private mode); resume is a nicety, not required.
    }
    if (index + 1 < count) {
      void fetch(`/api/chapters/${chapterId}/audio/${index + 1}`).catch(
        () => undefined,
      );
    }
  }, [chapterId, index, count, ready]);

  // Drive the element from the playing/index state. A src change (index) reloads the
  // element, so re-issuing play here resumes at the new paragraph.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      void audio.play().catch(() => undefined);
    } else {
      audio.pause();
    }
  }, [playing, index]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate, index]);

  const goNext = useCallback(() => {
    setIndex((i) => (i + 1 < count ? i + 1 : i));
  }, [count]);

  const goPrev = useCallback(() => {
    setIndex((i) => (i > 0 ? i - 1 : i));
  }, []);

  const onEnded = useCallback(() => {
    if (indexRef.current + 1 < count) {
      setIndex((i) => i + 1);
    } else {
      setPlaying(false);
    }
  }, [count]);

  if (count === 0) {
    return (
      <div data-testid="listen-empty" className="mt-8 text-center text-muted">
        <p>This chapter has no draft to listen to yet.</p>
        <Link
          href={`/book/${projectId}/chapter/${chapterId}/draft`}
          className="btn-quiet mt-3 inline-block"
        >
          Go to the draft
        </Link>
      </div>
    );
  }

  return (
    <div
      data-testid="listen-player"
      data-playing={playing ? "true" : "false"}
      data-paragraph={index}
      className="mx-auto mt-6 flex max-w-md flex-col items-center gap-6"
    >
      <audio
        ref={audioRef}
        data-testid="listen-audio"
        src={src}
        preload="auto"
        onEnded={onEnded}
        onLoadedData={() => {
          if (audioRef.current) audioRef.current.playbackRate = rate;
        }}
      />

      <p data-testid="listen-position" className="text-lg text-muted">
        paragraph {index + 1} of {count}
      </p>

      <div className="flex items-center gap-4">
        <button
          type="button"
          data-testid="listen-prev"
          onClick={goPrev}
          disabled={index === 0}
          className="btn-secondary h-14 w-14 text-lg disabled:opacity-40"
          aria-label="Previous paragraph"
        >
          Prev
        </button>
        <button
          type="button"
          data-testid="listen-play"
          onClick={() => setPlaying((p) => !p)}
          className="btn-primary h-20 w-20 text-lg"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          data-testid="listen-next"
          onClick={goNext}
          disabled={index + 1 >= count}
          className="btn-secondary h-14 w-14 text-lg disabled:opacity-40"
          aria-label="Next paragraph"
        >
          Next
        </button>
      </div>

      <label className="flex items-center gap-2 text-sm text-muted">
        Speed
        <select
          data-testid="listen-speed"
          value={rate}
          onChange={(e) => setRate(Number(e.target.value))}
          className="rounded border border-edge bg-surface px-2 py-1 text-ink"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
      </label>

      <p className="text-xs text-faint" data-testid="listen-format">
        Format: {format}
      </p>

      {voiceNotesEnabled && (
        <div className="w-full border-t border-edge-soft pt-4">
          <p className="mb-2 text-xs uppercase tracking-wide text-faint">
            Speak a note about this paragraph
          </p>
          <VoiceNoteRecorder
            chapterId={chapterId}
            getParagraphIndex={() => indexRef.current}
          />
        </div>
      )}

      <Link
        href={`/book/${projectId}/chapter/${chapterId}/review`}
        className="btn-quiet text-sm"
        data-testid="listen-review-link"
      >
        Back to review
      </Link>
    </div>
  );
}
