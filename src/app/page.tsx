import Link from "next/link";
import { getDb } from "@/lib/db";
import { listProjectsBySeries } from "@/lib/repo/projects";
import { listSeries } from "@/lib/repo/series";
import { TopNav } from "@/components/TopNav";
import { BooksManager } from "@/components/BooksManager";

export const dynamic = "force-dynamic";

// A16: the home Books page groups books under series headings, with calm
// creation (new book, new series) and rename flows. The grouped data is assembled
// server-side and handed to the client manager, which re-renders this page after
// each mutation via router.refresh().
export default function HomePage() {
  const db = getDb();
  const series = listSeries(db).map((s) => ({
    id: s.id,
    title: s.title,
    books: listProjectsBySeries(db, s.id).map((p) => ({
      id: p.id,
      title: p.title,
    })),
  }));

  return (
    <main>
      <TopNav active="books" />
      <div className="mt-6 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-serif text-xl">Books</h1>
        <Link
          href="/import-bible"
          data-testid="import-bible-link"
          className="text-sm text-muted hover:underline"
        >
          Import series bible
        </Link>
      </div>
      <BooksManager series={series} />
    </main>
  );
}
