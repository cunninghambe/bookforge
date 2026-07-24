"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LockPanel } from "./LockPanel";
import { VoiceNoteRecorder } from "./VoiceNoteRecorder";
import { paragraphIndexForOffset } from "@/lib/audio/paragraphs";
import { parseEmphasis } from "@/lib/markdown";
import { findSpan } from "@/lib/revision/spans";
import { decorateSegments, type ReviewAnchor } from "@/lib/reviewAnchors";

const CONTROL_DELIM = "\n<<<BOOKFORGE_CTRL>>>\n";

type Classification = "authorized" | "declared" | "unauthorized";

interface Hunk {
  index: number;
  oldStart: number;
  oldEnd: number;
  oldText: string;
  newText: string;
  classification: Classification;
  declaredBy?: string;
}

interface FailedPatch {
  original: string;
  replacement: string;
  reason: "not found" | "overlap";
  isConsistencyFix: boolean;
}

interface RevisionControl {
  revisionId: number;
  mode: "patch" | "full";
  hunks: Hunk[];
  unauthorizedCount: number;
  consistencyFixes: string[];
  failedPatches: FailedPatch[];
  retried: boolean;
  emDashUnresolved: boolean;
  // Set by GET /api/drafts/[id]/revision when a persisted pending revision is
  // restored after an interrupted call or a reload.
  restored?: boolean;
  error?: string;
}

interface CommentView {
  id: number;
  quotedText: string;
  comment: string;
  resolved: boolean;
  // A22: non-null makes this row a suggestion (the author's verbatim replacement).
  suggestedText: string | null;
}

interface PendingSelection {
  quotedText: string;
  start: number;
  end: number;
}

// A22.1: the floating popover shows a two-button toolbar over a fresh selection,
// then swaps in place to a comment or suggest composer.
type PopoverMode = "toolbar" | "comment" | "suggest";

// A22.1: where the popover anchors, in coordinates relative to the prose wrapper.
interface PopoverAnchor {
  left: number;
  top: number;
  bottom: number;
  // True when there is no room above the selection, so the popover flips below.
  flip: boolean;
}

// A22.2: the outcome of a mechanical apply-suggestions call.
interface SuggestionSkip {
  id: number;
  quotedText: string;
  suggestedText: string;
  reason: "not found" | "overlap";
}
interface SuggestionResult {
  applied: number;
  skips: SuggestionSkip[];
}

// A21: map a DOM selection endpoint inside the prose to a RAW content offset. The
// prose is rendered as emphasis segments, each wrapped in a `<span data-raw-start>`
// carrying the raw offset of its first visible character (markers removed). A
// segment's visible text is a contiguous run of the raw content, so the raw offset
// of an endpoint is the enclosing span's rawStart plus the endpoint's offset within
// that span's visible text. This keeps quotedText = content.slice(lo, hi) byte
// identical to the pre-A21 single-text-node behavior. Returns null when the
// endpoint is not inside a segment span (the caller then ignores the selection).
// A22.3: the anchor decoration splits segments at anchor boundaries, so there may
// be more, finer spans than in A21, but every one still carries a correct
// data-raw-start, so this mapping is unchanged.
function rawOffsetForEndpoint(
  root: HTMLElement,
  node: Node,
  offset: number,
): number | null {
  // Resolve the enclosing [data-raw-start] span.
  let span: HTMLElement | null = null;
  if (node.nodeType === Node.TEXT_NODE) {
    span =
      (node.parentElement?.closest("[data-raw-start]") as HTMLElement | null) ??
      null;
  } else if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as Element;
    const own = el.closest("[data-raw-start]") as HTMLElement | null;
    if (own && root.contains(own)) {
      span = own;
    } else {
      // The endpoint sits on the prose root or a wrapper: `offset` is a child
      // index into the segment spans. Map it to a segment boundary.
      const spans = root.querySelectorAll<HTMLElement>("[data-raw-start]");
      if (spans.length === 0) return null;
      if (offset >= spans.length) {
        const last = spans[spans.length - 1];
        return rawStartOf(last) + (last.textContent?.length ?? 0);
      }
      return rawStartOf(spans[Math.max(0, offset)]);
    }
  }
  if (!span || !root.contains(span)) return null;
  const base = rawStartOf(span);

  if (node.nodeType === Node.ELEMENT_NODE) {
    // `offset` is a child index within the span; sum the visible text before it.
    const before = Array.from(node.childNodes).slice(0, offset);
    const within = before.reduce(
      (n, c) => n + (c.textContent?.length ?? 0),
      0,
    );
    return base + within;
  }

  // Text-node endpoint: sum text-node lengths inside the span up to `node`, then
  // add `offset`. There is one visible text node per segment, so this is exact.
  let within = 0;
  const tw = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let cur = tw.nextNode();
  while (cur) {
    if (cur === node) return base + within + offset;
    within += cur.textContent?.length ?? 0;
    cur = tw.nextNode();
  }
  return base + within;
}

