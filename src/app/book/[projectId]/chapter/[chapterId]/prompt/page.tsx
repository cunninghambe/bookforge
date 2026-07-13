import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getChapter } from "@/lib/repo/chapters";
import { getProject } from "@/lib/repo/projects";
import { assemblePrompt } from "@/lib/assembler";
import { orderToUiChapter } from "@/lib/chapterNumbering";
import { TopNav } from "@/components/TopNav";

export const dynamic = "force-dynamic";

// Dev inspection surface: shows exactly what the model receives for one chapter.
// This is the view used at the Phase 3 mandatory stop. By default every beat is
// marked as a target so the full canon and character context is visible; narrow
// with ?beats=0,1.
export default async function PromptInspectorPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; chapterId: string }>;
  searchParams: Promise<{ beats?: string }>;
}) {
  const { projectId, chapterId } = await params;
  const { beats: beatsParam } = await searchParams;
  const db = getDb();
  const chapter = getChapter(db, Number(chapterId));
  const project = getProject(db, Number(projectId));
  if (!chapter || !project) notFound();

  const targetBeatIndices = beatsParam
    ? beatsParam
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n))
    : chapter.beats.map((_, i) => i);

  const assembled = assemblePrompt(db, {
    chapterId: chapter.id,
    targetBeatIndices,
  });

  const full = `SYSTEM:\n${assembled.system}\n\nUSER:\n${assembled.prompt}`;

  return (
    <main>
      <TopNav active="books" />
      <div className="mt-6 flex items-baseline justify-between">
        <h1 className="font-serif text-xl">
          Assembled prompt: {chapter.title || `Chapter ${orderToUiChapter(chapter.orderIndex)}`}
        </h1>
        <Link
          href={`/book/${project.id}/chapter/${chapter.id}/draft`}
          className="text-sm text-neutral-500 hover:underline"
        >
          Go to draft
        </Link>
      </div>
      <p className="mb-4 text-sm text-neutral-500">
        Target beats: {targetBeatIndices.map((i) => i + 1).join(", ") || "none"}.
        Appearing characters: {assembled.appearingCharacters.join(", ") || "none"}.
      </p>

      {assembled.warnings.length > 0 && (
        <div className="mb-4 space-y-1" data-testid="prompt-warnings">
          {assembled.warnings.map((w, i) => (
            <p
              key={i}
              className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
            >
              {w}
            </p>
          ))}
        </div>
      )}

      <section className="mb-6">
        <h2 className="mb-1 text-xs uppercase tracking-wide text-neutral-400">
          System
        </h2>
        <pre
          data-testid="system-block"
          className="overflow-x-auto whitespace-pre-wrap rounded border border-neutral-200 bg-white p-4 text-sm"
        >
          {assembled.system}
        </pre>
      </section>

      {assembled.blocks.map((b) => (
        <section className="mb-6" key={b.name}>
          <h2 className="mb-1 text-xs uppercase tracking-wide text-neutral-400">
            {b.name}
          </h2>
          <pre
            data-testid={`block-${b.name.replace(/\s+/g, "-").toLowerCase()}`}
            className="overflow-x-auto whitespace-pre-wrap rounded border border-neutral-200 bg-white p-4 text-sm"
          >
            {b.content}
          </pre>
        </section>
      ))}

      <section className="mb-10">
        <h2 className="mb-1 text-xs uppercase tracking-wide text-neutral-400">
          Full concatenated prompt
        </h2>
        <textarea
          readOnly
          data-testid="full-prompt"
          value={full}
          rows={20}
          className="w-full rounded border border-neutral-200 bg-neutral-50 p-4 font-mono text-xs"
        />
      </section>
    </main>
  );
}
