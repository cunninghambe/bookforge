"use client";

import { useEffect, useState } from "react";

// A9 theme toggle: a quiet labeled button in the top navigation. It flips the
// dark class on <html> immediately (no reload) and writes a long-lived plain
// cookie so the server can stamp the class on the next render. The initial theme
// is already applied server-side by the root layout; this reads it back on mount
// so the label matches.
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    // Long-lived (1 year), path=/, plain (not httpOnly) so this client can set it.
    document.cookie = `bookforge_theme=${next ? "dark" : "light"}; path=/; max-age=31536000; samesite=lax`;
    setDark(next);
  }

  return (
    <button
      type="button"
      data-testid="theme-toggle"
      onClick={toggle}
      aria-label="Toggle light or dark theme"
      className="btn-quiet text-sm"
    >
      {dark ? "Light mode" : "Dark mode"}
    </button>
  );
}