function rawStartOf(span: HTMLElement): number {
  const raw = Number(span.dataset.rawStart);
  return Number.isFinite(raw) ? raw : 0;
}

export function ReviewEditor({
  draftId: initialDraftId,
  initialContent,
  initialComments,
  chapterId,
  projectId,
  chapterStatus,
  chapterSummary,
  characters,
  voiceNotesEnabled = false,
}: {
  draftId: number;
  initialContent: string;
  initialComments: CommentView[];
  chapterId: number;
  projectId: number;
  chapterStatus: string;
  chapterSummary: string | null;
  characters: Array<{ id: number; name: string }>;
  voiceNotesEnabled?: boolean;
}) {
  const searchParams = useSearchParams();
  const fixtureKey = searchParams.get("fx") ?? undefined;

  const [draftId, setDraftId] = useState(initialDraftId);
  const [content, setContent] = useState(initialContent);
  const [comments, setComments] = useState<CommentView[]>(initialComments);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [commentText, setCommentText] = useState("");
  const [revising, setRevising] = useState(false);
  const [revision, setRevision] = useState<RevisionControl | null>(null);
  const [decisions, setDecisions] = useState<Record<number, "accept" | "reject">>(
    {},
  );
  const [saving, setSaving] = useState(false);
  const [savedVersion, setSavedVersion] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const proseRef = useRef<HTMLDivElement>(null);

  // A22 state: the inline popover, its anchor, the inline composer fields, the
  // apply-suggestions flow, and the anchor-click flash.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popover, setPopover] = useState<{ mode: PopoverMode } | null>(null);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  const [inlineComment, setInlineComment] = useState("");
  const [inlineSuggest, setInlineSuggest] = useState("");
  const [inlineNote, setInlineNote] = useState("");
  const [applying, setApplying] = useState(false);
  const [suggestionResult, setSuggestionResult] =
    useState<SuggestionResult | null>(null);
  const [flashedId, setFlashedId] = useState<number | null>(null);
  // A22.4: shortcut reminders show the platform's own modifier (the SearchTrigger
  // pattern); resolved in an effect so server and first client render agree.
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    setIsMac(/Mac/.test(navigator.userAgent));
  }, []);

  const unresolvedCount = comments.filter((c) => !c.resolved).length;
  // A22: the revise button consumes only plain comments; the apply button consumes
  // only suggestions. The lock gate keeps counting every unresolved row (via
  // unresolvedCount handed to LockPanel), so an unapplied suggestion still blocks.
  const unresolvedPlainCount = comments.filter(
    (c) => !c.resolved && c.suggestedText == null,
  ).length;
  const unresolvedSuggestionCount = comments.filter(
    (c) => !c.resolved && c.suggestedText != null,
  ).length;

  // A22.3: unresolved comments and suggestions become inline anchors, located with
  // the same findSpan the server uses, then rendered as tinted spans over the prose.
  const anchors = useMemo<ReviewAnchor[]>(() => {
    const result: ReviewAnchor[] = [];
    for (const c of comments) {
      if (c.resolved) continue;
      const span = findSpan(content, c.quotedText);
      if (!span) continue;
      result.push({
        id: c.id,
        start: span.start,
        end: span.end,
        kind: c.suggestedText != null ? "suggestion" : "comment",
      });
    }
    return result;
  }, [comments, content]);

  const anchorKind = useMemo(() => {
    const m = new Map<number, "comment" | "suggestion">();
    for (const a of anchors) m.set(a.id, a.kind);
    return m;
  }, [anchors]);

  // A21 + A22.3: the raw content rendered as emphasis segments, further split at
  // anchor boundaries. Each finer segment still carries its raw offset, so a
  // selection maps back to raw content offsets exactly as before.
  const anchored = useMemo(
    () => decorateSegments(content, anchors),
    [content, anchors],
  );

  // Whether a non-collapsed selection currently sits inside the prose. Used to gate
  // the single-key shortcuts (D179): they act only over a live prose selection.
  const proseSelectionActive = useCallback((): boolean => {
    const sel = window.getSelection();
    const root = proseRef.current;
    if (!sel || sel.rangeCount === 0 || !root) return false;
    const range = sel.getRangeAt(0);
    return (
      !range.collapsed &&
      root.contains(range.startContainer) &&
      root.contains(range.endContainer)
    );
  }, []);

  // Capture a text selection inside the prose so it survives clicking a button, and
  // position the floating popover from the selection's bounding rect (A22.1).
  useEffect(() => {
    function onSelectionChange() {
      const sel = window.getSelection();
      const root = proseRef.current;
      if (!sel || sel.rangeCount === 0 || !root) return;
      const range = sel.getRangeAt(0);
      if (
        range.collapsed ||
        !root.contains(range.startContainer) ||
        !root.contains(range.endContainer)
      ) {
        // The prose selection is gone. Hide only the bare toolbar; an open composer
        // stays put (the caret is now inside it), and pending keeps its last value.
        setPopover((cur) => (cur?.mode === "toolbar" ? null : cur));
        return;
      }
      const start = rawOffsetForEndpoint(root, range.startContainer, range.startOffset);
      const end = rawOffsetForEndpoint(root, range.endContainer, range.endOffset);
      if (start === null || end === null) return;
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      const quotedText = content.slice(lo, hi);
      if (quotedText.trim().length === 0) return;
      setPending({ quotedText, start: lo, end: hi });

      const wrap = wrapperRef.current;
      if (wrap) {
        const rect = range.getBoundingClientRect();
        const wrapRect = wrap.getBoundingClientRect();
        const half = 110;
        const maxLeft = Math.max(half, wrapRect.width - half);
        const rawLeft = rect.left - wrapRect.left + rect.width / 2;
        setAnchor({
          left: Math.min(Math.max(rawLeft, half), maxLeft),
          top: rect.top - wrapRect.top,
          bottom: rect.bottom - wrapRect.top,
          flip: rect.top - wrapRect.top < 160,
        });
      }
      // Show the toolbar for a fresh selection; leave an open composer alone.
      setPopover((cur) =>
        cur === null || cur.mode === "toolbar" ? { mode: "toolbar" } : cur,
      );
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [content]);

  // A22.1: open a composer for the current pending selection.
  const openComposer = useCallback(
    (mode: "comment" | "suggest") => {
      if (!pending) return;
      if (mode === "comment") {
        setInlineComment("");
      } else {
        setInlineSuggest(pending.quotedText);
        setInlineNote("");
      }
      setPopover({ mode });
    },
    [pending],
  );

  const closePopover = useCallback(() => setPopover(null), []);

  // A22.1: single-key shortcuts. c opens the comment composer, e the suggest
  // composer, but only over a live prose selection with focus outside any field, so
  // they can never eat typed text (D179). Escape closes an open composer.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const active = document.activeElement as HTMLElement | null;
      const inField =
        !!active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable);
      if (popover?.mode === "comment" || popover?.mode === "suggest") {
        // The composer handles Ctrl+Enter and Escape while focused; also honor a
        // global Escape if focus somehow left the composer.
        if (e.key === "Escape" && !inField) {
          e.preventDefault();
          closePopover();
        }
        return;
      }
      if (inField) return;
      if (!proseSelectionActive() || !pending) return;
      if (e.key === "c") {
        e.preventDefault();
        openComposer("comment");
      } else if (e.key === "e") {
        e.preventDefault();
        openComposer("suggest");
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [popover, pending, openComposer, closePopover, proseSelectionActive]);

  // A22.1: clicking outside the popover cancels it.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!popover) return;
      const pop = popoverRef.current;
      if (pop && pop.contains(e.target as Node)) return;
      closePopover();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [popover, closePopover]);

  async function refreshComments(id: number) {
    const res = await fetch(`/api/drafts/${id}/comments`);
    if (!res.ok) return;
    const data = (await res.json()) as {
      comments: Array<{
        id: number;
        quotedText: string;
        comment: string;
        resolved: number;
        suggestedText: string | null;
      }>;
    };
    setComments(
      data.comments.map((c) => ({
        id: c.id,
        quotedText: c.quotedText,
        comment: c.comment,
        resolved: c.resolved === 1,
        suggestedText: c.suggestedText ?? null,
      })),
    );
  }

  async function addComment() {
    if (!pending || commentText.trim().length === 0) return;
    const res = await fetch(`/api/drafts/${draftId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quotedText: pending.quotedText,
        comment: commentText,
        spanStart: pending.start,
        spanEnd: pending.end,
      }),
    });
    if (res.ok) {
      setCommentText("");
      setPending(null);
      await refreshComments(draftId);
    }
  }

  // A22.1: submit the inline composer. Comment mode posts a plain comment; suggest
  // mode posts a suggestion (the note is optional). Both hit the same endpoint the
  // static panel uses, then refresh the sidebar.
  async function submitComposer() {
    if (!pending || !popover) return;
    const body =
      popover.mode === "comment"
        ? {
            quotedText: pending.quotedText,
            comment: inlineComment,
            spanStart: pending.start,
            spanEnd: pending.end,
          }
        : {
            quotedText: pending.quotedText,
            comment: inlineNote,
            suggestedText: inlineSuggest,
            spanStart: pending.start,
            spanEnd: pending.end,
          };
    if (popover.mode === "comment" && inlineComment.trim().length === 0) return;
    if (
      popover.mode === "suggest" &&
      (inlineSuggest.trim().length === 0 || inlineSuggest === pending.quotedText)
    ) {
      return;
    }
    const res = await fetch(`/api/drafts/${draftId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      setInlineComment("");
      setInlineSuggest("");
      setInlineNote("");
      setPopover(null);
      await refreshComments(draftId);
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Could not save.");
    }
  }

  function onComposerKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      closePopover();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submitComposer();
    }
  }

  const composerReady =
    popover?.mode === "comment"
      ? inlineComment.trim().length > 0
      : popover?.mode === "suggest"
        ? inlineSuggest.trim().length > 0 &&
          !!pending &&
          inlineSuggest !== pending.quotedText
        : false;

  async function resolveComment(id: number) {
    const res = await fetch(`/api/comments/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved: true }),
    });
    if (res.ok) await refreshComments(draftId);
  }

  // A22.3: scroll the matching sidebar card into view and flash it.
  function flashCard(id: number) {
    const el = document.getElementById(`comment-card-${id}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashedId(id);
    window.setTimeout(
      () => setFlashedId((cur) => (cur === id ? null : cur)),
      1200,
    );
  }

  // A22.2: apply the author's suggestions mechanically (no model call). The prose
  // swaps to the new version, a banner reports the count, and skips are listed.
  async function applySuggestions() {
    if (applying || unresolvedSuggestionCount === 0) return;
    setApplying(true);
    setError(null);
    setSuggestionResult(null);
    try {
      const res = await fetch(`/api/drafts/${draftId}/apply-suggestions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (res.ok) {
        const data = (await res.json()) as {
          draft: { id: number; content: string };
          applied: number;
          skips: SuggestionSkip[];
        };
        setContent(data.draft.content);
        setDraftId(data.draft.id);
        setSuggestionResult({ applied: data.applied, skips: data.skips });
        await refreshComments(data.draft.id);
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Could not apply suggestions.");
      }
    } finally {
      setApplying(false);
    }
  }

  // Loads a persisted pending revision, if any, into the resolution UI. Used on
  // mount (a pending revision survives reloads and interrupted calls; the field
  // report was a 103-second call whose response the phone browser lost, leaving
  // durable server state with no way to reach it) and as recovery after a
  // failed revise() call.
  const loadPendingRevision = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/drafts/${draftId}/revision`);
      if (!res.ok) return false;
      const data = (await res.json()) as { revision: RevisionControl | null };
      if (data.revision) {
        setRevision(data.revision);
        setDecisions({});
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [draftId]);

  useEffect(() => {
    void loadPendingRevision();
  }, [loadPendingRevision]);

  async function revise() {
    if (revising || unresolvedPlainCount === 0) return;
    setRevising(true);
    setError(null);
    setRevision(null);
    setDecisions({});
    setSavedVersion(false);

    // Fully guarded (the chat-audit pattern): any mid-stream failure lands in
    // the catch, which then checks whether the revision completed server-side
    // anyway and restores it, so a dropped connection can no longer strand a
    // pending revision behind a silent UI.
    try {
      const res = await fetch(`/api/drafts/${draftId}/revise`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fixtureKey }),
      });
      if (!res.body) {
        setError("No response body from revise.");
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      const delimIdx = buffer.indexOf(CONTROL_DELIM);
      if (delimIdx === -1) {
        setError("Revision stream ended without a control frame.");
        return;
      }
      const control = JSON.parse(
        buffer.slice(delimIdx + CONTROL_DELIM.length),
      ) as RevisionControl;
      if (control.error) {
        setError(`Revision error: ${control.error}`);
      } else {
        setRevision(control);
      }
    } catch {
      const recovered = await loadPendingRevision();
      setError(
        recovered
          ? "The connection dropped mid-revision, but the revision completed and was restored below."
          : "The connection dropped during the revision. If it completed, reloading this page will show the proposed changes.",
      );
    } finally {
      setRevising(false);
    }
  }

  function decide(index: number, decision: "accept" | "reject") {
    setDecisions((prev) => ({ ...prev, [index]: decision }));
  }

  const unauthorized = useMemo(
    () => revision?.hunks.filter((h) => h.classification === "unauthorized") ?? [],
    [revision],
  );
  const authorizedOrDeclared = useMemo(
    () => revision?.hunks.filter((h) => h.classification !== "unauthorized") ?? [],
    [revision],
  );
  const allResolved = unauthorized.every((h) => decisions[h.index] !== undefined);

  async function saveRevision() {
    if (!revision || saving || !allResolved) return;
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/revisions/${revision.revisionId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions }),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        draft: { id: number; content: string };
      };
      setContent(data.draft.content);
      setDraftId(data.draft.id);
      // A revision creates a new version; comments do not carry forward.
      setComments([]);
      setRevision(null);
      setDecisions({});
      setSavedVersion(true);
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Could not save the revision.");
    }
    setSaving(false);
  }

  return (
    <div className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-[1fr_20rem]">
      <div>
        {error && (
          <div
            data-testid="review-error"
            className="mb-3 rounded border border-danger-edge bg-danger px-3 py-2 text-sm text-danger-ink"
          >
            {error}
          </div>
        )}
        {savedVersion && (
          <div
            data-testid="revision-saved"
            className="mb-3 rounded border border-ok-edge bg-ok px-3 py-2 text-sm text-ok-ink"
          >
            Saved as a new draft version.
          </div>
        )}

        {suggestionResult && (
          <div className="mb-3">
            <div
              data-testid="suggestions-applied"
              className="rounded border border-ok-edge bg-ok px-3 py-2 text-sm text-ok-ink"
            >
              {suggestionResult.applied} suggestion
              {suggestionResult.applied === 1 ? "" : "s"} applied as a new draft
              version.
            </div>
            {suggestionResult.skips.length > 0 && (
              <div
                data-testid="suggestion-skips"
                className="mt-2 rounded border border-warn-edge bg-warn p-3 text-sm text-warn-ink"
              >
                <p className="mb-2 font-medium">
                  {suggestionResult.skips.length} suggestion
                  {suggestionResult.skips.length === 1 ? "" : "s"} could not be
                  applied and{" "}
                  {suggestionResult.skips.length === 1 ? "was" : "were"} skipped.
                </p>
                <ul className="space-y-2">
                  {suggestionResult.skips.map((s, i) => (
                    <li
                      key={i}
                      data-testid={`suggestion-skip-${i}`}
                      className="rounded border border-warn-edge bg-surface p-2"
                    >
                      <p className="text-xs uppercase text-faint">{s.reason}</p>
                      <p className="mt-1 text-ink">
                        <span className="text-faint">original: </span>
                        {s.quotedText}
                      </p>
                      <p className="text-ink">
                        <span className="text-faint">replacement: </span>
                        {s.suggestedText}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div ref={wrapperRef} className="relative">
          <div
            ref={proseRef}
            data-testid="review-prose"
            className="max-w-[70ch] whitespace-pre-wrap rounded border border-edge bg-surface p-4 font-serif text-[15px] leading-relaxed text-ink"
          >
            {anchored.map((seg, i) => {
              const hasAnchor = seg.anchorIds.length > 0;
              const kind = hasAnchor
                ? seg.anchorIds.some(
                    (id) => anchorKind.get(id) === "suggestion",
                  )
                  ? "suggestion"
                  : "comment"
                : null;
              const flashing =
                flashedId !== null && seg.anchorIds.includes(flashedId);
              const cls = [
                hasAnchor ? "cursor-pointer rounded-[2px]" : "",
                kind === "suggestion"
                  ? "bg-info-chip"
                  : kind === "comment"
                    ? "bg-warn-chip"
                    : "",
                flashing ? "ring-2 ring-focus" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <span
                  key={i}
                  data-raw-start={seg.rawStart}
                  data-anchor-ids={
                    hasAnchor ? seg.anchorIds.join(",") : undefined
                  }
                  className={cls || undefined}
                  onClick={
                    hasAnchor ? () => flashCard(seg.anchorIds[0]) : undefined
                  }
                >
                  {seg.kind === "italic" ? (
                    <em>{seg.text}</em>
                  ) : seg.kind === "bold" ? (
                    <strong>{seg.text}</strong>
                  ) : (
                    seg.text
                  )}
                </span>
              );
            })}
          </div>

          {popover && anchor && (
            <div
              ref={popoverRef}
              className="absolute z-20"
              style={{
                left: `${anchor.left}px`,
                top: `${anchor.flip ? anchor.bottom + 8 : anchor.top - 8}px`,
                transform: anchor.flip
                  ? "translate(-50%, 0)"
                  : "translate(-50%, -100%)",
              }}
            >
              {popover.mode === "toolbar" && (
                <div
                  data-testid="selection-toolbar"
                  className="flex items-center gap-1 rounded-lg border border-edge bg-surface p-1 shadow-lg"
                >
                  <button
                    data-testid="toolbar-comment-button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => openComposer("comment")}
                    className="flex items-center gap-1.5 rounded px-2 py-1 text-sm text-ink hover:bg-inset"
                  >
                    Comment <Kbd>c</Kbd>
                  </button>
                  <button
                    data-testid="toolbar-suggest-button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => openComposer("suggest")}
                    className="flex items-center gap-1.5 rounded px-2 py-1 text-sm text-ink hover:bg-inset"
                  >
                    Suggest edit <Kbd>e</Kbd>
                  </button>
                </div>
              )}

              {(popover.mode === "comment" || popover.mode === "suggest") && (
                <div
                  data-testid="inline-composer"
                  onKeyDown={onComposerKeyDown}
                  className="w-72 rounded-lg border border-edge bg-surface p-2 shadow-lg"
                >
                  {popover.mode === "comment" ? (
                    <>
                      <p className="mb-1 rounded bg-warn px-2 py-1 text-xs text-warn-ink">
                        <EmphasisText text={pending?.quotedText ?? ""} />
                      </p>
                      <textarea
                        aria-label="Inline comment"
                        data-testid="inline-comment-input"
                        autoFocus
                        value={inlineComment}
                        onChange={(e) => setInlineComment(e.target.value)}
                        rows={3}
                        className="w-full rounded border border-edge p-2 text-sm"
                        placeholder="What should change about this span?"
                      />
                    </>
                  ) : (
                    <>
                      <p className="mb-1 text-xs uppercase tracking-wide text-faint">
                        Replacement text
                      </p>
                      <textarea
                        aria-label="Inline suggestion"
                        data-testid="inline-suggest-input"
                        autoFocus
                        value={inlineSuggest}
                        onChange={(e) => setInlineSuggest(e.target.value)}
                        rows={3}
                        className="w-full rounded border border-edge p-2 font-serif text-sm"
                        placeholder="Type the exact replacement."
                      />
                      <textarea
                        aria-label="Inline note"
                        data-testid="inline-note-input"
                        value={inlineNote}
                        onChange={(e) => setInlineNote(e.target.value)}
                        rows={2}
                        className="mt-1 w-full rounded border border-edge p-2 text-sm"
                        placeholder="Optional note"
                      />
                    </>
                  )}
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-xs text-faint">
                      <Kbd>{isMac ? "⌘+Enter" : "Ctrl+Enter"}</Kbd> to save,{" "}
                      <Kbd>Esc</Kbd> to cancel
                    </span>
                    <button
                      data-testid="inline-composer-submit"
                      onClick={submitComposer}
                      disabled={!composerReady}
                      className="rounded bg-accent hover:bg-accent-hover px-3 py-1 text-sm text-accent-ink disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <p
          data-testid="shortcut-hints"
          className="mt-2 hidden text-xs text-faint sm:block"
        >
          Select a passage, then press <Kbd>c</Kbd> to comment or <Kbd>e</Kbd>{" "}
          to suggest an edit. <Kbd>{isMac ? "⌘+Enter" : "Ctrl+Enter"}</Kbd>{" "}
          saves, <Kbd>Esc</Kbd> cancels.
        </p>

        <div className="mt-3 rounded border border-edge-soft p-3">
          <p className="mb-2 text-xs uppercase tracking-wide text-faint">
            Selected span
          </p>
          {pending ? (
            <p
              data-testid="selected-span"
              className="mb-2 rounded bg-warn px-2 py-1 text-sm text-warn-ink"
            >
              <EmphasisText text={pending.quotedText} />
            </p>
          ) : (
            <p className="mb-2 text-sm text-faint">
              Select text above to attach a comment.
            </p>
          )}
          <textarea
            aria-label="Comment"
            data-testid="comment-input"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            rows={2}
            className="w-full rounded border border-edge p-2 text-sm"
            placeholder="What should change about this span?"
          />
          <button
            data-testid="add-comment-button"
            onClick={addComment}
            disabled={!pending || commentText.trim().length === 0}
            className="mt-2 rounded bg-accent hover:bg-accent-hover px-3 py-1.5 text-sm text-accent-ink disabled:opacity-50"
          >
            Add comment
          </button>
        </div>

        {revising && (
          <div
            data-testid="revision-in-progress"
            className="mt-4 rounded border border-info-edge bg-info px-3 py-2 text-sm text-info-ink"
          >
            Revising in patch mode. Applying the smallest set of changes...
          </div>
        )}

        {revision && (
          <div className="mt-4" data-testid="revision-panel">
            <div
              data-testid="revision-mode"
              className="mb-3 inline-block rounded border border-edge bg-inset px-2 py-0.5 text-xs uppercase tracking-wide text-muted"
            >
              {revision.mode === "patch" ? "patch revision" : "full revision"}
            </div>
            {revision.failedPatches.length > 0 && (
              <div
                data-testid="failed-patches"
                className="mb-3 rounded border border-warn-edge bg-warn p-3 text-sm text-warn-ink"
              >
                <p className="mb-2 font-medium">
                  {revision.failedPatches.length} patch
                  {revision.failedPatches.length === 1 ? "" : "es"} could not be
                  anchored and {revision.failedPatches.length === 1 ? "was" : "were"}{" "}
                  skipped. The remaining changes still applied.
                </p>
                <ul className="space-y-2">
                  {revision.failedPatches.map((p, i) => (
                    <li
                      key={i}
                      data-testid={`failed-patch-${i}`}
                      className="rounded border border-warn-edge bg-surface p-2"
                    >
                      <p className="text-xs uppercase text-faint">
                        {p.reason}
                        {p.isConsistencyFix ? " (consistency fix)" : ""}
                      </p>
                      <p className="mt-1 text-ink">
                        <span className="text-faint">original: </span>
                        {p.original}
                      </p>
                      <p className="text-ink">
                        <span className="text-faint">replacement: </span>
                        {p.replacement}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {revision.restored && (
              <div
                data-testid="revision-restored"
                className="mb-3 rounded border border-info-edge bg-info px-3 py-2 text-sm text-info-ink"
              >
                A pending revision from an earlier run was restored. Review and
                resolve the proposed changes below; nothing has been applied yet.
              </div>
            )}
            {revision.retried && (
              <div
                data-testid="revision-retry-alert"
                className="mb-3 rounded border border-info-edge bg-info px-3 py-2 text-sm text-info-ink"
              >
                An em-dash was detected and the revision was regenerated without it.
              </div>
            )}
            {revision.emDashUnresolved && (
              <div
                data-testid="revision-emdash-unresolved"
                className="mb-3 rounded border border-warn-edge bg-warn px-3 py-2 text-sm text-warn-ink"
              >
                The regenerated revision still contains an em-dash. Edit it out
                before saving.
              </div>
            )}
            {unauthorized.length > 0 ? (
              <div
                data-testid="unauthorized-panel"
                className="rounded border border-warn-edge bg-warn p-3"
              >
                <p className="mb-2 font-medium text-warn-ink">
                  {unauthorized.length} unauthorized change
                  {unauthorized.length === 1 ? "" : "s"} detected. Resolve each
                  before saving.
                </p>
                <ul className="space-y-3">
                  {unauthorized.map((h) => (
                    <li
                      key={h.index}
                      data-testid={`hunk-${h.index}`}
                      className="rounded border border-warn-edge bg-surface p-2 text-sm"
                    >
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <p className="mb-1 text-xs uppercase text-faint">
                            Original
                          </p>
                          <p
                            data-testid={`hunk-old-${h.index}`}
                            className="whitespace-pre-wrap text-ink"
                          >
                            {h.oldText}
                          </p>
                        </div>
                        <div>
                          <p className="mb-1 text-xs uppercase text-faint">
                            Revised
                          </p>
                          <p
                            data-testid={`hunk-new-${h.index}`}
                            className="whitespace-pre-wrap text-ink"
                          >
                            {h.newText}
                          </p>
                        </div>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          data-testid={`accept-hunk-${h.index}`}
                          onClick={() => decide(h.index, "accept")}
                          className={`rounded border px-2 py-1 text-xs ${
                            decisions[h.index] === "accept"
                              ? "border-ok-strong bg-ok-chip text-ok-ink"
                              : "border-edge"
                          }`}
                        >
                          Accept
                        </button>
                        <button
                          data-testid={`reject-hunk-${h.index}`}
                          onClick={() => decide(h.index, "reject")}
                          className={`rounded border px-2 py-1 text-xs ${
                            decisions[h.index] === "reject"
                              ? "border-danger-strong bg-danger-chip text-danger-ink"
                              : "border-edge"
                          }`}
                        >
                          Reject (restore original)
                        </button>
                        {decisions[h.index] && (
                          <span
                            data-testid={`hunk-decided-${h.index}`}
                            className="text-xs text-muted"
                          >
                            {decisions[h.index]}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div
                data-testid="no-unauthorized"
                className="rounded border border-ok-edge bg-ok px-3 py-2 text-sm text-ok-ink"
              >
                No unauthorized changes. Every change is within a flagged span or a
                declared consistency fix.
              </div>
            )}

            <div className="mt-3 text-xs text-muted" data-testid="authorized-summary">
              {authorizedOrDeclared.length} authorized or declared change
              {authorizedOrDeclared.length === 1 ? "" : "s"} will be kept.
            </div>

            <button
              data-testid="save-revision-button"
              onClick={saveRevision}
              disabled={!allResolved || saving}
              className="mt-3 rounded bg-accent hover:bg-accent-hover px-4 py-1.5 text-accent-ink disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save revision as new version"}
            </button>
          </div>
        )}
      </div>

      <aside className="text-sm">
        {voiceNotesEnabled && (
          <div className="mb-4 rounded border border-edge-soft p-3">
            <p className="mb-2 text-xs uppercase tracking-wide text-faint">
              Voice note
            </p>
            <VoiceNoteRecorder
              chapterId={chapterId}
              getParagraphIndex={() =>
                pending ? paragraphIndexForOffset(content, pending.start) : 0
              }
              onSaved={() => refreshComments(draftId)}
            />
          </div>
        )}
        <h2 className="mb-2 text-xs uppercase tracking-wide text-faint">
          Comments
        </h2>
        <ul className="space-y-2" data-testid="comment-list">
          {comments.length === 0 && (
            <li className="text-muted" data-testid="no-comments">
              No comments yet. Select a span in the prose to flag what should change.
            </li>
          )}
          {comments.map((c) => (
            <li
              key={c.id}
              id={`comment-card-${c.id}`}
              data-testid={`comment-${c.id}`}
              className={`rounded border p-2 ${
                c.resolved
                  ? "border-edge-soft bg-inset text-faint"
                  : "border-edge"
              } ${flashedId === c.id ? "ring-2 ring-focus" : ""}`}
            >
              {c.suggestedText != null && (
                <span
                  data-testid={`suggestion-badge-${c.id}`}
                  className="mb-1 inline-block rounded bg-info-chip px-1.5 py-0.5 text-xs uppercase tracking-wide text-info-ink"
                >
                  Suggestion
                </span>
              )}
              <p className="mb-1 text-xs italic text-muted">
                &ldquo;<EmphasisText text={c.quotedText} />&rdquo;
              </p>
              {c.suggestedText != null && (
                <p className="mb-1 text-sm" data-testid={`suggestion-replacement-${c.id}`}>
                  <span className="text-faint">replace with: </span>
                  <EmphasisText text={c.suggestedText} />
                </p>
              )}
              {c.comment.trim().length > 0 && <p className="mb-1">{c.comment}</p>}
              {c.resolved ? (
                <span className="text-xs text-ok-ink">resolved</span>
              ) : (
                <button
                  data-testid={`resolve-comment-${c.id}`}
                  onClick={() => resolveComment(c.id)}
                  className="rounded border border-edge px-2 py-0.5 text-xs"
                >
                  Resolve
                </button>
              )}
            </li>
          ))}
        </ul>

        <button
          data-testid="revise-button"
          onClick={revise}
          disabled={revising || unresolvedPlainCount === 0}
          className="mt-4 w-full rounded bg-accent hover:bg-accent-hover px-3 py-2 text-accent-ink disabled:opacity-50"
        >
          {revising ? "Revising..." : "Revise flagged spans"}
        </button>
        {unresolvedPlainCount === 0 && (
          <p className="mt-1 text-xs text-faint">
            Add at least one unresolved comment to revise.
          </p>
        )}

        <button
          data-testid="apply-suggestions-button"
          onClick={applySuggestions}
          disabled={applying || unresolvedSuggestionCount === 0}
          className="mt-2 w-full rounded bg-accent hover:bg-accent-hover px-3 py-2 text-accent-ink disabled:opacity-50"
        >
          {applying ? "Applying..." : "Apply suggestions"}
        </button>
        {unresolvedSuggestionCount === 0 && (
          <p className="mt-1 text-xs text-faint">
            Suggest an exact replacement to apply it without a model call.
          </p>
        )}

        <LockPanel
          chapterId={chapterId}
          projectId={projectId}
          initialStatus={chapterStatus}
          initialSummary={chapterSummary}
          unresolvedCount={unresolvedCount}
          characters={characters}
          fixtureKey={fixtureKey}
        />
      </aside>
    </div>
  );
}

// A22.4: a small key-cap chip for the on-screen shortcut reminders.
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-edge bg-inset px-1 font-sans text-[11px] text-muted">
      {children}
    </kbd>
  );
}

// A21: render a raw string as emphasis (plain / italic / bold) through the same
// parser the review surface uses, so the pending-selection preview and the stored
// comment quotes never show a literal emphasis marker.
function EmphasisText({ text }: { text: string }) {
  return (
    <>
      {parseEmphasis(text).map((seg, i) =>
        seg.kind === "italic" ? (
          <em key={i}>{seg.text}</em>
        ) : seg.kind === "bold" ? (
          <strong key={i}>{seg.text}</strong>
        ) : (
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
    </>
  );
}
