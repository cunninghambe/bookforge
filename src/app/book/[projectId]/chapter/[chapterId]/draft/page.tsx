import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getChapter } from "@/lib/repo/chapters";
import { latestDraft } from "@/lib/repo/drafts";
import { getProject } from "@/lib/repo/projects";
import { orderToUiChapter } from "@/lib/chapterNumbering";
import { TopNav } from "@/components/TopNav";
import { DraftEditor } from "@/components/DraftEditor";

export const dynamic = "force-dynamic";

export default async function DraftPage({
  params,
}: {
  params: Promise<{ projectId: string; chapterId: string }>;
}) {
  const { projectId, chapterId } = await params;
  const db = getDb();
  const chapter = getChapter(db, Number(chapterId));
  const project = getProject(db, Number(projectId));
  if (!chapter || !project) notFound();
  const draft = latestDraft(db, chapter.id);

  return (
    <main>
      <TopNav active="books" />
      <div className="mt-6 flex items-baseline justify-between">
        <h1 className="font-serif text-xl">
          {project.title}: {chapter.title || `Chapter ${orderToUiChapter(chapter.orderIndex)}`}
        </h1>
        <div className="flex gap-4 text-sm text-neutral-500">
          <Link href={`/book/${project.id}`} className="hover:underline">
            Back to book
          </Link>
          <Link
            href={`/book/${project.id}/chapter/${chapter.id}/prompt`}
            className="hover:underline"
          >
            Inspect assembled prompt
          </Link>
          <Link
            href={`/book/${project.id}/chapter/${chapter.id}/review`}
            className="hover:underline"
            data-testid="review-link"
          >
            Review and revise
          </Link>
        </div>
      </div>
      <Suspense fallback={<p className="mt-4 text-sm text-neutral-400">Loading editor...</p>}>
        <DraftEditor
          chapterId={chapter.id}
          beats={chapter.beats}
          pov={chapter.pov ?? "omniscient"}
          initialContent={draft?.content ?? ""}
        />
      </Suspense>
    </main>
  );
}
