"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

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
}

interface SweepReport {
  chapters: ChapterReport[];
  totalContradictions: number;
}

// Drives the consistency sweep (SPEC section 6). Shows the chapter-count estimate
// before running, a range selector over the locked chapters, a progress indicator
// while the sequential run is in flight, and the aggregated report. A chapter whose
// response failed to parse shows its raw text rather than being dropped.
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
    const res = await fetch(`/api/projects/${projectId}/sweep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromOrder, toOrder, fixtureKey }),
    });
    setRunning(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Sweep failed.");
      return;
    }
    const data = (await res.json()) as { report: SweepReport };
    setReport(data.report);
  }

  if (lockedChapters.length === 0) {
    return (
      <p data-testid="no-locked-chapters" className="text-sm text-neutral-500">
        No locked chapters yet. Lock chapters before running a sweep.
      </p>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 rounded border border-neutral-200 bg-white p-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase text-neutral-400">From</span>
          <select
            aria-label="From chapter"
            data-testid="sweep-from"
            value={fromOrder}
            onChange={(e) => setFromOrder(Number(e.target.value))}
            className="rounded border border-neutral-300 px-2 py-1"
          >
            {lockedChapters.map((c) => (
              <option key={c.id} value={c.orderIndex}>
                {c.orderIndex + 1}. {c.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase text-neutral-400">To</span>
          <select
            aria-label="To chapter"
            data-testid="sweep-to"
            value={toOrder}
            onChange={(e) => setToOrder(Number(e.target.value))}
            className="rounded border border-neutral-300 px-2 py-1"
          >
            {lockedChapters.map((c) => (
              <option key={c.id} value={c.orderIndex}>
                {c.orderIndex + 1}. {c.title}
              </option>
            ))}
          </select>
        </label>
        <button
          data-testid="run-sweep"
          onClick={run}
          disabled={running || inRange.length === 0}
          className="rounded bg-neutral-900 px-4 py-1.5 text-white disabled:opacity-50"
        >
          {running ? "Running..." : "Run sweep"}
        </button>
      </div>

      <p className="mt-2 text-sm text-neutral-600" data-testid="sweep-estimate">
        This will run {inRange.length} chapter
        {inRange.length === 1 ? "" : "s"} and cost tokens.
      </p>

      {running && (
        <p
          data-testid="sweep-progress"
          className="mt-2 text-sm text-sky-700"
        >
          Sweeping {inRange.length} chapter{inRange.length === 1 ? "" : "s"} in
          order...
        </p>
      )}

      {error && (
        <div
          data-testid="sweep-error"
          className="mt-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
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
                className="rounded border border-neutral-200 bg-white p-3 text-sm"
              >
                <p className="mb-2 font-medium">
                  {c.order}. {c.title}
                </p>
                {c.parseError ? (
                  <div>
                    <p className="text-xs uppercase text-amber-700">
                      Response did not parse. Raw output:
                    </p>
                    <pre
                      data-testid={`sweep-raw-${c.chapterId}`}
                      className="mt-1 overflow-x-auto rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
                    >
                      {c.rawText}
                    </pre>
                  </div>
                ) : c.contradictions.length === 0 ? (
                  <p
                    data-testid={`sweep-clean-${c.chapterId}`}
                    className="text-xs text-green-700"
                  >
                    No contradictions.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {c.contradictions.map((x, i) => (
                      <li
                        key={i}
                        data-testid={`contradiction-${c.chapterId}-${i}`}
                        className="rounded border border-amber-200 bg-amber-50 p-2"
                      >
                        <p className="text-neutral-800">
                          <span
                            data-testid={`contradiction-severity-${c.chapterId}-${i}`}
                            className="mr-2 rounded bg-amber-200 px-1.5 py-0.5 text-xs uppercase text-amber-900"
                          >
                            {x.severity ?? "unknown"}
                          </span>
                          {x.conflictingFact}
                        </p>
                        {x.quote && (
                          <p
                            data-testid={`contradiction-quote-${c.chapterId}-${i}`}
                            className="mt-1 text-xs italic text-neutral-600"
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
