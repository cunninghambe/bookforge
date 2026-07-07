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
      <h1 className="mt-6 font-serif text-xl">{project.title}</h1>
      <p className="mb-4 text-sm text-neutral-500">
        Order the chapters, set synopsis and beats, then interrogate a chapter to
        lock its decisions before drafting.
      </p>
      <Sequencer projectId={project.id} />
    </main>
  );
}
