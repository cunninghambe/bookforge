import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getProject } from "@/lib/repo/projects";
import { listChapters } from "@/lib/repo/chapters";
import { orderToUiChapter } from "@/lib/chapterNumbering";
import { TopNav } from "@/components/TopNav";
import { SweepRunner } from "@/components/SweepRunner";

export const dynamic = "force-dynamic";

export default async function SweepPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const db = getDb();
  const project = getProject(db, Number(projectId));
  if (!project) notFound();
  const locked = listChapters(db, project.id)
    .filter((c) => c.status === "locked")
    .map((c) => ({
      id: c.id,
      orderIndex: c.orderIndex,
      title: c.title || `Chapter ${orderToUiChapter(c.orderIndex)}`,
    }));

  return (
    <main>
      <TopNav active="books" />
      <div className="mt-6 flex items-baseline justify-between">
        <h1 className="font-serif text-xl">Consistency sweep: {project.title}</h1>
        <Link
          href={`/book/${project.id}`}
          className="text-sm text-muted hover:underline"
        >
          Back to book
        </Link>
      </div>
      <p className="mb-4 text-sm text-muted">
        Checks each locked chapter against the full locked canon and reports
        contradictions only. One model call per chapter, run in order. This is slow
        and costs tokens, so pick a range.
      </p>
      <SweepRunner projectId={project.id} lockedChapters={locked} />
    </main>
  );
}
