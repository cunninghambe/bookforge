"use client";

import { orderToUiChapter } from "@/lib/chapterNumbering";
import type { BraidLayout } from "@/lib/braidLayout";

// Amendment A12 (phase 2): the SVG braid renderer. A dumb renderer over the pure
// geometry from buildBraidLayout: it does no layout math of its own beyond pixel
// placement, and it is the ONLY place that turns a 0-based chapterOrder into the
// 1-based label the author sees (A2, via chapterNumbering). Colors come from the
// semantic design tokens (A9): monochrome ink/muted lines, accent reserved for
// hover/selection, warn for dropped (stale) segments.

interface BraidChapter {
  id: number;
  orderIndex: number;
  status: string;
  title: string | null;
}

interface RowMeta {
  name: string;
  type: string;
  status: string;
}

const COL_W = 56;
const ROW_H = 36;
const PAD_L = 18;
const PAD_R = 18;
const PAD_TOP = 30;
const PAD_BOTTOM = 14;

function segmentPath(x1: number, x2: number, y: number, amp: number): string {
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y} C ${mx} ${y - amp}, ${mx} ${y + amp}, ${x2} ${y}`;
}

function NodeShape({
  kind,
  selected,
}: {
  kind: string;
  selected: boolean;
}) {
  const fillClass = selected ? "fill-accent" : "fill-ink";
  const strokeClass = selected ? "stroke-accent" : "stroke-muted";
  switch (kind) {
    case "mention":
      return <circle r={4.5} className={`fill-surface ${strokeClass}`} strokeWidth={1.5} />;
    case "complicate":
      return (
        <rect
          x={-4.2}
          y={-4.2}
          width={8.4}
          height={8.4}
          transform="rotate(45)"
          className={fillClass}
        />
      );
    case "payoff":
      return (
        <>
          <circle r={9} className="fill-none stroke-accent" strokeWidth={1.5} />
          <circle r={4.5} className={fillClass} />
        </>
      );
    case "advance":
    default:
      return <circle r={4.5} className={fillClass} />;
  }
}

export function BraidView({
  layout,
  chapters,
  projectId,
  selectedThreadId,
  onSelectThread,
}: {
  layout: BraidLayout;
  chapters: BraidChapter[];
  projectId: number;
  selectedThreadId: number | null;
  onSelectThread: (id: number | null) => void;
}) {
  const sortedChapters = [...chapters].sort((a, b) => a.orderIndex - b.orderIndex);
  const colIndexByOrder = new Map(sortedChapters.map((c, i) => [c.orderIndex, i]));
  const chapterByOrder = new Map(sortedChapters.map((c) => [c.orderIndex, c]));
  const colIndex = (order: number) => colIndexByOrder.get(order) ?? order;

  const cols = Math.max(sortedChapters.length, 1);
  const rowsCount = Math.max(layout.rows.length, 1);
  const width = PAD_L + cols * COL_W + PAD_R;
  const height = PAD_TOP + rowsCount * ROW_H + PAD_BOTTOM;

  const x = (order: number) => PAD_L + colIndex(order) * COL_W + COL_W / 2;
  const y = (row: number) => PAD_TOP + row * ROW_H + ROW_H / 2;

  const rowMeta = new Map<number, RowMeta>(
    layout.rows.map((r) => [r.row, { name: r.name, type: r.type, status: r.status }]),
  );
  const statusByThread = new Map(layout.rows.map((r) => [r.threadId, r.status]));

  const chapterHref = (order: number) => {
    const chapter = chapterByOrder.get(order);
    return chapter ? `/book/${projectId}/chapter/${chapter.id}/draft` : undefined;
  };

  if (sortedChapters.length === 0) {
    return (
      <p className="text-sm text-muted" data-testid="braid-empty">
        Add a chapter to this book to see the braid.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <svg
        role="img"
        aria-label="Thread braid"
        data-testid="braid-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
      >
        {/* Column rules and labels */}
        {sortedChapters.map((c) => {
          const cx = x(c.orderIndex);
          const locked = c.status === "locked";
          return (
            <g key={`col-${c.id}`}>
              <line
                x1={cx}
                y1={PAD_TOP - 10}
                x2={cx}
                y2={height - PAD_BOTTOM + 4}
                className={locked ? "stroke-edge-soft" : "stroke-edge-soft opacity-40"}
                strokeWidth={1}
              />
              <a href={chapterHref(c.orderIndex)}>
                <text
                  x={cx}
                  y={PAD_TOP - 16}
                  textAnchor="middle"
                  data-testid="braid-chapter-label"
                  data-chapter={orderToUiChapter(c.orderIndex)}
                  className={`text-[10px] ${locked ? "fill-muted" : "fill-faint"}`}
                >
                  {orderToUiChapter(c.orderIndex)}
                </text>
              </a>
            </g>
          );
        })}

        {/* Co-touch bands and connectors */}
        {layout.coTouchColumns.map((c) => {
          const cx = x(c.chapterOrder);
          const top = y(c.rows[0]);
          const bottom = y(c.rows[c.rows.length - 1]);
          return (
            <g key={`cotouch-${c.chapterOrder}`} data-testid="braid-cotouch" data-chapter={orderToUiChapter(c.chapterOrder)}>
              <rect
                x={cx - COL_W / 2 + 5}
                y={PAD_TOP - 8}
                width={COL_W - 10}
                height={height - PAD_TOP - PAD_BOTTOM + 12}
                className="fill-inset/70"
              />
              <line
                x1={cx}
                y1={top}
                x2={cx}
                y2={bottom}
                className="stroke-edge"
                strokeWidth={1.5}
              />
            </g>
          );
        })}

        {/* Segments (between-touch and run-out) */}
        {layout.segments.map((seg, i) => {
          const selected = selectedThreadId === seg.threadId;
          const x1 = x(seg.fromOrder);
          const x2 = x(seg.toOrder);
          const yy = y(seg.row);
          const dashed = seg.stale || seg.runout;
          const colorClass = selected
            ? "stroke-accent"
            : seg.stale
              ? "stroke-warn-edge"
              : seg.runout
                ? "stroke-faint"
                : "stroke-muted";
          return (
            <path
              key={`seg-${seg.threadId}-${i}`}
              d={segmentPath(x1, x2, yy, 7)}
              fill="none"
              className={colorClass}
              strokeWidth={selected ? 2.5 : 1.75}
              strokeDasharray={dashed ? "4 4" : undefined}
              data-testid="braid-segment"
              data-thread={seg.threadId}
              data-stale={seg.stale ? "true" : "false"}
              data-runout={seg.runout ? "true" : "false"}
            />
          );
        })}

        {/* Nodes */}
        {layout.nodes.map((node, i) => {
          const selected = selectedThreadId === node.threadId;
          const meta = rowMeta.get(node.row);
          const status = statusByThread.get(node.threadId);
          const retired = status === "retired";
          const cx = x(node.chapterOrder);
          const cy = y(node.row);
          const uiChapter = orderToUiChapter(node.chapterOrder);
          const href = chapterHref(node.chapterOrder);
          const title = `${meta?.name ?? "Thread"}: ${node.kind}${
            node.evidence ? ` "${node.evidence}"` : ""
          } (ch ${uiChapter})`;
          return (
            <a
              key={`node-${node.threadId}-${i}`}
              href={href}
              data-testid="braid-node"
              data-thread={node.threadId}
              data-chapter={uiChapter}
              data-kind={node.kind}
              data-terminal={node.terminal ? "true" : undefined}
              onMouseEnter={() => onSelectThread(node.threadId)}
              onFocus={() => onSelectThread(node.threadId)}
              onMouseLeave={() => onSelectThread(null)}
              onBlur={() => onSelectThread(null)}
            >
              <title>{title}</title>
              <g
                transform={`translate(${cx}, ${cy})`}
                className={retired ? "opacity-50" : undefined}
              >
                <NodeShape kind={node.kind} selected={selected} />
                {node.terminal && (
                  <line
                    x1={9}
                    y1={-6}
                    x2={9}
                    y2={6}
                    className={selected ? "stroke-accent" : "stroke-ink"}
                    strokeWidth={2}
                    data-testid="braid-terminal"
                    data-thread={node.threadId}
                    data-terminal="true"
                  />
                )}
              </g>
            </a>
          );
        })}
      </svg>
    </div>
  );
}
