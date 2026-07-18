import { getDb } from "@/lib/db";
import { listProjects } from "@/lib/repo/projects";
import { TopNav } from "@/components/TopNav";
import { CanonManager } from "@/components/CanonManager";

export const dynamic = "force-dynamic";

export default async function CanonPage({
  searchParams,
}: {
  searchParams: Promise<{ highlight?: string }>;
}) {
  const db = getDb();
  const projects = listProjects(db).map((p) => ({ id: p.id, title: p.title }));
  // A11: a search hit deep-links as /canon?highlight=<factId>; the manager
  // scrolls to and briefly flashes that row.
  const { highlight } = await searchParams;
  const highlightId = Number(highlight);
  return (
    <main>
      <TopNav active="canon" />
      <h1 className="mt-6 font-serif text-xl">Canon</h1>
      <p className="mb-4 text-sm text-muted">
        The store every prompt is assembled from. Retired facts are excluded from
        assembly. Locked facts must be unlocked before editing.
      </p>
      <CanonManager
        projects={projects}
        highlightId={Number.isFinite(highlightId) ? highlightId : null}
      />
    </main>
  );
}
