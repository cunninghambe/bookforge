"use client";

import { useState } from "react";
import Link from "next/link";

// Amendment A15: below the breakpoint, the section links fold into a disclosure
// menu opened from a 44px toggle. Mirrors the SearchTrigger composition (D107):
// TopNav stays a server component, and this small client child owns the only bit
// of interactivity. The toggle and the links panel are returned as siblings (not
// wrapped in an extra div) so they slot directly into TopNav's flex row with no
// change to its gap-based spacing at sm and up; the links panel is positioned
// absolutely under the nav bar on mobile (TopNav's <nav> carries `relative` for
// this) and reverts to a plain inline flex row at sm, identical to the pre-A15
// markup. data-testid="nav-settings" exists exactly once, so it is reachable in
// both layouts without ever appearing twice in the DOM.

const LINKS = [
  { key: "canon", href: "/canon", label: "Canon" },
  { key: "characters", href: "/characters", label: "Characters" },
  { key: "books", href: "/", label: "Books" },
  { key: "settings", href: "/settings", label: "Settings" },
] as const;

export function NavDisclosure({
  active,
}: {
  active?: "canon" | "characters" | "books" | "settings";
}) {
  const [open, setOpen] = useState(false);

  const linkClass = (key: string) =>
    `block px-3 py-2.5 sm:inline sm:px-0 sm:py-0 hover:text-ink transition-colors ${
      active === key ? "font-semibold text-ink" : "font-medium text-muted"
    }`;

  return (
    <>
      <button
        type="button"
        data-testid="nav-menu-toggle"
        aria-label="Open navigation menu"
        aria-expanded={open}
        aria-controls="nav-links"
        onClick={() => setOpen((o) => !o)}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded border border-edge text-ink sm:hidden"
      >
        <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
          <path
            d="M3 5h14M3 10h14M3 15h14"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <div
        id="nav-links"
        data-testid="nav-links"
        className={`${
          open ? "flex" : "hidden"
        } absolute left-0 top-full z-40 mt-1 w-48 flex-col rounded border border-edge-soft bg-surface p-1 shadow-lg sm:static sm:z-auto sm:mt-0 sm:flex sm:w-auto sm:flex-row sm:items-center sm:gap-6 sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none`}
      >
        {LINKS.map((l) => (
          <Link
            key={l.key}
            href={l.href}
            onClick={() => setOpen(false)}
            className={linkClass(l.key)}
            data-testid={l.key === "settings" ? "nav-settings" : undefined}
          >
            {l.label}
          </Link>
        ))}
      </div>
    </>
  );
}
