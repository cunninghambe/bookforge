import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getChapter } from "@/lib/repo/chapters";
import { getProject } from "@/lib/repo/projects";
import { latestDraft } from "@/lib/repo/drafts";
import { orderToUiChapter } from "@/lib/chapterNumbering";
import { ttsEnabled, sttEnabled } from "@/lib/audio/config";
import { detectFfmpeg, chooseAudioFormat } from "@/lib/audio/ffmpeg";
import { splitParagraphs } from "@/lib/audio/paragraphs";
import { TopNav } from "@/components/TopNav";
import { ListenPlayer } from "@/components/ListenPlayer";

export const dynamic = "force-dynamic";

// Phone-first listen page (A14). It 404s when TTS is not configured, so a fresh
// clone shows no trace of the feature. The player itself is a client island; this
// shell resolves the chapter, its paragraph count, and the serving format.
export default async function ListenPage({
  params,
}: {
  params: Promise<{ chapterId: string }>;
}) {
  if (!ttsEnabled()) notFound();
  const { chapterId } = await params;
  const db = getDb();
  const chapter = getChapter(db, Number(chapterId));
  if (!chapter) notFound();
  const project = getProject(db, chapter.projectId);
  if (!project) notFound();

  const draft = latestDraft(db, chapter.id);
  const paragraphCount = splitParagraphs(draft?.content ?? "").length;
  const { format } = chooseAudioFormat(await detectFfmpeg());
  const heading =
    chapter.title || `Chapter ${orderToUiChapter(chapter.orderIndex)}`;

  return (
    <main>
      <TopNav active="books" />
      <div className="mt-6 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-serif text-xl" data-testid="listen-heading">
          Listen: {heading}
        </h1>
        <Link
          href={`/book/${project.id}/chapter/${chapter.id}/review`}
          className="text-sm text-muted hover:underline"
        >
          Back to review
        </Link>
      </div>
      <ListenPlayer
        chapterId={chapter.id}
        projectId={project.id}
        heading={heading}
        initialParagraphCount={paragraphCount}
        initialFormat={format}
        voiceNotesEnabled={sttEnabled()}
      />
    </main>
  );
}
