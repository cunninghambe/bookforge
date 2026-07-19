import { getDb } from "@/lib/db";
import { listProjects } from "@/lib/repo/projects";
import { listSeries, firstSeriesId } from "@/lib/repo/series";
import { getCanon } from "@/lib/repo/canon";
import { TopNav } from "@/components/TopNav";
import { CanonManager } from "@/components/CanonManager";

export const dynamic = "force-dynamic";

export default async function CanonPage({
  searchParams,
}: {
  searchParams: Promise<{ highlight?: string }>;
}) {
  const db = getDb();
  const series = listSeries(db).map((s) => ({ id: s.id, title: s.title }));
  // A16: books carry their series so the manager can scope the scope selectors to
  // the selected series.
  const projects = listProjects(db).map((p) => ({
    id: p.id,
    title: p.title,
    seriesId: p.seriesId,
  }));
  // A11 + A16: a search hit deep-links as /canon?highlight=<factId>; the manager
  // scrolls to and briefly flashes that row. The initial series is the highlighted
  // fact's own series (so it is in the visible list), else the first series.
  const { highlight } = await searchParams;
  const highlightId = Number(highlight);
  const highlighted = Number.isFinite(highlightId)
    ? getCanon(db, highlightId)
    : undefined;
  const initialSeriesId =
    highlighted?.seriesId ?? firstSeriesId(db) ?? series[0]?.id ?? null;
  return (
    <main>
      <TopNav active="canon" />
      <h1 className="mt-6 font-serif text-xl">Canon</h1>
      <p className="mb-4 text-sm text-muted">
        The store every prompt is assembled from. Retired facts are excluded from
        assembly. Locked facts must be unlocked before editing.
      </p>
      <CanonManager
        series={series}
        projects={projects}
        initialSeriesId={initialSeriesId}
        highlightId={Number.isFinite(highlightId) ? highlightId : null}
      />
    </main>
  );
}
