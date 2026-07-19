import { getDb } from "@/lib/db";
import { listProjects } from "@/lib/repo/projects";
import { listSeries, firstSeriesId } from "@/lib/repo/series";
import { getCharacter } from "@/lib/repo/characters";
import { TopNav } from "@/components/TopNav";
import { CharactersManager } from "@/components/CharactersManager";

export const dynamic = "force-dynamic";

export default async function CharactersPage({
  searchParams,
}: {
  searchParams: Promise<{ highlight?: string }>;
}) {
  const db = getDb();
  const series = listSeries(db).map((s) => ({ id: s.id, title: s.title }));
  // A16: books carry their series so the manager can scope the state-form book
  // dropdown to the selected series.
  const projects = listProjects(db).map((p) => ({
    id: p.id,
    title: p.title,
    seriesId: p.seriesId,
  }));

  // A11 + A16: a search hit deep-links as /characters?highlight=<characterId>; the
  // manager scrolls to and briefly flashes that card. The initial series is the
  // highlighted character's own series (so it is in the visible roster), else the
  // first series (the calm default).
  const { highlight } = await searchParams;
  const highlightId = Number(highlight);
  const highlighted = Number.isFinite(highlightId)
    ? getCharacter(db, highlightId)
    : undefined;
  const initialSeriesId =
    highlighted?.seriesId ?? firstSeriesId(db) ?? series[0]?.id ?? null;

  return (
    <main>
      <TopNav active="characters" />
      <h1 className="mt-6 font-serif text-xl">Characters</h1>
      <p className="mb-4 text-sm text-muted">
        Cards carry durable fields. Expand a card to see the state timeline: what
        each character knows, feels, and is hiding, effective from a given chapter.
      </p>
      <CharactersManager
        series={series}
        projects={projects}
        initialSeriesId={initialSeriesId}
        highlightId={Number.isFinite(highlightId) ? highlightId : null}
      />
    </main>
  );
}
