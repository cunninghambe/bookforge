"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LockPanel } from "./LockPanel";
import { VoiceNoteRecorder } from "./VoiceNoteRecorder";
import { paragraphIndexForOffset } from "@/lib/audio/paragraphs";

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
  error?: string;
}

interface CommentView {
  id: number;
  quotedText: string;
  comment: string;
  resolved: boolean;
}

interface PendingSelection {
  quotedText: string;
  start: number;
  end: number;
}

// Offset of a node/offset pair within a root, summing the length of every text
// node that precedes it. Works whether the prose is one text node or several.
function offsetWithin(root: Node, node: Node, offset: number): number {
  let total = 0;
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = tw.nextNode();
  while (current) {
    if (current === node) return total + offset;
    total += current.textContent?.length ?? 0;
    current = tw.nextNode();
  }
  return total;
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

  const unresolvedCount = comments.filter((c) => !c.resolved).length;

  // Capture a text selection inside the prose so it survives clicking a button.
  useEffect(() => {
    function onSelectionChange() {
      const sel = window.getSelection();
      const root = proseRef.current;
      if (!sel || sel.rangeCount === 0 || !root) return;
      const range = sel.getRangeAt(0);
      if (range.collapsed) return;
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
        return;
      }
      const start = offsetWithin(root, range.startContainer, range.startOffset);
      const end = offsetWithin(root, range.endContainer, range.endOffset);
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      const quotedText = content.slice(lo, hi);
      if (quotedText.trim().length === 0) return;
      setPending({ quotedText, start: lo, end: hi });
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [content]);

  async function refreshComments(id: number) {
    const res = await fetch(`/api/drafts/${id}/comments`);
    if (!res.ok) return;
    const data = (await res.json()) as {
      comments: Array<{
        id: number;
        quotedText: string;
        comment: string;
        resolved: number;
      }>;
    };
    setComments(
      data.comments.map((c) => ({
        id: c.id,
        quotedText: c.quotedText,
        comment: c.comment,
        resolved: c.resolved === 1,
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

  async function resolveComment(id: number) {
    const res = await fetch(`/api/comments/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved: true }),
    });
    if (res.ok) await refreshComments(draftId);
  }

  async function revise() {
    if (revising || unresolvedCount === 0) return;
    setRevising(true);
    setError(null);
    setRevision(null);
    setDecisions({});
    setSavedVersion(false);

    const res = await fetch(`/api/drafts/${draftId}/revise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixtureKey }),
    });
    if (!res.body) {
      setRevising(false);
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
      setRevising(false);
      setError("Revision stream ended without a control frame.");
      return;
    }
    try {
      const control = JSON.parse(
        buffer.slice(delimIdx + CONTROL_DELIM.length),
      ) as RevisionControl;
      if (control.error) {
        setError(`Revision error: ${control.error}`);
      } else {
        setRevision(control);
      }
    } catch {
      setError("Could not parse the revision control frame.");
    }
    setRevising(false);
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
    <div className="mt-4 grid grid-cols-[1fr_20rem] gap-6">
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

        <div
          ref={proseRef}
          data-testid="review-prose"
          className="max-w-[70ch] whitespace-pre-wrap rounded border border-edge bg-surface p-4 font-serif text-[15px] leading-relaxed text-ink"
        >
          {content}
        </div>

        <div className="mt-3 rounded border border-edge-soft p-3">
          <p className="mb-2 text-xs uppercase tracking-wide text-faint">
            Selected span
          </p>
          {pending ? (
            <p
              data-testid="selected-span"
              className="mb-2 rounded bg-warn px-2 py-1 text-sm text-warn-ink"
            >
              {pending.quotedText}
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
              data-testid={`comment-${c.id}`}
              className={`rounded border p-2 ${
                c.resolved
                  ? "border-edge-soft bg-inset text-faint"
                  : "border-edge"
              }`}
            >
              <p className="mb-1 text-xs italic text-muted">
                &ldquo;{c.quotedText}&rdquo;
              </p>
              <p className="mb-1">{c.comment}</p>
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
          disabled={revising || unresolvedCount === 0}
          className="mt-4 w-full rounded bg-accent hover:bg-accent-hover px-3 py-2 text-accent-ink disabled:opacity-50"
        >
          {revising ? "Revising..." : "Revise flagged spans"}
        </button>
        {unresolvedCount === 0 && (
          <p className="mt-1 text-xs text-faint">
            Add at least one unresolved comment to revise.
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
