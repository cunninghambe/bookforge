import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listProjects, firstProjectOfSeries } from "@/lib/repo/projects";
import {
  SEARCH_KINDS,
  searchIndex,
  type SearchHit,
  type SearchKind,
} from "@/lib/search";

// Amendment A11: full-text search over the whole project. Sits behind the
// session gate like every other /api route. Each hit gains the app URL the
// palette navigates to; snippets keep the layer's marker characters (D106).

// firstBookForSeriesWideThread deep-links a series-wide thread hit (project_id
// null) to the first book of ITS series (A16), falling back to the overall first
// book when the series has no book yet.
function urlFor(
  hit: SearchHit,
  firstBookForSeriesWideThread: (hit: SearchHit) => number | null,
): string {
  switch (hit.kind) {
    case "chapter":
      return `/book/${hit.projectId}/chapter/${hit.id}/draft`;
    case "canon":
      return `/canon?highlight=${hit.id}`;
    case "character":
      return `/characters?highlight=${hit.id}`;
    case "state":
      return `/characters?highlight=${hit.characterId}`;
    case "thread": {
      // A16: a series-wide thread (projectId null) resolves to the first book of
      // its own series.
      const projectId = hit.projectId ?? firstBookForSeriesWideThread(hit);
      return `/book/${projectId}/threads?highlight=${hit.id}`;
    }
  }
}

export async function GET(req: Request) {
  const db = getDb();
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";

  const kindsParam = url.searchParams.get("kinds");
  const kinds = kindsParam
    ? (kindsParam
        .split(",")
        .filter((k) =>
          (SEARCH_KINDS as readonly string[]).includes(k),
        ) as SearchKind[])
    : undefined;

  const projectIdRaw = url.searchParams.get("projectId");
  const projectId =
    projectIdRaw !== null && Number.isFinite(Number(projectIdRaw))
      ? Number(projectIdRaw)
      : undefined;

  const seriesIdRaw = url.searchParams.get("seriesId");
  const seriesId =
    seriesIdRaw !== null && Number.isFinite(Number(seriesIdRaw))
      ? Number(seriesIdRaw)
      : undefined;

  const limitRaw = url.searchParams.get("limit");
  const limit =
    limitRaw !== null && Number.isFinite(Number(limitRaw))
      ? Number(limitRaw)
      : undefined;

  const hits = searchIndex(db, {
    query: q,
    kinds,
    projectId,
    seriesId,
    includeRetired: url.searchParams.get("includeRetired") === "1",
    limit,
  });
  // A16: a series-wide thread hit links to the first book of its own series;
  // fall back to the overall first book when the series has no book.
  const overallFirstBookId = listProjects(db)[0]?.id ?? null;
  const firstBookForSeriesWideThread = (h: SearchHit): number | null =>
    (h.seriesId !== null
      ? firstProjectOfSeries(db, h.seriesId)?.id ?? null
      : null) ?? overallFirstBookId;
  return NextResponse.json({
    results: hits.map((h) => ({
      ...h,
      url: urlFor(h, firstBookForSeriesWideThread),
    })),
  });
}
