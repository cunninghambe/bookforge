import Link from "next/link";
import { getDb } from "@/lib/db";
import { listProjects } from "@/lib/repo/projects";
import { listCharacters } from "@/lib/repo/characters";
import { TopNav } from "@/components/TopNav";
import { BibleImportPanel } from "@/components/BibleImportPanel";

export const dynamic = "force-dynamic";

// The series-bible importer page (Amendment A3). Turns a pasted story bible (world
// rules, character sheets, timeline notes, standing decisions that never lived in
// any chapter) into structured, approval-gated data.
export default function ImportBiblePage() {
  const db = getDb();
  const projects = listProjects(db).map((p) => ({ id: p.id, title: p.title }));
  const characters = listCharacters(db).map((c) => ({
    id: c.id,
    name: c.name,
    role: c.role,
    voiceRules: c.voiceRules,
    physical: c.physical,
    notes: c.notes,
  }));

  return (
    <main>
      <TopNav active="books" />
      <div className="mt-6 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-serif text-xl">Import series bible</h1>
        <Link href="/" className="text-sm text-muted hover:underline">
          Back to books
        </Link>
      </div>
      <p className="mb-4 text-sm text-muted">
        Paste the story bible: the accumulated world rules, character sheets,
        timeline notes, and standing decisions that never lived in any chapter.
        Choose a scope, then approve the proposals one at a time. Nothing lands
        until you approve it.
      </p>
      <BibleImportPanel projects={projects} characters={characters} />
    </main>
  );
}
