import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getProject } from "@/lib/repo/projects";
import { TopNav } from "@/components/TopNav";
import { Sequencer } from "@/components/Sequencer";

export const dynamic = "force-dynamic";

export default async function BookPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const db = getDb();
  const project = getProject(db, Number(projectId));
  if (!project) notFound();
  return (
    <main>
      <TopNav active="books" />
      <div className="mt-6 flex items-baseline justify-between">
        <h1 className="font-serif text-xl">{project.title}</h1>
        <div className="flex gap-4 text-sm text-muted">
          <Link
            href={`/book/${project.id}/import`}
            data-testid="import-link"
            className="hover:underline"
          >
            Import chapter
          </Link>
          <Link
            href={`/book/${project.id}/sweep`}
            data-testid="sweep-link"
            className="hover:underline"
          >
            Consistency sweep
          </Link>
          <Link
            href={`/book/${project.id}/threads`}
            data-testid="threads-link"
            className="hover:underline"
          >
            Threads
          </Link>
          <a
            href={`/api/projects/${project.id}/export`}
            data-testid="export-button"
            download
            className="hover:underline"
          >
            Export book
          </a>
        </div>
      </div>
      <p className="mb-4 text-sm text-muted">
        Order the chapters, set synopsis and beats, then interrogate a chapter to
        lock its decisions before drafting.
      </p>
      <Sequencer projectId={project.id} />
    </main>
  );
}
