import { getDb } from "@/lib/db";
import { listProjects } from "@/lib/repo/projects";
import { TopNav } from "@/components/TopNav";
import { CanonManager } from "@/components/CanonManager";

export const dynamic = "force-dynamic";

export default function CanonPage() {
  const db = getDb();
  const projects = listProjects(db).map((p) => ({ id: p.id, title: p.title }));
  return (
    <main>
      <TopNav active="canon" />
      <h1 className="mt-6 font-serif text-xl">Canon</h1>
      <p className="mb-4 text-sm text-muted">
        The store every prompt is assembled from. Retired facts are excluded from
        assembly. Locked facts must be unlocked before editing.
      </p>
      <CanonManager projects={projects} />
    </main>
  );
}
