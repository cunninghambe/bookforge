import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listProjects } from "@/lib/repo/projects";
import {
  SEARCH_KINDS,
  searchIndex,
  type SearchHit,
  type SearchKind,
} from "@/lib/search";

// Amendment A11: full-text search over the whole project. Sits behind the
// session gate like every other /api route. Each hit gains the app URL the
// palette navigates to; snippets keep the layer's marker characters (D106).

// firstBookId is used to deep-link a series-wide thread hit (project_id null): it
// lands on the first book's threads page (books are ordered by order_index).
function urlFor(hit: SearchHit, firstBookId: number | null): string {
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
      // A12: series-wide threads (projectId null) resolve to the first book.
      const projectId = hit.projectId ?? firstBookId;
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

  const limitRaw = url.searchParams.get("limit");
  const limit =
    limitRaw !== null && Number.isFinite(Number(limitRaw))
      ? Number(limitRaw)
      : undefined;

  const hits = searchIndex(db, {
    query: q,
    kinds,
    projectId,
    includeRetired: url.searchParams.get("includeRetired") === "1",
    limit,
  });
  // A12: resolved once so a series-wide thread hit can link to the first book.
  const firstBookId = listProjects(db)[0]?.id ?? null;
  return NextResponse.json({
    results: hits.map((h) => ({ ...h, url: urlFor(h, firstBookId) })),
  });
}
