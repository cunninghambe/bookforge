import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getChapter } from "@/lib/repo/chapters";
import { latestDraft } from "@/lib/repo/drafts";
import { listComments } from "@/lib/repo/comments";
import { listCharacters } from "@/lib/repo/characters";
import { getProject } from "@/lib/repo/projects";
import { orderToUiChapter } from "@/lib/chapterNumbering";
import { ttsEnabled, sttEnabled } from "@/lib/audio/config";
import { TopNav } from "@/components/TopNav";
import { ReviewEditor } from "@/components/ReviewEditor";

export const dynamic = "force-dynamic";

export default async function ReviewPage({
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
  const comments = draft ? listComments(db, draft.id, draft.content) : [];
  const characters = listCharacters(db).map((c) => ({ id: c.id, name: c.name }));

  return (
    <main>
      <TopNav active="books" />
      <div className="mt-6 flex items-baseline justify-between">
        <h1 className="font-serif text-xl">
          Review: {project.title}:{" "}
          {chapter.title || `Chapter ${orderToUiChapter(chapter.orderIndex)}`}
        </h1>
        <div className="flex gap-4 text-sm text-muted">
          <Link href={`/book/${project.id}`} className="hover:underline">
            Back to book
          </Link>
          <Link
            href={`/book/${project.id}/chapter/${chapter.id}/draft`}
            className="hover:underline"
          >
            Back to draft
          </Link>
          {ttsEnabled() && (
            <Link
              href={`/listen/${chapter.id}`}
              className="hover:underline"
              data-testid="listen-link"
            >
              Listen
            </Link>
          )}
        </div>
      </div>

      {draft ? (
        <ReviewEditor
          draftId={draft.id}
          initialContent={draft.content}
          initialComments={comments.map((c) => ({
            id: c.id,
            quotedText: c.quotedText,
            comment: c.comment,
            resolved: c.resolved === 1,
          }))}
          chapterId={chapter.id}
          projectId={project.id}
          chapterStatus={chapter.status}
          chapterSummary={chapter.summary}
          characters={characters}
          voiceNotesEnabled={sttEnabled()}
        />
      ) : (
        <p className="mt-6 text-sm text-muted" data-testid="no-draft">
          This chapter has no draft yet. Draft it first.
        </p>
      )}
    </main>
  );
}
