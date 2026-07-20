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
  // True while the element is stalled waiting on audio bytes (synthesis of a
  // long paragraph can take 5 to 15 seconds server-side); surfaced in the UI so
  // a pipeline gap reads as buffering, never as the player dying (field bug:
  // "listen cuts out after a few paragraphs").
  const [buffering, setBuffering] = useState(false);
  // Set when audio.play() rejected (mobile user-activation expiry after a long
  // stall). The UI flips to Play with a visible nudge instead of claiming to
  // play silence.
  const [needsResume, setNeedsResume] = useState(false);
  // Set when the audio element failed to LOAD its source (a server 500 on the
  // paragraph, a dropped connection). Distinct from needsResume: tapping Play
  // cannot help until the source is refetched, so the UI offers Retry, which
  // reloads the element (field bug: a failed paragraph showed the browser
  // pause message and Play did nothing).
  const [loadError, setLoadError] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const indexRef = useRef(0);
  indexRef.current = index;
  const countRef = useRef(count);
  countRef.current = count;
  // Sequential warm-ahead bookkeeping: which paragraphs have been fetched (and
  // therefore synthesized into the server cache), and whether the single warm
  // loop is running. One request at a time: the synthesis service is the
  // bottleneck and parallel requests would just queue there anyway.
  const warmedRef = useRef<Set<number>>(new Set());
  const warmingRef = useRef(false);

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

  // Warms every remaining paragraph sequentially from the given index: each
  // fetch triggers on-miss synthesis into the server cache, so playback stops
  // outrunning the synthesizer (the field cutouts: short dialogue paragraphs
  // play in 3 to 5 seconds while the next synthesis takes 5 to 15, and a
  // one-ahead prefetch starves). One loop per mount; retries happen naturally
  // on demand when the audio element requests a paragraph the warm loop missed.
  const warmFrom = useCallback(
    async (start: number) => {
      if (warmingRef.current) return;
      warmingRef.current = true;
      try {
        for (let i = start; i < countRef.current; i += 1) {
          if (warmedRef.current.has(i)) continue;
          try {
            const r = await fetch(`/api/chapters/${chapterId}/audio/${i}`);
            if (r.ok) warmedRef.current.add(i);
          } catch {
            // Transient network failure: leave unwarmed; the element fetches on
            // demand and the buffering state covers the gap.
          }
        }
      } finally {
        warmingRef.current = false;
      }
    },
    [chapterId],
  );

  // Persist position and keep the warm-ahead loop running.
  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(posKey(chapterId), String(index));
    } catch {
      // Storage may be unavailable (private mode); resume is a nicety, not required.
    }
    void warmFrom(index + 1);
  }, [chapterId, index, ready, warmFrom]);

  // Drive the element from the playing/index state. A src change (index) reloads the
  // element, so re-issuing play here resumes at the new paragraph. A rejected
  // play() (mobile user-activation expiry after a stall) flips the UI to a
  // visible resume state instead of silently pretending to play.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.play().then(
        () => setNeedsResume(false),
        () => {
          setPlaying(false);
          setNeedsResume(true);
        },
      );
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
        onWaiting={() => setBuffering(true)}
        onStalled={() => setBuffering(true)}
        onCanPlay={() => {
          setBuffering(false);
          setLoadError(false);
        }}
        onPlaying={() => setBuffering(false)}
        onError={() => {
          setBuffering(false);
          setPlaying(false);
          setLoadError(true);
        }}
        onLoadedData={() => {
          if (audioRef.current) audioRef.current.playbackRate = rate;
        }}
      />

      <p data-testid="listen-position" className="text-lg text-muted">
        paragraph {index + 1} of {count}
      </p>

      {playing && buffering && (
        <p data-testid="listen-buffering" className="text-sm text-info-ink">
          Synthesizing paragraph {index + 1}... audio resumes automatically.
        </p>
      )}
      {needsResume && !loadError && (
        <p data-testid="listen-resume-note" className="text-sm text-warn-ink">
          Playback paused by the browser. Tap Play to continue.
        </p>
      )}
      {loadError && (
        <div data-testid="listen-load-error" className="text-center text-sm">
          <p className="text-danger-ink">
            Paragraph {index + 1} could not be loaded.
          </p>
          <button
            type="button"
            data-testid="listen-retry"
            onClick={() => {
              setLoadError(false);
              setNeedsResume(false);
              audioRef.current?.load();
              setPlaying(true);
            }}
            className="btn-secondary mt-2 px-4 py-1.5"
          >
            Retry
          </button>
        </div>
      )}

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
