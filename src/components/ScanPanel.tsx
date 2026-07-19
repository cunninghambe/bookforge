"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { orderToUiChapter } from "@/lib/chapterNumbering";
import { MobileApproveReject } from "./MobileApproveReject";

// Amendment A17: the thread backfill scan, on the threads page. A book whose
// chapters were locked before A12 has an empty ledger; this flow runs one
// extraction-purpose call per locked chapter, proposes the threads each chapter
// touches, and merges the whole run into ONE approval checklist grouped by thread
// with per-touch checkoffs. Nothing lands until the author approves it. The scan
// PROPOSES; only the checklist approves (the gate discipline). Progress, cost
// warning, and per-chapter error carry-through mirror the sweep runner; the merged
// checklist and keyboard-plus-tap approval mirror the bible importer and LockPanel.

const TOUCH_KINDS = ["advance", "complicate", "payoff", "mention"] as const;
type TouchKind = (typeof TOUCH_KINDS)[number];
const THREAD_TYPES = ["arc", "mystery", "promise", "relationship"] as const;
type ThreadType = (typeof THREAD_TYPES)[number];

interface LockedChapter {
  id: number;
  orderIndex: number;
  title: string;
}

interface ScanChapterOutcome {
  chapterId: number;
  order: number;
  title: string;
  proposalCount: number;
  rawText: string | null;
  parseError: string | null;
  error: string | null;
}

interface TouchProposal {
  chapterId: number;
  order: number;
  kind: TouchKind;
  evidence: string | null;
}

interface AttachGroupResp {
  threadId: number;
  name: string;
  touches: TouchProposal[];
}
interface NewGroupResp {
  name: string;
  type: ThreadType;
  touches: TouchProposal[];
}

interface ScanReport {
  chapters: ScanChapterOutcome[];
  attaches: AttachGroupResp[];
  news: NewGroupResp[];
  scannedCount: number;
  failedCount: number;
}

// Local editable touch: the proposal plus its approval checkoff.
interface TouchRow extends TouchProposal {
  approved: boolean;
}
interface AttachGroup {
  threadId: number;
  name: string;
  touches: TouchRow[];
}
interface NewGroup {
  name: string;
  type: ThreadType;
  touches: TouchRow[];
}

