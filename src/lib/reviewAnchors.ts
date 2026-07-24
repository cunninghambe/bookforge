// A22.3: inline anchor decoration, a pure function layered on the A21 emphasis
// parser (D178). It takes the raw draft content and a list of anchors (an unresolved
// comment or suggestion located by findSpan, the same pure function the server uses)
// and returns the A21 emphasis segments further split at anchor boundaries, each
// finer segment tagged with the ids of the anchors that cover it. Every finer
// segment still carries a correct rawStart, so the data-raw-start tiling and the
// selection-to-raw-offset mapping (rawOffsetForEndpoint) are untouched: with no
// anchors this yields the A21 segments verbatim (plus an empty anchorIds list).

import { parseEmphasis, type EmphasisKind } from "./markdown";

export interface ReviewAnchor {
  id: number;
  // Raw content offsets: [start, end) on the raw draft, exactly as findSpan returns.
  start: number;
  end: number;
  kind: "comment" | "suggestion";
}

export interface AnchoredSegment {
  // The segment's VISIBLE text (emphasis markers removed), as in A21.
  text: string;
  kind: EmphasisKind;
  // Raw offset of this visible text's first character, as in A21. Still exact after
  // splitting, because a segment's visible text is a contiguous run of the raw input.
  rawStart: number;
  // The ids of every anchor whose raw range fully covers this finer segment. Empty
  // when the segment is not under any anchor. May hold several ids when anchors
  // overlap.
  anchorIds: number[];
}

// Splits each A21 emphasis segment at any anchor start/end that falls strictly
// inside that segment's visible raw range, then tags each finer piece with the
// anchors that cover it. Because we split at every boundary, a finer segment is
// always entirely inside or entirely outside each anchor, so coverage is the exact
// test start <= s and end >= e.
export function decorateSegments(
  content: string,
  anchors: ReviewAnchor[],
): AnchoredSegment[] {
  const segments = parseEmphasis(content);
  const boundaries = new Set<number>();
  for (const a of anchors) {
    boundaries.add(a.start);
    boundaries.add(a.end);
  }

  const out: AnchoredSegment[] = [];
  for (const seg of segments) {
    const segStart = seg.rawStart;
    const segEnd = seg.rawStart + seg.text.length;

    // Cut points strictly inside this segment's visible range, in order.
    const cuts = [...boundaries]
      .filter((b) => b > segStart && b < segEnd)
      .sort((x, y) => x - y);
    const points = [...cuts, segEnd];

    let prev = segStart;
    for (const cut of points) {
      const s = prev;
      const e = cut;
      const text = seg.text.slice(s - segStart, e - segStart);
      const anchorIds = anchors
        .filter((a) => a.start <= s && a.end >= e)
        .map((a) => a.id);
      out.push({ text, kind: seg.kind, rawStart: s, anchorIds });
      prev = cut;
    }
  }
  return out;
}
