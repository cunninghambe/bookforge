import { getDb } from "@/lib/db";
import { listProjects } from "@/lib/repo/projects";
import { TopNav } from "@/components/TopNav";
import { CharactersManager } from "@/components/CharactersManager";

export const dynamic = "force-dynamic";

export default function CharactersPage() {
  const db = getDb();
  const projects = listProjects(db).map((p) => ({ id: p.id, title: p.title }));
  return (
    <main>
      <TopNav active="characters" />
      <h1 className="mt-6 font-serif text-xl">Characters</h1>
      <p className="mb-4 text-sm text-muted">
        Cards carry durable fields. Expand a card to see the state timeline: what
        each character knows, feels, and is hiding, effective from a given chapter.
      </p>
      <CharactersManager projects={projects} />
    </main>
  );
}
