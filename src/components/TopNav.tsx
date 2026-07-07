import Link from "next/link";

// Shared top navigation for authed pages. Calm and minimal.
export function TopNav({ active }: { active?: "canon" | "characters" | "books" }) {
  const linkClass = (key: string) =>
    `hover:underline ${active === key ? "font-semibold" : "font-medium"}`;
  return (
    <nav className="flex items-center gap-6 border-b border-neutral-200 py-4 text-sm">
      <Link href="/canon" className={linkClass("canon")}>
        Canon
      </Link>
      <Link href="/characters" className={linkClass("characters")}>
        Characters
      </Link>
      <Link href="/" className={linkClass("books")}>
        Books
      </Link>
      <form action="/api/auth/logout" method="post" className="ml-auto">
        <button type="submit" className="text-neutral-500 hover:underline">
          Log out
        </button>
      </form>
    </nav>
  );
}
