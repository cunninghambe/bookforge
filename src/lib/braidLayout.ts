// Amendment A12 (phase 2): the pure geometry behind the braid view. No DOM, no
// React: this module takes plain data and returns typed geometry, so the SVG
// component (BraidView) is a dumb renderer and the layout rules are unit-tested
// in isolation. STALE_GAP is imported from threadFlags so the braid's dashed-
// segment threshold and the list's stale/orphan flag chips share one number.
//
// Every chapterOrder in the input and output is the 0-based DB value (A2). The
// renderer is the only place that converts to 1-based labels, via
// src/lib/chapterNumbering.ts.

import { STALE_GAP } from "./threadFlags";

export interface BraidThreadInput {
  id: number;
  name: string;
  type: string;
  status: string; // 'open' | 'resolved' | 'retired'
}

export interface BraidTouchInput {
  threadId: number;
  chapterOrder: number; // 0-based
  kind: string; // 'advance' | 'complicate' | 'payoff' | 'mention'
  evidence: string | null;
}

export interface BraidChapterInput {
  id: number;
  orderIndex: number; // 0-based
  status: string; // chapter status; 'locked' chapters set the frontier
  title: string | null;
}

// One row per thread, in display order top to bottom.
export interface BraidRow {
  threadId: number;
  row: number;
  name: string;
  type: string;
  status: string;
}

// One node per touch, positioned at (column = chapterOrder, row).
export interface BraidNode {
  threadId: number;
  row: number;
  chapterOrder: number;
  kind: string;
  evidence: string | null;
  // Set on the last node of a RESOLVED thread: the braid ends the line with a
  // terminal tick here instead of a run-out.
  terminal?: boolean;
}

// A drawn segment: either between two consecutive touches of a thread, or the
// trailing run-out from an open thread's last touch to the locked frontier.
export interface BraidSegment {
  threadId: number;
  row: number;
  fromOrder: number;
  toOrder: number;
  // The chapter gap between fromOrder and toOrder exceeds STALE_GAP. Computed
  // with the same rule for run-out segments, so a thread dropped after a single
  // touch (no between-touch segment exists) still renders its drop as dashed
  // warn, not just faint.
  stale: boolean;
  // The trailing continuation past an open thread's last touch to the frontier.
  // Only ever true on the last segment of an open thread's line.
  runout?: boolean;
}

export interface CoTouchColumn {
  chapterOrder: number;
  // Row indexes touched at this chapter order, ascending, at least two.
  rows: number[];
}

export interface BraidLayout {
  rows: BraidRow[];
  nodes: BraidNode[];
  segments: BraidSegment[];
  coTouchColumns: CoTouchColumn[];
  // The book's highest LOCKED chapter order, or null when nothing is locked.
  frontier: number | null;
}

// Pure layout builder. threads should already be in creation order (as
// GET /api/threads returns them); that order is the tiebreak for rows with
// equal first-touch order and for untouched threads (which sort last).
export function buildBraidLayout(
  threads: BraidThreadInput[],
  touches: BraidTouchInput[],
  chapters: BraidChapterInput[],
): BraidLayout {
  let frontier: number | null = null;
  for (const c of chapters) {
    if (c.status !== "locked") continue;
    frontier = frontier === null ? c.orderIndex : Math.max(frontier, c.orderIndex);
  }

  const touchesByThread = new Map<number, BraidTouchInput[]>();
  for (const t of touches) {
    const arr = touchesByThread.get(t.threadId);
    if (arr) arr.push(t);
    else touchesByThread.set(t.threadId, [t]);
  }

  // Row order: by first-touch chapter order ascending; threads with no
  // touches sort last; ties broken by input order (creation order).
  const ranked = threads.map((t, idx) => {
    const own = touchesByThread.get(t.id) ?? [];
    const first = own.length
      ? Math.min(...own.map((o) => o.chapterOrder))
      : null;
    return { t, idx, first };
  });
  ranked.sort((a, b) => {
    if (a.first === null && b.first === null) return a.idx - b.idx;
    if (a.first === null) return 1;
    if (b.first === null) return -1;
    if (a.first !== b.first) return a.first - b.first;
    return a.idx - b.idx;
  });

  const rows: BraidRow[] = ranked.map((r, row) => ({
    threadId: r.t.id,
    row,
    name: r.t.name,
    type: r.t.type,
    status: r.t.status,
  }));

  const nodes: BraidNode[] = [];
  const segments: BraidSegment[] = [];

  for (let i = 0; i < ranked.length; i += 1) {
    const { t } = ranked[i];
    const row = i;
    const own = (touchesByThread.get(t.id) ?? [])
      .map((touch, order) => ({ touch, order }))
      .sort((a, b) => a.touch.chapterOrder - b.touch.chapterOrder || a.order - b.order)
      .map((x) => x.touch);

    const pushedNodes: BraidNode[] = [];
    for (const touch of own) {
      const node: BraidNode = {
        threadId: t.id,
        row,
        chapterOrder: touch.chapterOrder,
        kind: touch.kind,
        evidence: touch.evidence,
      };
      nodes.push(node);
      pushedNodes.push(node);
    }

    for (let j = 1; j < own.length; j += 1) {
      const from = own[j - 1].chapterOrder;
      const to = own[j].chapterOrder;
      segments.push({
        threadId: t.id,
        row,
        fromOrder: from,
        toOrder: to,
        stale: to - from > STALE_GAP,
      });
    }

    if (own.length > 0) {
      const last = own[own.length - 1];
      if (t.status === "open") {
        if (frontier !== null && frontier > last.chapterOrder) {
          segments.push({
            threadId: t.id,
            row,
            fromOrder: last.chapterOrder,
            toOrder: frontier,
            stale: frontier - last.chapterOrder > STALE_GAP,
            runout: true,
          });
        }
      } else if (t.status === "resolved") {
        pushedNodes[pushedNodes.length - 1].terminal = true;
      }
      // Retired threads get neither a run-out nor a terminal tick: the line
      // simply stops at its last touch, rendered fainter by the caller.
    }
  }

  const rowsByOrder = new Map<number, Set<number>>();
  for (const n of nodes) {
    let set = rowsByOrder.get(n.chapterOrder);
    if (!set) {
      set = new Set();
      rowsByOrder.set(n.chapterOrder, set);
    }
    set.add(n.row);
  }
  const coTouchColumns: CoTouchColumn[] = [];
  for (const [chapterOrder, rowSet] of rowsByOrder) {
    if (rowSet.size >= 2) {
      coTouchColumns.push({
        chapterOrder,
        rows: Array.from(rowSet).sort((a, b) => a - b),
      });
    }
  }
  coTouchColumns.sort((a, b) => a.chapterOrder - b.chapterOrder);

  return { rows, nodes, segments, coTouchColumns, frontier };
}
