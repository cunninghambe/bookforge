import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  SEARCH_KINDS,
  searchIndex,
  type SearchHit,
  type SearchKind,
} from "@/lib/search";

// Amendment A11: full-text search over the whole project. Sits behind the
// session gate like every other /api route. Each hit gains the app URL the
// palette navigates to; snippets keep the layer's marker characters (D106).

function urlFor(hit: SearchHit): string {
  switch (hit.kind) {
    case "chapter":
      return `/book/${hit.projectId}/chapter/${hit.id}/draft`;
    case "canon":
      return `/canon?highlight=${hit.id}`;
    case "character":
      return `/characters?highlight=${hit.id}`;
    case "state":
      return `/characters?highlight=${hit.characterId}`;
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
  return NextResponse.json({
    results: hits.map((h) => ({ ...h, url: urlFor(h) })),
  });
}
