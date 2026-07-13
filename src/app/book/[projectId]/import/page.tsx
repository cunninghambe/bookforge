import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getProject } from "@/lib/repo/projects";
import { listChapters } from "@/lib/repo/chapters";
import { listCharacters } from "@/lib/repo/characters";
import { TopNav } from "@/components/TopNav";
import { ImportPanel } from "@/components/ImportPanel";

export const dynamic = "force-dynamic";

// The backfill importer page (SPEC section 7). Loads Book 1's canon and summaries
// into the tool so Book 2 drafting can use them.
export default async function ImportPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const db = getDb();
  const project = getProject(db, Number(projectId));
  if (!project) notFound();

  const chapters = listChapters(db, project.id).map((c) => ({
    id: c.id,
    title: c.title || `Chapter ${c.orderIndex + 1}`,
    orderIndex: c.orderIndex,
  }));
  const characters = listCharacters(db).map((c) => ({ id: c.id, name: c.name }));

  return (
    <main>
      <TopNav active="books" />
      <div className="mt-6 flex items-baseline justify-between">
        <h1 className="font-serif text-xl">Import: {project.title}</h1>
        <Link
          href={`/book/${project.id}`}
          className="text-sm text-neutral-500 hover:underline"
        >
          Back to book
        </Link>
      </div>
      <p className="mb-4 text-sm text-neutral-500">
        Paste one chapter at a time. Each paste saves as a locked chapter, then
        proposes canon facts and character-state deltas through the same approval
        checklist as locking.
      </p>
      <ImportPanel
        projectId={project.id}
        existingChapters={chapters}
        characters={characters}
      />
    </main>
  );
}
