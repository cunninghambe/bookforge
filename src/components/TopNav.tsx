import Link from "next/link";
import { SearchTrigger } from "./SearchTrigger";
import { ThemeToggle } from "./ThemeToggle";
import { NavDisclosure } from "./NavDisclosure";

// Shared top navigation for authed pages. Calm and minimal. A13 adds the
// small wordmark (accent book glyph plus serif name) linking home. A15: below
// the 640px breakpoint the section links fold into NavDisclosure's toggle menu;
// `relative` on <nav> anchors that menu's absolute positioning. At sm and up
// NavDisclosure's links render as a plain inline row (its toggle button is
// sm:hidden), so desktop markup and spacing are unchanged from before A15.
export function TopNav({
  active,
}: {
  active?: "canon" | "characters" | "books" | "settings";
}) {
  return (
    <nav className="relative flex flex-wrap items-center gap-3 border-b border-edge-soft py-4 text-sm sm:flex-nowrap sm:gap-6">
      <Link
        href="/"
        className="mr-2 flex items-center gap-2 font-serif text-base font-semibold tracking-tight text-ink"
        aria-label="bookforge home"
      >
        <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true">
          <rect x="7" y="5" width="18" height="22" rx="4" className="fill-accent" />
          <rect x="7" y="5" width="4" height="22" rx="2" className="fill-accent-hover" />
          <path
            d="M15 12h8M15 16h8M15 20h5"
            className="stroke-accent-ink"
            strokeWidth="1.6"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
        bookforge
      </Link>
      <NavDisclosure active={active} />
      <div className="ml-auto flex items-center gap-5">
        <SearchTrigger />
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
