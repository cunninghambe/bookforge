import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getCharacter } from "@/lib/repo/characters";
import { listProjects } from "@/lib/repo/projects";
import { listChapters } from "@/lib/repo/chapters";
import { TopNav } from "@/components/TopNav";
import { CharacterChat } from "@/components/CharacterChat";

export const dynamic = "force-dynamic";

export default async function CharacterChatPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getDb();
  const character = getCharacter(db, Number(id));
  if (!character) notFound();
  // chapterCount per book so the pin form can clamp to [1, count] and show the
  // valid range (A5.1b).
  const projects = listProjects(db).map((p) => ({
    id: p.id,
    title: p.title,
    chapterCount: listChapters(db, p.id).length,
  }));

  return (
    <main>
      <TopNav active="characters" />
      <div className="mt-6 flex items-baseline justify-between">
        <h1 className="font-serif text-xl">Chat with {character.name}</h1>
        <Link href="/characters" className="text-sm text-neutral-500 hover:underline">
          Back to characters
        </Link>
      </div>
      <p className="mb-2 text-sm text-neutral-500">
        Audition dialogue and test voice. {character.name} answers pinned to a
        moment in the book, knowing only what they knew then. Nothing said here is
        saved or enters canon, except a reply you explicitly propose as a
        provisional fact.
      </p>
      <Suspense
        fallback={<p className="mt-4 text-sm text-neutral-400">Loading chat...</p>}
      >
        <CharacterChat
          characterId={character.id}
          characterName={character.name}
          projects={projects}
        />
      </Suspense>
    </main>
  );
}
