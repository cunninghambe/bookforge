import Link from "next/link";
import { ThemeToggle } from "./ThemeToggle";

// Shared top navigation for authed pages. Calm and minimal.
export function TopNav({
  active,
}: {
  active?: "canon" | "characters" | "books" | "settings";
}) {
  const linkClass = (key: string) =>
    `hover:text-ink transition-colors ${
      active === key ? "font-semibold text-ink" : "font-medium text-muted"
    }`;
  return (
    <nav className="flex items-center gap-6 border-b border-edge-soft py-4 text-sm">
      <Link href="/canon" className={linkClass("canon")}>
        Canon
      </Link>
      <Link href="/characters" className={linkClass("characters")}>
        Characters
      </Link>
      <Link href="/" className={linkClass("books")}>
        Books
      </Link>
      <Link href="/settings" className={linkClass("settings")} data-testid="nav-settings">
        Settings
      </Link>
      <div className="ml-auto flex items-center gap-5">
        <ThemeToggle />
        <form action="/api/auth/logout" method="post">
          <button type="submit" className="btn-quiet">
            Log out
          </button>
        </form>
      </div>
    </nav>
  );
}
