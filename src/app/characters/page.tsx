import { getDb } from "@/lib/db";
import { listProjects } from "@/lib/repo/projects";
import { TopNav } from "@/components/TopNav";
import { CharactersManager } from "@/components/CharactersManager";

export const dynamic = "force-dynamic";

export default async function CharactersPage({
  searchParams,
}: {
  searchParams: Promise<{ highlight?: string }>;
}) {
  const db = getDb();
  const projects = listProjects(db).map((p) => ({ id: p.id, title: p.title }));
  // A10: a search hit deep-links as /characters?highlight=<characterId>; the
  // manager scrolls to and briefly flashes that card.
  const { highlight } = await searchParams;
  const highlightId = Number(highlight);
  return (
    <main>
      <TopNav active="characters" />
      <h1 className="mt-6 font-serif text-xl">Characters</h1>
      <p className="mb-4 text-sm text-muted">
        Cards carry durable fields. Expand a card to see the state timeline: what
        each character knows, feels, and is hiding, effective from a given chapter.
      </p>
      <CharactersManager
        projects={projects}
        highlightId={Number.isFinite(highlightId) ? highlightId : null}
      />
    </main>
  );
}