export function ScanPanel({
  projectId,
  lockedChapters,
  touchedChapterIds,
  startInvited,
  onApproved,
}: {
  projectId: number;
  lockedChapters: LockedChapter[];
  touchedChapterIds: number[];
  startInvited: boolean;
  onApproved: () => void;
}) {
  const searchParams = useSearchParams();
  const fixtureKey = searchParams.get("fx") ?? undefined;

  const orders = lockedChapters.map((c) => c.orderIndex);
  const minOrder = orders.length ? Math.min(...orders) : 0;
  const maxOrder = orders.length ? Math.max(...orders) : 0;
  const touchedSet = useMemo(
    () => new Set(touchedChapterIds),
    [touchedChapterIds],
  );

  const [open, setOpen] = useState(startInvited);
  const [fromOrder, setFromOrder] = useState(minOrder);
  const [toOrder, setToOrder] = useState(maxOrder);
  const [includeTouched, setIncludeTouched] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{
    current: number;
    total: number;
    title: string;
  } | null>(null);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [attachGroups, setAttachGroups] = useState<AttachGroup[]>([]);
  const [newGroups, setNewGroups] = useState<NewGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [approvedSummary, setApprovedSummary] = useState<{
    threads: number;
    touches: number;
  } | null>(null);

  // The parent loads chapters asynchronously, so lockedChapters is empty on the
  // first render and the range/open state cannot be seeded from props at mount.
  // Seed the range ONCE when the locked chapters first arrive (a ref latches it so
  // a later manual range change is never clobbered by a reload), and open the
  // panel whenever the empty-state invitation becomes true.
  const rangeInitedRef = useRef(false);
  useEffect(() => {
    if (!rangeInitedRef.current && lockedChapters.length > 0) {
      rangeInitedRef.current = true;
      setFromOrder(minOrder);
      setToOrder(maxOrder);
    }
  }, [lockedChapters.length, minOrder, maxOrder]);
  useEffect(() => {
    if (startInvited) setOpen(true);
  }, [startInvited]);

  // Chapters the current selection would scan: locked chapters in range, minus
  // any that already have touches unless includeTouched (mirrors scanTargets).
  const inRange = useMemo(
    () =>
      lockedChapters.filter(
        (c) =>
          c.orderIndex >= fromOrder &&
          c.orderIndex <= toOrder &&
          (includeTouched || !touchedSet.has(c.id)),
      ),
    [lockedChapters, fromOrder, toOrder, includeTouched, touchedSet],
  );

  // A flat, ordered list of every touch row across all groups, so the keyboard
  // handler can move focus across the whole checklist (attaches first, then new
  // threads) like the bible importer's single flat sequence.
  const flat = useMemo(() => {
    const out: Array<
      | { section: "attach"; gi: number; ti: number }
      | { section: "new"; gi: number; ti: number }
    > = [];
    attachGroups.forEach((g, gi) =>
      g.touches.forEach((_, ti) => out.push({ section: "attach", gi, ti })),
    );
    newGroups.forEach((g, gi) =>
      g.touches.forEach((_, ti) => out.push({ section: "new", gi, ti })),
    );
    return out;
  }, [attachGroups, newGroups]);

  function flatIndex(
    section: "attach" | "new",
    gi: number,
    ti: number,
  ): number {
    return flat.findIndex(
      (f) => f.section === section && f.gi === gi && f.ti === ti,
    );
  }

  function focusRow(idx: number) {
    const clamped = Math.max(0, Math.min(idx, flat.length - 1));
    document.getElementById(`scan-touch-${clamped}`)?.focus();
  }

  function setAttachApproved(gi: number, ti: number, v: boolean) {
    setAttachGroups((p) =>
      p.map((g, i) =>
        i === gi
          ? {
              ...g,
              touches: g.touches.map((t, j) =>
                j === ti ? { ...t, approved: v } : t,
              ),
            }
          : g,
      ),
    );
  }
  function setNewApproved(gi: number, ti: number, v: boolean) {
    setNewGroups((p) =>
      p.map((g, i) =>
        i === gi
          ? {
              ...g,
              touches: g.touches.map((t, j) =>
                j === ti ? { ...t, approved: v } : t,
              ),
            }
          : g,
      ),
    );
  }

  function onTouchKey(
    e: React.KeyboardEvent,
    section: "attach" | "new",
    gi: number,
    ti: number,
  ) {
    const setter = section === "attach" ? setAttachApproved : setNewApproved;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(flatIndex(section, gi, ti) + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(flatIndex(section, gi, ti) - 1);
    } else if (e.key === "a") {
      setter(gi, ti, true);
    } else if (e.key === "r") {
      setter(gi, ti, false);
    }
  }

  // One chapter per HTTP request: no request ever spans more than one model
  // call, so a book-sized run cannot outlive the infrastructure's patience (the
  // production 502: chapter-length prompts run minutes each, and the original
  // all-in-one request died partway). The server keeps the merge logic; each
  // response returns the whole run's merged checklist so far, and a failed
  // chapter (HTTP or model or parse) becomes its outcome row while the loop
  // carries on (A2.2).
  async function run() {
    if (running || inRange.length === 0) return;
    setRunning(true);
    setError(null);
    setReport(null);
    setAttachGroups([]);
    setNewGroups([]);
    setApprovedSummary(null);
    setProgress(null);

    const planRes = await fetch(`/api/projects/${projectId}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromOrder, toOrder, includeTouched }),
    });
    if (!planRes.ok) {
      const data = (await planRes.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? `Scan failed (HTTP ${planRes.status}).`);
      setRunning(false);
      return;
    }
    const { plan } = (await planRes.json()) as {
      plan: { targets: Array<{ chapterId: number; order: number; title: string }> };
    };

    const outcomes: ScanChapterOutcome[] = [];
    const prior: Array<{
      chapterId: number;
      order: number;
      proposals: unknown[];
    }> = [];
    let attaches: AttachGroupResp[] = [];
    let news: NewGroupResp[] = [];

    for (let i = 0; i < plan.targets.length; i += 1) {
      const target = plan.targets[i];
      setProgress({
        current: i + 1,
        total: plan.targets.length,
        title: target.title,
      });
      try {
        const res = await fetch(`/api/projects/${projectId}/scan/chapter`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chapterId: target.chapterId,
            prior,
            fixtureKey: fixtureKey ? `${fixtureKey}.${i + 1}` : undefined,
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          outcomes.push({
            chapterId: target.chapterId,
            order: target.order,
            title: target.title,
            proposalCount: 0,
            rawText: null,
            parseError: null,
            error: data.error ?? `HTTP ${res.status}`,
          });
          continue;
        }
        const data = (await res.json()) as {
          outcome: ScanChapterOutcome;
          proposals: { chapterId: number; order: number; proposals: unknown[] } | null;
          attaches: AttachGroupResp[];
          news: NewGroupResp[];
        };
        outcomes.push(data.outcome);
        if (data.proposals) prior.push(data.proposals);
        attaches = data.attaches;
        news = data.news;
      } catch (err) {
        outcomes.push({
          chapterId: target.chapterId,
          order: target.order,
          title: target.title,
          proposalCount: 0,
          rawText: null,
          parseError: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const failedCount = outcomes.filter(
      (o) => o.error !== null || o.parseError !== null,
    ).length;
    setReport({
      chapters: outcomes,
      attaches,
      news,
      scannedCount: outcomes.length,
      failedCount,
    });
    setAttachGroups(
      attaches.map((g) => ({
        threadId: g.threadId,
        name: g.name,
        touches: g.touches.map((t) => ({ ...t, approved: false })),
      })),
    );
    setNewGroups(
      news.map((g) => ({
        name: g.name,
        type: g.type,
        touches: g.touches.map((t) => ({ ...t, approved: false })),
      })),
    );
    setProgress(null);
    setRunning(false);
  }

  async function approve() {
    if (!report) return;
    setError(null);
    const attaches = attachGroups
      .map((g) => ({
        threadId: g.threadId,
        touches: g.touches
          .filter((t) => t.approved)
          .map((t) => ({ chapterId: t.chapterId, kind: t.kind, evidence: t.evidence })),
      }))
      .filter((g) => g.touches.length > 0);
    const newThreads = newGroups
      .map((g) => ({
        name: g.name,
        type: g.type,
        touches: g.touches
          .filter((t) => t.approved)
          .map((t) => ({ chapterId: t.chapterId, kind: t.kind, evidence: t.evidence })),
      }))
      .filter((g) => g.touches.length > 0);
    if (attaches.length === 0 && newThreads.length === 0) {
      setError("Check at least one touch to approve, or there is nothing to add.");
      return;
    }
    const touchCount =
      attaches.reduce((n, g) => n + g.touches.length, 0) +
      newThreads.reduce((n, g) => n + g.touches.length, 0);
    setRunning(true);
    const res = await fetch(`/api/projects/${projectId}/scan/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attaches, newThreads }),
    });
    setRunning(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Approval failed.");
      return;
    }
    setApprovedSummary({
      threads: attaches.length + newThreads.length,
      touches: touchCount,
    });
    setReport(null);
    setAttachGroups([]);
    setNewGroups([]);
    // The braid fills in once the touches exist: reload the manager's data.
    onApproved();
  }

  const hasProposals = attachGroups.length > 0 || newGroups.length > 0;
  const failures = (report?.chapters ?? []).filter(
    (c) => c.error !== null || c.parseError !== null,
  );

  if (lockedChapters.length === 0) {
    // Nothing to scan: unlocked chapters are never scanned (A17). Stay quiet
    // rather than offering a flow that cannot run.
    return null;
  }

  return (
    <div className="mt-4" data-testid="scan-section">
      {startInvited && (
        <p className="mb-2 text-sm text-muted" data-testid="scan-empty-invite">
          This book has locked chapters but no threads yet. Scan the chapters to
          recover the arcs, mysteries, promises, and relationships they touch. The
          scan proposes; nothing is added until you approve it.
        </p>
      )}

      <button
        data-testid="scan-toggle"
        onClick={() => setOpen((o) => !o)}
        className="rounded border border-edge px-3 py-1.5 text-sm text-ink"
      >
        {open ? "Hide thread scan" : "Scan for threads"}
      </button>

      {open && (
        <div className="mt-3" data-testid="scan-panel">
          {error && (
            <div
              data-testid="scan-error"
              className="mb-3 rounded border border-danger-edge bg-danger px-3 py-2 text-sm text-danger-ink"
            >
              {error}
            </div>
          )}

          <div className="flex flex-wrap items-end gap-3 rounded border border-edge-soft bg-surface p-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase text-faint">From</span>
              <select
                aria-label="Scan from chapter"
                data-testid="scan-from"
                value={fromOrder}
                onChange={(e) => setFromOrder(Number(e.target.value))}
                className="rounded border border-edge px-2 py-1"
              >
                {lockedChapters.map((c) => (
                  <option key={c.id} value={c.orderIndex}>
                    {orderToUiChapter(c.orderIndex)}. {c.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase text-faint">To</span>
              <select
                aria-label="Scan to chapter"
                data-testid="scan-to"
                value={toOrder}
                onChange={(e) => setToOrder(Number(e.target.value))}
                className="rounded border border-edge px-2 py-1"
              >
                {lockedChapters.map((c) => (
                  <option key={c.id} value={c.orderIndex}>
                    {orderToUiChapter(c.orderIndex)}. {c.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="scan-include-touched"
                checked={includeTouched}
                onChange={(e) => setIncludeTouched(e.target.checked)}
              />
              <span className="text-xs text-muted">
                Rescan chapters that already have touches
              </span>
            </label>
            <button
              data-testid="run-scan"
              onClick={run}
              disabled={running || inRange.length === 0}
              className="rounded bg-accent hover:bg-accent-hover px-4 py-1.5 text-accent-ink disabled:opacity-50"
            >
              {running ? "Scanning..." : "Run scan"}
            </button>
          </div>

          <p className="mt-2 text-sm text-muted" data-testid="scan-estimate">
            This will run {inRange.length} chapter
            {inRange.length === 1 ? "" : "s"} and cost tokens (one model call per
            chapter).
          </p>

          {running && !report && (
            <p data-testid="scan-progress" className="mt-2 text-sm text-info-ink">
              {progress
                ? `Scanning chapter ${progress.current} of ${progress.total}: ${progress.title}...`
                : "Preparing the scan..."}
            </p>
          )}

          {approvedSummary && (
            <div
              data-testid="scan-approve-success"
              className="mt-3 rounded border border-ok-edge bg-ok px-3 py-2 text-sm text-ok-ink"
            >
              Approved {approvedSummary.threads} thread update
              {approvedSummary.threads === 1 ? "" : "s"} and{" "}
              {approvedSummary.touches} touch
              {approvedSummary.touches === 1 ? "" : "es"}. The braid is updated
              below.
            </div>
          )}

          {failures.length > 0 && (
            <div className="mt-3" data-testid="scan-failures">
              <p className="text-xs uppercase tracking-wide text-warn-ink">
                Some chapters could not be scanned:
              </p>
              <ul className="mt-1 space-y-1">
                {failures.map((c) => (
                  <li
                    key={c.chapterId}
                    data-testid={`scan-chapter-failure-${c.chapterId}`}
                    className="rounded border border-warn-edge bg-warn p-2 text-xs text-warn-ink"
                  >
                    <span className="font-medium">
                      {c.order}. {c.title}:
                    </span>{" "}
                    <span data-testid={`scan-failure-reason-${c.chapterId}`}>
                      {c.error ?? c.parseError}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report && !hasProposals && (
            <p className="mt-3 text-sm text-muted" data-testid="scan-no-proposals">
              The scan found no new threads to propose in the scanned chapters.
            </p>
          )}

          {hasProposals && (
            <div className="mt-4" data-testid="scan-proposals">
              <p className="mb-2 text-xs uppercase tracking-wide text-muted">
                Proposals (nothing is added until you approve). Arrows move between
                touches, a approves, r rejects.
              </p>

              {attachGroups.length > 0 && (
                <>
                  <p className="mb-1 text-xs font-semibold uppercase text-faint">
                    Attach to existing threads
                  </p>
                  <ul className="space-y-3" data-testid="scan-attach-groups">
                    {attachGroups.map((g, gi) => (
                      <li
                        key={`attach-${g.threadId}`}
                        data-testid={`scan-attach-group-${gi}`}
                        className="rounded border border-edge-soft bg-surface p-2"
                      >
                        <p className="mb-1 text-sm">
                          <span className="mr-2 rounded bg-chip px-1.5 py-0.5 text-xs uppercase text-muted">
                            attach
                          </span>
                          <span className="font-medium text-ink">{g.name}</span>
                        </p>
                        <ul className="space-y-2">
                          {g.touches.map((t, ti) => (
                            <TouchRowView
                              key={`attach-${gi}-${ti}`}
                              flatId={flatIndex("attach", gi, ti)}
                              touch={t}
                              onKeyDown={(e) => onTouchKey(e, "attach", gi, ti)}
                              onApprove={() => setAttachApproved(gi, ti, true)}
                              onReject={() => setAttachApproved(gi, ti, false)}
                              onToggle={(v) => setAttachApproved(gi, ti, v)}
                            />
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {newGroups.length > 0 && (
                <>
                  <p className="mb-1 mt-3 text-xs font-semibold uppercase text-faint">
                    New threads
                  </p>
                  <ul className="space-y-3" data-testid="scan-new-groups">
                    {newGroups.map((g, gi) => (
                      <li
                        key={`new-${gi}`}
                        data-testid={`scan-new-group-${gi}`}
                        className="rounded border border-edge-soft bg-surface p-2"
                      >
                        <p className="mb-1 text-sm">
                          <span className="mr-2 rounded bg-info-chip px-1.5 py-0.5 text-xs text-info-ink">
                            new {g.type}
                          </span>
                          <span className="font-medium text-ink">{g.name}</span>
                        </p>
                        <ul className="space-y-2">
                          {g.touches.map((t, ti) => (
                            <TouchRowView
                              key={`new-${gi}-${ti}`}
                              flatId={flatIndex("new", gi, ti)}
                              touch={t}
                              onKeyDown={(e) => onTouchKey(e, "new", gi, ti)}
                              onApprove={() => setNewApproved(gi, ti, true)}
                              onReject={() => setNewApproved(gi, ti, false)}
                              onToggle={(v) => setNewApproved(gi, ti, v)}
                            />
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <button
                data-testid="scan-approve-button"
                onClick={approve}
                disabled={running}
                className="mt-3 rounded bg-accent hover:bg-accent-hover px-4 py-1.5 text-sm text-accent-ink disabled:opacity-50"
              >
                Approve checked touches
              </button>
              <span className="ml-3 text-xs text-faint">
                Press a to approve or r to reject a focused touch.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TouchRowView({
  flatId,
  touch,
  onKeyDown,
  onApprove,
  onReject,
  onToggle,
}: {
  flatId: number;
  touch: TouchRow;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onApprove: () => void;
  onReject: () => void;
  onToggle: (v: boolean) => void;
}) {
  return (
    <li
      id={`scan-touch-${flatId}`}
      data-testid={`scan-touch-${flatId}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="rounded border border-edge-soft bg-inset p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:border-edge"
    >
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          data-testid={`scan-touch-approve-${flatId}`}
          checked={touch.approved}
          onChange={(e) => onToggle(e.target.checked)}
          className="mt-1"
        />
        <span className="flex-1">
          <span className="mr-2 rounded bg-chip px-1.5 py-0.5 text-xs uppercase text-muted">
            ch {touch.order}: {touch.kind}
          </span>
          {touch.evidence && (
            <span className="text-xs italic text-faint">
              &ldquo;{touch.evidence}&rdquo;
            </span>
          )}
        </span>
      </label>
      <MobileApproveReject
        approved={touch.approved}
        onApprove={onApprove}
        onReject={onReject}
        testidPrefix={`scan-touch-${flatId}`}
      />
    </li>
  );
}
