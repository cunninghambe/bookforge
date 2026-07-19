"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { orderToUiChapter } from "@/lib/chapterNumbering";

interface LockedChapter {
  id: number;
  orderIndex: number;
  title: string;
}

interface Contradiction {
  chapter: number | null;
  quote: string | null;
  conflictingFact: string | null;
  severity: string | null;
}

interface ChapterReport {
  chapterId: number;
  order: number;
  title: string;
  contradictions: Contradiction[];
  rawText: string | null;
  parseError: string | null;
  error: string | null;
}

interface SweepReport {
  chapters: ChapterReport[];
  totalContradictions: number;
}

// Drives the consistency sweep (SPEC section 6). Shows the chapter-count estimate
// before running, a range selector over the locked chapters, live progress naming
// the chapter under sweep, and the aggregated report assembled as chapters
// complete. A chapter whose response failed to parse shows its raw text rather than
// being dropped; a per-chapter failure (HTTP, model, or parse) becomes its report
// entry while the loop carries on (A2.2).
//
// Amendment A18: the run is client-driven. One HTTP request per chapter, so no
// request ever spans more than one model call, and a book-sized run cannot outlive
// the infrastructure's patience (the production 502 D158 documents: chapter-length
// prompts run minutes each, and the original all-in-one request died partway,
// discarding completed work). POST .../sweep only plans the target list; the loop
// then hits POST .../sweep/chapter once per chapter.
export function SweepRunner({
  projectId,
  lockedChapters,
}: {
  projectId: number;
  lockedChapters: LockedChapter[];
}) {
  const searchParams = useSearchParams();
  const fixtureKey = searchParams.get("fx") ?? undefined;

  const orders = lockedChapters.map((c) => c.orderIndex);
  const minOrder = orders.length ? Math.min(...orders) : 0;
  const maxOrder = orders.length ? Math.max(...orders) : 0;

  const [fromOrder, setFromOrder] = useState(minOrder);
  const [toOrder, setToOrder] = useState(maxOrder);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{
    current: number;
    total: number;
    title: string;
  } | null>(null);
  const [report, setReport] = useState<SweepReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inRange = useMemo(
    () =>
      lockedChapters.filter(
        (c) => c.orderIndex >= fromOrder && c.orderIndex <= toOrder,
      ),
    [lockedChapters, fromOrder, toOrder],
  );

  async function run() {
    if (running || inRange.length === 0) return;
    setRunning(true);
    setError(null);
    setReport(null);
    setProgress(null);

    // Plan the run (no LLM). A whole-run failure here surfaces its reason; per
    // chapter failures below carry their own reason inside the report.
    const planRes = await fetch(`/api/projects/${projectId}/sweep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromOrder, toOrder }),
    });
    if (!planRes.ok) {
      const data = (await planRes.json().catch(() => ({}))) as { error?: string };
      // A2.2: never a bare "Sweep failed." with no reason.
      setError(data.error ?? `Sweep failed (HTTP ${planRes.status}).`);
      setRunning(false);
      return;
    }
    const { plan } = (await planRes.json()) as {
      plan: {
        targets: Array<{ chapterId: number; order: number; title: string }>;
      };
    };

    // One chapter per request. The report is assembled as each chapter completes,
    // so completed work stays visible even if a later chapter fails.
    const chapters: ChapterReport[] = [];
    for (let i = 0; i < plan.targets.length; i += 1) {
      const target = plan.targets[i];
      setProgress({
        current: i + 1,
        total: plan.targets.length,
        title: target.title,
      });
      try {
        const res = await fetch(`/api/projects/${projectId}/sweep/chapter`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chapterId: target.chapterId,
            // Preserve per-position fixture routing: base key plus the 1-based
            // position in the swept set, matching the fixtures the old single
            // request run used (D25). The real client ignores fixtureKey.
            fixtureKey: fixtureKey ? `${fixtureKey}.${i + 1}` : undefined,
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          chapters.push({
            chapterId: target.chapterId,
            order: target.order,
            title: target.title,
            contradictions: [],
            rawText: null,
            parseError: null,
            error: data.error ?? `HTTP ${res.status}`,
          });
        } else {
          const data = (await res.json()) as { report: ChapterReport };
          chapters.push(data.report);
        }
      } catch (err) {
        chapters.push({
          chapterId: target.chapterId,
          order: target.order,
          title: target.title,
          contradictions: [],
          rawText: null,
          parseError: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      setReport({
        chapters: [...chapters],
        totalContradictions: chapters.reduce(
          (n, c) => n + c.contradictions.length,
          0,
        ),
      });
    }

    // Always land on a final report, matching the old single-request behavior
    // where an empty range still rendered an empty (zero-chapter) report.
    setReport({
      chapters,
      totalContradictions: chapters.reduce(
        (n, c) => n + c.contradictions.length,
        0,
      ),
    });
    setProgress(null);
    setRunning(false);
  }

  if (lockedChapters.length === 0) {
    return (
      <p data-testid="no-locked-chapters" className="text-sm text-muted">
        No locked chapters yet. Lock chapters before running a sweep.
      </p>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 rounded border border-edge-soft bg-surface p-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase text-faint">From</span>
          <select
            aria-label="From chapter"
            data-testid="sweep-from"
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
            aria-label="To chapter"
            data-testid="sweep-to"
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
        <button
          data-testid="run-sweep"
          onClick={run}
          disabled={running || inRange.length === 0}
          className="rounded bg-accent hover:bg-accent-hover px-4 py-1.5 text-accent-ink disabled:opacity-50"
        >
          {running ? "Running..." : "Run sweep"}
        </button>
      </div>

      <p className="mt-2 text-sm text-muted" data-testid="sweep-estimate">
        This will run {inRange.length} chapter
        {inRange.length === 1 ? "" : "s"} and cost tokens.
      </p>

      {running && (
        <p
          data-testid="sweep-progress"
          className="mt-2 text-sm text-info-ink"
        >
          {progress
            ? `Sweeping chapter ${progress.current} of ${progress.total}: ${progress.title}...`
            : "Preparing the sweep..."}
        </p>
      )}

      {error && (
        <div
          data-testid="sweep-error"
          className="mt-3 rounded border border-danger-edge bg-danger px-3 py-2 text-sm text-danger-ink"
        >
          {error}
        </div>
      )}

      {report && (
        <div className="mt-4" data-testid="sweep-report">
          <p className="mb-3 text-sm font-medium">
            {report.totalContradictions} contradiction
            {report.totalContradictions === 1 ? "" : "s"} found across{" "}
            {report.chapters.length} chapter
            {report.chapters.length === 1 ? "" : "s"}.
          </p>
          <ul className="space-y-3">
            {report.chapters.map((c) => (
              <li
                key={c.chapterId}
                data-testid={`sweep-chapter-${c.chapterId}`}
                className="rounded border border-edge-soft bg-surface p-3 text-sm"
              >
                <p className="mb-2 font-medium">
                  {c.order}. {c.title}
                </p>
                {c.error ? (
                  <div
                    data-testid={`sweep-error-${c.chapterId}`}
                    className="rounded border border-danger-edge bg-danger p-2 text-xs text-danger-ink"
                  >
                    <p className="uppercase tracking-wide text-danger-ink">
                      Sweep failed for this chapter:
                    </p>
                    <p className="mt-1">{c.error}</p>
                  </div>
                ) : c.parseError ? (
                  <div>
                    <p className="text-xs uppercase text-warn-ink">
                      Response did not parse. Raw output:
                    </p>
                    <pre
                      data-testid={`sweep-raw-${c.chapterId}`}
                      className="mt-1 overflow-x-auto rounded border border-warn-edge bg-warn p-2 text-xs text-warn-ink"
                    >
                      {c.rawText}
                    </pre>
                  </div>
                ) : c.contradictions.length === 0 ? (
                  <p
                    data-testid={`sweep-clean-${c.chapterId}`}
                    className="text-xs text-ok-ink"
                  >
                    No contradictions.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {c.contradictions.map((x, i) => (
                      <li
                        key={i}
                        data-testid={`contradiction-${c.chapterId}-${i}`}
                        className="rounded border border-warn-edge bg-warn p-2"
                      >
                        <p className="text-ink">
                          <span
                            data-testid={`contradiction-severity-${c.chapterId}-${i}`}
                            className="mr-2 rounded bg-warn-chip px-1.5 py-0.5 text-xs uppercase text-warn-ink"
                          >
                            {x.severity ?? "unknown"}
                          </span>
                          {x.conflictingFact}
                        </p>
                        {x.quote && (
                          <p
                            data-testid={`contradiction-quote-${c.chapterId}-${i}`}
                            className="mt-1 text-xs italic text-muted"
                          >
                            &ldquo;{x.quote}&rdquo;
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
