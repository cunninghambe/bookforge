import Link from "next/link";
import { getDb } from "@/lib/db";
import { listProjects } from "@/lib/repo/projects";
import { TopNav } from "@/components/TopNav";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const db = getDb();
  const projects = listProjects(db);
  return (
    <main>
      <TopNav active="books" />
      <div className="mt-6 flex items-baseline justify-between">
        <h1 className="font-serif text-xl">Books</h1>
        <Link
          href="/import-bible"
          data-testid="import-bible-link"
          className="text-sm text-muted hover:underline"
        >
          Import series bible
        </Link>
      </div>
      <ul className="mt-4 space-y-2" data-testid="book-list">
        {projects.map((p) => (
          <li key={p.id}>
            <Link
              href={`/book/${p.id}`}
              className="text-lg hover:underline"
            >
              {p.title}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
