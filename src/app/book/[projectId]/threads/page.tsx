import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getProject } from "@/lib/repo/projects";
import { TopNav } from "@/components/TopNav";
import { ThreadsManager } from "@/components/ThreadsManager";

export const dynamic = "force-dynamic";

// Amendment A12 (phase 2): the braid view. A search hit or the book page's
// Threads link lands here; ?highlight=<id> scrolls to and flashes that row
// (the A11 deep-link pattern, D107).
export default async function ThreadsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ highlight?: string }>;
}) {
  const { projectId } = await params;
  const db = getDb();
  const project = getProject(db, Number(projectId));
  if (!project) notFound();

  const { highlight } = await searchParams;
  const highlightId = Number(highlight);

  return (
    <main>
      <TopNav active="books" />
      <h1 className="mt-6 font-serif text-xl">Threads: {project.title}</h1>
      <p className="mb-4 text-sm text-muted">
        The promises, mysteries, and relationships running through this book,
        woven into a braid so a dropped thread is visible, not just remembered.
      </p>
      <ThreadsManager
        projectId={project.id}
        highlightId={Number.isFinite(highlightId) ? highlightId : null}
      />
    </main>
  );
}
